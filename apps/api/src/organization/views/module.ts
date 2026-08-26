import { createHash } from "node:crypto";

import {
  organizationViewCreateRequestSchema,
  organizationViewRemoveRequestSchema,
  organizationViewReorderRequestSchema,
  organizationViewResultQuerySchema,
  organizationViewUpdateRequestSchema,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
  type OrganizationView,
  type OrganizationViewCreateRequest,
  type OrganizationViewRemoveRequest,
  type OrganizationViewReorderRequest,
  type OrganizationViewResultPage,
  type OrganizationViewResultQuery,
  type OrganizationViewUpdateRequest,
} from "@orca/shared";
import { authorizeOrganizationOperation, canonicalOrganizationJson } from "../authority.ts";

export class OrganizationViewAccessError extends Error {
  readonly code: "account_denied" | "resource_denied";
  constructor(message = "The requested Account scope is not authorized for this Workspace", code: "account_denied" | "resource_denied" = "account_denied") { super(message); this.code = code; this.name = "OrganizationViewAccessError"; }
}

export class OrganizationViewNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(message = "The requested View was not found") { super(message); this.name = "OrganizationViewNotFoundError"; }
}

export class OrganizationViewConflictError extends Error {
  readonly code = "revision_conflict" as const;
  constructor(message = "The View changed before this request could be applied") { super(message); this.name = "OrganizationViewConflictError"; }
}

export class OrganizationViewQueryError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor(message: string) { super(message); this.name = "OrganizationViewQueryError"; }
}

export class OrganizationViewValidationError extends Error {
  readonly code = "validation_error" as const;
  constructor(message: string) { super(message); this.name = "OrganizationViewValidationError"; }
}

export type OrganizationViewScope = {
  workspaceId: string;
  accountIds: string[];
  actor: { id: string; type: "human" | "agent" | "system" };
};

export type OrganizationViewMutationAuthorization = {
  executionContext: OrganizationExecutionContext;
  trace: OrganizationAuthorityTrace;
  authorizationEnvelopeDigest: string;
  command: OrganizationCommand;
};

