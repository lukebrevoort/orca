import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  organizationViewBounds,
  organizationViewDefinitionSchema,
  organizationViewResultItemSchema,
  organizationViewResultPageSchema,
  organizationViewSchema,
  facetDefinitionSchema,
  type FacetDefinition,
  type FacetFilter,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewReorderRequest,
  type OrganizationViewResultItem,
  type OrganizationViewResultQuery,
  type OrganizationViewSelectedMessageReference,
} from "@orca/shared";

import { validateFacetFilters, FacetWorkflowValidationError } from "../facet-workflow.ts";
import { authorizeOrganizationOperation, canonicalOrganizationJson, digestOrganizationAuthorizationEnvelope, digestOrganizationCommand } from "../authority.ts";
import { loadAuthorizedOrganizationAgentCapability, organizationReplayAuthorityMatches } from "../agent-capability.ts";
import { digestOrganizationViewOrder, organizationViewOrderResourceId, OrganizationViewAccessError, OrganizationViewConflictError, OrganizationViewNotFoundError, OrganizationViewQueryError, OrganizationViewSelectionError, OrganizationViewValidationError, type OrganizationViewMutationAuthorization, type OrganizationViewMutationPlan, type OrganizationViewQueryAuthorization, type OrganizationViewsRepository, type OrganizationViewScope } from "./module.ts";

type ViewRow = {
  workspace_id: string; id: string; name: string; description: string; color: string; position: number;
  definition: string; revision: number; created_at: number; updated_at: number;
};
type SqlBinding = string | number | bigint | boolean | Uint8Array | null;
export type OrganizationViewPageKey = { accountId: string; threadId: string };
type OrganizationViewDetailRow = {
  accountId: string; accountEmail: string; provider: string; threadId: string; subject: string; latestReceivedAt: number;
  messageCount: number; isRead: number; primaryLaneId: string; senderName: string | null; senderEmail: string;
  humanSignal: number | null; humanClassification: string | null;
};
type SelectedSenderRow = {
  ordinal: number; accountId: string; threadId: string; messageId: string; fromAddress: string | null; providerEmail: string;
};

const ecmaScriptTrimCharacterSql = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
function normalizedEmailSql(valueSql: string) {
  return `lower(trim(coalesce(${valueSql}, ''), ${ecmaScriptTrimCharacterSql}))`;
}
function normalizedAddressSql(alias: string) { return normalizedEmailSql(`${alias}.from_address`); }
function normalizedDomainSql(alias: string) { const address = normalizedAddressSql(alias); return `case when instr(${address}, '@') > 0 then substr(${address}, instr(${address}, '@') + 1) else '' end`; }

function selectedSenderRows(sqlite: Database, workspaceId: string, references: OrganizationViewSelectedMessageReference[]) {
  return sqlite.query(`
    SELECT CAST(reference.key AS INTEGER) AS ordinal,
      email.account_id AS accountId,
      email.thread_id AS threadId,
      email.id AS messageId,
      ${normalizedEmailSql("email.from_address")} AS fromAddress,
      ${normalizedEmailSql("account.provider_email")} AS providerEmail
    FROM json_each(?) reference
    JOIN emails email
      ON email.id=json_extract(reference.value,'$.messageId')
      AND email.account_id=json_extract(reference.value,'$.accountId')
      AND email.thread_id=json_extract(reference.value,'$.threadId')
    JOIN threads thread ON thread.id=email.thread_id AND thread.account_id=email.account_id
    JOIN oauth_accounts account ON account.id=email.account_id AND account.user_id=?
    ORDER BY CAST(reference.key AS INTEGER)
  `).all(JSON.stringify(references), workspaceId) as SelectedSenderRow[];
}

function iso(value: number) { return new Date(value).toISOString(); }
function mapView(row: ViewRow): OrganizationView {
  return organizationViewSchema.parse({
    id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description, color: row.color,
    position: row.position, definition: JSON.parse(row.definition), revision: row.revision,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

function placeholders(values: readonly unknown[]) { return values.map(() => "?").join(","); }
function fingerprint(input: { definitionDigest: string; resultSetKey: string; accountIds: readonly string[]; authorizedScopeDigest: string }) {
  return createHash("sha256").update(canonicalOrganizationJson(input)).digest("hex");
}
function cursorDigest(scopeFingerprint: string, key: Omit<Cursor, "version" | "fingerprint">) {
  return createHash("sha256").update(canonicalOrganizationJson({ scopeFingerprint, key })).digest("hex");
}
type Cursor = { version: 2; fingerprint: string; receivedAt: number; accountId: string; threadId: string; shown: number };
function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}
function decodeCursor(value: string | undefined, expectedFingerprint: string): Cursor | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("non-canonical base64url alphabet");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical base64url encoding");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>;
      const keys = Object.keys(candidate);
      if (keys.length === 6
        && keys.every((key) => ["version", "fingerprint", "receivedAt", "accountId", "threadId", "shown"].includes(key))
        && candidate.version === 2
        && typeof candidate.fingerprint === "string"
        && /^[0-9a-f]{64}$/.test(candidate.fingerprint)
        && typeof candidate.receivedAt === "number"
        && Number.isSafeInteger(candidate.receivedAt)
        && candidate.receivedAt >= 0
        && candidate.receivedAt <= 8_640_000_000_000_000
        && Number.isSafeInteger(candidate.shown) && Number(candidate.shown) >= 1
        && isBoundedIdentifier(candidate.accountId)
        && isBoundedIdentifier(candidate.threadId)) {
        const key = { receivedAt: candidate.receivedAt, accountId: candidate.accountId, threadId: candidate.threadId, shown: Number(candidate.shown) };
        if (candidate.fingerprint === cursorDigest(expectedFingerprint, key)) return candidate as Cursor;
      }
    }
  } catch { /* one stable public error below */ }
  throw new OrganizationViewQueryError("The View cursor does not match this live definition or Account scope");
}

