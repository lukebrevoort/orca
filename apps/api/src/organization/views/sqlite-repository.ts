import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  organizationViewBounds,
  organizationViewDefinitionSchema,
  organizationViewResultItemSchema,
  organizationViewResultPageSchema,
  organizationViewSchema,
  type FacetFilter,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewReorderRequest,
  type OrganizationViewResultItem,
  type OrganizationViewResultQuery,
} from "@orca/shared";

import { OrganizationViewAccessError, OrganizationViewConflictError, OrganizationViewNotFoundError, OrganizationViewQueryError, type OrganizationViewsRepository, type OrganizationViewScope } from "./module.ts";

type ViewRow = {
  workspace_id: string; id: string; name: string; description: string; color: string; position: number;
  definition: string; revision: number; created_at: number; updated_at: number;
};
type SqlBinding = string | number | bigint | boolean | Uint8Array | null;
export type OrganizationViewPageKey = { threadId: string };
type OrganizationViewDetailRow = {
  accountId: string; accountEmail: string; provider: string; threadId: string; subject: string; latestReceivedAt: number;
  messageCount: number; isRead: number; primaryLaneId: string; senderName: string | null; senderEmail: string;
  humanSignal: number | null; humanClassification: string | null;
};

function iso(value: number) { return new Date(value).toISOString(); }
function mapView(row: ViewRow): OrganizationView {
  return organizationViewSchema.parse({
    id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description, color: row.color,
    position: row.position, definition: JSON.parse(row.definition), revision: row.revision,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

function placeholders(values: readonly unknown[]) { return values.map(() => "?").join(","); }
function fingerprint(view: OrganizationView, accountIds: readonly string[]) {
  return createHash("sha256").update(JSON.stringify([view.id, view.revision, view.definition, accountIds])).digest("hex");
}
type Cursor = { version: 1; fingerprint: string; receivedAt: number; accountId: string; threadId: string };
function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
function decodeCursor(value: string | undefined, expectedFingerprint: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>;
      const keys = Object.keys(candidate);
      if (keys.length === 5
        && keys.every((key) => ["version", "fingerprint", "receivedAt", "accountId", "threadId"].includes(key))
        && candidate.version === 1
        && typeof candidate.fingerprint === "string"
        && /^[0-9a-f]{64}$/.test(candidate.fingerprint)
        && candidate.fingerprint === expectedFingerprint
        && typeof candidate.receivedAt === "number"
        && Number.isSafeInteger(candidate.receivedAt)
        && candidate.receivedAt >= 0
        && candidate.receivedAt <= 8_640_000_000_000_000
        && isBoundedIdentifier(candidate.accountId)
        && isBoundedIdentifier(candidate.threadId)) return candidate as Cursor;
    }
  } catch { /* one stable public error below */ }
  throw new OrganizationViewQueryError("The View cursor does not match this live definition or Account scope");
}
function encodeCursor(item: OrganizationViewResultItem, cursorFingerprint: string) {
  return Buffer.from(JSON.stringify({ version: 1, fingerprint: cursorFingerprint, receivedAt: Date.parse(item.latestReceivedAt), accountId: item.accountId, threadId: item.threadId }), "utf8").toString("base64url");
}

function facetPredicate(filter: FacetFilter, params: SqlBinding[]) {
  const base = "f.workspace_id = ? AND f.facet_id = ? AND f.account_id = t.account_id AND f.thread_id = t.id";
  params.push("__WORKSPACE__", filter.facetId);
  if (filter.operator === "missing") return `NOT EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base})`;
  if (filter.operator === "present") return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base})`;
  if (!("value" in filter)) throw new OrganizationViewQueryError("A Facet value predicate is incomplete");
  const jsonValue = JSON.stringify(filter.value);
  if (filter.operator === "equals") {
    params.push(jsonValue, jsonValue);
    return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base} AND (json_extract(f.value,'$') = json_extract(?,'$') OR EXISTS (SELECT 1 FROM json_each(f.value) j WHERE j.value = json_extract(?,'$'))))`;
  }
  params.push(String(filter.value).toLocaleLowerCase(), `%${String(filter.value).toLocaleLowerCase()}%`);
  return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base} AND (lower(CAST(json_extract(f.value,'$') AS TEXT)) = ? OR EXISTS (SELECT 1 FROM json_each(f.value) j WHERE lower(CAST(j.value AS TEXT)) LIKE ?)))`;
}

/**
 * Builds the production ordering scan. Keep projection work out of this query:
 * SQLite can then satisfy the complete keyset order from threads_view_order_idx
 * and stop after limit + 1 qualifying keys without a mailbox-sized temp sort.
 * CROSS JOIN is deliberate: it keeps Threads as the outer loop at small limits,
 * where SQLite otherwise reorders the inner joins and adds a temporary B-tree.
 */
export function buildOrganizationViewPageKeyQuery(input: { scope: OrganizationViewScope; view: OrganizationView; query: OrganizationViewResultQuery }) {
  const { scope, view, query } = input;
  const definition = organizationViewDefinitionSchema.parse(view.definition);
  const owned = new Set(scope.accountIds);
  const accountIds = [...(definition.accountIds ?? scope.accountIds)].sort();
  if (accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationViewQueryError("The View Account scope is no longer authorized");
  const conditions: string[] = [`oa.user_id = ?`, `t.account_id IN (${placeholders(accountIds)})`];
  const params: SqlBinding[] = [scope.workspaceId, ...accountIds];
  if (definition.laneIds) { conditions.push(`lane.primary_lane_id IN (${placeholders(definition.laneIds)})`); params.push(...definition.laneIds); }
  if (definition.workflowStateIds) { conditions.push(`EXISTS (SELECT 1 FROM organization_thread_workflow_states workflow WHERE workflow.workspace_id=? AND workflow.account_id=t.account_id AND workflow.thread_id=t.id AND workflow.state_id IN (${placeholders(definition.workflowStateIds)}))`); params.push(scope.workspaceId, ...definition.workflowStateIds); }
  for (const filter of definition.facetFilters ?? []) {
    const filterParams: SqlBinding[] = [];
    conditions.push(facetPredicate(filter, filterParams));
    params.push(...filterParams.map((value) => value === "__WORKSPACE__" ? scope.workspaceId : value));
  }
  for (const filter of definition.contextFilters ?? []) {
    conditions.push("EXISTS (SELECT 1 FROM organization_thread_context_relationships context_edge WHERE context_edge.workspace_id=? AND context_edge.account_id=t.account_id AND context_edge.thread_id=t.id AND context_edge.context_type_id=? AND context_edge.context_id=? AND context_edge.relationship_type_id=?" + (filter.direction ? " AND context_edge.direction=?" : "") + ")");
    params.push(scope.workspaceId, filter.context.contextTypeId, filter.context.contextId, filter.relationshipTypeId, ...(filter.direction ? [filter.direction] : []));
  }
  if (definition.thread?.ids) { conditions.push(`t.id IN (${placeholders(definition.thread.ids)})`); params.push(...definition.thread.ids); }
  if (definition.thread?.subjectContains) { conditions.push("lower(COALESCE(t.subject,'')) LIKE ?"); params.push(`%${definition.thread.subjectContains.toLocaleLowerCase()}%`); }
  if (definition.thread?.readState) { conditions.push("t.is_read = ?"); params.push(definition.thread.readState === "read" ? 1 : 0); }

  const emailConditions: string[] = ["e.account_id=t.account_id", "e.thread_id=t.id"];
  const signal = definition.humanSignal;
  if (signal?.minimumScore !== undefined) { emailConditions.push("e.human_signal >= ?"); params.push(signal.minimumScore); }
  if (signal?.maximumScore !== undefined) { emailConditions.push("e.human_signal <= ?"); params.push(signal.maximumScore); }
  if (signal?.classifications) { emailConditions.push(`e.human_classification IN (${placeholders(signal.classifications)})`); params.push(...signal.classifications); }
  if (signal?.evidenceReasonCodes) { emailConditions.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(e.human_classification_reasons,'[]')) reason WHERE reason.value IN (${placeholders(signal.evidenceReasonCodes)}))`); params.push(...signal.evidenceReasonCodes); }
  if (definition.sender) {
    const senderParts: string[] = [];
    if (definition.sender.addresses) { senderParts.push(`lower(e.from_address) IN (${placeholders(definition.sender.addresses)})`); params.push(...definition.sender.addresses); }
    if (definition.sender.domains) { senderParts.push(`lower(substr(e.from_address,instr(e.from_address,'@')+1)) IN (${placeholders(definition.sender.domains)})`); params.push(...definition.sender.domains); }
    emailConditions.push(`(${senderParts.join(" OR ")})`);
  }
  if (definition.date?.receivedAfter) { emailConditions.push("e.received_at >= ?"); params.push(Date.parse(definition.date.receivedAfter)); }
  if (definition.date?.receivedBefore) { emailConditions.push("e.received_at <= ?"); params.push(Date.parse(definition.date.receivedBefore)); }
  if (emailConditions.length > 2) conditions.push(`EXISTS (SELECT 1 FROM emails e WHERE ${emailConditions.join(" AND ")})`);

  const cursorFingerprint = fingerprint(view, accountIds);
  const cursor = decodeCursor(query.cursor, cursorFingerprint);
  if (cursor) {
    conditions.push("(COALESCE(t.latest_received_at,t.created_at) < ? OR (COALESCE(t.latest_received_at,t.created_at) = ? AND (t.account_id > ? OR (t.account_id = ? AND t.id > ?))))");
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.accountId, cursor.accountId, cursor.threadId);
  }
  params.push(query.limit + 1);
  return {
    sql: `SELECT t.id AS threadId FROM threads t INDEXED BY threads_view_order_idx CROSS JOIN oauth_accounts oa ON oa.id=t.account_id CROSS JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(t.latest_received_at,t.created_at) DESC,t.account_id ASC,t.id ASC LIMIT ?`,
    params,
    accountIds,
    cursorFingerprint,
  };
}

