import { createHash } from "node:crypto";

import {
  organizationCollectionPinApplyRequestSchema,
  organizationCollectionPinDescribeResponseSchema,
  organizationCollectionPinQueryResponseSchema,
  organizationCollectionPinQuerySchema,
  organizationCollectionPinRevertRequestSchema,
  organizationCollectionPinScopeSchema,
  type OrganizationCollectionPinApplyRequest,
  type OrganizationCollectionPinAuditEntry,
  type OrganizationCollectionPinChange,
  type OrganizationCollectionPinMutationResponse,
  type OrganizationCollectionPinQuery,
  type OrganizationCollectionPinQueryResponse,
  type OrganizationCollectionPinRevertRequest,
  type OrganizationCollectionPinScope,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
} from "@orca/shared";
import { authorizeOrganizationOperation } from "../authority.ts";
import { requireOrganizationCapability, type OrganizationAgentCapabilitySource } from "../agent-capability.ts";

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
  getAuthorityState(workspaceId: string): {
    workspaceRevision: number;
    resourceRevisions: Record<string, number>;
    reservedIdempotencyKeys: string[];
  };
  replay(input: {
    scope: OrganizationCollectionPinScope;
    idempotencyKey: string;
    operation: "apply" | "revert";
    command: unknown;
    agentCapabilitySource?: OrganizationAgentCapabilitySource;
  }): OrganizationCollectionPinAuditEntry | null;
  getRevertAuthorityTargets(workspaceId: string, changeId: string): Array<{
    changeKind: OrganizationCollectionPinAuditEntry["changeKind"];
    resourceId: string;
    mutation: "create" | "update";
  }> | null;
  query(input: { workspaceId: string; accountIds: string[]; query: OrganizationCollectionPinQuery }): OrganizationCollectionPinQueryResponse;
  apply(input: {
    scope: OrganizationCollectionPinScope;
    request: OrganizationCollectionPinApplyRequest;
    changeId: string;
    trustedResourceIds: { primary: string; savedQuery: string | null } | null;
    authorization: { executionContext: OrganizationExecutionContext; trace: OrganizationAuthorityTrace; command: OrganizationCommand; agentCapabilitySource?: OrganizationAgentCapabilitySource };
    now: Date;
  }): OrganizationCollectionPinAuditEntry;
  revert(input: {
    scope: OrganizationCollectionPinScope;
    request: OrganizationCollectionPinRevertRequest;
    changeId: string;
    authorization: { executionContext: OrganizationExecutionContext; trace: OrganizationAuthorityTrace; command: OrganizationCommand; agentCapabilitySource?: OrganizationAgentCapabilitySource };
    now: Date;
  }): OrganizationCollectionPinAuditEntry;
  audit(input: { workspaceId: string; accountIds: string[] }): OrganizationCollectionPinAuditEntry[];
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestOrganizationCollectionPinChange(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function authorityResourceId(kind: "collection" | "pin" | "saved_query", id: string) {
  return `${kind}:${id}`;
}

function intentKind(kind: OrganizationCollectionPinAuditEntry["changeKind"]) {
  if (kind === "pin") return "mutate_shortcut" as const;
  if (kind === "saved_query") return "mutate_saved_query" as const;
  return "mutate_collection" as const;
}

type TrustedResourceIds = { primary: string; savedQuery: string | null } | null;
type RevertAuthorityTarget = {
  changeKind: OrganizationCollectionPinAuditEntry["changeKind"];
  resourceId: string;
  mutation: "create" | "update";
};

export function bindOrganizationCollectionPinApplyCommand(input: {
  changeId: string;
  change: OrganizationCollectionPinChange;
  trustedResourceIds: TrustedResourceIds;
}): OrganizationCommand {
  const { change, changeId, trustedResourceIds } = input;
  const typedChangeDigest = digestOrganizationCollectionPinChange(change);
  const primaryId = change.kind === "collection_membership"
    ? change.collectionId
    : change.action === "create"
      ? trustedResourceIds?.primary
      : change.kind === "collection"
        ? change.collectionId
        : change.kind === "pin"
          ? change.pinId
          : change.queryId;
  if (!primaryId) throw new OrganizationCollectionsPinsAccessError("Trusted Organization resource identity is missing");
  const primaryKind = change.kind === "collection_membership" ? "collection" : change.kind;
  const additionalQueryId = change.kind === "pin" && change.action === "create" && change.pin.target.type === "new_query"
    ? trustedResourceIds?.savedQuery
    : null;
  if (change.kind === "pin" && change.action === "create" && change.pin.target.type === "new_query" && !additionalQueryId) {
    throw new OrganizationCollectionsPinsAccessError("Trusted saved-query identity is missing");
  }
  return {
    id: changeId,
    intents: [{
      kind: intentKind(change.kind),
      resourceId: authorityResourceId(primaryKind, primaryId),
      mutation: change.action === "create" ? "create" : "update",
      changes: { action: change.action, typedChangeDigest },
    }, ...(additionalQueryId ? [{
      kind: "mutate_saved_query" as const,
      resourceId: authorityResourceId("saved_query", additionalQueryId),
      mutation: "create" as const,
      changes: { action: "create", typedChangeDigest },
    }] : [])],
  };
}

export function bindOrganizationCollectionPinRevertCommand(input: {
  changeId: string;
  request: OrganizationCollectionPinRevertRequest;
  targets: RevertAuthorityTarget[];
}): OrganizationCommand {
  const typedChangeDigest = digestOrganizationCollectionPinChange(input.request);
  return {
    id: input.changeId,
    intents: input.targets.map((target) => ({
      kind: intentKind(target.changeKind),
      resourceId: target.resourceId,
      mutation: target.mutation,
      changes: { action: "revert", typedChangeDigest },
    })),
  };
}

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
    agentCapabilitySource?: OrganizationAgentCapabilitySource;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const newChangeId = dependencies.newChangeId ?? (() => `organization-change:${crypto.randomUUID()}`);
  const newResourceId = dependencies.newResourceId
    ?? ((kind: "collection" | "pin" | "saved_query") => `${kind === "saved_query" ? "query" : kind}:${crypto.randomUUID()}`);

  function authorizeBound(input: {
    scope: OrganizationCollectionPinScope;
    operation: "apply" | "revert";
    idempotencyKey: string;
    command: OrganizationCommand;
    expectedWorkspaceRevision?: number;
  }) {
    const live = repository.getAuthorityState(input.scope.workspaceId);
    const expectedResources = Object.fromEntries(input.command.intents.flatMap((intent) => {
      if (intent.mutation !== "update") return [];
      const revision = live.resourceRevisions[intent.resourceId];
      return revision === undefined ? [] : [[intent.resourceId, revision]];
    }));
    const humanCapability = (actor: OrganizationCollectionPinScope["actor"] & { type: "human" }): OrganizationCapabilitySnapshot => ({
      id: `first_party:human:${actor.id}`,
      revision: 1,
      actor,
      scope: { workspaceId: input.scope.workspaceId, accountIds: input.scope.accountIds },
      operations: ["describe", "query", "apply", "revert"],
      resourceFamilies: ["collection", "shortcut", "saved_query", "thread", "audit", "change_set"],
      actionFamilies: ["organization_read", "organization_structure", "organization_thread"],
    });
    let liveCapability;
    try {
      liveCapability = requireOrganizationCapability(input.scope, humanCapability, dependencies.agentCapabilitySource);
    } catch (error) {
      throw new OrganizationCollectionsPinsAccessError(error instanceof Error ? error.message : "Collections/Pins Actor is not authorized");
    }
    const capability = liveCapability.snapshot;
    const decision = authorizeOrganizationOperation({
      actor: input.scope.actor,
      capabilitySnapshot: capability,
      operation: input.operation,
      scope: capability.scope,
      command: input.command,
      expectedRevisions: { workspace: input.expectedWorkspaceRevision ?? live.workspaceRevision, resources: expectedResources },
      idempotencyKey: input.idempotencyKey,
    }, {
      scope: capability.scope,
      capability: liveCapability,
      workspaceRevision: live.workspaceRevision,
      resourceRevisions: live.resourceRevisions,
      reservedIdempotencyKeys: live.reservedIdempotencyKeys,
    });
    if (!decision.allowed) {
      if (decision.code === "revision_conflict" || decision.code === "duplicate_idempotency_key") {
        throw new OrganizationCollectionsPinsConflictError(decision.reason);
      }
      throw new OrganizationCollectionsPinsAccessError(decision.reason);
    }
    return { executionContext: decision.executionContext, trace: decision.trace, command: input.command, ...(input.scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) };
  }

  function queryAuthorized(scope: OrganizationCollectionPinScope, query: OrganizationCollectionPinQuery) {
    const accountIds = authorizeQueryAccounts(scope.accountIds, query);
    return organizationCollectionPinQueryResponseSchema.parse(repository.query({
      workspaceId: scope.workspaceId,
      accountIds,
      query: { ...query, accountIds },
    }));
  }

  function idempotentReplay(
    scope: OrganizationCollectionPinScope,
    idempotencyKey: string,
    operation: "apply" | "revert",
    command: unknown,
  ) {
    return repository.replay({ scope, idempotencyKey, operation, command, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) });
  }

  return {
    describe(input: { scope: unknown }) {
      const { scope, accountIds } = authorize(repository, input.scope);
      const canWrite = scope.actor.type === "human" || (scope.actor.type === "agent" && Boolean(dependencies.agentCapabilitySource));
      return organizationCollectionPinDescribeResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds,
        semantics: { collections: "explicit_thread_membership", pins: "stable_shortcut_identity" },
        operations: { describe: true, query: true, apply: canWrite, revert: canWrite, simulate: false },
        authority: { sendMail: false, deleteProviderMail: false },
      });
    },
    query(input: { scope: unknown; query: unknown }) {
      const { scope } = authorize(repository, input.scope);
      return queryAuthorized(scope, organizationCollectionPinQuerySchema.parse(input.query));
    },
    apply(input: { scope: unknown; request: unknown; expectedWorkspaceRevision?: number }): OrganizationCollectionPinMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationCollectionPinApplyRequestSchema.parse(input.request);
      if (!scope.accountIds.includes(request.change.accountId)) throw new OrganizationCollectionsPinsAccessError();
      const replay = idempotentReplay(scope, request.idempotencyKey, "apply", request.change);
      if (replay) return { change: replay, state: queryAuthorized(scope, {}) };
      const trustedResourceIds = request.change.action === "create" && (
        request.change.kind === "collection" || request.change.kind === "pin" || request.change.kind === "saved_query"
      ) ? {
          primary: newResourceId(request.change.kind),
          savedQuery: request.change.kind === "pin" && request.change.pin.target.type === "new_query"
            ? newResourceId("saved_query")
            : null,
        } : null;
      const changeId = newChangeId();
      const command = bindOrganizationCollectionPinApplyCommand({ changeId, change: request.change, trustedResourceIds });
      const authorization = authorizeBound({ scope, operation: "apply", idempotencyKey: request.idempotencyKey, command, expectedWorkspaceRevision: input.expectedWorkspaceRevision });
      const change = repository.apply({ scope, request, changeId, trustedResourceIds, authorization, now: now() });
      return { change, state: queryAuthorized(scope, {}) };
    },
    revert(input: { scope: unknown; request: unknown }): OrganizationCollectionPinMutationResponse {
      const { scope } = authorize(repository, input.scope);
      const request = organizationCollectionPinRevertRequestSchema.parse(input.request);
      const replay = idempotentReplay(scope, request.idempotencyKey, "revert", { revert: request.changeId });
      if (replay) return { change: replay, state: queryAuthorized(scope, {}) };
      const targets = repository.getRevertAuthorityTargets(scope.workspaceId, request.changeId);
      if (!targets) throw new OrganizationCollectionsPinsNotFoundError("Organization change not found in the authorized Account scope");
      const changeId = newChangeId();
      const command = bindOrganizationCollectionPinRevertCommand({ changeId, request, targets });
      const authorization = authorizeBound({ scope, operation: "revert", idempotencyKey: request.idempotencyKey, command });
      const change = repository.revert({ scope, request, changeId, authorization, now: now() });
      return { change, state: queryAuthorized(scope, {}) };
    },
    audit(input: { scope: unknown }) {
      const { scope, accountIds } = authorize(repository, input.scope);
      return repository.audit({ workspaceId: scope.workspaceId, accountIds });
    },
  };
}
