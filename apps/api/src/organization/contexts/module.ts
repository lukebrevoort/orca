import { createHash } from "node:crypto";

import {
  organizationContextApplyRequestSchema,
  organizationContextBounds,
  organizationContextChangeSummarySchema,
  organizationContextDescribeResponseSchema,
  organizationContextMutationResponseSchema,
  organizationContextQueryResponseSchema,
  organizationContextQuerySchema,
  organizationContextRevertRequestSchema,
  organizationContextScopeSchema,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationContextAction,
  type OrganizationContextActionKind,
  type OrganizationContextApplyRequest,
  type OrganizationContextChangeSummary,
  type OrganizationContextMutationResponse,
  type OrganizationContextQuery,
  type OrganizationContextQueryResponse,
  type OrganizationContextRevertRequest,
  type OrganizationContextScope,
  type OrganizationExecutionContext,
} from "@orca/shared";
import { authorizeOrganizationOperation, canonicalOrganizationJson } from "../authority.ts";

export type OrganizationContextSnapshot = OrganizationContextQueryResponse & {
  threads: Array<{ accountId: string; threadId: string }>;
};

export type OrganizationContextAllocatedIds = Array<string | null>;

export type OrganizationContextsRepository = {
  listAccountIds(workspaceId: string): string[];
  getSnapshot(workspaceId: string): OrganizationContextSnapshot;
  getAuthorityState(workspaceId: string): {
    workspaceRevision: number;
    resourceRevisions: Record<string, number>;
    reservedIdempotencyKeys: string[];
  };
  getIdempotentChange(workspaceId: string, idempotencyKey: string): {
    request: OrganizationContextApplyRequest | { revert: OrganizationContextRevertRequest };
    change: OrganizationContextChangeSummary;
  } | null;
  apply(input: {
    scope: OrganizationContextScope;
    request: OrganizationContextApplyRequest;
    allocatedIds: OrganizationContextAllocatedIds;
    changeId: string;
    authorization: { executionContext: OrganizationExecutionContext; trace: OrganizationAuthorityTrace; command: OrganizationCommand };
    now: Date;
  }): { snapshot: OrganizationContextSnapshot; change: OrganizationContextChangeSummary };
  revert(input: {
    scope: OrganizationContextScope;
    request: OrganizationContextRevertRequest;
    changeId: string;
    authorization: { executionContext: OrganizationExecutionContext; trace: OrganizationAuthorityTrace; command: OrganizationCommand };
    now: Date;
  }): { snapshot: OrganizationContextSnapshot; change: OrganizationContextChangeSummary };
  audit(workspaceId: string): OrganizationContextChangeSummary[];
};

export type OrganizationContextIssueCode =
  | "missing_reference"
  | "retired_resource"
  | "relationship_type_mismatch"
  | "duplicate_relationship"
  | "fan_out_exceeded"
  | "cycle_detected"
  | "revision_conflict"
  | "name_conflict"
  | "position_conflict";

export class OrganizationContextsValidationError extends Error {
  readonly issues: Array<{ code: OrganizationContextIssueCode; path: string; message: string }>;

  constructor(readonly code: OrganizationContextIssueCode, message: string, path = "actions") {
    super(message);
    this.name = "OrganizationContextsValidationError";
    this.issues = [{ code, path, message }];
  }
}

export class OrganizationContextsAccessError extends Error {
  readonly code = "account_denied" as const;

  constructor(message = "The requested Account scope is not authorized for this Workspace") {
    super(message);
    this.name = "OrganizationContextsAccessError";
  }
}

export class OrganizationContextsConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationContextsConflictError";
  }
}

export class OrganizationContextsNotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationContextsNotFoundError";
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function digestOrganizationContextActions(actions: readonly OrganizationContextAction[]): string {
  return sha256(canonicalOrganizationJson(actions));
}

function contextTypeResourceId(id: string) { return `context_type:${id}`; }
function relationshipTypeResourceId(id: string) { return `context_relationship_type:${id}`; }
function contextResourceId(id: string) { return `context:${id}`; }
function relationshipResourceId(id: string) { return `context_relationship:${id}`; }
function threadResourceId(accountId: string, threadId: string) { return `thread:${accountId}:${threadId}`; }