/**
 * Builds the bounded detail lookup for keys selected by the ordering scan. This
 * query intentionally has no ORDER BY: at most 100 rows are projected and the
 * first query's authoritative order is restored in application code.
 */
export function buildOrganizationViewDetailQuery(keys: readonly OrganizationViewPageKey[]) {
  if (keys.length < 1 || keys.length > organizationViewBounds.maximumResultsPerPage) {
    throw new Error(`View detail projection requires 1-${organizationViewBounds.maximumResultsPerPage} page keys`);
  }
  const values = keys.map(() => "(?)").join(",");
  return {
    sql: `WITH requested(thread_id) AS (VALUES ${values}) SELECT t.account_id AS accountId,oa.provider_email AS accountEmail,oa.provider,t.id AS threadId,COALESCE(t.subject,'') AS subject,COALESCE(t.latest_received_at,t.created_at) AS latestReceivedAt,t.message_count AS messageCount,t.is_read AS isRead,lane.primary_lane_id AS primaryLaneId,latest.from_name AS senderName,COALESCE(latest.from_address,'') AS senderEmail,(SELECT MAX(signal_email.human_signal) FROM emails signal_email WHERE signal_email.account_id=t.account_id AND signal_email.thread_id=t.id) AS humanSignal,latest.human_classification AS humanClassification FROM requested JOIN threads t ON t.id=requested.thread_id JOIN oauth_accounts oa ON oa.id=t.account_id JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id LEFT JOIN emails latest ON latest.id=(SELECT latest_id.id FROM emails latest_id WHERE latest_id.account_id=t.account_id AND latest_id.thread_id=t.id ORDER BY latest_id.received_at DESC,latest_id.id DESC LIMIT 1)`,
    params: keys.map((key) => key.threadId),
  };
}

