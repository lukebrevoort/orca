import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  orcaRuleCompileRequestSchema,
  orcaRuleCompileResponseSchema,
  orcaRuleRevisionListQuerySchema,
  orcaRuleRevisionListSchema,
  type OrcaRule,
  type OrcaRuleCompileRequest,
  type OrcaRuleCompileResponse,
  type OrcaRuleRevision,
  type OrcaRuleRevisionList,
  type OrcaRuleRevisionListQuery,
  type OrganizationActor,
  type OrganizationAuthorityDenialCode,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
} from "@orca/shared";

import { authorizeOrganizationOperation, canonicalOrganizationJson } from "../authority.ts";
import { compileOrcaRule, type OrcaWorkspaceSnapshot } from "./compiler.ts";

export class WorkspaceSchemaConflictError extends Error {
  readonly code = "workspace_schema_conflict";
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Workspace Schema revision ${expectedRevision} is stale; current revision is ${actualRevision}`);
  }
}
export class RuleRevisionConflictError extends Error {
  readonly code = "rule_revision_conflict";
  constructor(readonly expectedRevision: number | null, readonly actualRevision: number | null) {
    super(actualRevision === null ? "Rule is unavailable in this Workspace" : `Rule revision ${expectedRevision ?? "new"} is stale; current revision is ${actualRevision}`);
  }
}
export class RuleIdempotencyConflictError extends Error {
  readonly code = "duplicate_idempotency_key" as const;
  constructor(message = "Idempotency key was already used for a different Rule compilation") { super(message); }
}
export class RuleRevisionCursorError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor(message = "Rule revision cursor is malformed or does not match this history") { super(message); }
}
export class RuleRevisionCursorStaleError extends Error {
  readonly code = "stale_cursor" as const;
  constructor() { super("Rule revision history changed after this cursor was issued"); }
}
export class RuleAuthorityError extends Error {
  constructor(readonly code: OrganizationAuthorityDenialCode, message: string) { super(message); }
}

declare const ruleAuthorizationAnchorBrand: unique symbol;
export type RuleAuthorizationAnchor = Readonly<{ [ruleAuthorizationAnchorBrand]: true }>;
export type RulePersistenceIntent = Readonly<{
  request: OrcaRuleCompileRequest;
  changeId: string;
  command: OrganizationCommand;
  executionContext: OrganizationExecutionContext;
  authorityTrace: OrganizationAuthorityTrace;
  authorizationEnvelopeDigest: string;
  expectedWorkspaceSchemaRevision: number;
  expectedRuleRevision: number | null;
  rule: OrcaRule;
  revision: OrcaRuleRevision;
}>;
type RuleAuthorizationBinding = Readonly<{
  actor: OrganizationActor;
  workspaceId: string;
  accountIds: string[];
  authorizationEnvelopeDigest: string;
  persistenceIntentDigest: string;
}>;
const ruleAuthorizationAnchors = new WeakMap<object, RuleAuthorizationBinding>();

/** Canonically binds every caller-controlled field that can affect Rule authority or persistence. */
export function digestRulePersistenceIntent(input: RulePersistenceIntent): string {
  const intent: RulePersistenceIntent = {
    request: input.request,
    changeId: input.changeId,
    command: input.command,
    executionContext: input.executionContext,
    authorityTrace: input.authorityTrace,
    authorizationEnvelopeDigest: input.authorizationEnvelopeDigest,
    expectedWorkspaceSchemaRevision: input.expectedWorkspaceSchemaRevision,
    expectedRuleRevision: input.expectedRuleRevision,
    rule: input.rule,
    revision: input.revision,
  };
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(intent)).digest("hex")}`;
}

function issueRuleAuthorizationAnchor(binding: RuleAuthorizationBinding): RuleAuthorizationAnchor {
  const anchor = Object.freeze({}) as RuleAuthorizationAnchor;
  ruleAuthorizationAnchors.set(anchor, structuredClone(binding));
  return anchor;
}

/** Transaction adapters consume a service-issued authorization binding exactly once. */
export function consumeRuleAuthorizationAnchor(anchor: unknown): RuleAuthorizationBinding | null {
  if (typeof anchor !== "object" || anchor === null) return null;
  const binding = ruleAuthorizationAnchors.get(anchor);
  ruleAuthorizationAnchors.delete(anchor);
  return binding ? structuredClone(binding) : null;
}