export function organizationContextResourceRevisions(snapshot: OrganizationContextSnapshot): Record<string, number> {
  return Object.fromEntries([
    ...snapshot.contextTypes.map((item) => [contextTypeResourceId(item.id), item.revision] as const),
    ...snapshot.relationshipTypes.map((item) => [relationshipTypeResourceId(item.id), item.revision] as const),
    ...snapshot.contexts.map((item) => [contextResourceId(item.id), item.revision] as const),
    ...snapshot.relationships.map((item) => [relationshipResourceId(item.id), item.revision] as const),
    ...snapshot.threadRevisions.map((item) => [threadResourceId(item.accountId, item.threadId), item.revision] as const),
  ]);
}

function copySnapshot(snapshot: OrganizationContextSnapshot): OrganizationContextSnapshot {
  return structuredClone(snapshot);
}

function validation(code: OrganizationContextIssueCode, message: string, index: number): never {
  throw new OrganizationContextsValidationError(code, message, `actions[${index}]`);
}

function assertExpected(actual: number | null, expected: number | null, index: number, label: string) {
  if (actual !== expected) validation("revision_conflict", `${label} changed; expected revision ${String(expected)}, found ${String(actual)}`, index);
}

function nameCollision(values: readonly { id: string; name: string }[], id: string | null, name: string) {
  const normalized = name.trim().toLocaleLowerCase();
  return values.some((value) => value.id !== id && value.name.trim().toLocaleLowerCase() === normalized);
}

function requireActive<T extends { retiredAt: string | null }>(value: T | undefined, label: string, index: number): T {
  if (!value) validation("missing_reference", `${label} does not exist`, index);
  if (value.retiredAt !== null) validation("retired_resource", `${label} is retired and cannot receive new relationships`, index);
  return value;
}

