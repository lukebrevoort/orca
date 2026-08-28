import { createHash } from "node:crypto";

import {
  organizationLaneApplySchema,
  organizationLaneConfigurationSchema,
  threadLanePlacementSchema,
  type OrganizationActor,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationExecutionContext,
  type OrganizationLaneAction,
  type OrganizationLaneApplyResponse,
  type OrganizationLaneConfiguration,
  type ThreadLanePlacement,
} from "@orca/shared";

export type OrganizationLaneSnapshot = {
  configuration: OrganizationLaneConfiguration;
  placements: ThreadLanePlacement[];
};

export class OrganizationLaneValidationError extends Error {
  readonly code = "lane_validation_error" as const;
  constructor(message: string) { super(message); this.name = "OrganizationLaneValidationError"; }
}

export class OrganizationSafetyLockError extends Error {
  readonly code = "safety_lock_denied" as const;
  constructor(message = "Safety Lock prevents changing this Thread placement") { super(message); this.name = "OrganizationSafetyLockError"; }
}

function key(accountId: string, threadId: string) { return `${accountId}\0${threadId}`; }

export function fallbackPlacement(input: { accountId: string; threadId: string; fallbackLaneId: string }): ThreadLanePlacement {
  return threadLanePlacementSchema.parse({
    accountId: input.accountId,
    threadId: input.threadId,
    primaryLaneId: input.fallbackLaneId,
    manualOverride: null,
    safetyLock: { locked: false, actor: null, reason: null, updatedAt: null },
    evidence: {
      winningSource: "workspace_fallback",
      sourceId: input.fallbackLaneId,
      precedenceLevel: "5_workspace_fallback",
      actor: { id: "system:workspace-fallback", type: "system" },
      reason: "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.",
    },
    revision: null,
  });
}

function placementWithEvidence(placement: ThreadLanePlacement): ThreadLanePlacement {
  if (placement.safetyLock.locked) {
    if (!placement.safetyLock.actor || !placement.safetyLock.reason) {
      throw new OrganizationLaneValidationError("A locked Thread must preserve the Safety Lock Actor and reason");
    }
    return threadLanePlacementSchema.parse({
      ...placement,
      evidence: {
        winningSource: "safety_lock",
        sourceId: placement.primaryLaneId,
        precedenceLevel: "1_safety_lock",
        actor: placement.safetyLock.actor,
        reason: placement.safetyLock.reason,
      },
    });
  }
  if (placement.manualOverride) {
    return threadLanePlacementSchema.parse({
      ...placement,
      primaryLaneId: placement.manualOverride.laneId,
      evidence: {
        winningSource: "manual_override",
        sourceId: placement.manualOverride.laneId,
        precedenceLevel: "2_manual_override",
        actor: placement.manualOverride.actor,
        reason: placement.manualOverride.reason,
      },
    });
  }
  if (placement.evidence.winningSource === "rule_revision" || placement.evidence.winningSource === "lane_policy") {
    return threadLanePlacementSchema.parse(placement);
  }
  return threadLanePlacementSchema.parse({
    ...placement,
    evidence: {
      winningSource: "workspace_fallback",
      sourceId: placement.primaryLaneId,
      precedenceLevel: "5_workspace_fallback",
      actor: { id: "system:workspace-fallback", type: "system" },
      reason: "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.",
    },
  });
}