export type RuleRevisionRepository = {
  loadWorkspaceSnapshot(workspaceId: string): OrcaWorkspaceSnapshot;
  getAuthorityState(workspaceId: string, lookup: { ruleId: string; idempotencyKey: string }): {
    accountIds: string[];
    workspaceRevision: number;
    resourceRevisions: Record<string, number>;
    idempotencyKeyReserved: boolean;
  };
  getIdempotent(workspaceId: string, idempotencyKey: string): {
    request: OrcaRuleCompileRequest;
    response: OrcaRuleCompileResponse & { ok: true };
  } | null;
  append(input: RulePersistenceIntent & {
    authorizationAnchor: RuleAuthorizationAnchor;
  }): OrcaRuleCompileResponse & { ok: true };
  getRule(workspaceId: string, ruleId: string): OrcaRule | null;
  listRevisions(workspaceId: string, ruleId: string, query: { afterRevision: number; throughRevision: number; limit: number }): OrcaRuleRevision[];
};

const ruleRevisionCursorSchema = z.object({
  v: z.literal(1),
  workspaceId: z.string().trim().min(1).max(200),
  ruleId: z.string().trim().min(1).max(200),
  afterRevision: z.number().int().positive(),
  headRevision: z.number().int().positive(),
}).strict();

function encodeRuleRevisionCursor(payload: z.infer<typeof ruleRevisionCursorSchema>): string {
  return Buffer.from(canonicalOrganizationJson(payload), "utf8").toString("base64url");
}

function decodeRuleRevisionCursor(cursor: string): z.infer<typeof ruleRevisionCursorSchema> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("non-canonical alphabet");
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== cursor) throw new Error("non-canonical encoding");
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
    const payload = ruleRevisionCursorSchema.parse(JSON.parse(json));
    if (canonicalOrganizationJson(payload) !== json || payload.afterRevision >= payload.headRevision) throw new Error("non-canonical payload");
    return payload;
  } catch {
    throw new RuleRevisionCursorError();
  }
}

