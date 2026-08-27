import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  laneInterruptionSchema,
  lanePlacementSourceSchema,
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
import { canonicalOrganizationJson, digestOrganizationCommand } from "../authority.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../module.ts";
import {
  applyLaneActions,
  digestLaneActions,
  fallbackPlacement,
  parseLaneApply,
  type OrganizationLaneSnapshot,
  type OrganizationLanesRepository,
} from "./module.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type PlacementEvidence = ThreadLanePlacement["evidence"];
type LowerPlacementCandidate = Pick<ThreadLanePlacement, "primaryLaneId" | "evidence">;

function laneResourceId(id: string) { return `lane:${id}`; }
function policyResourceId(id: string) { return `lane_policy:${id}`; }
function threadResourceId(accountId: string, threadId: string) { return `thread:${accountId}:${threadId}`; }
function fallbackResourceId(workspaceId: string) { return `workspace_fallback:${workspaceId}`; }
function placementKey(accountId: string, threadId: string) { return `${accountId}\0${threadId}`; }
function sameValue(left: unknown, right: unknown) { return isDeepStrictEqual(left, right); }

function actor(type: string, id: string): OrganizationActor {
  return { type: type === "human" ? "human" : type === "agent" ? "agent" : "system", id };
}

function precedence(source: PlacementEvidence["winningSource"]): PlacementEvidence["precedenceLevel"] {
  if (source === "safety_lock") return "1_safety_lock";
  if (source === "manual_override") return "2_manual_override";
  if (source === "rule_revision") return "3_rule_revision";
  if (source === "lane_policy") return "4_lane_policy";
  return "5_workspace_fallback";
}

function lowerCandidateFromPlacement(placement: ThreadLanePlacement): LowerPlacementCandidate {
  return { primaryLaneId: placement.primaryLaneId, evidence: placement.evidence };
}

function placementWithLowerCandidate(placement: ThreadLanePlacement, lower: LowerPlacementCandidate): ThreadLanePlacement {
  return threadLanePlacementSchema.parse({ ...placement, primaryLaneId: lower.primaryLaneId, evidence: lower.evidence });
}