function escapeLikeLiteral(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
function encodeCursor(item: OrganizationViewResultItem, cursorFingerprint: string, shown: number) {
  const key = { receivedAt: Date.parse(item.latestReceivedAt), accountId: item.accountId, threadId: item.threadId, shown };
  return Buffer.from(JSON.stringify({ version: 2, fingerprint: cursorDigest(cursorFingerprint, key), ...key }), "utf8").toString("base64url");
}

function effectiveClassificationSql(alias: string) {
  const address = normalizedAddressSql(alias);
  const domain = normalizedDomainSql(alias);
  return `coalesce(
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='message' and override.target_value=${alias}.id limit 1),
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='sender_address' and override.target_value=${address} limit 1),
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='sender_domain' and override.target_value=${domain} limit 1),
    ${alias}.human_classification,
    'unclassified'
  )`;
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
  const literal = escapeLikeLiteral(String(filter.value).toLocaleLowerCase());
  params.push(String(filter.value).toLocaleLowerCase(), `%${literal}%`);
  return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base} AND (lower(CAST(json_extract(f.value,'$') AS TEXT)) = ? OR EXISTS (SELECT 1 FROM json_each(f.value) j WHERE lower(CAST(j.value AS TEXT)) LIKE ? ESCAPE '\\')))`;
}

/**
 * Builds the production ordering scan. Keep projection work out of this query:
 * SQLite can then satisfy the complete keyset order from threads_view_order_idx
 * and stop after limit + 1 qualifying keys without a mailbox-sized temp sort.
 * CROSS JOIN is deliberate: it keeps Threads as the outer loop at small limits,
 * where SQLite otherwise reorders the inner joins and adds a temporary B-tree.
 */
export function buildOrganizationViewPageKeyQuery(input: {
  scope: OrganizationViewScope;
  definition: OrganizationViewDefinition;
  definitionDigest: string;
  resultSetKey: string;
  authorizedScopeDigest: string;
  query: OrganizationViewResultQuery;
}) {
  const { scope, query } = input;
  const definition = organizationViewDefinitionSchema.parse(input.definition);
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
  if (definition.thread?.subjectContains) { conditions.push("lower(COALESCE(t.subject,'')) LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeLiteral(definition.thread.subjectContains.toLocaleLowerCase())}%`); }
  if (definition.thread?.readState) { conditions.push("t.is_read = ?"); params.push(definition.thread.readState === "read" ? 1 : 0); }

  const emailConditions: string[] = ["e.account_id=t.account_id", "e.thread_id=t.id"];
  const signal = definition.humanSignal;
  if (signal?.minimumScore !== undefined) { emailConditions.push("e.human_signal >= ?"); params.push(signal.minimumScore); }
  if (signal?.maximumScore !== undefined) { emailConditions.push("e.human_signal <= ?"); params.push(signal.maximumScore); }
  if (signal?.classifications) { emailConditions.push(`${effectiveClassificationSql("e")} IN (${placeholders(signal.classifications)})`); params.push(...signal.classifications); }
  if (signal?.evidenceReasonCodes) { emailConditions.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(e.human_classification_reasons,'[]')) reason WHERE reason.value IN (${placeholders(signal.evidenceReasonCodes)}))`); params.push(...signal.evidenceReasonCodes); }
  if (definition.sender) {
    const senderParts: string[] = [];
    if (definition.sender.addresses) { senderParts.push(`${normalizedAddressSql("e")} IN (${placeholders(definition.sender.addresses)})`); params.push(...definition.sender.addresses); }
    if (definition.sender.domains) { senderParts.push(`${normalizedDomainSql("e")} IN (${placeholders(definition.sender.domains)})`); params.push(...definition.sender.domains); }
    emailConditions.push(`(${senderParts.join(" OR ")})`);
  }
  if (definition.date?.receivedAfter) { emailConditions.push("e.received_at >= ?"); params.push(Date.parse(definition.date.receivedAfter)); }
  if (definition.date?.receivedBefore) { emailConditions.push("e.received_at <= ?"); params.push(Date.parse(definition.date.receivedBefore)); }
  if (emailConditions.length > 2) conditions.push(`EXISTS (SELECT 1 FROM emails e WHERE ${emailConditions.join(" AND ")})`);

  const cursorFingerprint = fingerprint({ definitionDigest: input.definitionDigest, resultSetKey: input.resultSetKey, accountIds, authorizedScopeDigest: input.authorizedScopeDigest });
  const cursor = decodeCursor(query.cursor, cursorFingerprint);
  if (cursor) {
    conditions.push("(COALESCE(t.latest_received_at,t.created_at) < ? OR (COALESCE(t.latest_received_at,t.created_at) = ? AND (t.account_id > ? OR (t.account_id = ? AND t.id > ?))))");
    params.push(cursor.receivedAt, cursor.receivedAt, cursor.accountId, cursor.accountId, cursor.threadId);
  }
  params.push(query.limit + 1);
  return {
    sql: `SELECT t.account_id AS accountId,t.id AS threadId FROM threads t INDEXED BY threads_view_order_idx CROSS JOIN oauth_accounts oa ON oa.id=t.account_id CROSS JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(t.latest_received_at,t.created_at) DESC,t.account_id ASC,t.id ASC LIMIT ?`,
    params,
    accountIds,
    cursorFingerprint,
    previouslyShown: cursor?.shown ?? 0,
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
  const values = keys.map(() => "(?,?)").join(",");
  return {
    sql: `WITH requested(account_id,thread_id) AS (VALUES ${values}) SELECT t.account_id AS accountId,oa.provider_email AS accountEmail,oa.provider,t.id AS threadId,COALESCE(t.subject,'') AS subject,COALESCE(t.latest_received_at,t.created_at) AS latestReceivedAt,t.message_count AS messageCount,t.is_read AS isRead,lane.primary_lane_id AS primaryLaneId,latest.from_name AS senderName,COALESCE(latest.from_address,'') AS senderEmail,(SELECT MAX(signal_email.human_signal) FROM emails signal_email WHERE signal_email.account_id=t.account_id AND signal_email.thread_id=t.id) AS humanSignal,${effectiveClassificationSql("latest")} AS humanClassification FROM requested JOIN threads t ON t.account_id=requested.account_id AND t.id=requested.thread_id JOIN oauth_accounts oa ON oa.id=t.account_id JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id LEFT JOIN emails latest ON latest.id=(SELECT latest_id.id FROM emails latest_id WHERE latest_id.account_id=t.account_id AND latest_id.thread_id=t.id ORDER BY latest_id.received_at DESC,latest_id.id DESC LIMIT 1)`,
    params: keys.flatMap((key) => [key.accountId, key.threadId]),
  };
}

function assertOwnedIds(sqlite: Database, workspaceId: string, table: "organization_lanes" | "organization_facets" | "organization_workflow_states", ids: readonly string[] | undefined) {
  if (!ids?.length) return;
  const uniqueIds = [...new Set(ids)];
  const row = sqlite.query(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=? AND id IN (${placeholders(uniqueIds)})`).get(workspaceId, ...uniqueIds) as { count: number };
  if (row.count !== uniqueIds.length) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
}

