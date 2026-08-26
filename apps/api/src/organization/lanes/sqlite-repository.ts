import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  laneInterruptionSchema,
  laneReviewSchema,
  laneVisibilitySchema,
  organizationLaneApplyResponseSchema,
  organizationLaneConfigurationSchema,
  threadLanePlacementSchema,
  type OrganizationActor,
  type ThreadLanePlacement,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationLanePolicies,
  organizationLanes,
  organizationThreadLaneStates,
  organizationWorkspaceLaneSettings,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import { digestOrganizationCommand } from "../authority.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../module.ts";
import {
  applyLaneActions,
  digestLaneActions,
  parseLaneApply,
  type OrganizationLaneSnapshot,
  type OrganizationLanesRepository,
} from "./module.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function laneResourceId(id: string) { return `lane:${id}`; }
function policyResourceId(id: string) { return `lane_policy:${id}`; }
function threadResourceId(accountId: string, threadId: string) { return `thread:${accountId}:${threadId}`; }
function fallbackResourceId(workspaceId: string) { return `workspace_fallback:${workspaceId}`; }
function auditResourceId(action: ReturnType<typeof parseLaneApply>["actions"][number]): string {
  if (action.kind === "define_lane_policy") return action.id;
  if (action.kind === "update_lane_policy") return action.policyId;
  if (action.kind === "define_lane") return action.id;
  if (action.kind === "update_lane" || action.kind === "set_fallback_lane") return action.laneId;
  return `${action.accountId}:${action.threadId}`;
}

function actor(type: string, id: string): OrganizationActor {
  return { type: type === "human" ? "human" : type === "agent" ? "agent" : "system", id };
}

function loadSnapshot(executor: Database, workspaceId: string, accountIds: readonly string[]): OrganizationLaneSnapshot {
  const state = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const settings = executor.select().from(organizationWorkspaceLaneSettings).where(eq(organizationWorkspaceLaneSettings.workspaceId, workspaceId)).get();
  if (!settings) throw new OrganizationAuthorityError("invalid_live_authority", "Workspace Lane defaults are not provisioned");
  const policies = executor.select().from(organizationLanePolicies)
    .where(eq(organizationLanePolicies.workspaceId, workspaceId)).orderBy(asc(organizationLanePolicies.id)).all()
    .map((policy) => ({
      id: policy.id,
      visibility: laneVisibilitySchema.parse(policy.visibility),
      interruption: laneInterruptionSchema.parse(policy.interruption),
      review: laneReviewSchema.parse(policy.review),
      retention: policy.retentionMode === "keep" ? { mode: "keep" as const, days: null } : { mode: "review_after" as const, days: policy.retentionDays },
      providerDeletion: false as const,
      revision: policy.revision,
    }));
  const lanes = executor.select().from(organizationLanes)
    .where(eq(organizationLanes.workspaceId, workspaceId)).orderBy(asc(organizationLanes.position), asc(organizationLanes.id)).all()
    .map((lane) => ({ id: lane.id, name: lane.name, position: lane.position, defaultPolicyId: lane.defaultPolicyId, retiredAt: lane.retiredAt?.toISOString() ?? null, revision: lane.revision }));
  const rows = accountIds.length === 0 ? [] : executor.select().from(organizationThreadLaneStates)
    .where(and(eq(organizationThreadLaneStates.workspaceId, workspaceId), inArray(organizationThreadLaneStates.accountId, [...accountIds]))).all();
  const placements = rows.map((row): ThreadLanePlacement => {
    const sourceActor = actor(row.actorType, row.actorId);
    const manualOverride = row.manualOverrideLaneId && row.manualOverrideAt
      ? { laneId: row.manualOverrideLaneId, actor: sourceActor, reason: row.reason, updatedAt: row.manualOverrideAt.toISOString() }
      : null;
    const source = manualOverride ? "manual_override" as const : "workspace_fallback" as const;
    return threadLanePlacementSchema.parse({
      accountId: row.accountId,
      threadId: row.threadId,
      primaryLaneId: row.primaryLaneId,
      manualOverride,
      safetyLock: {
        locked: row.safetyLocked,
        actor: row.safetyLockActorId && row.safetyLockActorType ? actor(row.safetyLockActorType, row.safetyLockActorId) : null,
        reason: row.safetyLockReason,
        updatedAt: row.safetyLockUpdatedAt?.toISOString() ?? null,
      },
      evidence: {
        winningSource: source,
        sourceId: row.sourceId,
        precedenceLevel: source === "manual_override" ? "2_manual_override" : "5_workspace_fallback",
        actor: sourceActor,
        reason: row.reason,
      },
      revision: row.revision,
    });
  });
  return {
    configuration: organizationLaneConfigurationSchema.parse({ workspaceRevision: state?.revision ?? 1, fallbackLaneId: settings.fallbackLaneId, lanes, policies }),
    placements,
  };
}

