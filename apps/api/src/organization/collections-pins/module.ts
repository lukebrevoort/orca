import {
  organizationCollectionPinApplyRequestSchema,
  organizationCollectionPinDescribeResponseSchema,
  organizationCollectionPinQueryResponseSchema,
  organizationCollectionPinQuerySchema,
  organizationCollectionPinRevertRequestSchema,
  organizationCollectionPinScopeSchema,
  type OrganizationCollectionPinApplyRequest,
  type OrganizationCollectionPinAuditEntry,
  type OrganizationCollectionPinMutationResponse,
  type OrganizationCollectionPinQuery,
  type OrganizationCollectionPinQueryResponse,
  type OrganizationCollectionPinRevertRequest,
  type OrganizationCollectionPinScope,
} from "@orca/shared";

export class OrganizationCollectionsPinsAccessError extends Error {
  readonly code = "account_denied" as const;

  constructor(message = "The requested Account scope is not authorized for this Workspace") {
    super(message);
    this.name = "OrganizationCollectionsPinsAccessError";
  }
}

export class OrganizationCollectionsPinsNotFoundError extends Error {
  readonly code = "not_found" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationCollectionsPinsNotFoundError";
  }
}

export class OrganizationCollectionsPinsConflictError extends Error {
  readonly code = "conflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationCollectionsPinsConflictError";
  }
}

export type OrganizationCollectionsPinsRepository = {
  listAccountIds(workspaceId: string): string[];
  query(input: { workspaceId: string; accountIds: string[]; query: OrganizationCollectionPinQuery }): OrganizationCollectionPinQueryResponse;
  apply(input: {
    scope: OrganizationCollectionPinScope;
    request: OrganizationCollectionPinApplyRequest;
    changeId: string;
    trustedResourceId: string | null;
    now: Date;
  }): OrganizationCollectionPinAuditEntry;
  revert(input: {
    scope: OrganizationCollectionPinScope;
    request: OrganizationCollectionPinRevertRequest;
    changeId: string;
    now: Date;
  }): OrganizationCollectionPinAuditEntry;
  audit(input: { workspaceId: string; accountIds: string[] }): OrganizationCollectionPinAuditEntry[];
};

function authorize(repository: OrganizationCollectionsPinsRepository, untrustedScope: unknown) {
  const scope = organizationCollectionPinScopeSchema.parse(untrustedScope);
  const owned = new Set(repository.listAccountIds(scope.workspaceId));
  if (scope.accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationCollectionsPinsAccessError();
  return { scope, accountIds: [...scope.accountIds].sort() };
}

function authorizeQueryAccounts(scopeAccountIds: readonly string[], query: OrganizationCollectionPinQuery) {
  const requested = query.accountIds ? [...query.accountIds].sort() : [...scopeAccountIds];
  const scoped = new Set(scopeAccountIds);
  if (requested.some((accountId) => !scoped.has(accountId))) throw new OrganizationCollectionsPinsAccessError();
  return requested;
}

export function createOrganizationCollectionsPins(
  repository: OrganizationCollectionsPinsRepository,
  dependencies: {
    now?: () => Date;
    newChangeId?: () => string;
    newResourceId?: (kind: "collection" | "pin" | "saved_query") => string;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const newChangeId = dependencies.newChangeId ?? (() => `organization-change:${crypto.randomUUID()}`);
  const newResourceId = dependencies.newResourceId
    ?? ((kind: "collection" | "pin" | "saved_query") => `${kind === "saved_query" ? "query" : kind}:${crypto.randomUUID()}`);

  function queryAuthorized(scope: OrganizationCollectionPinScope, query: OrganizationCollectionPinQuery) {
    const accountIds = authorizeQueryAccounts(scope.accountIds, query);
    return organizationCollectionPinQueryResponseSchema.parse(repository.query({
      workspaceId: scope.workspaceId,
      accountIds,
      query: { ...query, accountIds },
    }));
  }

  return {
    describe(input: { scope: unknown }) {
      const { scope, accountIds } = authorize(repository, input.scope);
      return organizationCollectionPinDescribeResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds,
        semantics: { collections: "explicit_thread_membership", pins: "stable_shortcut_identity" },
        operations: { describe: true, query: true, apply: true, revert: true, simulate: false },
        authority: { sendMail: false, deleteProviderMail: false },
      });
    },
    query(input: { scope: unknown; query: unknown }) {
      const { scope } = authorize(repository, input.scope);
      return queryAuthorized(scope, organizationCollectionPinQuerySchema.parse(input.query));
    },
    apply(input: { scope: unknown; request: unknown }): OrganizationCollectionPinMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationCollectionPinApplyRequestSchema.parse(input.request);
      if (!scope.accountIds.includes(request.change.accountId)) throw new OrganizationCollectionsPinsAccessError();
      const trustedResourceId = request.change.action === "create" && (
        request.change.kind === "collection" || request.change.kind === "pin" || request.change.kind === "saved_query"
      ) ? newResourceId(request.change.kind) : null;
      const change = repository.apply({ scope, request, changeId: newChangeId(), trustedResourceId, now: now() });
      return { change, state: queryAuthorized(scope, {}) };
    },
    revert(input: { scope: unknown; request: unknown }): OrganizationCollectionPinMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationCollectionPinRevertRequestSchema.parse(input.request);
      const change = repository.revert({ scope, request, changeId: newChangeId(), now: now() });
      return { change, state: queryAuthorized(scope, {}) };
    },
    audit(input: { scope: unknown }) {
      const { scope, accountIds } = authorize(repository, input.scope);
      return repository.audit({ workspaceId: scope.workspaceId, accountIds });
    },
  };
}
