import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  orcaRuleCompileRequestSchema,
  orcaRuleCompileResponseSchema,
  orcaRuleRevisionListQuerySchema,
  orcaRuleRevisionListSchema,
  orcaRuleReorderRequestSchema,
  orcaRuleOrderResponseSchema,
  type OrcaRule,
  type OrcaRuleCompileRequest,
  type OrcaRuleCompileResponse,
  type OrcaRuleRevision,
  type OrcaRuleRevisionList,
  type OrcaRuleRevisionListQuery,
  type OrcaRuleReorderRequest,
  type OrcaRuleOrderResponse,
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
export class RuleSetRevisionConflictError extends Error {
  readonly code = "rule_set_revision_conflict" as const;
  constructor(readonly expectedRevision: number, readonly actualRevision: number) { super(`Rule Set revision ${expectedRevision} is stale; current revision is ${actualRevision}`); }
}
export class RuleOrderValidationError extends Error {
  readonly code = "validation_error" as const;
  constructor(message: string) { super(message); }
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
  orderPlan: RuleOrderMutationPlan | null;
}>;
export type RuleOrderState = Readonly<{
  revision: number;
  orderDigest: string;
  ruleCount: number;
  items: Array<{ id: string; position: number; revision: number }>;
}>;
export type RuleOrderMutationPlan = Readonly<{
  expected: RuleOrderState;
  orderedRuleIds: string[];
  targetOrderDigest: string;
}>;
export type RuleReorderPersistenceIntent = Readonly<{
  request: OrcaRuleReorderRequest;
  response: OrcaRuleOrderResponse;
  changeId: string;
  command: OrganizationCommand;
  executionContext: OrganizationExecutionContext;
  authorityTrace: OrganizationAuthorityTrace;
  authorizationEnvelopeDigest: string;
  plan: RuleOrderMutationPlan;
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
    orderPlan: input.orderPlan,
  };
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(intent)).digest("hex")}`;
}

/** Fixed-size deterministic digest shared with migration 0030's SQLite CTE. */
export function digestRuleOrder(orderedRuleIds: readonly string[]): string {
  const value = canonicalOrganizationJson(orderedRuleIds);
  const moduli = [2147483647, 2147483629, 2147483587, 2147483579, 2147483563, 2147483549, 2147483543, 2147483497];
  const multipliers = [131, 137, 139, 149, 151, 157, 163, 167];
  const hashes = [17, 29, 43, 59, 71, 89, 101, 127];
  for (const character of value) {
    const code = character.codePointAt(0)!;
    for (let index = 0; index < hashes.length; index += 1) hashes[index] = (hashes[index]! * multipliers[index]! + code) % moduli[index]!;
  }
  return `order-v1:${hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("")}`;
}

export function digestRuleReorderPersistenceIntent(input: RuleReorderPersistenceIntent): string {
  const intent: RuleReorderPersistenceIntent = {
    request: input.request, response: input.response, changeId: input.changeId, command: input.command,
    executionContext: input.executionContext, authorityTrace: input.authorityTrace,
    authorizationEnvelopeDigest: input.authorizationEnvelopeDigest, plan: input.plan,
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
  getOrder(workspaceId: string): RuleOrderState;
  getIdempotentReorder(workspaceId: string, idempotencyKey: string): { request: OrcaRuleReorderRequest; response: OrcaRuleOrderResponse } | null;
  append(input: RulePersistenceIntent & {
    authorizationAnchor: RuleAuthorizationAnchor;
  }): OrcaRuleCompileResponse & { ok: true };
  reorder(input: RuleReorderPersistenceIntent & { authorizationAnchor: RuleAuthorizationAnchor }): OrcaRuleOrderResponse;
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
      const currentOrder = repository.getOrder(input.workspaceId);
      const revisionNumber = (actualRevision ?? 0) + 1;
      const rule: OrcaRule = {
        id: ruleId,
        workspaceId: input.workspaceId,
        name: compilation.revision.name,
        latestRevision: revisionNumber,
        activeRevisionId: existing?.activeRevisionId ?? null,
        position: existing?.position ?? currentOrder.items.length,
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
      const orderedRuleIds = [...currentOrder.items.map(({ id: currentId }) => currentId), ...(existing ? [] : [ruleId])];
      const clientRequestDigest = `sha256:${createHash("sha256").update(canonicalOrganizationJson(request)).digest("hex")}`;
      const orderPlan: RuleOrderMutationPlan | null = existing ? null : {
        expected: currentOrder,
        orderedRuleIds,
        targetOrderDigest: digestRuleOrder(orderedRuleIds),
      };
      const command: OrganizationCommand = {
        id: changeId,
        intents: [{
          kind: "mutate_rule",
          resourceId: `rule:${ruleId}`,
          mutation: request.expectedRuleRevision === null ? "create" : "update",
          changes: { sourceDigest: revision.sourceDigest, revision: revisionNumber },
        }, ...(orderPlan ? [{
          kind: "mutate_rule" as const,
          resourceId: `rule_order:${input.workspaceId}`,
          mutation: "update" as const,
          changes: { clientRequestDigest, orderDigest: orderPlan.targetOrderDigest, ruleCount: orderedRuleIds.length, revision: currentOrder.revision + 1 },
        }] : [])],
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
          resources: request.expectedRuleRevision === null
            ? { [`rule_order:${input.workspaceId}`]: currentOrder.revision }
            : { [`rule:${ruleId}`]: request.expectedRuleRevision },
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
        orderPlan,
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
    reorder(input: { actor: OrganizationActor; workspaceId: string; request: unknown }): OrcaRuleOrderResponse {
      const request = orcaRuleReorderRequestSchema.parse(input.request);
      const replay = repository.getIdempotentReorder(input.workspaceId, request.idempotencyKey);
      if (replay) {
        if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson(request)) throw new RuleIdempotencyConflictError("Idempotency key was already used for a different Rule reorder");
        return replay.response;
      }
      if (input.actor.type !== "human") throw new RuleAuthorityError("actor_operation_denied", "Rule reorder requires an authenticated human session");
      const current = repository.getOrder(input.workspaceId);
      if (request.expectedRuleSetRevision !== current.revision) throw new RuleSetRevisionConflictError(request.expectedRuleSetRevision, current.revision);
      const byId = new Map(current.items.map((item) => [item.id, item]));
      for (const item of request.items) {
        const live = byId.get(item.id);
        if (!live) throw new RuleRevisionConflictError(item.expectedRevision, null);
        if (live.revision !== item.expectedRevision) throw new RuleRevisionConflictError(item.expectedRevision, live.revision);
        if (item.position >= current.items.length) throw new RuleOrderValidationError("Rule reorder positions must fit the complete Rule Set ordering");
      }
      const ordered = Array<string | undefined>(current.items.length);
      const requestedIds = new Set(request.items.map(({ id: requestedId }) => requestedId));
      for (const item of request.items) ordered[item.position] = item.id;
      const untouched = current.items.filter(({ id: currentId }) => !requestedIds.has(currentId)).map(({ id: currentId }) => currentId);
      for (let index = 0; index < ordered.length; index += 1) if (!ordered[index]) ordered[index] = untouched.shift();
      const orderedRuleIds = ordered as string[];
      const plan: RuleOrderMutationPlan = { expected: current, orderedRuleIds, targetOrderDigest: digestRuleOrder(orderedRuleIds) };
      const clientRequestDigest = `sha256:${createHash("sha256").update(canonicalOrganizationJson(request)).digest("hex")}`;
      const changeId = id();
      const command: OrganizationCommand = { id: changeId, intents: [{
        kind: "mutate_rule", resourceId: `rule_order:${input.workspaceId}`, mutation: "update",
        changes: { clientRequestDigest, orderDigest: plan.targetOrderDigest, ruleCount: orderedRuleIds.length, revision: current.revision + 1 },
      }] };
      const live = repository.getAuthorityState(input.workspaceId, { ruleId: request.items[0]!.id, idempotencyKey: request.idempotencyKey });
      const granted = capability(input.actor, input.workspaceId, live.accountIds);
      const decision = authorizeOrganizationOperation({
        actor: input.actor, capabilitySnapshot: granted, operation: "apply", scope: granted.scope, command,
        expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: { [`rule_order:${input.workspaceId}`]: request.expectedRuleSetRevision } },
        idempotencyKey: request.idempotencyKey,
      }, { scope: granted.scope, capability: { snapshot: granted, revokedAt: null }, workspaceRevision: live.workspaceRevision, resourceRevisions: live.resourceRevisions, reservedIdempotencyKeys: live.idempotencyKeyReserved ? [request.idempotencyKey] : [] });
      if (!decision.allowed) {
        if (decision.code === "duplicate_idempotency_key") throw new RuleIdempotencyConflictError(decision.reason);
        if (decision.code === "revision_conflict") throw new RuleSetRevisionConflictError(request.expectedRuleSetRevision, current.revision);
        throw new RuleAuthorityError(decision.code, decision.reason);
      }
      const response = orcaRuleOrderResponseSchema.parse({
        workspaceId: input.workspaceId, workspaceRevision: request.expectedWorkspaceRevision + 1,
        ruleSetRevision: current.revision + 1, orderDigest: plan.targetOrderDigest, ruleCount: orderedRuleIds.length,
        items: orderedRuleIds.map((ruleId, position) => ({ id: ruleId, position, revision: byId.get(ruleId)!.revision })),
      });
      const persistenceIntent: RuleReorderPersistenceIntent = { request, response, changeId, command, executionContext: decision.executionContext, authorityTrace: decision.trace, authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest, plan };
      return repository.reorder({ ...persistenceIntent, authorizationAnchor: issueRuleAuthorizationAnchor({ actor: input.actor, workspaceId: input.workspaceId, accountIds: granted.scope.accountIds, authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest, persistenceIntentDigest: digestRuleReorderPersistenceIntent(persistenceIntent) }) });
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