function loadFacetDefinitions(sqlite: Database, workspaceId: string, ids: readonly string[]): FacetDefinition[] {
  if (ids.length === 0) return [];
  const uniqueIds = [...new Set(ids)];
  const rows = sqlite.query(`SELECT id,name,position,value_type,cardinality,is_optional,default_value,retired_at,revision FROM organization_facets WHERE workspace_id=? AND id IN (${placeholders(uniqueIds)})`).all(workspaceId, ...uniqueIds) as Array<{
    id: string; name: string; position: number; value_type: string; cardinality: string; is_optional: number;
    default_value: string | null; retired_at: number | null; revision: number;
  }>;
  return rows.map((row) => facetDefinitionSchema.parse({
    id: row.id, name: row.name, position: row.position, valueType: JSON.parse(row.value_type), cardinality: JSON.parse(row.cardinality),
    isOptional: Boolean(row.is_optional), defaultValue: row.default_value === null ? null : JSON.parse(row.default_value),
    retiredAt: row.retired_at === null ? null : iso(row.retired_at), revision: row.revision,
  }));
}

function assertOwnedDefinition(sqlite: Database, workspaceId: string, definition: OrganizationViewDefinition, authorizedAccountIds: readonly string[]) {
  const granted = new Set(authorizedAccountIds);
  const effectiveAccountIds = [...(definition.accountIds ?? authorizedAccountIds)].sort();
  if (effectiveAccountIds.length === 0 || effectiveAccountIds.some((accountId) => !granted.has(accountId))) throw new OrganizationViewAccessError();
  const accountRow = sqlite.query(`SELECT COUNT(*) AS count FROM oauth_accounts WHERE user_id=? AND id IN (${placeholders(effectiveAccountIds)})`).get(workspaceId, ...effectiveAccountIds) as { count: number };
  if (accountRow.count !== effectiveAccountIds.length) throw new OrganizationViewAccessError();
  assertOwnedIds(sqlite, workspaceId, "organization_lanes", definition.laneIds);
  const facetFilters = definition.facetFilters ?? [];
  assertOwnedIds(sqlite, workspaceId, "organization_facets", facetFilters.map((filter) => filter.facetId));
  try { validateFacetFilters(loadFacetDefinitions(sqlite, workspaceId, facetFilters.map((filter) => filter.facetId)), facetFilters); }
  catch (error) { if (error instanceof FacetWorkflowValidationError) throw new OrganizationViewValidationError(error.message); throw error; }
  assertOwnedIds(sqlite, workspaceId, "organization_workflow_states", definition.workflowStateIds);
  if (definition.thread?.ids?.length) {
    const row = sqlite.query(`SELECT COUNT(*) AS count FROM threads t JOIN oauth_accounts oa ON oa.id=t.account_id WHERE oa.user_id=? AND t.account_id IN (${placeholders(effectiveAccountIds)}) AND t.id IN (${placeholders(definition.thread.ids)})`).get(workspaceId, ...effectiveAccountIds, ...definition.thread.ids) as { count: number };
    if (row.count !== definition.thread.ids.length) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
  }
  for (const filter of definition.contextFilters ?? []) {
    const owned = sqlite.query("SELECT 1 FROM organization_context_types context_type JOIN organization_contexts context ON context.workspace_id=context_type.workspace_id AND context.context_type_id=context_type.id JOIN organization_context_relationship_types relationship ON relationship.workspace_id=context_type.workspace_id AND relationship.context_type_id=context_type.id WHERE context_type.workspace_id=? AND context_type.id=? AND context.id=? AND relationship.id=?" + (filter.direction ? " AND relationship.direction=?" : "") + " LIMIT 1")
      .get(workspaceId, filter.context.contextTypeId, filter.context.contextId, filter.relationshipTypeId, ...(filter.direction ? [filter.direction] : []));
    if (!owned) throw new OrganizationViewAccessError("The View definition references a resource outside this Workspace", "resource_denied");
  }
}

