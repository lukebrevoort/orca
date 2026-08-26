import {
  organizationViewCreateRequestSchema,
  organizationViewResultQuerySchema,
  organizationViewUpdateRequestSchema,
  type OrganizationView,
  type OrganizationViewCreateRequest,
  type OrganizationViewResultPage,
  type OrganizationViewResultQuery,
  type OrganizationViewUpdateRequest,
} from "@orca/shared";

export class OrganizationViewAccessError extends Error {
  readonly code = "account_denied" as const;
  constructor(message = "The requested Account scope is not authorized for this Workspace") { super(message); this.name = "OrganizationViewAccessError"; }
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

export type OrganizationViewScope = {
  workspaceId: string;
  accountIds: string[];
  actor: { id: string; type: "human" | "agent" | "system" };
};

export type OrganizationViewsRepository = {
  list(workspaceId: string): OrganizationView[];
  get(workspaceId: string, viewId: string): OrganizationView | null;
  create(input: { workspaceId: string; viewId: string; request: OrganizationViewCreateRequest; now: Date }): OrganizationView;
  update(input: { workspaceId: string; viewId: string; request: OrganizationViewUpdateRequest; now: Date }): OrganizationView;
  remove(input: { workspaceId: string; viewId: string; expectedRevision: number }): void;
  query(input: { scope: OrganizationViewScope; view: OrganizationView; query: OrganizationViewResultQuery }): OrganizationViewResultPage;
};

function authorizedAccountIds(scope: OrganizationViewScope, requested: readonly string[] | undefined) {
  const owned = new Set(scope.accountIds);
  const accountIds = requested ? [...requested] : [...scope.accountIds];
  if (accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationViewAccessError();
  return accountIds.sort();
}

export function createOrganizationViews(repository: OrganizationViewsRepository, dependencies: { newViewId?: () => string; now?: () => Date } = {}) {
  const newViewId = dependencies.newViewId ?? (() => `view_${crypto.randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());
  return {
    list(input: { scope: OrganizationViewScope }) {
      authorizedAccountIds(input.scope, undefined);
      return { workspaceId: input.scope.workspaceId, items: repository.list(input.scope.workspaceId) };
    },
    create(input: { scope: OrganizationViewScope; request: unknown }) {
      if (input.scope.actor.type !== "human") throw new OrganizationViewAccessError("Only an authenticated human can create a View");
      const request = organizationViewCreateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.definition.accountIds);
      return repository.create({ workspaceId: input.scope.workspaceId, viewId: newViewId(), request, now: now() });
    },
    update(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      if (input.scope.actor.type !== "human") throw new OrganizationViewAccessError("Only an authenticated human can update a View");
      const request = organizationViewUpdateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.patch.definition?.accountIds);
      if (!repository.get(input.scope.workspaceId, input.viewId)) throw new OrganizationViewNotFoundError();
      return repository.update({ workspaceId: input.scope.workspaceId, viewId: input.viewId, request, now: now() });
    },
    remove(input: { scope: OrganizationViewScope; viewId: string; expectedRevision: number }) {
      if (input.scope.actor.type !== "human") throw new OrganizationViewAccessError("Only an authenticated human can remove a View");
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new OrganizationViewConflictError("A positive expected View revision is required");
      repository.remove({ workspaceId: input.scope.workspaceId, viewId: input.viewId, expectedRevision: input.expectedRevision });
    },
    results(input: { scope: OrganizationViewScope; viewId: string; query: unknown }) {
      const view = repository.get(input.scope.workspaceId, input.viewId);
      if (!view) throw new OrganizationViewNotFoundError();
      authorizedAccountIds(input.scope, view.definition.accountIds);
      const query = organizationViewResultQuerySchema.parse(input.query);
      return repository.query({ scope: input.scope, view, query });
    },
  };
}