function assertOwnedIds(sqlite: Database, workspaceId: string, table: "organization_lanes" | "organization_facets" | "organization_workflow_states", ids: readonly string[] | undefined) {
  if (!ids?.length) return;
  const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=? AND id IN (${placeholders(ids)})`).get(workspaceId, ...ids) as { count: number };
  if (row.count !== ids.length) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
}

function assertOwnedDefinition(sqlite: Database, workspaceId: string, definition: OrganizationViewDefinition) {
  if (definition.accountIds?.length) {
    const row = sqlite.query(`SELECT COUNT(*) AS count FROM oauth_accounts WHERE user_id=? AND id IN (${placeholders(definition.accountIds)})`).get(workspaceId, ...definition.accountIds) as { count: number };
    if (row.count !== definition.accountIds.length) throw new OrganizationViewAccessError();
  }
  assertOwnedIds(sqlite, workspaceId, "organization_lanes", definition.laneIds);
  assertOwnedIds(sqlite, workspaceId, "organization_facets", definition.facetFilters?.map((filter) => filter.facetId));
  assertOwnedIds(sqlite, workspaceId, "organization_workflow_states", definition.workflowStateIds);
  if (definition.thread?.ids?.length) {
    const row = sqlite.query(`SELECT COUNT(*) AS count FROM threads t JOIN oauth_accounts oa ON oa.id=t.account_id WHERE oa.user_id=? AND t.id IN (${placeholders(definition.thread.ids)})`).get(workspaceId, ...definition.thread.ids) as { count: number };
    if (row.count !== definition.thread.ids.length) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
  }
  for (const filter of definition.contextFilters ?? []) {
    const owned = sqlite.query("SELECT 1 FROM organization_context_types context_type JOIN organization_contexts context ON context.workspace_id=context_type.workspace_id AND context.context_type_id=context_type.id JOIN organization_context_relationship_types relationship ON relationship.workspace_id=context_type.workspace_id AND relationship.context_type_id=context_type.id WHERE context_type.workspace_id=? AND context_type.id=? AND context.id=? AND relationship.id=?" + (filter.direction ? " AND relationship.direction=?" : "") + " LIMIT 1")
      .get(workspaceId, filter.context.contextTypeId, filter.context.contextId, filter.relationshipTypeId, ...(filter.direction ? [filter.direction] : []));
    if (!owned) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
  }
}

export function createSqliteOrganizationViewsRepository(sqlite: Database): OrganizationViewsRepository {
  const get = (workspaceId: string, viewId: string) => {
    const row = sqlite.query("SELECT * FROM organization_views WHERE workspace_id = ? AND id = ?").get(workspaceId, viewId) as ViewRow | null;
    return row ? mapView(row) : null;
  };
  return {
    list(workspaceId) {
      return (sqlite.query("SELECT * FROM organization_views WHERE workspace_id = ? ORDER BY position,id").all(workspaceId) as ViewRow[]).map(mapView);
    },
    get,
    create({ workspaceId, viewId, request, now }) {
      const timestamp = now.getTime();
      return sqlite.transaction(() => {
        assertOwnedDefinition(sqlite, workspaceId, request.definition);
        sqlite.query("INSERT INTO organization_views (workspace_id,id,name,description,color,position,definition,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(workspaceId, viewId, request.name, request.description, request.color, request.position, JSON.stringify(request.definition), 1, timestamp, timestamp);
        return get(workspaceId, viewId)!;
      })();
    },
    update({ workspaceId, viewId, request, now }) {
      return sqlite.transaction(() => {
        const current = get(workspaceId, viewId);
        if (!current) throw new OrganizationViewNotFoundError();
        if (current.revision !== request.expectedRevision) throw new OrganizationViewConflictError();
        const next = { ...current, ...request.patch, definition: request.patch.definition ?? current.definition };
        assertOwnedDefinition(sqlite, workspaceId, next.definition);
        const result = sqlite.query("UPDATE organization_views SET name=?,description=?,color=?,position=?,definition=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?")
          .run(next.name, next.description, next.color, next.position, JSON.stringify(next.definition), now.getTime(), workspaceId, viewId, request.expectedRevision);
        if (result.changes !== 1) throw new OrganizationViewConflictError();
        return get(workspaceId, viewId)!;
      })();
    },
    reorder({ workspaceId, request, now }: { workspaceId: string; request: OrganizationViewReorderRequest; now: Date }) {
      return sqlite.transaction(() => {
        for (const item of request.items) {
          const current = get(workspaceId, item.id);
          if (!current) throw new OrganizationViewNotFoundError();
          if (current.revision !== item.expectedRevision) throw new OrganizationViewConflictError();
        }
        for (const item of request.items) {
          const result = sqlite.query("UPDATE organization_views SET position=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?")
            .run(item.position, now.getTime(), workspaceId, item.id, item.expectedRevision);
          if (result.changes !== 1) throw new OrganizationViewConflictError();
        }
        return (sqlite.query("SELECT * FROM organization_views WHERE workspace_id = ? ORDER BY position,id").all(workspaceId) as ViewRow[]).map(mapView);
      })();
    },
    remove({ workspaceId, viewId, expectedRevision }) {
      const result = sqlite.query("DELETE FROM organization_views WHERE workspace_id=? AND id=? AND revision=?").run(workspaceId, viewId, expectedRevision);
      if (result.changes !== 1) {
        if (!get(workspaceId, viewId)) throw new OrganizationViewNotFoundError();
        throw new OrganizationViewConflictError();
      }
    },
    query({ scope, view, query }) {
      const pageQuery = buildOrganizationViewPageKeyQuery({ scope, view, query });
      return sqlite.transaction(() => {
        const pageKeys = sqlite.query(pageQuery.sql).all(...pageQuery.params) as OrganizationViewPageKey[];
        const hasMore = pageKeys.length > query.limit;
        const requestedKeys = pageKeys.slice(0, query.limit);
        if (requestedKeys.length === 0) {
          return organizationViewResultPageSchema.parse({ viewId: view.id, viewRevision: view.revision, accountIds: pageQuery.accountIds, items: [], nextCursor: null, limit: query.limit });
        }

        const detailQuery = buildOrganizationViewDetailQuery(requestedKeys);
        const details = sqlite.query(detailQuery.sql).all(...detailQuery.params) as OrganizationViewDetailRow[];
        const detailsByKey = new Map(details.map((row) => [row.threadId, row]));
        const items = requestedKeys.map((key) => {
          const row = detailsByKey.get(key.threadId);
          if (!row) throw new Error(`View detail projection did not return ${key.threadId}`);
          return organizationViewResultItemSchema.parse({
            accountId: row.accountId, accountEmail: row.accountEmail, provider: row.provider, threadId: row.threadId, subject: row.subject,
            latestReceivedAt: iso(row.latestReceivedAt), messageCount: row.messageCount, readState: row.isRead ? "read" : "unread",
            primaryLaneId: row.primaryLaneId, sender: { name: row.senderName, email: row.senderEmail }, humanSignal: row.humanSignal,
            humanClassification: row.humanClassification,
          });
        });
        return organizationViewResultPageSchema.parse({ viewId: view.id, viewRevision: view.revision, accountIds: pageQuery.accountIds, items, nextCursor: hasMore ? encodeCursor(items.at(-1)!, pageQuery.cursorFingerprint) : null, limit: query.limit });
      }).deferred();
    },
  };
}