function verifyQueryAuthorization(sqlite: Database, scope: OrganizationViewScope, authorization: OrganizationViewQueryAuthorization) {
  const expected = authorization.capabilitySnapshot;
  const live = scope.actor.type === "agent"
    ? authorization.agentCapabilitySource?.load({ actor: scope.actor as typeof scope.actor & { type: "agent" }, workspaceId: scope.workspaceId, accountIds: scope.accountIds }, sqlite) ?? null
    : { snapshot: expected, revokedAt: null };
  if (!live || live.revokedAt !== null
    || canonicalOrganizationJson(live.snapshot) !== canonicalOrganizationJson(expected)
    || expected.actor.id !== scope.actor.id
    || expected.actor.type !== scope.actor.type
    || expected.scope.workspaceId !== scope.workspaceId
    || canonicalOrganizationJson([...expected.scope.accountIds].sort()) !== canonicalOrganizationJson([...scope.accountIds].sort())
    || !expected.operations.includes("query")
    || !expected.actionFamilies.includes("organization_read")
    || authorization.requiredResourceFamilies.some((family) => !expected.resourceFamilies.includes(family))) {
    throw new OrganizationViewAccessError("The live Capability no longer authorizes this View query and every referenced resource family", "resource_denied");
  }
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson({
    actor: scope.actor,
    workspaceId: scope.workspaceId,
    authorizedAccountIds: [...scope.accountIds].sort(),
    capability: expected,
    requiredResourceFamilies: [...authorization.requiredResourceFamilies].sort(),
  })).digest("hex")}`;
}

function viewRows(sqlite: Database, workspaceId: string) {
  return sqlite.query("SELECT * FROM organization_views WHERE workspace_id=? ORDER BY position,id").all(workspaceId) as ViewRow[];
}

/** Moves every row through unique, non-negative temporary slots before assigning the canonical 0..n-1 order. */
function rewritePositions(sqlite: Database, workspaceId: string, orderedIds: readonly string[], changedIds: ReadonlySet<string>, now: number) {
  const rows = viewRows(sqlite, workspaceId);
  if (rows.length !== orderedIds.length || new Set(orderedIds).size !== rows.length) throw new OrganizationViewValidationError("A View reorder must resolve to one complete Workspace ordering");
  const known = new Set(rows.map((row) => row.id));
  if (orderedIds.some((id) => !known.has(id))) throw new OrganizationViewNotFoundError();
  const temporaryBase = Math.max(rows.length, ...rows.map((row) => row.position + 1)) + rows.length + 1;
  rows.forEach((row, index) => sqlite.query("UPDATE organization_views SET position=? WHERE workspace_id=? AND id=?").run(temporaryBase + index, workspaceId, row.id));
  orderedIds.forEach((id, position) => {
    sqlite.query(`UPDATE organization_views SET position=?${changedIds.has(id) ? ",revision=revision+1,updated_at=?" : ""} WHERE workspace_id=? AND id=?`)
      .run(...(changedIds.has(id) ? [position, now, workspaceId, id] : [position, workspaceId, id]));
  });
}

function workspaceRevision(sqlite: Database, workspaceId: string) {
  return (sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id=?").get(workspaceId) as { revision: number } | null)?.revision ?? 1;
}

function authorityState(sqlite: Database, workspaceId: string) {
  const resources = viewRows(sqlite, workspaceId);
  const currentWorkspaceRevision = workspaceRevision(sqlite, workspaceId);
  return {
    workspaceRevision: currentWorkspaceRevision,
    resourceRevisions: {
      ...Object.fromEntries(resources.map((row) => [`view:${row.id}`, row.revision])),
      [organizationViewOrderResourceId(workspaceId)]: currentWorkspaceRevision,
    },
    reservedIdempotencyKeys: (sqlite.query("SELECT idempotency_key AS key FROM organization_change_sets WHERE workspace_id=?").all(workspaceId) as Array<{ key: string }>).map((row) => row.key),
  };
}

function idempotentMutation(sqlite: Database, workspaceId: string, idempotencyKey: string) {
  const row = sqlite.query("SELECT command_json,authority_trace FROM organization_change_sets WHERE workspace_id=? AND idempotency_key=? AND resource_family='view'").get(workspaceId, idempotencyKey) as { command_json: string; authority_trace: string } | null;
  if (!row) return null;
  const parsed = JSON.parse(row.command_json) as { request: unknown; response: unknown };
  return { ...parsed, authorityTrace: JSON.parse(row.authority_trace) as unknown };
}

function verifyReplayAuthorization(
  sqlite: Database,
  scope: OrganizationViewScope,
  agentCapabilitySource: OrganizationViewMutationAuthorization["agentCapabilitySource"],
  replay: NonNullable<ReturnType<typeof idempotentMutation>>,
) {
  if (scope.actor.type !== "agent") return;
  const agentScope = { ...scope, actor: scope.actor as typeof scope.actor & { type: "agent" } };
  if (!loadAuthorizedOrganizationAgentCapability(
    agentScope, agentCapabilitySource, sqlite,
    { operation: "apply", resourceFamily: "view", actionFamily: "organization_structure" },
  )) throw new OrganizationViewAccessError("The persisted MCP Organization grant no longer authorizes View apply", "resource_denied");
  if (!organizationReplayAuthorityMatches(agentScope, replay.authorityTrace)) throw new OrganizationViewAccessError("The cached View mutation belongs to a different Organization authority", "resource_denied");
}

function verifyAuthorization(sqlite: Database, workspaceId: string, authorization: OrganizationViewMutationAuthorization) {
  sqlite.query("INSERT INTO organization_workspace_states (workspace_id,revision,updated_at) VALUES (?,1,?) ON CONFLICT(workspace_id) DO NOTHING").run(workspaceId, Date.now());
  const live = authorityState(sqlite, workspaceId);
  const capability = authorization.trace.capabilitySnapshot;
  const liveCapability = authorization.executionContext.actor.type === "agent"
    ? authorization.agentCapabilitySource?.load({
        actor: authorization.executionContext.actor as typeof authorization.executionContext.actor & { type: "agent" },
        workspaceId: authorization.executionContext.workspaceId,
        accountIds: authorization.executionContext.accountIds,
      }, sqlite) ?? null
    : { snapshot: capability, revokedAt: null };
  if (!liveCapability || liveCapability.revokedAt !== null
    || canonicalOrganizationJson(liveCapability.snapshot) !== canonicalOrganizationJson(capability)) {
    throw new OrganizationViewAccessError("The persisted MCP Organization grant changed before commit", "resource_denied");
  }
  const decision = authorizeOrganizationOperation({
    actor: authorization.executionContext.actor,
    capabilitySnapshot: capability,
    operation: authorization.executionContext.operation,
    scope: authorization.trace.scope,
    command: authorization.command,
    expectedRevisions: authorization.executionContext.expectedRevisions,
    idempotencyKey: authorization.executionContext.idempotencyKey,
  }, {
    scope: capability.scope,
    capability: liveCapability,
    workspaceRevision: live.workspaceRevision,
    resourceRevisions: live.resourceRevisions,
    reservedIdempotencyKeys: live.reservedIdempotencyKeys,
  });
  if (!decision.allowed) {
    if (["revision_conflict", "duplicate_idempotency_key"].includes(decision.code)) throw new OrganizationViewConflictError(decision.reason);
    throw new OrganizationViewAccessError(decision.reason, "resource_denied");
  }
  const envelope = { executionContext: authorization.executionContext, trace: authorization.trace };
  if (digestOrganizationCommand(authorization.command) !== authorization.executionContext.command.digest
    || digestOrganizationAuthorizationEnvelope(envelope) !== authorization.authorizationEnvelopeDigest
    || canonicalOrganizationJson(decision.executionContext) !== canonicalOrganizationJson(authorization.executionContext)
    || canonicalOrganizationJson(decision.trace) !== canonicalOrganizationJson(authorization.trace)) {
    throw new OrganizationViewAccessError("The authorized View command was modified before commit", "resource_denied");
  }
  return live.workspaceRevision;
}

function authorizedMutation<T>(sqlite: Database, input: {
  workspaceId: string; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date; mutate: () => T;
}) {
  return sqlite.transaction(() => {
    const key = input.authorization.executionContext.idempotencyKey;
    if (!key) throw new OrganizationViewValidationError("A View mutation requires an idempotency key");
    const replay = idempotentMutation(sqlite, input.workspaceId, key);
    if (replay) {
      verifyReplayAuthorization(sqlite, {
        actor: input.authorization.executionContext.actor,
        workspaceId: input.workspaceId,
        accountIds: input.authorization.executionContext.accountIds,
      }, input.authorization.agentCapabilitySource, replay);
      if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson(input.boundRequest)) throw new OrganizationViewConflictError("The idempotency key was already used for a different View command");
      return replay.response as T;
    }
    const revisionBefore = verifyAuthorization(sqlite, input.workspaceId, input.authorization);
    const beforeRows = viewRows(sqlite, input.workspaceId);
    const actualSnapshot = beforeRows.map((row) => ({ id: row.id, position: row.position, revision: row.revision }));
    if (canonicalOrganizationJson(actualSnapshot) !== canonicalOrganizationJson(input.plan.expectedViews)) {
      throw new OrganizationViewConflictError("The View ordering snapshot changed before this command could commit");
    }
    const intents = new Map(input.authorization.command.intents.map((intent) => [intent.resourceId, intent]));
    const orderResourceId = organizationViewOrderResourceId(input.workspaceId);
    const orderIntent = intents.get(orderResourceId);
    const beforeOrderIds = beforeRows.map((row) => row.id);
    const orderChanges = canonicalOrganizationJson(beforeOrderIds) !== canonicalOrganizationJson(input.plan.orderedViewIds);
    if (orderIntent) {
      if (orderIntent.mutation !== "update"
        || orderIntent.changes?.orderDigest !== digestOrganizationViewOrder(input.plan.orderedViewIds)
        || orderIntent.changes?.viewCount !== input.plan.orderedViewIds.length) {
        throw new OrganizationViewAccessError("The authorized View ordering aggregate does not match the exact target order", "resource_denied");
      }
    } else if (orderChanges) {
      throw new OrganizationViewAccessError("A View order changed without aggregate authority", "resource_denied");
    }
    const before = new Map(beforeRows.map((row) => [row.id, mapView(row)]));
    const response = input.mutate();
    const after = new Map(viewRows(sqlite, input.workspaceId).map((row) => [row.id, mapView(row)]));
    const changedIds = [...new Set([...before.keys(), ...after.keys()])].filter((id) => canonicalOrganizationJson(before.get(id) ?? null) !== canonicalOrganizationJson(after.get(id) ?? null));
    if (canonicalOrganizationJson([...after.values()].map((view) => view.id)) !== canonicalOrganizationJson(input.plan.orderedViewIds)) {
      throw new OrganizationViewAccessError("The authorized View order does not match the committed mutation", "resource_denied");
    }
    for (const id of changedIds) {
      const previous = before.get(id) ?? null;
      const next = after.get(id) ?? null;
      const intent = intents.get(`view:${id}`);
      if (intent) {
        if ((previous === null && intent.mutation !== "create")
          || (previous !== null && intent.mutation !== "update")
          || (next === null && intent.changes?.remove !== true)
          || (next !== null && intent.changes?.position !== next.position)) {
          throw new OrganizationViewAccessError(`View ${id} changed outside the exact authorized command`, "resource_denied");
        }
        continue;
      }
      if (!orderIntent || previous === null || next === null
        || next.revision !== previous.revision + 1
        || canonicalOrganizationJson({ ...previous, position: next.position, revision: next.revision, updatedAt: next.updatedAt }) !== canonicalOrganizationJson(next)) {
        throw new OrganizationViewAccessError(`View ${id} changed outside the exact authorized command`, "resource_denied");
      }
    }
    sqlite.query("INSERT INTO organization_change_sets (workspace_id,id,idempotency_key,command_digest,authority_trace,resource_family,operation,command_json,reverts_change_id,workspace_revision_before,workspace_revision_after,created_at) VALUES (?,?,?,?,?,'view','apply',?,NULL,?,?,?)")
      .run(input.workspaceId, input.authorization.command.id, key, input.authorization.executionContext.command.digest, JSON.stringify(input.authorization.trace), JSON.stringify({ request: input.boundRequest, response: response ?? null }), revisionBefore, revisionBefore + 1, input.now.getTime());
    const insertAction = sqlite.query("INSERT INTO organization_change_actions (workspace_id,change_id,position,action_kind,resource_family,resource_id,before_json,after_json) VALUES (?,?,?,?,?,?,?,?)");
    const directChangedIds = changedIds.filter((id) => intents.has(`view:${id}`));
    directChangedIds.forEach((id, position) => {
      const previous = before.get(id) ?? null; const next = after.get(id) ?? null;
      insertAction.run(input.workspaceId, input.authorization.command.id, position, previous === null ? "view_create" : next === null ? "view_remove" : "view_update", "view", `view:${id}`, previous === null ? null : JSON.stringify(previous), next === null ? null : JSON.stringify(next));
    });
    if (orderIntent) {
      const beforeOrder = { orderDigest: digestOrganizationViewOrder(beforeOrderIds), revision: revisionBefore, viewCount: beforeOrderIds.length };
      const afterOrderIds = [...after.values()].map((view) => view.id);
      const afterOrder = { orderDigest: digestOrganizationViewOrder(afterOrderIds), revision: revisionBefore + 1, viewCount: afterOrderIds.length };
      insertAction.run(input.workspaceId, input.authorization.command.id, directChangedIds.length, "view_order_update", "view", orderResourceId, JSON.stringify(beforeOrder), JSON.stringify(afterOrder));
    }
    const advanced = sqlite.query("UPDATE organization_workspace_states SET revision=revision+1,updated_at=? WHERE workspace_id=? AND revision=?").run(input.now.getTime(), input.workspaceId, revisionBefore);
    if (advanced.changes !== 1) throw new OrganizationViewConflictError("The Workspace changed before this View command could commit");
    return response;
  })();
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
    getWorkspaceRevision(workspaceId) { return workspaceRevision(sqlite, workspaceId); },
    getAuthorityState(workspaceId) { return authorityState(sqlite, workspaceId); },
    replay(input) {
      return sqlite.transaction(() => {
        const executor = sqlite;
        const existing = idempotentMutation(executor, input.scope.workspaceId, input.idempotencyKey);
        if (!existing) return null;
        verifyReplayAuthorization(executor, input.scope, input.agentCapabilitySource, existing);
        if (canonicalOrganizationJson(existing.request) !== canonicalOrganizationJson(input.boundRequest)) throw new OrganizationViewConflictError("The idempotency key was already used for a different View command");
        return { response: existing.response };
      })();
    },
    create({ workspaceId, viewId, request, boundRequest, plan, authorization, now }) {
      const timestamp = now.getTime();
      return authorizedMutation(sqlite, { workspaceId, boundRequest, plan, authorization, now, mutate: () => {
        assertOwnedDefinition(sqlite, workspaceId, request.definition, authorization.executionContext.accountIds);
        const current = viewRows(sqlite, workspaceId);
        const temporaryPosition = Math.max(current.length, ...current.map((row) => row.position + 1)) + current.length + 1;
        sqlite.query("INSERT INTO organization_views (workspace_id,id,name,description,color,position,definition,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(workspaceId, viewId, request.name, request.description, request.color, temporaryPosition, JSON.stringify(request.definition), 1, timestamp, timestamp);
        const changed = new Set(current.filter((row) => plan.orderedViewIds.indexOf(row.id) !== row.position).map((row) => row.id));
        rewritePositions(sqlite, workspaceId, plan.orderedViewIds, changed, timestamp);
        return get(workspaceId, viewId)!;
      } });
    },
    update({ workspaceId, viewId, request, boundRequest, plan, authorization, now }) {
      return authorizedMutation(sqlite, { workspaceId, boundRequest, plan, authorization, now, mutate: () => {
        const current = get(workspaceId, viewId);
        if (!current) throw new OrganizationViewNotFoundError();
        if (current.revision !== request.expectedRevision) throw new OrganizationViewConflictError();
        const next = { ...current, ...request.patch, definition: request.patch.definition ?? current.definition };
        assertOwnedDefinition(sqlite, workspaceId, next.definition, authorization.executionContext.accountIds);
        if (request.patch.position !== undefined) {
          const rows = viewRows(sqlite, workspaceId);
          rewritePositions(sqlite, workspaceId, plan.orderedViewIds, new Set(rows.filter((row) => plan.orderedViewIds.indexOf(row.id) !== row.position && row.id !== viewId).map((row) => row.id)), now.getTime());
        }
        const result = sqlite.query("UPDATE organization_views SET name=?,description=?,color=?,position=?,definition=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?")
          .run(next.name, next.description, next.color, plan.orderedViewIds.indexOf(viewId), JSON.stringify(next.definition), now.getTime(), workspaceId, viewId, request.expectedRevision);
        if (result.changes !== 1) throw new OrganizationViewConflictError();
        return get(workspaceId, viewId)!;
      } });
    },
    reorder({ workspaceId, request, boundRequest, plan, authorization, now }) {
      return authorizedMutation(sqlite, { workspaceId, boundRequest, plan, authorization, now, mutate: () => {
        const rows = viewRows(sqlite, workspaceId);
        for (const item of request.items) {
          const current = get(workspaceId, item.id);
          if (!current) throw new OrganizationViewNotFoundError();
          if (current.revision !== item.expectedRevision) throw new OrganizationViewConflictError();
        }
        const changed = new Set(rows.filter((row) => plan.orderedViewIds.indexOf(row.id) !== row.position).map((row) => row.id));
        rewritePositions(sqlite, workspaceId, plan.orderedViewIds, changed, now.getTime());
        return viewRows(sqlite, workspaceId).map(mapView);
      } });
    },
    remove({ workspaceId, viewId, request, boundRequest, plan, authorization, now }) {
      authorizedMutation(sqlite, { workspaceId, boundRequest, plan, authorization, now, mutate: () => {
        const rows = viewRows(sqlite, workspaceId);
        const target = rows.find((row) => row.id === viewId);
        if (!target) throw new OrganizationViewNotFoundError();
        if (target.revision !== request.expectedRevision) throw new OrganizationViewConflictError();
        sqlite.query("DELETE FROM organization_views WHERE workspace_id=? AND id=? AND revision=?").run(workspaceId, viewId, request.expectedRevision);
        const remaining = rows.filter((row) => row.id !== viewId);
        const changed = new Set(remaining.filter((row) => plan.orderedViewIds.indexOf(row.id) !== row.position).map((row) => row.id));
        rewritePositions(sqlite, workspaceId, plan.orderedViewIds, changed, now.getTime());
        return null;
      } });
    },
    validateDefinition({ scope, definition, authorization }) {
      return sqlite.transaction(() => {
        const authorizedScopeDigest = verifyQueryAuthorization(sqlite, scope, authorization);
        assertOwnedDefinition(sqlite, scope.workspaceId, definition, scope.accountIds);
        return { accountIds: [...(definition.accountIds ?? scope.accountIds)].sort(), authorizedScopeDigest };
      })();
    },
    resolveSelectedSenders({ scope, references, authorization }) {
      return sqlite.transaction(() => {
        verifyQueryAuthorization(sqlite, scope, authorization);
        const rows = selectedSenderRows(sqlite, scope.workspaceId, references);
        if (rows.length !== references.length || rows.some((row, ordinal) => row.ordinal !== ordinal)) {
          throw new OrganizationViewSelectionError("selection_reference_unavailable", "One or more selected messages is no longer available in this Workspace. Your selection was kept; refresh and try again.");
        }
        const authorizedAccounts = new Set(scope.accountIds);
        if (rows.some((row) => !authorizedAccounts.has(row.accountId))) throw new OrganizationViewAccessError();
        const accountIds = [...new Set(rows.map((row) => row.accountId))];
        if (accountIds.length !== 1) {
          throw new OrganizationViewSelectionError("mixed_account_selection", "Use these senders supports one connected account at a time. Your selection was kept.");
        }
        const addresses: string[] = [];
        const seen = new Set<string>();
        let omittedSelfCount = 0;
        for (const row of rows) {
          const address = row.fromAddress ?? "";
          const selfAddress = row.providerEmail;
          if (!address) throw new OrganizationViewSelectionError("selection_reference_unavailable", "A selected message no longer has a usable stored From address. Your selection was kept.");
          if (!organizationViewDefinitionSchema.safeParse({ revision: 1, sender: { addresses: [address] } }).success) {
            throw new OrganizationViewSelectionError("selection_reference_unavailable", "A selected message no longer has a usable stored From address. Your selection was kept.");
          }
          if (address === selfAddress) {
            omittedSelfCount += 1;
            continue;
          }
          if (seen.has(address)) continue;
          seen.add(address);
          addresses.push(address);
        }
        if (addresses.length === 0) {
          throw new OrganizationViewSelectionError("all_selected_senders_are_self", "Every selected message was sent by this connected account. Select at least one incoming sender.");
        }
        if (!organizationViewDefinitionSchema.safeParse({ revision: 1, accountIds, sender: { addresses } }).success) {
          throw new OrganizationViewSelectionError("selection_reference_unavailable", "A selected message no longer has a usable stored From address. Your selection was kept.");
        }
        return { accountId: accountIds[0]!, addresses, omittedSelfCount };
      })();
    },
    evaluate({ scope, definition, definitionDigest, resultSetKey, query, authorization }) {
      return sqlite.transaction(() => {
        const authorizedScopeDigest = verifyQueryAuthorization(sqlite, scope, authorization);
        assertOwnedDefinition(sqlite, scope.workspaceId, definition, scope.accountIds);
        const pageQuery = buildOrganizationViewPageKeyQuery({ scope, definition, definitionDigest, resultSetKey, authorizedScopeDigest, query });
        const pageKeys = sqlite.query(pageQuery.sql).all(...pageQuery.params) as OrganizationViewPageKey[];
        const hasMore = pageKeys.length > query.limit;
        const requestedKeys = pageKeys.slice(0, query.limit);
        const cumulativeCount = pageQuery.previouslyShown + requestedKeys.length;
        if (requestedKeys.length === 0) {
          return { accountIds: pageQuery.accountIds, items: [], nextCursor: null, limit: query.limit, count: { kind: "exact" as const, value: cumulativeCount }, authorizedScopeDigest };
        }

        const detailQuery = buildOrganizationViewDetailQuery(requestedKeys);
        const details = sqlite.query(detailQuery.sql).all(...detailQuery.params) as OrganizationViewDetailRow[];
        const detailsByKey = new Map(details.map((row) => [canonicalOrganizationJson([row.accountId, row.threadId]), row]));
        const items = requestedKeys.map((key) => {
          const row = detailsByKey.get(canonicalOrganizationJson([key.accountId, key.threadId]));
          if (!row) throw new Error(`View detail projection did not return ${key.accountId}:${key.threadId}`);
          return organizationViewResultItemSchema.parse({
            accountId: row.accountId, accountEmail: row.accountEmail, provider: row.provider, threadId: row.threadId, subject: row.subject,
            latestReceivedAt: iso(row.latestReceivedAt), messageCount: row.messageCount, readState: row.isRead ? "read" : "unread",
            primaryLaneId: row.primaryLaneId, sender: { name: row.senderName, email: row.senderEmail }, humanSignal: row.humanSignal,
            humanClassification: row.humanClassification,
          });
        });
        return {
          accountIds: pageQuery.accountIds,
          items,
          nextCursor: hasMore ? encodeCursor(items.at(-1)!, pageQuery.cursorFingerprint, cumulativeCount) : null,
          limit: query.limit,
          count: { kind: hasMore ? "shown" as const : "exact" as const, value: cumulativeCount },
          authorizedScopeDigest,
        };
      })();
    },
  };
}
