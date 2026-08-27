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
import { requireOrganizationCapability, type OrganizationAgentCapabilitySource } from "../agent-capability.ts";

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

export type OrganizationViewMutationPlan = {
  orderedViewIds: string[];
  expectedViews: Array<{ id: string; position: number; revision: number }>;
};

export type OrganizationViewsRepository = {
  list(workspaceId: string): OrganizationView[];
  get(workspaceId: string, viewId: string): OrganizationView | null;
  getWorkspaceRevision(workspaceId: string): number;
  getAuthorityState(workspaceId: string): { workspaceRevision: number; resourceRevisions: Record<string, number>; reservedIdempotencyKeys: string[] };
  getIdempotentMutation(workspaceId: string, idempotencyKey: string): { request: unknown; response: unknown } | null;
  create(input: { workspaceId: string; viewId: string; request: OrganizationViewCreateRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  update(input: { workspaceId: string; viewId: string; request: OrganizationViewUpdateRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  reorder(input: { workspaceId: string; request: OrganizationViewReorderRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView[];
  remove(input: { workspaceId: string; viewId: string; request: OrganizationViewRemoveRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): void;
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

export function organizationViewOrderResourceId(workspaceId: string) { return `view_order:${workspaceId}`; }
export function digestOrganizationViewOrder(orderedViewIds: readonly string[]) { return digest(orderedViewIds); }

function mutationPlan(current: readonly OrganizationView[], orderedViewIds: readonly string[]): OrganizationViewMutationPlan {
  return {
    orderedViewIds: [...orderedViewIds],
    expectedViews: current.map((view) => ({ id: view.id, position: view.position, revision: view.revision })),
  };
}

function orderChanged(current: readonly OrganizationView[], orderedViewIds: readonly string[]) {
  return current.length !== orderedViewIds.length || current.some((view, position) => view.id !== orderedViewIds[position]);
}

function viewIntent(input: { viewId: string; mutation: "create" | "update"; requestDigest: string; position?: number; remove?: boolean }): OrganizationCommand["intents"][number] {
  return {
    kind: "mutate_view",
    resourceId: viewResourceId(input.viewId),
    mutation: input.mutation,
    changes: { clientRequestDigest: input.requestDigest, ...(input.position === undefined ? {} : { position: input.position }), ...(input.remove ? { remove: true } : {}) },
  };
}

function orderingIntent(workspaceId: string, orderedViewIds: readonly string[], requestDigest: string): OrganizationCommand["intents"][number] {
  return {
    kind: "mutate_view",
    resourceId: organizationViewOrderResourceId(workspaceId),
    mutation: "update",
    changes: {
      clientRequestDigest: requestDigest,
      orderDigest: digestOrganizationViewOrder(orderedViewIds),
      viewCount: orderedViewIds.length,
    },
  };
}

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

export function createOrganizationViews(repository: OrganizationViewsRepository, dependencies: { newViewId?: () => string; newChangeId?: () => string; now?: () => Date; agentCapabilitySource?: OrganizationAgentCapabilitySource } = {}) {
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
    let liveCapability;
    try {
      liveCapability = requireOrganizationCapability(scope, (actor) => firstPartyViewsCapability({ ...scope, actor }), dependencies.agentCapabilitySource);
    } catch (error) {
      throw new OrganizationViewAccessError(error instanceof Error ? error.message : "View Actor is not authorized", "resource_denied");
    }
    const capability = liveCapability.snapshot;
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
      capability: liveCapability,
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
      const current = repository.list(input.scope.workspaceId);
      const orderedViewIds = current.map((view) => view.id);
      orderedViewIds.splice(Math.min(request.position, orderedViewIds.length), 0, viewId);
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId, mutation: "create", requestDigest, position: orderedViewIds.indexOf(viewId) }),
        orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      return repository.create({
        workspaceId: input.scope.workspaceId,
        viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision }),
        now: now(),
      });
    },
    update(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewUpdateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.patch.definition?.accountIds);
      const boundRequest = { kind: "update", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return existing.response as OrganizationView;
      const current = repository.list(input.scope.workspaceId);
      const target = current.find((view) => view.id === input.viewId);
      if (!target) throw new OrganizationViewNotFoundError();
      const orderedViewIds = current.map((view) => view.id);
      if (request.patch.position !== undefined) {
        orderedViewIds.splice(orderedViewIds.indexOf(input.viewId), 1);
        orderedViewIds.splice(Math.min(request.patch.position, orderedViewIds.length), 0, input.viewId);
      }
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId: input.viewId, mutation: "update", requestDigest, position: orderedViewIds.indexOf(input.viewId) }),
        ...(orderChanged(current, orderedViewIds) ? [orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest)] : []),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      return repository.update({
        workspaceId: input.scope.workspaceId,
        viewId: input.viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, {
          [viewResourceId(input.viewId)]: request.expectedRevision,
          ...(orderChanged(current, orderedViewIds) ? { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision } : {}),
        }),
        now: now(),
      });
    },
    reorder(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewReorderRequestSchema.parse(input.request);
      const boundRequest = { kind: "reorder", request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return { workspaceId: input.scope.workspaceId, workspaceRevision: request.expectedWorkspaceRevision + 1, items: existing.response as OrganizationView[] };
      const current = repository.list(input.scope.workspaceId);
      const byId = new Map(current.map((view) => [view.id, view]));
      if (request.items.some((item) => !byId.has(item.id))) throw new OrganizationViewNotFoundError();
      if (request.items.some((item) => item.position >= current.length)) throw new OrganizationViewValidationError("View reorder positions must fit the complete Workspace ordering");
      const ordered = Array<string | undefined>(current.length);
      const requestedIds = new Set(request.items.map((item) => item.id));
      for (const item of request.items) ordered[item.position] = item.id;
      const untouched = current.filter((view) => !requestedIds.has(view.id)).map((view) => view.id);
      for (let index = 0; index < ordered.length; index += 1) if (!ordered[index]) ordered[index] = untouched.shift();
      const orderedViewIds = ordered as string[];
      const requestDigest = digest(boundRequest);
      const intents = [orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest)];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      const items = repository.reorder({
        workspaceId: input.scope.workspaceId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision }),
        now: now(),
      });
      return { workspaceId: input.scope.workspaceId, workspaceRevision: repository.getWorkspaceRevision(input.scope.workspaceId), items };
    },
    remove(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewRemoveRequestSchema.parse(input.request);
      const boundRequest = { kind: "remove", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return;
      const current = repository.list(input.scope.workspaceId);
      const target = current.find((view) => view.id === input.viewId);
      if (!target) throw new OrganizationViewNotFoundError();
      const orderedViewIds = current.filter((view) => view.id !== input.viewId).map((view) => view.id);
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId: input.viewId, mutation: "update", requestDigest, remove: true }),
        orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      repository.remove({
        workspaceId: input.scope.workspaceId,
        viewId: input.viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, {
          [viewResourceId(input.viewId)]: request.expectedRevision,
          [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision,
        }),
        now: now(),
      });
    },
    results(input: { scope: OrganizationViewScope; viewId: string; query: unknown }) {
      const view = repository.get(input.scope.workspaceId, input.viewId);
      if (!view) throw new OrganizationViewNotFoundError();
      authorizedAccountIds(input.scope, view.definition.accountIds);
      return repository.query({ scope: input.scope, view, query: organizationViewResultQuerySchema.parse(input.query) });
    },
  };
}