function loadSnapshot(
  executor: Database,
  workspaceId: string,
  accountIds: readonly string[],
  lowerCandidatesByThread?: Map<string, LowerPlacementCandidate>,
): OrganizationLaneSnapshot {
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
    const manualOverrideActor = row.manualOverrideActorId && row.manualOverrideActorType
      ? actor(row.manualOverrideActorType, row.manualOverrideActorId)
      : sourceActor;
    const manualOverride = row.manualOverrideLaneId && row.manualOverrideAt
      ? { laneId: row.manualOverrideLaneId, actor: manualOverrideActor, reason: row.manualOverrideReason ?? row.reason, updatedAt: row.manualOverrideAt.toISOString() }
      : null;
    const safetyLockActor = row.safetyLockActorId && row.safetyLockActorType ? actor(row.safetyLockActorType, row.safetyLockActorId) : null;
    if (row.safetyLocked && (!safetyLockActor || !row.safetyLockReason)) {
      throw new OrganizationAuthorityError("invalid_live_authority", "A locked Thread is missing its Safety Lock Actor or reason");
    }
    const storedSource = lanePlacementSourceSchema.parse(row.placementSource);
    const storedEvidence = {
      winningSource: storedSource,
      sourceId: row.sourceId,
      precedenceLevel: precedence(storedSource),
      actor: sourceActor,
      reason: row.reason,
    } satisfies PlacementEvidence;
    const lowerCandidate = { primaryLaneId: row.primaryLaneId, evidence: storedEvidence } satisfies LowerPlacementCandidate;
    lowerCandidatesByThread?.set(placementKey(row.accountId, row.threadId), lowerCandidate);
    const effectiveLaneId = manualOverride?.laneId ?? lowerCandidate.primaryLaneId;
    const effectiveEvidence: PlacementEvidence = manualOverride ? {
      winningSource: "manual_override",
      sourceId: manualOverride.laneId,
      precedenceLevel: "2_manual_override",
      actor: manualOverride.actor,
      reason: manualOverride.reason,
    } : lowerCandidate.evidence;
    return threadLanePlacementSchema.parse({
      accountId: row.accountId,
      threadId: row.threadId,
      primaryLaneId: effectiveLaneId,
      manualOverride,
      safetyLock: {
        locked: row.safetyLocked,
        actor: safetyLockActor,
        reason: row.safetyLockReason,
        updatedAt: row.safetyLockUpdatedAt?.toISOString() ?? null,
      },
      evidence: {
        winningSource: row.safetyLocked ? "safety_lock" : effectiveEvidence.winningSource,
        sourceId: row.safetyLocked ? effectiveLaneId : effectiveEvidence.sourceId,
        precedenceLevel: row.safetyLocked ? "1_safety_lock" : effectiveEvidence.precedenceLevel,
        actor: row.safetyLocked ? safetyLockActor! : effectiveEvidence.actor,
        reason: row.safetyLocked ? row.safetyLockReason! : effectiveEvidence.reason,
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
    replay(input) {
      const parsed = parseLaneApply(input.command);
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        if (input.scope.actor.type === "agent") {
          const live = input.agentCapabilitySource?.load({ ...input.scope, actor: input.scope.actor as typeof input.scope.actor & { type: "agent" } }, executor) ?? null;
          if (!live || live.revokedAt !== null || !live.snapshot.operations.includes("apply")) throw new OrganizationAuthorityError("actor_operation_denied", "The persisted MCP Organization grant no longer authorizes apply");
        }
        const row = executor.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.scope.workspaceId),
          eq(organizationChangeSets.idempotencyKey, parsed.idempotencyKey),
          eq(organizationChangeSets.resourceFamily, "lane"),
        )).get();
        if (!row) return null;
        const stored = JSON.parse(row.commandJson) as { request?: unknown; scope?: unknown; response?: unknown };
        const replayScope = { actor: input.scope.actor, workspaceId: input.scope.workspaceId, accountIds: [...input.scope.accountIds].sort() };
        if (canonicalOrganizationJson(stored.request) !== canonicalOrganizationJson(parsed)
          || canonicalOrganizationJson(stored.scope) !== canonicalOrganizationJson(replayScope)) {
          throw new OrganizationAuthorityError("duplicate_idempotency_key", "The idempotency key was already used for a different Lane request or scope");
        }
        return organizationLaneApplyResponseSchema.parse(stored.response);
      });
    },
    apply(input) {
      const parsed = parseLaneApply(input.command);
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const workspaceId = input.executionContext.workspaceId;
        if (input.executionContext.actor.type === "agent") {
          const liveCapability = input.agentCapabilitySource?.load({
            actor: input.executionContext.actor as typeof input.executionContext.actor & { type: "agent" },
            workspaceId,
            accountIds: input.executionContext.accountIds,
          }, executor) ?? null;
          if (!liveCapability || liveCapability.revokedAt !== null
            || JSON.stringify(liveCapability.snapshot) !== JSON.stringify(input.authorityTrace.capabilitySnapshot)) {
            throw new OrganizationAuthorityError("actor_operation_denied", "The persisted MCP Organization grant changed before commit");
          }
        }
        const lowerCandidatesByThread = new Map<string, LowerPlacementCandidate>();
        const current = loadSnapshot(executor, workspaceId, input.executionContext.accountIds, lowerCandidatesByThread);
        const currentLowerCandidatesByThread = new Map(lowerCandidatesByThread);
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
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.id, input.boundCommand.id))).get()) throw new OrganizationAuthorityError("invalid_request", `Change Set ${input.boundCommand.id} already exists in this Workspace`);
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get()) throw new OrganizationAuthorityError("duplicate_idempotency_key", "The idempotency key was already reserved");
        const existingThreads = new Set(executor.select({ accountId: threads.accountId, threadId: threads.id }).from(threads)
          .where(inArray(threads.accountId, [...input.executionContext.accountIds])).all().map((row) => `${row.accountId}\0${row.threadId}`));
        const now = new Date().toISOString();
        const applied = applyLaneActions(current, parsed.actions, { actor: input.executionContext.actor, authorizedAccountIds: input.executionContext.accountIds, existingThreads, now });
        const currentPlacements = new Map(current.placements.map((placement) => [placementKey(placement.accountId, placement.threadId), placement]));
        const next = {
          configuration: applied.configuration,
          placements: applied.placements.map((placement) => {
            const threadKey = placementKey(placement.accountId, placement.threadId);
            const previous = currentPlacements.get(threadKey);
            let lower = lowerCandidatesByThread.get(threadKey) ?? lowerCandidateFromPlacement(placement);
            if (lower.evidence.winningSource === "workspace_fallback"
              && !placement.safetyLock.locked
              && lower.primaryLaneId !== applied.configuration.fallbackLaneId) {
              const rebasedFallback = fallbackPlacement({
                accountId: placement.accountId,
                threadId: placement.threadId,
                fallbackLaneId: applied.configuration.fallbackLaneId,
              });
              lower = lowerCandidateFromPlacement(rebasedFallback);
            }
            const revealedLowerCandidate = previous
              && ((previous.manualOverride !== null && placement.manualOverride === null)
                || (previous.safetyLock.locked && !placement.safetyLock.locked && placement.manualOverride === null));
            if (!placement.manualOverride && !placement.safetyLock.locked && !revealedLowerCandidate) {
              lower = lowerCandidateFromPlacement(placement);
            }
            lowerCandidatesByThread.set(threadKey, lower);
            if (!revealedLowerCandidate) return placement;
            return placementWithLowerCandidate(placement, lower);
          }),
        };
        const response = organizationLaneApplyResponseSchema.parse({ changeSetId: input.boundCommand.id, workspaceId, workspaceRevision: next.configuration.workspaceRevision, appliedActions: parsed.actions.length, laneConfiguration: next.configuration, placements: next.placements.filter((placement) => parsed.actions.some((action) => "threadId" in action && action.accountId === placement.accountId && action.threadId === placement.threadId)) });

        transaction.insert(organizationChangeSets).values({
          workspaceId,
          id: input.boundCommand.id,
          idempotencyKey,
          commandDigest: input.executionContext.command.digest,
          authorityTrace: JSON.stringify(input.authorityTrace),
          resourceFamily: "lane",
          operation: "apply",
          commandJson: JSON.stringify({ request: parsed, scope: { actor: input.executionContext.actor, workspaceId, accountIds: [...input.executionContext.accountIds].sort() }, response }),
          workspaceRevisionBefore: current.configuration.workspaceRevision,
          workspaceRevisionAfter: next.configuration.workspaceRevision,
          createdAt: new Date(now),
        }).run();
        const currentPolicies = new Map(current.configuration.policies.map((policy) => [policy.id, policy]));
        const changedPolicies = next.configuration.policies.filter((policy) => !sameValue(currentPolicies.get(policy.id), policy));
        const currentLanes = new Map(current.configuration.lanes.map((lane) => [lane.id, lane]));
        const changedLanes = next.configuration.lanes.filter((lane) => !sameValue(currentLanes.get(lane.id), lane));
        const changedPlacements = next.placements.filter((placement) => {
          const key = placementKey(placement.accountId, placement.threadId);
          return !sameValue(currentPlacements.get(key), placement)
            || !sameValue(currentLowerCandidatesByThread.get(key), lowerCandidatesByThread.get(key));
        });
        const fallbackChanged = current.configuration.fallbackLaneId !== next.configuration.fallbackLaneId;
        const auditRows: Array<{ actionKind: string; resourceFamily: string; resourceId: string; before: unknown; after: unknown }> = [
          ...changedPolicies.map((policy) => ({ actionKind: currentPolicies.has(policy.id) ? "update_lane_policy" : "define_lane_policy", resourceFamily: "lane_policy", resourceId: policy.id, before: currentPolicies.get(policy.id) ?? null, after: policy })),
          ...changedLanes.map((lane) => ({ actionKind: currentLanes.has(lane.id) ? "update_lane" : "define_lane", resourceFamily: "lane", resourceId: lane.id, before: currentLanes.get(lane.id) ?? null, after: lane })),
          ...(fallbackChanged ? [{ actionKind: "set_fallback_lane", resourceFamily: "lane", resourceId: workspaceId, before: { fallbackLaneId: current.configuration.fallbackLaneId }, after: { fallbackLaneId: next.configuration.fallbackLaneId } }] : []),
          ...changedPlacements.map((placement) => {
            const key = placementKey(placement.accountId, placement.threadId);
            const beforePlacement = currentPlacements.get(key);
            return {
              actionKind: "set_thread_lane_state",
              resourceFamily: "thread",
              resourceId: `${placement.accountId}:${placement.threadId}`,
              before: beforePlacement ? { placement: beforePlacement, lowerCandidate: currentLowerCandidatesByThread.get(key) } : null,
              after: { placement, lowerCandidate: lowerCandidatesByThread.get(key) },
            };
          }),
        ];
        if (auditRows.length > 0) transaction.insert(organizationChangeActions).values(auditRows.map((row, position) => ({
          workspaceId, changeId: input.boundCommand.id, position, actionKind: row.actionKind,
          resourceFamily: row.resourceFamily, resourceId: row.resourceId,
          beforeJson: row.before === null ? null : JSON.stringify(row.before),
          afterJson: row.after === null ? null : JSON.stringify(row.after),
        }))).run();

        for (const policy of changedPolicies) {
          const values = {
            workspaceId, id: policy.id, visibility: policy.visibility, interruption: policy.interruption, review: policy.review,
            retentionMode: policy.retention.mode, retentionDays: policy.retention.days, providerDeletion: false, revision: policy.revision, updatedAt: new Date(now),
          };
          if (!currentPolicies.has(policy.id)) transaction.insert(organizationLanePolicies).values(values).run();
          else transaction.update(organizationLanePolicies).set(values).where(and(eq(organizationLanePolicies.workspaceId, workspaceId), eq(organizationLanePolicies.id, policy.id))).run();
        }
        const movedExistingLaneIds = changedLanes.filter((lane) => currentLanes.has(lane.id) && currentLanes.get(lane.id)!.position !== lane.position).map((lane) => lane.id);
        if (movedExistingLaneIds.length > 0) transaction.update(organizationLanes).set({ position: sql`${organizationLanes.position} + 1000000` })
          .where(and(eq(organizationLanes.workspaceId, workspaceId), inArray(organizationLanes.id, movedExistingLaneIds))).run();
        for (const lane of changedLanes) {
          const values = {
            workspaceId, id: lane.id, name: lane.name, position: lane.position, defaultPolicyId: lane.defaultPolicyId,
            retiredAt: lane.retiredAt ? new Date(lane.retiredAt) : null, revision: lane.revision, updatedAt: new Date(now),
          };
          if (!currentLanes.has(lane.id)) transaction.insert(organizationLanes).values(values).run();
          else transaction.update(organizationLanes).set(values).where(and(eq(organizationLanes.workspaceId, workspaceId), eq(organizationLanes.id, lane.id))).run();
        }
        if (fallbackChanged) transaction.update(organizationWorkspaceLaneSettings)
          .set({ fallbackLaneId: next.configuration.fallbackLaneId, revision: sql`${organizationWorkspaceLaneSettings.revision} + 1`, updatedAt: new Date(now) })
          .where(eq(organizationWorkspaceLaneSettings.workspaceId, workspaceId)).run();
        for (const placement of changedPlacements) {
          const key = placementKey(placement.accountId, placement.threadId);
          const lower = lowerCandidatesByThread.get(key) ?? lowerCandidateFromPlacement(placement);
          const values = {
            workspaceId, accountId: placement.accountId, threadId: placement.threadId, primaryLaneId: lower.primaryLaneId,
            placementSource: lower.evidence.winningSource, sourceId: lower.evidence.sourceId, actorId: lower.evidence.actor.id, actorType: lower.evidence.actor.type,
            reason: lower.evidence.reason, manualOverrideLaneId: placement.manualOverride?.laneId ?? null,
            manualOverrideActorId: placement.manualOverride?.actor.id ?? null, manualOverrideActorType: placement.manualOverride?.actor.type ?? null,
            manualOverrideReason: placement.manualOverride?.reason ?? null, manualOverrideAt: placement.manualOverride ? new Date(placement.manualOverride.updatedAt) : null,
            safetyLocked: placement.safetyLock.locked, safetyLockActorId: placement.safetyLock.actor?.id ?? null, safetyLockActorType: placement.safetyLock.actor?.type ?? null,
            safetyLockReason: placement.safetyLock.reason, safetyLockUpdatedAt: placement.safetyLock.updatedAt ? new Date(placement.safetyLock.updatedAt) : null,
            revision: placement.revision ?? 1, updatedAt: new Date(now),
          };
          if (!currentPlacements.has(key)) transaction.insert(organizationThreadLaneStates).values(values).run();
          else transaction.update(organizationThreadLaneStates).set(values).where(and(
            eq(organizationThreadLaneStates.workspaceId, workspaceId),
            eq(organizationThreadLaneStates.accountId, placement.accountId),
            eq(organizationThreadLaneStates.threadId, placement.threadId),
          )).run();
        }
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.configuration.workspaceRevision, updatedAt: new Date(now) })
          .where(and(eq(organizationWorkspaceStates.workspaceId, workspaceId), eq(organizationWorkspaceStates.revision, current.configuration.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.configuration.workspaceRevision, current.configuration.workspaceRevision + 1);
        return response;
      });
    },
  };
}