function resourceRevisions(snapshot: OrganizationLaneSnapshot, workspaceId: string): Record<string, number> {
  return Object.fromEntries([
    ...snapshot.configuration.lanes.map((lane) => [laneResourceId(lane.id), lane.revision] as const),
    ...snapshot.configuration.policies.map((policy) => [policyResourceId(policy.id), policy.revision] as const),
    [fallbackResourceId(workspaceId), 1] as const,
    ...snapshot.placements.flatMap((placement) => placement.revision === null ? [] : [[threadResourceId(placement.accountId, placement.threadId), placement.revision] as const]),
  ]);
}

export function createSqliteOrganizationLanesRepository(db: Database): OrganizationLanesRepository {
  return {
    getSnapshot(workspaceId, accountIds) { return loadSnapshot(db, workspaceId, accountIds); },
    getAuthorityState(workspaceId) {
      const accountIds = db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).all().map((row) => row.id);
      const snapshot = loadSnapshot(db, workspaceId, accountIds);
      return {
        workspaceRevision: snapshot.configuration.workspaceRevision,
        resourceRevisions: resourceRevisions(snapshot, workspaceId),
        reservedIdempotencyKeys: db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets).where(eq(organizationChangeSets.workspaceId, workspaceId)).all().map((row) => row.key),
      };
    },
    apply(input) {
      const parsed = parseLaneApply(input.command);
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const workspaceId = input.executionContext.workspaceId;
        const current = loadSnapshot(executor, workspaceId, input.executionContext.accountIds);
        const expected = input.executionContext.expectedRevisions.workspace;
        if (expected === null || current.configuration.workspaceRevision !== expected) throw new OrganizationRevisionConflictError(expected ?? 0, current.configuration.workspaceRevision);
        if (input.executionContext.command.digest !== digestOrganizationCommand(input.boundCommand)) throw new OrganizationAuthorityError("invalid_request", "Authorized Lane command digest does not match execution payload");
        const actionsDigest = digestLaneActions(parsed.actions);
        if (input.boundCommand.intents.some((intent) => intent.changes?.typedActionsDigest !== actionsDigest)) throw new OrganizationAuthorityError("invalid_request", "Authorized command does not match the exact typed Lane actions");
        const liveResources = resourceRevisions(current, workspaceId);
        for (const intent of input.boundCommand.intents) {
          const liveRevision = liveResources[intent.resourceId];
          const expectedRevision = input.executionContext.expectedRevisions.resources[intent.resourceId];
          if (intent.mutation === "create" && liveRevision !== undefined) throw new OrganizationAuthorityError("revision_conflict", `Create target ${intent.resourceId} now exists`);
          if (intent.mutation === "update" && liveRevision !== expectedRevision) throw new OrganizationAuthorityError("revision_conflict", `Update target ${intent.resourceId} changed before commit`);
        }
        const idempotencyKey = input.executionContext.idempotencyKey;
        if (!idempotencyKey) throw new OrganizationAuthorityError("idempotency_key_required", "An authorized Lane apply must reserve an idempotency key");
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get()) throw new OrganizationAuthorityError("duplicate_idempotency_key", "The idempotency key was already reserved");
        const existingThreads = new Set(executor.select({ accountId: threads.accountId, threadId: threads.id }).from(threads)
          .where(inArray(threads.accountId, [...input.executionContext.accountIds])).all().map((row) => `${row.accountId}\0${row.threadId}`));
        const now = new Date().toISOString();
        const next = applyLaneActions(current, parsed.actions, { actor: input.executionContext.actor, authorizedAccountIds: input.executionContext.accountIds, existingThreads, now });

        transaction.insert(organizationChangeSets).values({
          workspaceId,
          id: input.boundCommand.id,
          idempotencyKey,
          commandDigest: input.executionContext.command.digest,
          authorityTrace: JSON.stringify(input.authorityTrace),
          resourceFamily: "lane",
          operation: "apply",
          commandJson: JSON.stringify(parsed),
          workspaceRevisionBefore: current.configuration.workspaceRevision,
          workspaceRevisionAfter: next.configuration.workspaceRevision,
          createdAt: new Date(now),
        }).run();
        transaction.insert(organizationChangeActions).values(parsed.actions.map((action, position) => ({
          workspaceId,
          changeId: input.boundCommand.id,
          position,
          actionKind: action.kind,
          resourceFamily: action.kind.includes("policy") ? "lane_policy" : action.kind.includes("thread") ? "thread" : "lane",
          resourceId: auditResourceId(action),
          beforeJson: JSON.stringify(current),
          afterJson: JSON.stringify(next),
        }))).run();

        for (const policy of next.configuration.policies) transaction.insert(organizationLanePolicies).values({
          workspaceId, id: policy.id, visibility: policy.visibility, interruption: policy.interruption, review: policy.review,
          retentionMode: policy.retention.mode, retentionDays: policy.retention.days, providerDeletion: false, revision: policy.revision, updatedAt: new Date(now),
        }).onConflictDoUpdate({ target: [organizationLanePolicies.workspaceId, organizationLanePolicies.id], set: {
          visibility: policy.visibility, interruption: policy.interruption, review: policy.review, retentionMode: policy.retention.mode,
          retentionDays: policy.retention.days, providerDeletion: false, revision: policy.revision, updatedAt: new Date(now),
        }}).run();
        transaction.update(organizationLanes).set({ position: sql`${organizationLanes.position} + 1000000` }).where(eq(organizationLanes.workspaceId, workspaceId)).run();
        for (const lane of next.configuration.lanes) transaction.insert(organizationLanes).values({
          workspaceId, id: lane.id, name: lane.name, position: lane.position, defaultPolicyId: lane.defaultPolicyId, retiredAt: lane.retiredAt ? new Date(lane.retiredAt) : null, revision: lane.revision, updatedAt: new Date(now),
        }).onConflictDoUpdate({ target: [organizationLanes.workspaceId, organizationLanes.id], set: {
          name: lane.name, position: lane.position, defaultPolicyId: lane.defaultPolicyId, retiredAt: lane.retiredAt ? new Date(lane.retiredAt) : null, revision: lane.revision, updatedAt: new Date(now),
        }}).run();
        transaction.update(organizationWorkspaceLaneSettings).set({ fallbackLaneId: next.configuration.fallbackLaneId, revision: sql`${organizationWorkspaceLaneSettings.revision} + 1`, updatedAt: new Date(now) }).where(eq(organizationWorkspaceLaneSettings.workspaceId, workspaceId)).run();
        for (const placement of next.placements) transaction.insert(organizationThreadLaneStates).values({
          workspaceId, accountId: placement.accountId, threadId: placement.threadId, primaryLaneId: placement.primaryLaneId,
          placementSource: placement.evidence.winningSource, sourceId: placement.evidence.sourceId, actorId: placement.evidence.actor.id, actorType: placement.evidence.actor.type,
          reason: placement.evidence.reason, manualOverrideLaneId: placement.manualOverride?.laneId ?? null, manualOverrideAt: placement.manualOverride ? new Date(placement.manualOverride.updatedAt) : null,
          safetyLocked: placement.safetyLock.locked, safetyLockActorId: placement.safetyLock.actor?.id ?? null, safetyLockActorType: placement.safetyLock.actor?.type ?? null,
          safetyLockReason: placement.safetyLock.reason, safetyLockUpdatedAt: placement.safetyLock.updatedAt ? new Date(placement.safetyLock.updatedAt) : null,
          revision: placement.revision ?? 1, updatedAt: new Date(now),
        }).onConflictDoUpdate({ target: [organizationThreadLaneStates.workspaceId, organizationThreadLaneStates.accountId, organizationThreadLaneStates.threadId], set: {
          primaryLaneId: placement.primaryLaneId, placementSource: placement.evidence.winningSource, sourceId: placement.evidence.sourceId,
          actorId: placement.evidence.actor.id, actorType: placement.evidence.actor.type, reason: placement.evidence.reason,
          manualOverrideLaneId: placement.manualOverride?.laneId ?? null, manualOverrideAt: placement.manualOverride ? new Date(placement.manualOverride.updatedAt) : null,
          safetyLocked: placement.safetyLock.locked, safetyLockActorId: placement.safetyLock.actor?.id ?? null, safetyLockActorType: placement.safetyLock.actor?.type ?? null,
          safetyLockReason: placement.safetyLock.reason, safetyLockUpdatedAt: placement.safetyLock.updatedAt ? new Date(placement.safetyLock.updatedAt) : null,
          revision: placement.revision ?? 1, updatedAt: new Date(now),
        }}).run();
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.configuration.workspaceRevision, updatedAt: new Date(now) })
          .where(and(eq(organizationWorkspaceStates.workspaceId, workspaceId), eq(organizationWorkspaceStates.revision, current.configuration.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.configuration.workspaceRevision, current.configuration.workspaceRevision + 1);
        return organizationLaneApplyResponseSchema.parse({ workspaceId, workspaceRevision: next.configuration.workspaceRevision, appliedActions: parsed.actions.length, laneConfiguration: next.configuration, placements: next.placements.filter((placement) => parsed.actions.some((action) => "threadId" in action && action.accountId === placement.accountId && action.threadId === placement.threadId)) });
      });
    },
  };
}