export function createRuleRevisionService(repository: RuleRevisionRepository, options: {
  now?: () => Date;
  id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const capability = (actor: OrganizationActor, workspaceId: string, accountIds: string[]): OrganizationCapabilitySnapshot => ({
    id: `first_party:rule_compiler:${actor.type}:${actor.id}`,
    revision: 1,
    actor,
    scope: { workspaceId, accountIds },
    operations: ["query", "apply"],
    resourceFamilies: ["rule", "audit", "change_set"],
    actionFamilies: ["organization_read", "organization_structure"],
  });
  return {
    compile(input: { actor: OrganizationActor; workspaceId: string; request: unknown }): OrcaRuleCompileResponse {
      const request = orcaRuleCompileRequestSchema.parse(input.request);
      const replay = repository.getIdempotent(input.workspaceId, request.idempotencyKey);
      if (replay) {
        if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson(request)) throw new RuleIdempotencyConflictError();
        return replay.response;
      }
      const workspace = repository.loadWorkspaceSnapshot(input.workspaceId);
      if (request.workspaceSchemaRevision !== workspace.revision) {
        throw new WorkspaceSchemaConflictError(request.workspaceSchemaRevision, workspace.revision);
      }
      const compilation = compileOrcaRule({ source: request.source, workspace });
      if (!compilation.ok) return orcaRuleCompileResponseSchema.parse(compilation);

      const existing = request.ruleId ? repository.getRule(input.workspaceId, request.ruleId) : null;
      const actualRevision = existing?.latestRevision ?? null;
      if (request.expectedRuleRevision !== null && (!existing || actualRevision !== request.expectedRuleRevision)) {
        throw new RuleRevisionConflictError(request.expectedRuleRevision, actualRevision);
      }
      if (request.expectedRuleRevision === null && existing) throw new RuleRevisionConflictError(null, actualRevision);
      const timestamp = now().toISOString();
      const ruleId = existing?.id ?? request.ruleId ?? id();
      const revisionNumber = (actualRevision ?? 0) + 1;
      const rule: OrcaRule = {
        id: ruleId,
        workspaceId: input.workspaceId,
        name: compilation.revision.name,
        latestRevision: revisionNumber,
        activeRevisionId: existing?.activeRevisionId ?? null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const revision: OrcaRuleRevision = {
        id: id(),
        ruleId,
        workspaceId: input.workspaceId,
        revision: revisionNumber,
        source: request.source,
        sourceDigest: `sha256:${createHash("sha256").update(request.source).digest("hex")}`,
        compiled: compilation.revision,
        actor: input.actor,
        createdAt: timestamp,
      };
      const changeId = id();
      const command: OrganizationCommand = {
        id: changeId,
        intents: [{
          kind: "mutate_rule",
          resourceId: `rule:${ruleId}`,
          mutation: request.expectedRuleRevision === null ? "create" : "update",
          changes: { sourceDigest: revision.sourceDigest, revision: revisionNumber },
        }],
      };
      const live = repository.getAuthorityState(input.workspaceId, { ruleId, idempotencyKey: request.idempotencyKey });
      const granted = capability(input.actor, input.workspaceId, live.accountIds);
      const decision = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot: granted,
        operation: "apply",
        scope: granted.scope,
        command,
        expectedRevisions: {
          workspace: request.workspaceSchemaRevision,
          resources: request.expectedRuleRevision === null ? {} : { [`rule:${ruleId}`]: request.expectedRuleRevision },
        },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: granted.scope,
        capability: { snapshot: granted, revokedAt: null },
        workspaceRevision: live.workspaceRevision,
        resourceRevisions: live.resourceRevisions,
        reservedIdempotencyKeys: live.idempotencyKeyReserved ? [request.idempotencyKey] : [],
      });
      if (!decision.allowed) {
        if (decision.code === "duplicate_idempotency_key") throw new RuleIdempotencyConflictError(decision.reason);
        throw new RuleAuthorityError(decision.code, decision.reason);
      }
      const persistenceIntent: RulePersistenceIntent = {
        request,
        changeId,
        command,
        executionContext: decision.executionContext,
        authorityTrace: decision.trace,
        authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest,
        expectedWorkspaceSchemaRevision: request.workspaceSchemaRevision,
        expectedRuleRevision: request.expectedRuleRevision,
        rule,
        revision,
      };
      return repository.append({
        ...persistenceIntent,
        authorizationAnchor: issueRuleAuthorizationAnchor({
          actor: input.actor,
          workspaceId: input.workspaceId,
          accountIds: granted.scope.accountIds,
          authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest,
          persistenceIntentDigest: digestRulePersistenceIntent(persistenceIntent),
        }),
      });
    },
    get(input: { workspaceId: string; ruleId: string; query?: OrcaRuleRevisionListQuery }): OrcaRuleRevisionList {
      const query = orcaRuleRevisionListQuerySchema.parse(input.query ?? {});
      const rule = repository.getRule(input.workspaceId, input.ruleId);
      if (!rule) throw new RuleRevisionConflictError(null, null);
      let afterRevision = 0;
      if (query.cursor) {
        const cursor = decodeRuleRevisionCursor(query.cursor);
        if (cursor.workspaceId !== input.workspaceId || cursor.ruleId !== input.ruleId) throw new RuleRevisionCursorError();
        if (cursor.headRevision !== rule.latestRevision) throw new RuleRevisionCursorStaleError();
        afterRevision = cursor.afterRevision;
      }
      const rows = repository.listRevisions(input.workspaceId, input.ruleId, {
        afterRevision,
        throughRevision: rule.latestRevision,
        limit: query.limit + 1,
      });
      const revisions = rows.slice(0, query.limit);
      const last = revisions.at(-1);
      const nextCursor = rows.length > query.limit && last ? encodeRuleRevisionCursor({
        v: 1,
        workspaceId: input.workspaceId,
        ruleId: input.ruleId,
        afterRevision: last.revision,
        headRevision: rule.latestRevision,
      }) : null;
      return orcaRuleRevisionListSchema.parse({ rule, revisions, nextCursor, limit: query.limit });
    },
  };
}