export type OrganizationViewsRepository = {
  list(workspaceId: string): OrganizationView[];
  get(workspaceId: string, viewId: string): OrganizationView | null;
  getWorkspaceRevision(workspaceId: string): number;
  getAuthorityState(workspaceId: string): { workspaceRevision: number; resourceRevisions: Record<string, number>; reservedIdempotencyKeys: string[] };
  getIdempotentMutation(workspaceId: string, idempotencyKey: string): { request: unknown; response: unknown } | null;
  create(input: { workspaceId: string; viewId: string; request: OrganizationViewCreateRequest; boundRequest: unknown; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  update(input: { workspaceId: string; viewId: string; request: OrganizationViewUpdateRequest; boundRequest: unknown; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  reorder(input: { workspaceId: string; request: OrganizationViewReorderRequest; boundRequest: unknown; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView[];
  remove(input: { workspaceId: string; viewId: string; request: OrganizationViewRemoveRequest; boundRequest: unknown; authorization: OrganizationViewMutationAuthorization; now: Date }): void;
  query(input: { scope: OrganizationViewScope; view: OrganizationView; query: OrganizationViewResultQuery }): OrganizationViewResultPage;
};

function authorizedAccountIds(scope: OrganizationViewScope, requested: readonly string[] | undefined) {
  const owned = new Set(scope.accountIds);
  const accountIds = requested ? [...requested] : [...scope.accountIds];
  if (accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationViewAccessError();
  return accountIds.sort();
}

function viewResourceId(viewId: string) { return `view:${viewId}`; }
function digest(value: unknown) { return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`; }

function firstPartyViewsCapability(scope: OrganizationViewScope): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:${scope.actor.type}:${scope.actor.id}`,
    revision: 1,
    actor: scope.actor,
    scope: { workspaceId: scope.workspaceId, accountIds: [...scope.accountIds].sort() },
    operations: ["query", "apply"],
    resourceFamilies: ["view"],
    actionFamilies: ["organization_read", "organization_structure"],
  };
}

export function createOrganizationViews(repository: OrganizationViewsRepository, dependencies: { newViewId?: () => string; newChangeId?: () => string; now?: () => Date } = {}) {
  const newViewId = dependencies.newViewId ?? (() => `view_${crypto.randomUUID()}`);
  const newChangeId = dependencies.newChangeId ?? (() => `change_${crypto.randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());

  function replay(scope: OrganizationViewScope, idempotencyKey: string, boundRequest: unknown) {
    const existing = repository.getIdempotentMutation(scope.workspaceId, idempotencyKey);
    if (!existing) return { found: false as const, response: null };
    if (canonicalOrganizationJson(existing.request) !== canonicalOrganizationJson(boundRequest)) throw new OrganizationViewConflictError("The idempotency key was already used for a different View command");
    return { found: true as const, response: existing.response };
  }

  function authorizeBound(scope: OrganizationViewScope, request: { idempotencyKey: string; expectedWorkspaceRevision: number }, command: OrganizationCommand, expectedResources: Record<string, number>): OrganizationViewMutationAuthorization {
    if (scope.actor.type !== "human") throw new OrganizationViewAccessError("View writes require an authenticated human session", "resource_denied");
    const capability = firstPartyViewsCapability(scope);
    const live = repository.getAuthorityState(scope.workspaceId);
    const decision = authorizeOrganizationOperation({
      actor: scope.actor,
      capabilitySnapshot: capability,
      operation: "apply",
      scope: capability.scope,
      command,
      expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
      idempotencyKey: request.idempotencyKey,
    }, {
      scope: capability.scope,
      capability: { snapshot: capability, revokedAt: null },
      workspaceRevision: live.workspaceRevision,
      resourceRevisions: live.resourceRevisions,
      reservedIdempotencyKeys: live.reservedIdempotencyKeys,
    });
    if (!decision.allowed) {
      if (["revision_conflict", "duplicate_idempotency_key"].includes(decision.code)) throw new OrganizationViewConflictError(decision.reason);
      throw new OrganizationViewAccessError(decision.reason, "resource_denied");
    }
    return { executionContext: decision.executionContext, trace: decision.trace, authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest, command };
  }

  return {
    list(input: { scope: OrganizationViewScope }) {
      authorizedAccountIds(input.scope, undefined);
      return { workspaceId: input.scope.workspaceId, workspaceRevision: repository.getWorkspaceRevision(input.scope.workspaceId), items: repository.list(input.scope.workspaceId) };
    },
    create(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewCreateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.definition.accountIds);
      const boundRequest = { kind: "create", request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return existing.response as OrganizationView;
      const viewId = newViewId();
      const command: OrganizationCommand = { id: newChangeId(), intents: [{ kind: "mutate_view", resourceId: viewResourceId(viewId), mutation: "create", changes: { clientRequestDigest: digest(boundRequest) } }] };
      return repository.create({ workspaceId: input.scope.workspaceId, viewId, request, boundRequest, authorization: authorizeBound(input.scope, request, command, {}), now: now() });
    },
    update(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewUpdateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.patch.definition?.accountIds);
      const boundRequest = { kind: "update", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return existing.response as OrganizationView;
      if (!repository.get(input.scope.workspaceId, input.viewId)) throw new OrganizationViewNotFoundError();
      const resourceId = viewResourceId(input.viewId);
      const command: OrganizationCommand = { id: newChangeId(), intents: [{ kind: "mutate_view", resourceId, mutation: "update", changes: { clientRequestDigest: digest(boundRequest) } }] };
      return repository.update({ workspaceId: input.scope.workspaceId, viewId: input.viewId, request, boundRequest, authorization: authorizeBound(input.scope, request, command, { [resourceId]: request.expectedRevision }), now: now() });
    },
    reorder(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewReorderRequestSchema.parse(input.request);
      const boundRequest = { kind: "reorder", request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return { workspaceId: input.scope.workspaceId, workspaceRevision: request.expectedWorkspaceRevision + 1, items: existing.response as OrganizationView[] };
      const command: OrganizationCommand = { id: newChangeId(), intents: request.items.map((item) => ({ kind: "mutate_view", resourceId: viewResourceId(item.id), mutation: "update", changes: { clientRequestDigest: digest(boundRequest), position: item.position } })) };
      const expected = Object.fromEntries(request.items.map((item) => [viewResourceId(item.id), item.expectedRevision]));
      const items = repository.reorder({ workspaceId: input.scope.workspaceId, request, boundRequest, authorization: authorizeBound(input.scope, request, command, expected), now: now() });
      return { workspaceId: input.scope.workspaceId, workspaceRevision: repository.getWorkspaceRevision(input.scope.workspaceId), items };
    },
    remove(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewRemoveRequestSchema.parse(input.request);
      const boundRequest = { kind: "remove", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return;
      const resourceId = viewResourceId(input.viewId);
      const command: OrganizationCommand = { id: newChangeId(), intents: [{ kind: "mutate_view", resourceId, mutation: "update", changes: { clientRequestDigest: digest(boundRequest), remove: true } }] };
      repository.remove({ workspaceId: input.scope.workspaceId, viewId: input.viewId, request, boundRequest, authorization: authorizeBound(input.scope, request, command, { [resourceId]: request.expectedRevision }), now: now() });
    },
    results(input: { scope: OrganizationViewScope; viewId: string; query: unknown }) {
      const view = repository.get(input.scope.workspaceId, input.viewId);
      if (!view) throw new OrganizationViewNotFoundError();
      authorizedAccountIds(input.scope, view.definition.accountIds);
      return repository.query({ scope: input.scope, view, query: organizationViewResultQuerySchema.parse(input.query) });
    },
  };
}
