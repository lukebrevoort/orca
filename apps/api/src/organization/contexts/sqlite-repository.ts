import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  organizationAuthorizationEnvelopeSchema,
  organizationAuthorityTraceSchema,
  organizationCommandSchema,
  organizationContextApplyRequestSchema,
  organizationContextChangeSummarySchema,
  organizationContextBounds,
  organizationContextSchema,
  organizationContextQueryResponseSchema,
  organizationContextRelationshipTypeSchema,
  organizationContextRevertRequestSchema,
  organizationContextScopeSchema,
  organizationContextThreadRevisionSchema,
  organizationContextTypeSchema,
  organizationThreadContextRelationshipSchema,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationContextActionKind,
  type OrganizationContextApplyRequest,
  type OrganizationContextChangeSummary,
  type OrganizationContextRevertRequest,
  type OrganizationExecutionContext,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationContextRelationshipTypes,
  organizationContexts,
  organizationContextTypes,
  organizationThreadContextRelationships,
  organizationThreadStates,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import {
  authorizeOrganizationOperation,
  canonicalOrganizationJson,
  digestOrganizationAuthorizationEnvelope,
  digestOrganizationCommand,
} from "../authority.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../module.ts";
import { isAgentOrganizationActor, isHumanOrganizationActor } from "../agent-capability.ts";
import {
  OrganizationContextsAccessError,
  OrganizationContextsConflictError,
  OrganizationContextsNotFoundError,
  applyOrganizationContextActions,
  consumeOrganizationContextAuthorizationAnchor,
  digestOrganizationContextActions,
  organizationContextsCapability,
  organizationContextResourceRevisions,
  type OrganizationContextAllocatedIds,
  type OrganizationContextSnapshot,
  type OrganizationContextsRepository,
} from "./module.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function iso(value: Date | null): string | null { return value?.toISOString() ?? null; }

