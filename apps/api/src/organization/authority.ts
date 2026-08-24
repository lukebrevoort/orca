import { createHash } from "node:crypto";

import {
  organizationLiveAuthorityStateSchema,
  organizationOperationRequestSchema,
  type OrganizationActionFamily,
  type OrganizationActorType,
  type OrganizationAuthorityDenialCode,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationCommandIntent,
  type OrganizationExecutionContext,
  type OrganizationLiveAuthorityState,
  type OrganizationOperation,
  type OrganizationOperationRequest,
  type OrganizationResourceFamily,
  type OrganizationRisk,
} from "@orca/shared";

export const organizationActorOperationMatrix = {
  human: ["describe", "query", "simulate", "apply", "revert"],
  agent: ["describe", "query", "simulate", "apply", "revert"],
  system: ["describe", "query", "simulate", "apply"],
} as const satisfies Record<OrganizationActorType, readonly OrganizationOperation[]>;

type CommandRequirement = {
  resourceFamily: OrganizationResourceFamily;
  actionFamily: OrganizationActionFamily;
  risk: OrganizationRisk;
  mutates: boolean;
};

const commandRequirements = {
  describe_workspace: { resourceFamily: "workspace_schema", actionFamily: "organization_read", risk: "read_only", mutates: false },
  query_mail: { resourceFamily: "mail", actionFamily: "organization_read", risk: "read_only", mutates: false },
  query_trace: { resourceFamily: "trace", actionFamily: "organization_read", risk: "read_only", mutates: false },
  query_audit: { resourceFamily: "audit", actionFamily: "organization_read", risk: "read_only", mutates: false },
  mutate_lane: { resourceFamily: "lane", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_view: { resourceFamily: "view", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_collection: { resourceFamily: "collection", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_shortcut: { resourceFamily: "shortcut", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_saved_query: { resourceFamily: "saved_query", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_facet: { resourceFamily: "facet", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_context: { resourceFamily: "context", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_workflow_state: { resourceFamily: "workflow_state", actionFamily: "organization_structure", risk: "medium", mutates: true },
  mutate_rule: { resourceFamily: "rule", actionFamily: "organization_structure", risk: "high", mutates: true },
  organize_thread: { resourceFamily: "thread", actionFamily: "organization_thread", risk: "medium", mutates: true },
  change_attention: { resourceFamily: "thread", actionFamily: "organization_attention", risk: "medium", mutates: true },
  send_mail: { resourceFamily: "mail", actionFamily: "mail_send", risk: "destructive", mutates: true },
  delete_provider_mail: { resourceFamily: "mail", actionFamily: "provider_delete", risk: "destructive", mutates: true },
} as const satisfies Record<OrganizationCommandIntent["kind"], CommandRequirement>;

const riskRank: Record<OrganizationRisk, number> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
  destructive: 4,
};

export type OrganizationAuthorityDecision =
  | {
      allowed: true;
      executionContext: OrganizationExecutionContext;
      trace: OrganizationAuthorityTrace;
    }
  | {
      allowed: false;
      code: OrganizationAuthorityDenialCode;
      reason: string;
      trace: OrganizationAuthorityTrace | null;
    };

type DerivedCommand = {
  command: { id: string; digest: string };
  resourceFamilies: OrganizationResourceFamily[];
  actionFamilies: OrganizationActionFamily[];
  resourceIds: string[];
  risk: OrganizationRisk;
  resourceMutations: Array<{ resourceId: string; mutation: "create" | "update" }>;
  hasMutation: boolean;
  hasRead: boolean;
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bindCommand(command: OrganizationCommand): DerivedCommand {
  const requirements = command.intents.map((intent) => commandRequirements[intent.kind]);
  const risk = requirements.reduce<OrganizationRisk>(
    (highest, requirement) => riskRank[requirement.risk] > riskRank[highest] ? requirement.risk : highest,
    "read_only",
  );
  return {
    command: {
      id: command.id,
      digest: `sha256:${createHash("sha256").update(canonicalJson(command)).digest("hex")}`,
    },
    resourceFamilies: unique(requirements.map((requirement) => requirement.resourceFamily)),
    actionFamilies: unique(requirements.map((requirement) => requirement.actionFamily)),
    resourceIds: unique(command.intents.map((intent) => intent.resourceId)),
    risk,
    resourceMutations: command.intents.flatMap((intent) => intent.mutation
      ? [{ resourceId: intent.resourceId, mutation: intent.mutation }]
      : []),
    hasMutation: requirements.some((requirement) => requirement.mutates),
    hasRead: requirements.some((requirement) => !requirement.mutates),
  };
}

/** Recomputes the canonical digest that binds an authorized execution payload. */
export function digestOrganizationCommand(command: OrganizationCommand): string {
  return bindCommand(command).command.digest;
}

function traceFor(
  request: OrganizationOperationRequest,
  derived: DerivedCommand,
  decision: "allowed" | "denied",
  reason: string,
  denialCode: OrganizationAuthorityDenialCode | null,
): OrganizationAuthorityTrace {
  return {
    actor: request.actor,
    capabilitySnapshot: request.capabilitySnapshot,
    operation: request.operation,
    scope: request.scope,
    command: derived.command,
    requestedResourceFamilies: derived.resourceFamilies,
    requestedActionFamilies: derived.actionFamilies,
    requestedResourceIds: derived.resourceIds,
    expectedRevisions: request.expectedRevisions,
    risk: derived.risk,
    winner: decision === "allowed"
      ? { source: "authority_gate", sourceId: request.capabilitySnapshot.id }
      : { source: "none", sourceId: null },
    reason,
    decision,
    denialCode,
  };
}

function invalid(
  code: "invalid_request" | "invalid_live_authority",
  reason: string,
): OrganizationAuthorityDecision {
  return { allowed: false, code, reason, trace: null };
}

function deny(
  request: OrganizationOperationRequest,
  derived: DerivedCommand,
  code: OrganizationAuthorityDenialCode,
  reason: string,
): OrganizationAuthorityDecision {
  return { allowed: false, code, reason, trace: traceFor(request, derived, "denied", reason, code) };
}

function sameCapabilitySnapshot(
  claimed: OrganizationOperationRequest["capabilitySnapshot"],
  live: OrganizationLiveAuthorityState["capability"]["snapshot"],
): boolean {
  return JSON.stringify(claimed) === JSON.stringify(live);
}

function operationMatchesCommand(operation: OrganizationOperation, derived: DerivedCommand): boolean {
  if (operation === "describe") {
    return derived.actionFamilies.length === 1 && derived.actionFamilies[0] === "organization_read" &&
      derived.resourceFamilies.every((family) => family === "workspace_schema");
  }
  if (operation === "query") return !derived.hasMutation;
  if (operation === "simulate") return true;
  return derived.hasMutation && !derived.hasRead;
}

/**
 * Runtime-validated G0 authority gate for the deep Organization module.
 *
 * The returned execution context is bound to the parsed command digest. For
 * apply/revert, the eventual transaction must atomically reserve the returned
 * idempotency key while checking the returned expected revisions again.
 */
export function authorizeOrganizationOperation(
  untrustedRequest: unknown,
  untrustedLiveAuthority: unknown,
): OrganizationAuthorityDecision {
  const requestResult = organizationOperationRequestSchema.safeParse(untrustedRequest);
  if (!requestResult.success) return invalid("invalid_request", "The Organization request failed runtime validation");
  const liveResult = organizationLiveAuthorityStateSchema.safeParse(untrustedLiveAuthority);
  if (!liveResult.success) return invalid("invalid_live_authority", "The trusted live authority state failed runtime validation");

  const request = requestResult.data;
  const live = liveResult.data;
  const derived = bindCommand(request.command);
  const eligibleOperations: readonly OrganizationOperation[] = organizationActorOperationMatrix[request.actor.type];

  if (!eligibleOperations.includes(request.operation)) {
    return deny(request, derived, "actor_operation_denied", `${request.actor.type} Actors cannot ${request.operation}`);
  }
  if (
    request.actor.id !== request.capabilitySnapshot.actor.id ||
    request.actor.type !== request.capabilitySnapshot.actor.type
  ) {
    return deny(request, derived, "actor_mismatch", "The Capability snapshot belongs to a different Actor identity or type");
  }
  if (live.capability.revokedAt !== null) {
    return deny(request, derived, "capability_revoked", "The live Capability has been revoked");
  }
  if (!sameCapabilitySnapshot(request.capabilitySnapshot, live.capability.snapshot)) {
    return deny(request, derived, "capability_stale", "The Capability snapshot is not the current live revision");
  }
  if (
    request.scope.workspaceId !== live.scope.workspaceId ||
    request.scope.workspaceId !== request.capabilitySnapshot.scope.workspaceId
  ) {
    return deny(request, derived, "workspace_denied", "Workspace scope is not both current and granted");
  }

  const liveAccountIds = new Set(live.scope.accountIds);
  const grantedAccountIds = new Set(request.capabilitySnapshot.scope.accountIds);
  const requestedAccountIds = unique(request.scope.accountIds);
  if (requestedAccountIds.some((accountId) => !liveAccountIds.has(accountId) || !grantedAccountIds.has(accountId))) {
    return deny(request, derived, "account_denied", "Every requested Account must be both currently owned and granted");
  }
  if (!request.capabilitySnapshot.operations.includes(request.operation)) {
    return deny(request, derived, "missing_operation_capability", `The Capability snapshot does not grant ${request.operation}`);
  }
  if (!operationMatchesCommand(request.operation, derived)) {
    return deny(request, derived, "operation_intent_mismatch", "The operation does not match the exact command intents");
  }

  const grantedResources = new Set(request.capabilitySnapshot.resourceFamilies);
  if (derived.resourceFamilies.some((family) => !grantedResources.has(family))) {
    return deny(request, derived, "resource_family_denied", "A command resource family is outside the Capability snapshot");
  }
  if (derived.actionFamilies.includes("mail_send") || derived.actionFamilies.includes("provider_delete")) {
    return deny(request, derived, "send_delete_forbidden", "M8 Organization authority never includes send or provider deletion");
  }
  if (derived.risk === "destructive") {
    return deny(request, derived, "destructive_risk_forbidden", "Destructive risk is outside M8 Organization authority");
  }

  const grantedActions = new Set(request.capabilitySnapshot.actionFamilies);
  if (derived.actionFamilies.some((family) => !grantedActions.has(family))) {
    return deny(request, derived, "action_family_denied", "A command action family is outside the Capability snapshot");
  }

  const isWrite = request.operation === "apply" || request.operation === "revert";
  if (isWrite) {
    if (!request.idempotencyKey) {
      return deny(request, derived, "idempotency_key_required", `${request.operation} requires an idempotency key`);
    }
    if (live.reservedIdempotencyKeys.includes(request.idempotencyKey)) {
      return deny(request, derived, "duplicate_idempotency_key", "The idempotency key is already reserved");
    }
    if (request.expectedRevisions.workspace === null) {
      return deny(request, derived, "expected_revision_required", `${request.operation} requires an expected Workspace revision`);
    }
    if (request.expectedRevisions.workspace !== live.workspaceRevision) {
      return deny(request, derived, "revision_conflict", "The expected Workspace revision is stale");
    }

    const expectedResourceIds = Object.keys(request.expectedRevisions.resources);
    if (expectedResourceIds.some((resourceId) => !derived.resourceIds.includes(resourceId))) {
      return deny(request, derived, "revision_conflict", "Expected revisions include a resource outside the bound command");
    }
    for (const { resourceId, mutation } of derived.resourceMutations) {
      const liveRevision = live.resourceRevisions[resourceId];
      const expectedRevision = request.expectedRevisions.resources[resourceId];
      if (mutation === "update" && (liveRevision === undefined || expectedRevision !== liveRevision)) {
        return deny(request, derived, "revision_conflict", `Update target ${resourceId} must exist at the exact expected revision`);
      }
      if (mutation === "create" && (liveRevision !== undefined || expectedRevision !== undefined)) {
        return deny(request, derived, "revision_conflict", `Create target ${resourceId} must not already exist or carry an expected revision`);
      }
    }
  }

  return {
    allowed: true,
    executionContext: {
      actor: request.actor,
      command: derived.command,
      operation: request.operation,
      workspaceId: request.scope.workspaceId,
      accountIds: requestedAccountIds,
      capabilityId: request.capabilitySnapshot.id,
      capabilityRevision: request.capabilitySnapshot.revision,
      expectedRevisions: request.expectedRevisions,
      idempotencyKey: request.idempotencyKey,
      requiresAtomicIdempotencyReservation: isWrite,
    },
    trace: traceFor(request, derived, "allowed", "Live scope, live Capability, and bound command authorize this execution precondition", null),
  };
}