/** Pure Context semantics. SQLite re-runs this inside its transaction before writing. */
export function applyOrganizationContextActions(input: {
  snapshot: OrganizationContextSnapshot;
  actions: readonly OrganizationContextAction[];
  allocatedIds: OrganizationContextAllocatedIds;
  authorizedAccountIds: readonly string[];
  now: string;
}): OrganizationContextSnapshot {
  const next = copySnapshot(input.snapshot);
  const baseThreadRevisions = new Map(input.snapshot.threadRevisions.map((thread) => [`${thread.accountId}\0${thread.threadId}`, thread.revision]));
  const threadInventory = new Set(input.snapshot.threads.map((thread) => `${thread.accountId}\0${thread.threadId}`));
  const authorized = new Set(input.authorizedAccountIds);
  const touchedThreads = new Set<string>();

  input.actions.forEach((action, index) => {
    const allocatedId = input.allocatedIds[index];
    if (action.kind === "create_context_type") {
      if (!allocatedId) validation("missing_reference", "Server did not allocate a Context Type identity", index);
      if (nameCollision(next.contextTypes, null, action.name)) validation("name_conflict", "Context Type name is already in use", index);
      if (next.contextTypes.some((item) => item.position === action.position)) validation("position_conflict", "Context Type position is already in use", index);
      next.contextTypes.push({ id: allocatedId, name: action.name, position: action.position, retiredAt: null, revision: 1, createdAt: input.now, updatedAt: input.now });
      return;
    }
    if (action.kind === "update_context_type") {
      const item = next.contextTypes.find((candidate) => candidate.id === action.contextTypeId);
      if (!item) validation("missing_reference", "Context Type does not exist", index);
      assertExpected(item.revision, action.expectedRevision, index, "Context Type");
      if (item.retiredAt && action.patch.retired !== false) validation("retired_resource", "Retired Context Types must be explicitly restored before editing", index);
      if (action.patch.name && nameCollision(next.contextTypes, item.id, action.patch.name)) validation("name_conflict", "Context Type name is already in use", index);
      if (action.patch.position !== undefined && next.contextTypes.some((candidate) => candidate.id !== item.id && candidate.position === action.patch.position)) validation("position_conflict", "Context Type position is already in use", index);
      if (action.patch.name !== undefined) item.name = action.patch.name;
      if (action.patch.position !== undefined) item.position = action.patch.position;
      if (action.patch.retired !== undefined) item.retiredAt = action.patch.retired ? input.now : null;
      item.revision += 1;
      item.updatedAt = input.now;
      return;
    }
    if (action.kind === "create_relationship_type") {
      if (!allocatedId) validation("missing_reference", "Server did not allocate a Relationship Type identity", index);
      requireActive(next.contextTypes.find((item) => item.id === action.contextTypeId), "Context Type", index);
      const sameType = next.relationshipTypes.filter((item) => item.contextTypeId === action.contextTypeId);
      if (nameCollision(sameType, null, action.name)) validation("name_conflict", "Relationship Type name is already in use for this Context Type", index);
      if (sameType.some((item) => item.position === action.position)) validation("position_conflict", "Relationship Type position is already in use for this Context Type", index);
      next.relationshipTypes.push({ id: allocatedId, contextTypeId: action.contextTypeId, name: action.name, inverseName: action.inverseName, direction: action.direction, position: action.position, maximumPerThread: action.maximumPerThread, retiredAt: null, revision: 1, createdAt: input.now, updatedAt: input.now });
      return;
    }
    if (action.kind === "update_relationship_type") {
      const item = next.relationshipTypes.find((candidate) => candidate.id === action.relationshipTypeId);
      if (!item) validation("missing_reference", "Relationship Type does not exist", index);
      assertExpected(item.revision, action.expectedRevision, index, "Relationship Type");
      if (item.retiredAt && action.patch.retired !== false) validation("retired_resource", "Retired Relationship Types must be explicitly restored before editing", index);
      const sameType = next.relationshipTypes.filter((candidate) => candidate.contextTypeId === item.contextTypeId);
      if (action.patch.name && nameCollision(sameType, item.id, action.patch.name)) validation("name_conflict", "Relationship Type name is already in use for this Context Type", index);
      if (action.patch.position !== undefined && sameType.some((candidate) => candidate.id !== item.id && candidate.position === action.patch.position)) validation("position_conflict", "Relationship Type position is already in use for this Context Type", index);
      if (action.patch.maximumPerThread !== undefined) {
        const maximumUsage = Math.max(0, ...next.threads.map((thread) => next.relationships.filter((relationship) => relationship.accountId === thread.accountId && relationship.threadId === thread.threadId && relationship.relationshipTypeId === item.id).length));
        if (action.patch.maximumPerThread < maximumUsage) validation("fan_out_exceeded", "Relationship Type maximum cannot be lower than current Thread usage", index);
      }
      if (action.patch.name !== undefined) item.name = action.patch.name;
      if (action.patch.inverseName !== undefined) item.inverseName = action.patch.inverseName;
      if (action.patch.position !== undefined) item.position = action.patch.position;
      if (action.patch.maximumPerThread !== undefined) item.maximumPerThread = action.patch.maximumPerThread;
      if (action.patch.retired !== undefined) item.retiredAt = action.patch.retired ? input.now : null;
      item.revision += 1;
      item.updatedAt = input.now;
      return;
    }
    if (action.kind === "create_context") {
      if (!allocatedId) validation("missing_reference", "Server did not allocate a Context identity", index);
      requireActive(next.contextTypes.find((item) => item.id === action.contextTypeId), "Context Type", index);
      if (nameCollision(next.contexts.filter((item) => item.contextTypeId === action.contextTypeId), null, action.name)) validation("name_conflict", "Context name is already in use for this Context Type", index);
      next.contexts.push({ id: allocatedId, contextTypeId: action.contextTypeId, name: action.name, retiredAt: null, revision: 1, createdAt: input.now, updatedAt: input.now });
      return;
    }
    if (action.kind === "update_context") {
      const item = next.contexts.find((candidate) => candidate.id === action.contextId);
      if (!item) validation("missing_reference", "Context does not exist", index);
      assertExpected(item.revision, action.expectedRevision, index, "Context");
      if (item.retiredAt && action.patch.retired !== false) validation("retired_resource", "Retired Contexts must be explicitly restored before editing", index);
      if (action.patch.name && nameCollision(next.contexts.filter((candidate) => candidate.contextTypeId === item.contextTypeId), item.id, action.patch.name)) validation("name_conflict", "Context name is already in use for this Context Type", index);
      if (action.patch.name !== undefined) item.name = action.patch.name;
      if (action.patch.retired !== undefined) item.retiredAt = action.patch.retired ? input.now : null;
      item.revision += 1;
      item.updatedAt = input.now;
      return;
    }

    if (!authorized.has(action.accountId)) throw new OrganizationContextsAccessError();
    if (action.kind === "link_thread_context" && action.threadId === action.contextId) validation("cycle_detected", "A Thread cannot use its own identity as a Context relationship target", index);
    const threadKey = `${action.accountId}\0${action.threadId}`;
    if (!threadInventory.has(threadKey)) validation("missing_reference", "Thread does not exist in the requested Account", index);
    assertExpected(baseThreadRevisions.get(threadKey) ?? null, action.expectedThreadRevision, index, "Thread Organization state");

    if (action.kind === "link_thread_context") {
      if (!allocatedId) validation("missing_reference", "Server did not allocate a relationship identity", index);
      const context = requireActive(next.contexts.find((item) => item.id === action.contextId), "Context", index);
      requireActive(next.contextTypes.find((item) => item.id === context.contextTypeId), "Context Type", index);
      const relationshipType = requireActive(next.relationshipTypes.find((item) => item.id === action.relationshipTypeId), "Relationship Type", index);
      if (relationshipType.contextTypeId !== context.contextTypeId) validation("relationship_type_mismatch", "Relationship Type and Context must reference the same stable Context Type", index);
      if (next.relationships.some((item) => item.accountId === action.accountId && item.threadId === action.threadId && item.contextId === action.contextId && item.relationshipTypeId === action.relationshipTypeId)) validation("duplicate_relationship", "This Thread already has the requested typed Context relationship", index);
      const threadRelationships = next.relationships.filter((item) => item.accountId === action.accountId && item.threadId === action.threadId);
      if (threadRelationships.length >= organizationContextBounds.maximumRelationshipsPerThread) validation("fan_out_exceeded", `A Thread can have at most ${organizationContextBounds.maximumRelationshipsPerThread} Context relationships`, index);
      if (threadRelationships.filter((item) => item.relationshipTypeId === action.relationshipTypeId).length >= relationshipType.maximumPerThread) validation("fan_out_exceeded", `Relationship Type ${relationshipType.name} allows at most ${relationshipType.maximumPerThread} links per Thread`, index);
      if (next.relationships.filter((item) => item.contextId === action.contextId).length >= organizationContextBounds.maximumRelationshipsPerContext) validation("fan_out_exceeded", `A Context can have at most ${organizationContextBounds.maximumRelationshipsPerContext} Thread relationships`, index);
      next.relationships.push({ id: allocatedId, accountId: action.accountId, threadId: action.threadId, contextTypeId: context.contextTypeId, contextId: context.id, relationshipTypeId: relationshipType.id, direction: relationshipType.direction, revision: 1, createdAt: input.now, updatedAt: input.now });
    } else {
      const relationshipIndex = next.relationships.findIndex((item) => item.id === action.relationshipId && item.accountId === action.accountId && item.threadId === action.threadId);
      if (relationshipIndex < 0) validation("missing_reference", "Thread Context relationship does not exist", index);
      assertExpected(next.relationships[relationshipIndex]!.revision, action.expectedRelationshipRevision, index, "Thread Context relationship");
      next.relationships.splice(relationshipIndex, 1);
    }
    touchedThreads.add(threadKey);
  });

  for (const key of touchedThreads) {
    const separator = key.indexOf("\0");
    const accountId = key.slice(0, separator);
    const threadId = key.slice(separator + 1);
    const existing = next.threadRevisions.find((thread) => thread.accountId === accountId && thread.threadId === threadId);
    if (existing) existing.revision += 1;
    else next.threadRevisions.push({ accountId, threadId, revision: 1 });
  }
  next.workspaceRevision += 1;
  return sortSnapshot(next);
}