function loadSnapshot(db: Database, workspaceId: string): OrganizationContextSnapshot {
  const accountIds = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
    .where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id)).all().map((row) => row.id);
  const state = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const contextTypes = db.select().from(organizationContextTypes).where(eq(organizationContextTypes.workspaceId, workspaceId))
    .orderBy(asc(organizationContextTypes.position), asc(organizationContextTypes.id)).all().map((row) => ({
      id: row.id, name: row.name, position: row.position, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const relationshipTypes = db.select().from(organizationContextRelationshipTypes).where(eq(organizationContextRelationshipTypes.workspaceId, workspaceId))
    .orderBy(asc(organizationContextRelationshipTypes.position), asc(organizationContextRelationshipTypes.id)).all().map((row) => ({
      id: row.id, contextTypeId: row.contextTypeId, name: row.name, inverseName: row.inverseName,
      direction: row.direction, position: row.position, maximumPerThread: row.maximumPerThread, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const contexts = db.select().from(organizationContexts).where(eq(organizationContexts.workspaceId, workspaceId))
    .orderBy(asc(organizationContexts.name), asc(organizationContexts.id)).all().map((row) => ({
      id: row.id, contextTypeId: row.contextTypeId, name: row.name, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const relationships = db.select().from(organizationThreadContextRelationships).where(eq(organizationThreadContextRelationships.workspaceId, workspaceId))
    .orderBy(asc(organizationThreadContextRelationships.relationshipTypeId), asc(organizationThreadContextRelationships.contextId), asc(organizationThreadContextRelationships.id)).all().map((row) => ({
      id: row.id, accountId: row.accountId, threadId: row.threadId, contextTypeId: row.contextTypeId, contextId: row.contextId,
      relationshipTypeId: row.relationshipTypeId, direction: row.direction, revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const threadRevisions = db.select().from(organizationThreadStates).where(eq(organizationThreadStates.workspaceId, workspaceId))
    .orderBy(asc(organizationThreadStates.accountId), asc(organizationThreadStates.threadId)).all().map((row) => ({ accountId: row.accountId, threadId: row.threadId, revision: row.revision }));
  const threadInventory = accountIds.length === 0 ? [] : db.select({ accountId: threads.accountId, threadId: threads.id }).from(threads)
    .where(inArray(threads.accountId, accountIds)).orderBy(asc(threads.accountId), asc(threads.id)).all();
  const parsed = organizationContextQueryResponseSchema.parse({ workspaceId, accountIds, workspaceRevision: state?.revision ?? 1, contextTypes, relationshipTypes, contexts, relationships, threadRevisions });
  return { ...parsed, threads: threadInventory };
}

type EvidenceKind = "context_type" | "relationship_type" | "context" | "relationship" | "thread";
type EvidenceValue =
  | OrganizationContextSnapshot["contextTypes"][number]
  | OrganizationContextSnapshot["relationshipTypes"][number]
  | OrganizationContextSnapshot["contexts"][number]
  | OrganizationContextSnapshot["relationships"][number]
  | OrganizationContextSnapshot["threadRevisions"][number];
type ResourceEvidence = {
  actionKind: EvidenceKind;
  resourceFamily: "context" | "thread";
  resourceId: string;
  before: EvidenceValue | null;
  after: EvidenceValue | null;
};

function collectEvidence(current: OrganizationContextSnapshot, next: OrganizationContextSnapshot): ResourceEvidence[] {
  const evidence: ResourceEvidence[] = [];
  const collect = <T extends EvidenceValue>(
    actionKind: EvidenceKind,
    resourceFamily: "context" | "thread",
    beforeItems: readonly T[],
    afterItems: readonly T[],
    key: (item: T) => string,
    resourceId: (item: T) => string,
  ) => {
    const beforeByKey = new Map(beforeItems.map((item) => [key(item), item]));
    const afterByKey = new Map(afterItems.map((item) => [key(item), item]));
    for (const itemKey of [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort()) {
      const before = beforeByKey.get(itemKey) ?? null;
      const after = afterByKey.get(itemKey) ?? null;
      if (canonicalOrganizationJson(before) === canonicalOrganizationJson(after)) continue;
      evidence.push({ actionKind, resourceFamily, resourceId: resourceId((after ?? before)!), before, after });
    }
  };
  collect("context_type", "context", current.contextTypes, next.contextTypes, (item) => item.id, (item) => `context_type:${item.id}`);
  collect("relationship_type", "context", current.relationshipTypes, next.relationshipTypes, (item) => item.id, (item) => `context_relationship_type:${item.id}`);
  collect("context", "context", current.contexts, next.contexts, (item) => item.id, (item) => `context:${item.id}`);
  collect("relationship", "context", current.relationships, next.relationships, (item) => item.id, (item) => `context_relationship:${item.id}`);
  collect("thread", "thread", current.threadRevisions, next.threadRevisions, (item) => `${item.accountId}\0${item.threadId}`, (item) => `thread:${item.accountId}:${item.threadId}`);
  return evidence;
}

function parseEvidenceValue(kind: EvidenceKind, value: string | null): EvidenceValue | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (kind === "context_type") return organizationContextTypeSchema.parse(parsed);
  if (kind === "relationship_type") return organizationContextRelationshipTypeSchema.parse(parsed);
  if (kind === "context") return organizationContextSchema.parse(parsed);
  if (kind === "relationship") return organizationThreadContextRelationshipSchema.parse(parsed);
  return organizationContextThreadRevisionSchema.parse(parsed);
}

function evidenceResourceId(kind: EvidenceKind, value: EvidenceValue): string {
  if (kind === "context_type") return `context_type:${(value as OrganizationContextSnapshot["contextTypes"][number]).id}`;
  if (kind === "relationship_type") return `context_relationship_type:${(value as OrganizationContextSnapshot["relationshipTypes"][number]).id}`;
  if (kind === "context") return `context:${(value as OrganizationContextSnapshot["contexts"][number]).id}`;
  if (kind === "relationship") return `context_relationship:${(value as OrganizationContextSnapshot["relationships"][number]).id}`;
  const thread = value as OrganizationContextSnapshot["threadRevisions"][number];
  return `thread:${thread.accountId}:${thread.threadId}`;
}

function parseTrace(value: string): OrganizationAuthorityTrace {
  return organizationAuthorityTraceSchema.parse(JSON.parse(value));
}

function parseCommandJson(value: string): { request?: OrganizationContextApplyRequest; allocatedIds?: OrganizationContextAllocatedIds; revert?: OrganizationContextRevertRequest } {
  return JSON.parse(value) as { request?: OrganizationContextApplyRequest; allocatedIds?: OrganizationContextAllocatedIds; revert?: OrganizationContextRevertRequest };
}

function summary(db: Database, row: typeof organizationChangeSets.$inferSelect): OrganizationContextChangeSummary {
  const command = parseCommandJson(row.commandJson);
  let actionKinds: OrganizationContextActionKind[] = command.request?.actions.map((action) => action.kind) ?? [];
  if (actionKinds.length === 0 && row.revertsChangeId) {
    const original = db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, row.workspaceId), eq(organizationChangeSets.id, row.revertsChangeId))).get();
    actionKinds = original ? (parseCommandJson(original.commandJson).request?.actions.map((action) => action.kind) ?? []) : [];
  }
  const reverted = db.select({ id: organizationChangeSets.id }).from(organizationChangeSets)
    .where(and(eq(organizationChangeSets.workspaceId, row.workspaceId), eq(organizationChangeSets.revertsChangeId, row.id))).get();
  return organizationContextChangeSummarySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    actor: parseTrace(row.authorityTrace).actor,
    operation: row.operation,
    actionKinds,
    reason: row.operation === "revert" ? `Reverted Context change ${row.revertsChangeId}` : `Applied ${actionKinds.length} typed Context action${actionKinds.length === 1 ? "" : "s"}`,
    revertsChangeId: row.revertsChangeId,
    revertedByChangeId: reverted?.id ?? null,
    workspaceRevisionBefore: row.workspaceRevisionBefore,
    workspaceRevisionAfter: row.workspaceRevisionAfter,
    createdAt: row.createdAt.toISOString(),
  });
}

function assertBoundCommand(input: {
  command: OrganizationCommand;
  executionContext: OrganizationExecutionContext;
  actions?: readonly OrganizationContextApplyRequest["actions"][number][];
  allocatedIds?: OrganizationContextAllocatedIds;
}) {
  if (input.executionContext.command.digest !== digestOrganizationCommand(input.command)) {
    throw new OrganizationAuthorityError("invalid_request", "The authorized command digest does not match the Context execution payload");
  }
  if (input.actions) {
    const typedDigest = digestOrganizationContextActions(input.actions);
    const expectedAllocated = input.command.intents[0]?.changes?.allocatedIdsDigest;
    const actualAllocated = `sha256:${createHash("sha256").update(canonicalOrganizationJson(input.allocatedIds ?? [])).digest("hex")}`;
    if (input.command.intents.some((intent) => intent.changes?.typedActionsDigest !== typedDigest || intent.changes?.allocatedIdsDigest !== expectedAllocated || intent.changes?.actionCount !== input.actions!.length) || expectedAllocated !== actualAllocated) {
      throw new OrganizationAuthorityError("invalid_request", "The authorized command does not match the exact ordered typed Context actions and server identities");
    }
  }
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`;
}

function assertAuthorizedEnvelope(db: Database, input: {
  request: OrganizationContextApplyRequest | OrganizationContextRevertRequest;
  scope: Parameters<OrganizationContextsRepository["apply"]>[0]["scope"];
  executionContext: OrganizationExecutionContext;
  authorityTrace: OrganizationAuthorityTrace;
  command: OrganizationCommand;
  changeId: string;
  operation: "apply" | "revert";
  authorizationEnvelopeDigest: string;
  anchoredAuthorization: NonNullable<ReturnType<typeof consumeOrganizationContextAuthorizationAnchor>>;
}): {
  workspaceId: string;
  expectedWorkspaceRevision: number;
  idempotencyKey: string;
  request: OrganizationContextApplyRequest | OrganizationContextRevertRequest;
  executionContext: OrganizationExecutionContext;
  authorityTrace: OrganizationAuthorityTrace;
  command: OrganizationCommand;
  current: OrganizationContextSnapshot;
} {
  const scopeResult = organizationContextScopeSchema.safeParse(input.scope);
  const requestResult = input.operation === "apply"
    ? organizationContextApplyRequestSchema.safeParse(input.request)
    : organizationContextRevertRequestSchema.safeParse(input.request);
  const commandResult = organizationCommandSchema.safeParse(input.command);
  const envelopeResult = organizationAuthorizationEnvelopeSchema.safeParse({
    executionContext: input.executionContext,
    trace: input.authorityTrace,
  });
  if (!scopeResult.success || !requestResult.success || !commandResult.success || !envelopeResult.success) {
    throw new OrganizationAuthorityError("invalid_request", "The Context authorization envelope failed runtime validation");
  }

  const scope = scopeResult.data;
  const request = requestResult.data;
  const command = commandResult.data;
  const suppliedEnvelope = envelopeResult.data;
  const suppliedDigest = digestOrganizationAuthorizationEnvelope(suppliedEnvelope);
  if (suppliedDigest !== input.authorizationEnvelopeDigest
    || input.authorizationEnvelopeDigest !== input.anchoredAuthorization.authorizationEnvelopeDigest
    || canonicalOrganizationJson(scope) !== canonicalOrganizationJson(input.anchoredAuthorization.scope)
    || suppliedEnvelope.executionContext.operation !== input.operation
    || suppliedEnvelope.trace.operation !== input.operation
    || request.expectedWorkspaceRevision !== suppliedEnvelope.executionContext.expectedRevisions.workspace
    || request.idempotencyKey !== suppliedEnvelope.executionContext.idempotencyKey
    || canonicalOrganizationJson(scope.actor) !== canonicalOrganizationJson(suppliedEnvelope.executionContext.actor)
    || scope.workspaceId !== suppliedEnvelope.executionContext.workspaceId
    || canonicalOrganizationJson([...scope.accountIds].sort()) !== canonicalOrganizationJson([...suppliedEnvelope.executionContext.accountIds].sort())
    || input.changeId !== command.id) {
    throw new OrganizationAuthorityError("invalid_request", "The Context request envelope does not match the authorized execution context");
  }
  const current = loadSnapshot(db, scope.workspaceId);
  const liveAccountIds = new Set(current.accountIds);
  if (scope.accountIds.some((accountId) => !liveAccountIds.has(accountId))) {
    throw new OrganizationAuthorityError("account_denied", "The Context authorization scope is not currently owned");
  }
  let liveCapability;
  if (isHumanOrganizationActor(scope.actor)) {
    if (scope.actor.id !== scope.workspaceId) {
      throw new OrganizationAuthorityError("account_denied", "The Context authorization scope is not currently owned");
    }
    liveCapability = { snapshot: organizationContextsCapability(scope), revokedAt: null };
  } else {
    if (!isAgentOrganizationActor(scope.actor)) {
      throw new OrganizationAuthorityError("account_denied", "Only an authenticated human or external agent can authorize Context writes");
    }
    const source = input.anchoredAuthorization.agentCapabilitySource;
    liveCapability = source?.load({
      actor: scope.actor,
      workspaceId: scope.workspaceId,
      accountIds: scope.accountIds,
    }) ?? null;
    if (!liveCapability) {
      throw new OrganizationAuthorityError("account_denied", "The external-agent Context Capability is unavailable or revoked");
    }
  }
  const resourceRevisions = organizationContextResourceRevisions(current);
  const expectedResources = Object.fromEntries(command.intents.flatMap((intent) => {
    if (intent.mutation !== "update") return [];
    const revision = resourceRevisions[intent.resourceId];
    return revision === undefined ? [] : [[intent.resourceId, revision]];
  }));
  const capability = liveCapability.snapshot;
  const reservedIdempotencyKeys = db.select({ key: organizationChangeSets.idempotencyKey })
    .from(organizationChangeSets)
    .where(eq(organizationChangeSets.workspaceId, scope.workspaceId))
    .all()
    .map((row) => row.key);
  const decision = authorizeOrganizationOperation({
    actor: scope.actor,
    capabilitySnapshot: capability,
    operation: input.operation,
    scope: capability.scope,
    command,
    expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
    idempotencyKey: request.idempotencyKey,
  }, {
    scope: capability.scope,
    capability: liveCapability,
    workspaceRevision: current.workspaceRevision,
    resourceRevisions,
    reservedIdempotencyKeys,
  });
  if (!decision.allowed) throw new OrganizationAuthorityError(decision.code, decision.reason);

  if (input.authorizationEnvelopeDigest !== decision.authorizationEnvelopeDigest
    || suppliedDigest !== decision.authorizationEnvelopeDigest) {
    throw new OrganizationAuthorityError("invalid_request", "The Context request envelope does not match the authorized execution context");
  }
  if (input.operation === "revert") {
    const revertRequest = request as OrganizationContextRevertRequest;
    const intent = command.intents[0];
    if (command.intents.length !== 1
      || intent?.kind !== "mutate_context"
      || intent.resourceId !== `context_change:${revertRequest.changeId}`
      || intent.mutation !== "create"
      || intent.changes?.action !== "revert"
      || intent.changes?.requestDigest !== canonicalDigest(revertRequest)) {
      throw new OrganizationAuthorityError("invalid_request", "The Context revert request does not match the authorized command");
    }
  }
  const expectedWorkspaceRevision = decision.executionContext.expectedRevisions.workspace;
  const idempotencyKey = decision.executionContext.idempotencyKey;
  if (expectedWorkspaceRevision === null || idempotencyKey === null) {
    throw new OrganizationAuthorityError("invalid_request", "Context writes require a bound revision and idempotency reservation");
  }
  return {
    workspaceId: decision.executionContext.workspaceId,
    expectedWorkspaceRevision,
    idempotencyKey,
    request,
    executionContext: decision.executionContext,
    authorityTrace: decision.trace,
    command,
    current,
  };
}

function assertLiveResources(current: OrganizationContextSnapshot, executionContext: OrganizationExecutionContext, command: OrganizationCommand) {
  const live = organizationContextResourceRevisions(current);
  for (const intent of command.intents) {
    if (intent.mutation === "create" && live[intent.resourceId] !== undefined) throw new OrganizationAuthorityError("revision_conflict", `Create target ${intent.resourceId} now exists`);
    if (intent.mutation === "update" && live[intent.resourceId] !== executionContext.expectedRevisions.resources[intent.resourceId]) throw new OrganizationAuthorityError("revision_conflict", `Update target ${intent.resourceId} changed before commit`);
  }
}

function reserveChange(db: Database, input: {
  workspaceId: string;
  changeId: string;
  idempotencyKey: string;
  commandDigest: string;
  authorityTrace: OrganizationAuthorityTrace;
  operation: "apply" | "revert";
  commandJson: unknown;
  revertsChangeId: string | null;
  workspaceRevisionBefore: number;
  workspaceRevisionAfter: number;
  evidence: readonly ResourceEvidence[];
  now: Date;
}) {
  db.insert(organizationChangeSets).values({
    workspaceId: input.workspaceId, id: input.changeId, idempotencyKey: input.idempotencyKey,
    commandDigest: input.commandDigest, authorityTrace: JSON.stringify(input.authorityTrace), resourceFamily: "context",
    operation: input.operation, commandJson: JSON.stringify(input.commandJson), revertsChangeId: input.revertsChangeId,
    workspaceRevisionBefore: input.workspaceRevisionBefore, workspaceRevisionAfter: input.workspaceRevisionAfter, createdAt: input.now,
  }).run();
  for (const [position, evidence] of input.evidence.entries()) {
    db.insert(organizationChangeActions).values({
      workspaceId: input.workspaceId,
      changeId: input.changeId,
      position,
      actionKind: evidence.actionKind,
      resourceFamily: evidence.resourceFamily,
      resourceId: evidence.resourceId,
      beforeJson: evidence.before === null ? null : JSON.stringify(evidence.before),
      afterJson: evidence.after === null ? null : JSON.stringify(evidence.after),
    }).run();
  }
}

function writeSnapshot(db: Database, workspaceId: string, current: OrganizationContextSnapshot, next: OrganizationContextSnapshot, now: Date) {
  const currentTypes = new Map(current.contextTypes.map((item) => [item.id, item]));
  for (const item of next.contextTypes) {
    if (!currentTypes.has(item.id)) db.insert(organizationContextTypes).values({ workspaceId, id: item.id, name: item.name, position: item.position, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) }).run();
    else db.update(organizationContextTypes).set({ name: item.name, position: item.position, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContextTypes.workspaceId, workspaceId), eq(organizationContextTypes.id, item.id))).run();
  }
  for (const item of current.contextTypes) if (!next.contextTypes.some((candidate) => candidate.id === item.id)) db.delete(organizationContextTypes).where(and(eq(organizationContextTypes.workspaceId, workspaceId), eq(organizationContextTypes.id, item.id))).run();

  const currentRelationshipTypes = new Set(current.relationshipTypes.map((item) => item.id));
  for (const item of next.relationshipTypes) {
    const values = { workspaceId, id: item.id, contextTypeId: item.contextTypeId, name: item.name, inverseName: item.inverseName, direction: item.direction, position: item.position, maximumPerThread: item.maximumPerThread, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentRelationshipTypes.has(item.id)) db.insert(organizationContextRelationshipTypes).values(values).run();
    else db.update(organizationContextRelationshipTypes).set({ contextTypeId: item.contextTypeId, name: item.name, inverseName: item.inverseName, direction: item.direction, position: item.position, maximumPerThread: item.maximumPerThread, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContextRelationshipTypes.workspaceId, workspaceId), eq(organizationContextRelationshipTypes.id, item.id))).run();
  }
  for (const item of current.relationshipTypes) if (!next.relationshipTypes.some((candidate) => candidate.id === item.id)) db.delete(organizationContextRelationshipTypes).where(and(eq(organizationContextRelationshipTypes.workspaceId, workspaceId), eq(organizationContextRelationshipTypes.id, item.id))).run();

  const currentContexts = new Set(current.contexts.map((item) => item.id));
  for (const item of next.contexts) {
    const values = { workspaceId, id: item.id, contextTypeId: item.contextTypeId, name: item.name, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentContexts.has(item.id)) db.insert(organizationContexts).values(values).run();
    else db.update(organizationContexts).set({ contextTypeId: item.contextTypeId, name: item.name, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContexts.workspaceId, workspaceId), eq(organizationContexts.id, item.id))).run();
  }
  for (const item of current.contexts) if (!next.contexts.some((candidate) => candidate.id === item.id)) db.delete(organizationContexts).where(and(eq(organizationContexts.workspaceId, workspaceId), eq(organizationContexts.id, item.id))).run();

  const currentRelationships = new Set(current.relationships.map((item) => item.id));
  for (const item of next.relationships) {
    const values = { workspaceId, id: item.id, accountId: item.accountId, threadId: item.threadId, contextTypeId: item.contextTypeId, contextId: item.contextId, relationshipTypeId: item.relationshipTypeId, direction: item.direction, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentRelationships.has(item.id)) db.insert(organizationThreadContextRelationships).values(values).run();
    else db.update(organizationThreadContextRelationships).set({ accountId: item.accountId, threadId: item.threadId, contextTypeId: item.contextTypeId, contextId: item.contextId, relationshipTypeId: item.relationshipTypeId, direction: item.direction, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationThreadContextRelationships.workspaceId, workspaceId), eq(organizationThreadContextRelationships.id, item.id))).run();
  }
  for (const item of current.relationships) if (!next.relationships.some((candidate) => candidate.id === item.id)) db.delete(organizationThreadContextRelationships).where(and(eq(organizationThreadContextRelationships.workspaceId, workspaceId), eq(organizationThreadContextRelationships.id, item.id))).run();

  const nextThreadKeys = new Set(next.threadRevisions.map((item) => `${item.accountId}\0${item.threadId}`));
  for (const item of next.threadRevisions) db.insert(organizationThreadStates).values({ workspaceId, accountId: item.accountId, threadId: item.threadId, revision: item.revision, updatedAt: now }).onConflictDoUpdate({ target: [organizationThreadStates.workspaceId, organizationThreadStates.accountId, organizationThreadStates.threadId], set: { revision: item.revision, updatedAt: now } }).run();
  for (const item of current.threadRevisions) if (!nextThreadKeys.has(`${item.accountId}\0${item.threadId}`)) db.delete(organizationThreadStates).where(and(eq(organizationThreadStates.workspaceId, workspaceId), eq(organizationThreadStates.accountId, item.accountId), eq(organizationThreadStates.threadId, item.threadId))).run();
}

function evidenceResource(snapshot: OrganizationContextSnapshot, evidence: ResourceEvidence): EvidenceValue | null {
  const identity = evidence.after ?? evidence.before;
  if (!identity) throw new OrganizationContextsConflictError("Context change evidence has no resource identity");
  if (evidence.actionKind === "context_type") return snapshot.contextTypes.find((item) => item.id === (identity as OrganizationContextSnapshot["contextTypes"][number]).id) ?? null;
  if (evidence.actionKind === "relationship_type") return snapshot.relationshipTypes.find((item) => item.id === (identity as OrganizationContextSnapshot["relationshipTypes"][number]).id) ?? null;
  if (evidence.actionKind === "context") return snapshot.contexts.find((item) => item.id === (identity as OrganizationContextSnapshot["contexts"][number]).id) ?? null;
  if (evidence.actionKind === "relationship") return snapshot.relationships.find((item) => item.id === (identity as OrganizationContextSnapshot["relationships"][number]).id) ?? null;
  const thread = identity as OrganizationContextSnapshot["threadRevisions"][number];
  return snapshot.threadRevisions.find((item) => item.accountId === thread.accountId && item.threadId === thread.threadId) ?? null;
}

function replaceEvidenceResource(snapshot: OrganizationContextSnapshot, evidence: ResourceEvidence, current: EvidenceValue | null, now: string) {
  const before = evidence.before;
  if (evidence.actionKind === "context_type") {
    const identity = (evidence.after ?? before) as OrganizationContextSnapshot["contextTypes"][number];
    snapshot.contextTypes = snapshot.contextTypes.filter((item) => item.id !== identity.id);
    if (before) snapshot.contextTypes.push({ ...(before as OrganizationContextSnapshot["contextTypes"][number]), revision: (current?.revision ?? before.revision) + 1, updatedAt: now });
    return;
  }
  if (evidence.actionKind === "relationship_type") {
    const identity = (evidence.after ?? before) as OrganizationContextSnapshot["relationshipTypes"][number];
    snapshot.relationshipTypes = snapshot.relationshipTypes.filter((item) => item.id !== identity.id);
    if (before) snapshot.relationshipTypes.push({ ...(before as OrganizationContextSnapshot["relationshipTypes"][number]), revision: (current?.revision ?? before.revision) + 1, updatedAt: now });
    return;
  }
  if (evidence.actionKind === "context") {
    const identity = (evidence.after ?? before) as OrganizationContextSnapshot["contexts"][number];
    snapshot.contexts = snapshot.contexts.filter((item) => item.id !== identity.id);
    if (before) snapshot.contexts.push({ ...(before as OrganizationContextSnapshot["contexts"][number]), revision: (current?.revision ?? before.revision) + 1, updatedAt: now });
    return;
  }
  if (evidence.actionKind === "relationship") {
    const identity = (evidence.after ?? before) as OrganizationContextSnapshot["relationships"][number];
    snapshot.relationships = snapshot.relationships.filter((item) => item.id !== identity.id);
    if (before) snapshot.relationships.push({ ...(before as OrganizationContextSnapshot["relationships"][number]), revision: (current?.revision ?? before.revision) + 1, updatedAt: now });
    return;
  }
  const identity = (evidence.after ?? before) as OrganizationContextSnapshot["threadRevisions"][number];
  snapshot.threadRevisions = snapshot.threadRevisions.filter((item) => item.accountId !== identity.accountId || item.threadId !== identity.threadId);
  const prior = before as OrganizationContextSnapshot["threadRevisions"][number] | null;
  const live = current as OrganizationContextSnapshot["threadRevisions"][number] | null;
  snapshot.threadRevisions.push({ accountId: identity.accountId, threadId: identity.threadId, revision: (live?.revision ?? prior?.revision ?? 0) + 1 });
}

function assertCompensatedSnapshot(snapshot: OrganizationContextSnapshot) {
  const contextTypeIds = new Set(snapshot.contextTypes.map((item) => item.id));
  const relationshipTypes = new Map(snapshot.relationshipTypes.map((item) => [item.id, item]));
  const contexts = new Map(snapshot.contexts.map((item) => [item.id, item]));
  const threadInventory = new Set(snapshot.threads.map((item) => `${item.accountId}\0${item.threadId}`));
  const unique = (values: readonly string[], label: string) => {
    if (new Set(values).size !== values.length) throw new OrganizationContextsConflictError(`A later Context change now conflicts with the prior ${label}`);
  };
  unique(snapshot.contextTypes.map((item) => item.name.trim().toLocaleLowerCase()), "Context Type name");
  unique(snapshot.contextTypes.map((item) => String(item.position)), "Context Type position");
  for (const contextType of snapshot.contextTypes) {
    const typedRelationships = snapshot.relationshipTypes.filter((item) => item.contextTypeId === contextType.id);
    const typedContexts = snapshot.contexts.filter((item) => item.contextTypeId === contextType.id);
    unique(typedRelationships.map((item) => item.name.trim().toLocaleLowerCase()), "Relationship Type name");
    unique(typedRelationships.map((item) => String(item.position)), "Relationship Type position");
    unique(typedContexts.map((item) => item.name.trim().toLocaleLowerCase()), "Context name");
  }
  if (snapshot.relationshipTypes.some((item) => !contextTypeIds.has(item.contextTypeId)) || snapshot.contexts.some((item) => !contextTypeIds.has(item.contextTypeId))) {
    throw new OrganizationContextsConflictError("A later Context dependency prevents this causal revert");
  }
  const threadCounts = new Map<string, number>();
  const typedThreadCounts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  const edgeKeys = new Set<string>();
  for (const relationship of snapshot.relationships) {
    const context = contexts.get(relationship.contextId);
    const relationshipType = relationshipTypes.get(relationship.relationshipTypeId);
    if (!context || !relationshipType || context.contextTypeId !== relationship.contextTypeId || relationshipType.contextTypeId !== relationship.contextTypeId || relationshipType.direction !== relationship.direction || !threadInventory.has(`${relationship.accountId}\0${relationship.threadId}`)) {
      throw new OrganizationContextsConflictError("A later Context relationship dependency prevents this causal revert");
    }
    const edgeKey = `${relationship.accountId}\0${relationship.threadId}\0${relationship.contextId}\0${relationship.relationshipTypeId}`;
    if (edgeKeys.has(edgeKey)) throw new OrganizationContextsConflictError("A later duplicate Context relationship prevents this causal revert");
    edgeKeys.add(edgeKey);
    const threadKey = `${relationship.accountId}\0${relationship.threadId}`;
    const typedThreadKey = `${threadKey}\0${relationship.relationshipTypeId}`;
    threadCounts.set(threadKey, (threadCounts.get(threadKey) ?? 0) + 1);
    typedThreadCounts.set(typedThreadKey, (typedThreadCounts.get(typedThreadKey) ?? 0) + 1);
    contextCounts.set(relationship.contextId, (contextCounts.get(relationship.contextId) ?? 0) + 1);
    if (threadCounts.get(threadKey)! > organizationContextBounds.maximumRelationshipsPerThread
      || typedThreadCounts.get(typedThreadKey)! > relationshipType.maximumPerThread
      || contextCounts.get(relationship.contextId)! > organizationContextBounds.maximumRelationshipsPerContext) {
      throw new OrganizationContextsConflictError("A later Context fan-out change prevents this causal revert");
    }
  }
}

function causalCompensation(current: OrganizationContextSnapshot, evidence: readonly ResourceEvidence[], now: string): OrganizationContextSnapshot {
  const next = structuredClone(current);
  for (const item of evidence) {
    const live = evidenceResource(current, item);
    if (canonicalOrganizationJson(live) !== canonicalOrganizationJson(item.after)) {
      throw new OrganizationContextsConflictError(`Context resource ${item.resourceId} changed after the requested change`);
    }
    replaceEvidenceResource(next, item, live, now);
  }
  next.workspaceRevision = current.workspaceRevision + 1;
  next.threads = current.threads;
  assertCompensatedSnapshot(next);
  return next;
}

export function createSqliteOrganizationContextsRepository(db: Database): OrganizationContextsRepository {
  return {
    listAccountIds(workspaceId) {
      return db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id)).all().map((row) => row.id);
    },
    getSnapshot(workspaceId) { return loadSnapshot(db, workspaceId); },
    getAuthorityState(workspaceId) {
      const snapshot = loadSnapshot(db, workspaceId);
      return {
        workspaceRevision: snapshot.workspaceRevision,
        resourceRevisions: organizationContextResourceRevisions(snapshot),
        reservedIdempotencyKeys: db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets).where(eq(organizationChangeSets.workspaceId, workspaceId)).all().map((row) => row.key),
      };
    },
    getIdempotentChange(workspaceId, idempotencyKey) {
      const row = db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get();
      if (!row || row.resourceFamily !== "context") return null;
      const command = parseCommandJson(row.commandJson);
      const request = command.request ?? (command.revert ? { revert: command.revert } : null);
      return request ? { request, change: summary(db, row) } : null;
    },
    apply(input) {
      const anchoredAuthorization = consumeOrganizationContextAuthorizationAnchor(input.authorization.authorizationAnchor);
      if (!anchoredAuthorization) throw new OrganizationAuthorityError("invalid_request", "The authenticated Context authorization anchor is missing or expired");
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const authorized = assertAuthorizedEnvelope(executor, { request: input.request, scope: input.scope, executionContext: input.authorization.executionContext, authorityTrace: input.authorization.trace, authorizationEnvelopeDigest: input.authorization.authorizationEnvelopeDigest, anchoredAuthorization, command: input.authorization.command, changeId: input.changeId, operation: "apply" });
        const { workspaceId, expectedWorkspaceRevision, idempotencyKey, executionContext, authorityTrace, command, current } = authorized;
        const request = organizationContextApplyRequestSchema.parse(authorized.request);
        assertBoundCommand({ command, executionContext, actions: request.actions, allocatedIds: input.allocatedIds });
        if (current.workspaceRevision !== expectedWorkspaceRevision) throw new OrganizationRevisionConflictError(expectedWorkspaceRevision, current.workspaceRevision);
        assertLiveResources(current, executionContext, command);
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get()) throw new OrganizationContextsConflictError("The idempotency key is already reserved");
        const next = applyOrganizationContextActions({ snapshot: current, actions: request.actions, allocatedIds: input.allocatedIds, authorizedAccountIds: executionContext.accountIds, now: input.now.toISOString() });
        transaction.insert(organizationWorkspaceStates).values({ workspaceId }).onConflictDoNothing().run();
        writeSnapshot(executor, workspaceId, current, next, input.now);
        reserveChange(executor, { workspaceId, changeId: input.changeId, idempotencyKey, commandDigest: executionContext.command.digest, authorityTrace, operation: "apply", commandJson: { request, allocatedIds: input.allocatedIds }, revertsChangeId: null, workspaceRevisionBefore: current.workspaceRevision, workspaceRevisionAfter: next.workspaceRevision, evidence: collectEvidence(current, next), now: input.now });
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.workspaceRevision, updatedAt: input.now }).where(and(eq(organizationWorkspaceStates.workspaceId, workspaceId), eq(organizationWorkspaceStates.revision, current.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.workspaceRevision, current.workspaceRevision + 1);
        return { snapshot: next, change: summary(executor, transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.id, input.changeId))).get()!) };
      });
    },
    revert(input) {
      const anchoredAuthorization = consumeOrganizationContextAuthorizationAnchor(input.authorization.authorizationAnchor);
      if (!anchoredAuthorization) throw new OrganizationAuthorityError("invalid_request", "The authenticated Context authorization anchor is missing or expired");
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const authorized = assertAuthorizedEnvelope(executor, { request: input.request, scope: input.scope, executionContext: input.authorization.executionContext, authorityTrace: input.authorization.trace, authorizationEnvelopeDigest: input.authorization.authorizationEnvelopeDigest, anchoredAuthorization, command: input.authorization.command, changeId: input.changeId, operation: "revert" });
        const { workspaceId, expectedWorkspaceRevision, idempotencyKey, executionContext, authorityTrace, command, current } = authorized;
        const request = organizationContextRevertRequestSchema.parse(authorized.request);
        assertBoundCommand({ command, executionContext });
        const original = transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.id, request.changeId), eq(organizationChangeSets.resourceFamily, "context"))).get();
        if (!original) throw new OrganizationContextsNotFoundError("Context change was not found in this Workspace");
        if (original.operation !== "apply") throw new OrganizationContextsConflictError("Only an applied Context change can be reverted");
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.revertsChangeId, original.id))).get()) throw new OrganizationContextsConflictError("Context change was already reverted");
        const evidenceRows = transaction.select().from(organizationChangeActions).where(and(eq(organizationChangeActions.workspaceId, workspaceId), eq(organizationChangeActions.changeId, original.id))).orderBy(asc(organizationChangeActions.position)).all();
        const evidence = evidenceRows.map((row): ResourceEvidence => {
          if (!["context_type", "relationship_type", "context", "relationship", "thread"].includes(row.actionKind)) throw new OrganizationContextsConflictError("Context change contains unsupported compensating evidence");
          const actionKind = row.actionKind as EvidenceKind;
          const resourceFamily = actionKind === "thread" ? "thread" : "context";
          const before = parseEvidenceValue(actionKind, row.beforeJson);
          const after = parseEvidenceValue(actionKind, row.afterJson);
          const identity = after ?? before;
          if (!identity || row.resourceFamily !== resourceFamily || row.resourceId !== evidenceResourceId(actionKind, identity)) throw new OrganizationContextsConflictError("Context change contains mismatched compensating evidence");
          return { actionKind, resourceFamily, resourceId: row.resourceId, before, after };
        });
        if (evidence.length === 0) throw new OrganizationContextsConflictError("Context change does not contain compensating evidence");
        if (current.workspaceRevision !== expectedWorkspaceRevision) throw new OrganizationRevisionConflictError(expectedWorkspaceRevision, current.workspaceRevision);
        const originalScope = parseTrace(original.authorityTrace).scope.accountIds;
        if (originalScope.some((accountId) => !executionContext.accountIds.includes(accountId))) throw new OrganizationContextsAccessError();
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get()) throw new OrganizationContextsConflictError("The idempotency key is already reserved");
        const next = causalCompensation(current, evidence, input.now.toISOString());
        writeSnapshot(executor, workspaceId, current, next, input.now);
        reserveChange(executor, { workspaceId, changeId: input.changeId, idempotencyKey, commandDigest: executionContext.command.digest, authorityTrace, operation: "revert", commandJson: { revert: request }, revertsChangeId: original.id, workspaceRevisionBefore: current.workspaceRevision, workspaceRevisionAfter: next.workspaceRevision, evidence: collectEvidence(current, next), now: input.now });
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.workspaceRevision, updatedAt: input.now }).where(and(eq(organizationWorkspaceStates.workspaceId, workspaceId), eq(organizationWorkspaceStates.revision, current.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.workspaceRevision, current.workspaceRevision + 1);
        return { snapshot: next, change: summary(executor, transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.id, input.changeId))).get()!) };
      });
    },
    audit(workspaceId) {
      return db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.resourceFamily, "context"))).orderBy(asc(organizationChangeSets.createdAt), asc(organizationChangeSets.id)).all().map((row) => summary(db, row));
    },
  };
}