export function applyLaneActions(
  snapshot: OrganizationLaneSnapshot,
  actions: readonly OrganizationLaneAction[],
  input: { actor: OrganizationActor; authorizedAccountIds: readonly string[]; existingThreads: ReadonlySet<string>; now: string },
): OrganizationLaneSnapshot {
  const configuration = structuredClone(snapshot.configuration);
  const placements = new Map(snapshot.placements.map((placement) => [key(placement.accountId, placement.threadId), structuredClone(placement)]));
  const authorized = new Set(input.authorizedAccountIds);
  const touchedThreads = new Set<string>();

  for (const action of actions) {
    if (action.kind === "define_lane_policy") {
      if (configuration.policies.some((policy) => policy.id === action.id)) throw new OrganizationLaneValidationError(`Lane Policy ${action.id} already exists`);
      configuration.policies.push({ id: action.id, visibility: action.visibility, interruption: action.interruption, review: action.review, retention: action.retention, providerDeletion: false, revision: 1 });
      continue;
    }
    if (action.kind === "update_lane_policy") {
      const policy = configuration.policies.find((item) => item.id === action.policyId);
      if (!policy) throw new OrganizationLaneValidationError(`Lane Policy ${action.policyId} does not exist`);
      if (policy.revision !== action.expectedRevision) throw new OrganizationLaneValidationError(`Lane Policy ${action.policyId} revision is stale`);
      if (action.visibility !== undefined) policy.visibility = action.visibility;
      if (action.interruption !== undefined) policy.interruption = action.interruption;
      if (action.review !== undefined) policy.review = action.review;
      if (action.retention !== undefined) policy.retention = action.retention;
      policy.providerDeletion = false;
      policy.revision += 1;
      continue;
    }
    if (action.kind === "define_lane") {
      if (configuration.lanes.some((lane) => lane.id === action.id)) throw new OrganizationLaneValidationError(`Lane ${action.id} already exists`);
      if (!configuration.policies.some((policy) => policy.id === action.defaultPolicyId)) throw new OrganizationLaneValidationError(`Lane Policy ${action.defaultPolicyId} does not exist`);
      configuration.lanes.push({ id: action.id, name: action.name, position: action.position, defaultPolicyId: action.defaultPolicyId, retiredAt: null, revision: 1 });
      continue;
    }
    if (action.kind === "update_lane") {
      const lane = configuration.lanes.find((item) => item.id === action.laneId);
      if (!lane) throw new OrganizationLaneValidationError(`Lane ${action.laneId} does not exist`);
      if (lane.revision !== action.expectedRevision) throw new OrganizationLaneValidationError(`Lane ${action.laneId} revision is stale`);
      if (action.retired === true && lane.id === configuration.fallbackLaneId) throw new OrganizationLaneValidationError("The configured Fallback Lane cannot be retired");
      if (action.retired === true && [...placements.values()].some((placement) => placement.primaryLaneId === lane.id || placement.manualOverride?.laneId === lane.id)) {
        throw new OrganizationLaneValidationError("A Lane with routed Threads cannot be retired until those Threads are moved");
      }
      if (action.defaultPolicyId !== undefined && !configuration.policies.some((policy) => policy.id === action.defaultPolicyId)) throw new OrganizationLaneValidationError(`Lane Policy ${action.defaultPolicyId} does not exist`);
      if (action.name !== undefined) lane.name = action.name;
      if (action.position !== undefined) lane.position = action.position;
      if (action.defaultPolicyId !== undefined) lane.defaultPolicyId = action.defaultPolicyId;
      if (action.retired !== undefined) lane.retiredAt = action.retired ? input.now : null;
      lane.revision += 1;
      continue;
    }
    if (action.kind === "set_fallback_lane") {
      const lane = configuration.lanes.find((item) => item.id === action.laneId);
      if (!lane || lane.retiredAt) throw new OrganizationLaneValidationError("Fallback Lane must be an active Lane");
      configuration.fallbackLaneId = lane.id;
      for (const placement of placements.values()) {
        if (placement.evidence.winningSource === "workspace_fallback" && !placement.safetyLock.locked) {
          placement.primaryLaneId = lane.id;
          placement.revision = (placement.revision ?? 0) + 1;
        }
      }
      continue;
    }

    if (!authorized.has(action.accountId)) throw new OrganizationLaneValidationError(`Account ${action.accountId} is outside the authorized scope`);
    const threadKey = key(action.accountId, action.threadId);
    if (!input.existingThreads.has(threadKey)) throw new OrganizationLaneValidationError(`Thread ${action.threadId} does not exist in Account ${action.accountId}`);
    if (touchedThreads.has(threadKey)) throw new OrganizationLaneValidationError("A Lane command can change each Thread only once");
    touchedThreads.add(threadKey);
    const placement = placements.get(threadKey) ?? fallbackPlacement({ accountId: action.accountId, threadId: action.threadId, fallbackLaneId: configuration.fallbackLaneId });
    if (placement.revision !== action.expectedThreadRevision) throw new OrganizationLaneValidationError(`Thread ${action.threadId} Organization revision is stale`);
    if (action.kind === "set_thread_manual_override") {
      if (placement.safetyLock.locked) throw new OrganizationSafetyLockError();
      if (action.laneId !== null) {
        const lane = configuration.lanes.find((item) => item.id === action.laneId);
        if (!lane || lane.retiredAt) throw new OrganizationLaneValidationError("Manual Override must select an active Lane");
        placement.manualOverride = { laneId: lane.id, actor: input.actor, reason: action.reason, updatedAt: input.now };
        placement.primaryLaneId = lane.id;
      } else {
        placement.manualOverride = null;
        placement.primaryLaneId = configuration.fallbackLaneId;
      }
    } else {
      placement.safetyLock = action.locked
        ? { locked: true, actor: input.actor, reason: action.reason, updatedAt: input.now }
        : { locked: false, actor: input.actor, reason: action.reason, updatedAt: input.now };
    }
    placement.revision = (placement.revision ?? 0) + 1;
    placements.set(threadKey, placementWithEvidence(placement));
  }

  configuration.workspaceRevision += 1;
  if (new Set(configuration.lanes.map((lane) => lane.position)).size !== configuration.lanes.length) {
    throw new OrganizationLaneValidationError("Lane positions must be unique after reorder");
  }
  configuration.lanes.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  return {
    configuration: organizationLaneConfigurationSchema.parse(configuration),
    placements: [...placements.values()].map(placementWithEvidence),
  };
}

export type OrganizationLanesRepository = {
  getSnapshot(workspaceId: string, accountIds: readonly string[]): OrganizationLaneSnapshot;
  getAuthorityState(workspaceId: string): { workspaceRevision: number; resourceRevisions: Record<string, number>; reservedIdempotencyKeys: string[] };
  apply(input: {
    executionContext: OrganizationExecutionContext;
    authorityTrace: OrganizationAuthorityTrace;
    boundCommand: OrganizationCommand;
    command: unknown;
  }): OrganizationLaneApplyResponse;
};

export function parseLaneApply(command: unknown) {
  return organizationLaneApplySchema.parse(command);
}

export function digestLaneActions(actions: readonly OrganizationLaneAction[]): string {
  return createHash("sha256").update(JSON.stringify(actions)).digest("base64url");
}