function sortSnapshot(snapshot: OrganizationContextSnapshot): OrganizationContextSnapshot {
  snapshot.contextTypes.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  snapshot.relationshipTypes.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  snapshot.contexts.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  snapshot.relationships.sort((left, right) => left.relationshipTypeId.localeCompare(right.relationshipTypeId) || left.contextId.localeCompare(right.contextId) || left.id.localeCompare(right.id));
  snapshot.threadRevisions.sort((left, right) => left.accountId.localeCompare(right.accountId) || left.threadId.localeCompare(right.threadId));
  return snapshot;
}

function authorize(repository: OrganizationContextsRepository, untrustedScope: unknown) {
  const scope = organizationContextScopeSchema.parse(untrustedScope);
  const owned = new Set(repository.listAccountIds(scope.workspaceId));
  if (scope.accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationContextsAccessError();
  return { scope, accountIds: [...scope.accountIds].sort() };
}

function allocateActionIds(actions: readonly OrganizationContextAction[], newResourceId: () => string): OrganizationContextAllocatedIds {
  return actions.map((action) => action.kind === "create_context_type" || action.kind === "create_relationship_type" || action.kind === "create_context" || action.kind === "link_thread_context" ? newResourceId() : null);
}

function querySnapshot(snapshot: OrganizationContextSnapshot, accountIds: readonly string[], query: OrganizationContextQuery): OrganizationContextQueryResponse {
  const scoped = new Set(accountIds);
  let relationships = snapshot.relationships.filter((relationship) => scoped.has(relationship.accountId));
  if (query.threadId) relationships = relationships.filter((relationship) => relationship.threadId === query.threadId);
  if (query.relationshipTypeId) relationships = relationships.filter((relationship) => relationship.relationshipTypeId === query.relationshipTypeId);
  if (query.contextTypeId) relationships = relationships.filter((relationship) => relationship.contextTypeId === query.contextTypeId);
  if (query.contextRef) relationships = relationships.filter((relationship) => relationship.contextId === query.contextRef!.contextId && relationship.contextTypeId === query.contextRef!.contextTypeId);
  relationships = relationships.slice(0, query.limit);
  const referencedContextIds = new Set(relationships.map((relationship) => relationship.contextId));
  const referencedRelationshipTypeIds = new Set(relationships.map((relationship) => relationship.relationshipTypeId));
  let contexts = snapshot.contexts.filter((context) => query.includeRetired || context.retiredAt === null || referencedContextIds.has(context.id));
  if (query.contextTypeId) contexts = contexts.filter((context) => context.contextTypeId === query.contextTypeId);
  if (query.contextRef) contexts = contexts.filter((context) => context.id === query.contextRef!.contextId && context.contextTypeId === query.contextRef!.contextTypeId);
  if (query.threadId || query.relationshipTypeId) contexts = contexts.filter((context) => referencedContextIds.has(context.id));
  contexts = contexts.slice(0, query.limit);
  const contextTypeIds = new Set(contexts.map((context) => context.contextTypeId));
  const contextTypes = snapshot.contextTypes.filter((type) => (query.includeRetired || type.retiredAt === null || contextTypeIds.has(type.id)) && (!query.contextTypeId || type.id === query.contextTypeId)).slice(0, query.limit);
  const relationshipTypes = snapshot.relationshipTypes.filter((type) => (query.includeRetired || type.retiredAt === null || referencedRelationshipTypeIds.has(type.id)) && (!query.relationshipTypeId || type.id === query.relationshipTypeId) && (!query.contextTypeId || type.contextTypeId === query.contextTypeId)).slice(0, query.limit);
  const visibleThreadKeys = new Set(relationships.map((relationship) => `${relationship.accountId}\0${relationship.threadId}`));
  const filtersRelationships = Boolean(query.threadId || query.relationshipTypeId || query.contextTypeId || query.contextRef);
  const threadRevisions = snapshot.threadRevisions.filter((thread) => scoped.has(thread.accountId) && (!query.threadId || thread.threadId === query.threadId) && (!filtersRelationships || visibleThreadKeys.has(`${thread.accountId}\0${thread.threadId}`)));
  return organizationContextQueryResponseSchema.parse({ workspaceId: snapshot.workspaceId, accountIds: [...accountIds], workspaceRevision: snapshot.workspaceRevision, contextTypes, relationshipTypes, contexts, relationships, threadRevisions });
}

function buildCommand(snapshot: OrganizationContextSnapshot, request: OrganizationContextApplyRequest, allocatedIds: OrganizationContextAllocatedIds, changeId: string): OrganizationCommand {
  const digest = digestOrganizationContextActions(request.actions);
  const resources = new Map<string, { kind: "mutate_context" | "organize_thread"; mutation: "create" | "update" }>();
  request.actions.forEach((action, index) => {
    if (action.kind === "create_context_type") resources.set(contextTypeResourceId(allocatedIds[index]!), { kind: "mutate_context", mutation: "create" });
    else if (action.kind === "update_context_type") resources.set(contextTypeResourceId(action.contextTypeId), { kind: "mutate_context", mutation: "update" });
    else if (action.kind === "create_relationship_type") resources.set(relationshipTypeResourceId(allocatedIds[index]!), { kind: "mutate_context", mutation: "create" });
    else if (action.kind === "update_relationship_type") resources.set(relationshipTypeResourceId(action.relationshipTypeId), { kind: "mutate_context", mutation: "update" });
    else if (action.kind === "create_context") resources.set(contextResourceId(allocatedIds[index]!), { kind: "mutate_context", mutation: "create" });
    else if (action.kind === "update_context") resources.set(contextResourceId(action.contextId), { kind: "mutate_context", mutation: "update" });
    else {
      if (action.kind === "link_thread_context") resources.set(relationshipResourceId(allocatedIds[index]!), { kind: "mutate_context", mutation: "create" });
      else resources.set(relationshipResourceId(action.relationshipId), { kind: "mutate_context", mutation: "update" });
      const threadId = threadResourceId(action.accountId, action.threadId);
      resources.set(threadId, { kind: "organize_thread", mutation: organizationContextResourceRevisions(snapshot)[threadId] === undefined ? "create" : "update" });
    }
  });
  return {
    id: changeId,
    intents: [...resources].map(([resourceId, resource]) => ({
      kind: resource.kind,
      resourceId,
      mutation: resource.mutation,
      changes: { typedActionsDigest: digest, allocatedIdsDigest: sha256(canonicalOrganizationJson(allocatedIds)), actionCount: request.actions.length },
    })),
  };
}

export function createOrganizationContexts(repository: OrganizationContextsRepository, dependencies: { now?: () => Date; newId?: () => string } = {}) {
  const now = dependencies.now ?? (() => new Date());
  const newId = dependencies.newId ?? (() => crypto.randomUUID());

  function queryAuthorized(scope: OrganizationContextScope, query: OrganizationContextQuery) {
    const requested = query.accountIds ? [...query.accountIds].sort() : [...scope.accountIds].sort();
    const scoped = new Set(scope.accountIds);
    if (requested.some((accountId) => !scoped.has(accountId))) throw new OrganizationContextsAccessError();
    return querySnapshot(repository.getSnapshot(scope.workspaceId), requested, query);
  }

  function authorizeBound(scope: OrganizationContextScope, operation: "apply" | "revert", idempotencyKey: string, command: OrganizationCommand, expectedWorkspaceRevision: number) {
    if (scope.actor.type !== "human") throw new OrganizationContextsAccessError("Context writes require an authenticated human session");
    const live = repository.getAuthorityState(scope.workspaceId);
    const expectedResources = Object.fromEntries(command.intents.flatMap((intent) => intent.mutation === "update" && live.resourceRevisions[intent.resourceId] !== undefined ? [[intent.resourceId, live.resourceRevisions[intent.resourceId]!]] : []));
    const capability = {
      id: `first_party:human:${scope.actor.id}`,
      revision: 1,
      actor: scope.actor,
      scope: { workspaceId: scope.workspaceId, accountIds: scope.accountIds },
      operations: ["describe", "query", "apply", "revert"] as const,
      resourceFamilies: ["context", "thread", "audit", "change_set"] as const,
      actionFamilies: ["organization_read", "organization_structure", "organization_thread"] as const,
    };
    const decision = authorizeOrganizationOperation({ actor: scope.actor, capabilitySnapshot: capability, operation, scope: capability.scope, command, expectedRevisions: { workspace: expectedWorkspaceRevision, resources: expectedResources }, idempotencyKey }, { scope: capability.scope, capability: { snapshot: capability, revokedAt: null }, workspaceRevision: live.workspaceRevision, resourceRevisions: live.resourceRevisions, reservedIdempotencyKeys: live.reservedIdempotencyKeys });
    if (!decision.allowed) {
      if (decision.code === "revision_conflict" || decision.code === "duplicate_idempotency_key") throw new OrganizationContextsConflictError(decision.reason);
      throw new OrganizationContextsAccessError(decision.reason);
    }
    return { executionContext: decision.executionContext, trace: decision.trace, command };
  }

  return {
    describe(input: { scope: unknown }) {
      const { scope, accountIds } = authorize(repository, input.scope);
      const snapshot = repository.getSnapshot(scope.workspaceId);
      return organizationContextDescribeResponseSchema.parse({ workspaceId: scope.workspaceId, accountIds, semantics: { stableIdentity: true, arbitraryFields: false, contextEdges: "thread_context_only" }, bounds: { maximumActionsPerChange: organizationContextBounds.maximumActionsPerChange, maximumRelationshipsPerThread: organizationContextBounds.maximumRelationshipsPerThread, maximumRelationshipsPerContext: organizationContextBounds.maximumRelationshipsPerContext }, operations: { describe: true, query: true, apply: true, revert: true, simulate: false }, authority: { sendMail: false, deleteProviderMail: false }, contextTypes: snapshot.contextTypes, relationshipTypes: snapshot.relationshipTypes });
    },
    query(input: { scope: unknown; query: unknown }) {
      const { scope } = authorize(repository, input.scope);
      return queryAuthorized(scope, organizationContextQuerySchema.parse(input.query));
    },
    apply(input: { scope: unknown; request: unknown }): OrganizationContextMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationContextApplyRequestSchema.parse(input.request);
      const replay = repository.getIdempotentChange(scope.workspaceId, request.idempotencyKey);
      if (replay) {
        if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson(request)) throw new OrganizationContextsConflictError("Idempotency key was already used for a different Context change");
        return organizationContextMutationResponseSchema.parse({ change: replay.change, state: queryAuthorized(scope, organizationContextQuerySchema.parse({ includeRetired: true })) });
      }
      const snapshot = repository.getSnapshot(scope.workspaceId);
      if (snapshot.workspaceRevision !== request.expectedWorkspaceRevision) throw new OrganizationContextsConflictError(`Expected Workspace revision ${request.expectedWorkspaceRevision}, found ${snapshot.workspaceRevision}`);
      const allocatedIds = allocateActionIds(request.actions, newId);
      applyOrganizationContextActions({ snapshot, actions: request.actions, allocatedIds, authorizedAccountIds: scope.accountIds, now: now().toISOString() });
      const changeId = newId();
      const command = buildCommand(snapshot, request, allocatedIds, changeId);
      const authorization = authorizeBound(scope, "apply", request.idempotencyKey, command, request.expectedWorkspaceRevision);
      const result = repository.apply({ scope, request, allocatedIds, changeId, authorization, now: now() });
      return organizationContextMutationResponseSchema.parse({ change: result.change, state: queryAuthorized(scope, organizationContextQuerySchema.parse({ includeRetired: true })) });
    },
    revert(input: { scope: unknown; request: unknown }): OrganizationContextMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationContextRevertRequestSchema.parse(input.request);
      const replay = repository.getIdempotentChange(scope.workspaceId, request.idempotencyKey);
      if (replay) {
        if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson({ revert: request })) throw new OrganizationContextsConflictError("Idempotency key was already used for a different Context change");
        return organizationContextMutationResponseSchema.parse({ change: replay.change, state: queryAuthorized(scope, organizationContextQuerySchema.parse({ includeRetired: true })) });
      }
      const changeId = newId();
      const command: OrganizationCommand = { id: changeId, intents: [{ kind: "mutate_context", resourceId: `context_change:${request.changeId}`, mutation: "create", changes: { action: "revert", requestDigest: sha256(canonicalOrganizationJson(request)) } }] };
      const authorization = authorizeBound(scope, "revert", request.idempotencyKey, command, request.expectedWorkspaceRevision);
      const result = repository.revert({ scope, request, changeId, authorization, now: now() });
      return organizationContextMutationResponseSchema.parse({ change: result.change, state: queryAuthorized(scope, organizationContextQuerySchema.parse({ includeRetired: true })) });
    },
    audit(input: { scope: unknown }) {
      const { scope } = authorize(repository, input.scope);
      return repository.audit(scope.workspaceId).map((change) => organizationContextChangeSummarySchema.parse(change));
    },
  };
}
