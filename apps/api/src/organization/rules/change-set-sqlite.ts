import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  organizationCapabilitySnapshotSchema,
  organizationCommandSchema,
  orcaRuleActivationRequestSchema,
  orcaRuleRevertRequestSchema,
  type OrcaEvaluationTrace,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrcaRuleRisk,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationRuleRevisions,
  organizationRules,
  organizationRuleSets,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationWorkspaceStates,
} from "../../db/schema.ts";
import {
  authorizeOrganizationOperation,
  canonicalOrganizationJson,
} from "../authority.ts";
import { createHistoricalRuleSimulationService } from "./simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./simulation-sqlite.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type Scalar = string | number | boolean;

export type OrcaRuleChangeSetResult = {
  changeSetId: string;
  status: "active" | "reverted" | "conflicted";
  operation: "apply" | "revert";
  ruleId: string;
  revisionId: string;
  simulationId: string;
  revertsChangeSetId: string | null;
  workspaceRevisionBefore: number;
  workspaceRevisionAfter: number;
  ruleSetRevisionAfter: number;
  traceCount: number;
  risk: OrcaRuleRisk;
  conflicts: Array<{ resourceId: string; expectedRevision: number; actualRevision: number | null }>;
};

export class OrcaRuleChangeSetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OrcaRuleChangeSetError";
  }
}

export class OrcaRuleCompensationConflictError extends OrcaRuleChangeSetError {
  constructor(readonly conflicts: OrcaRuleChangeSetResult["conflicts"]) {
    super("compensation_conflict", "Newer Organization state conflicts with this compensating Change Set");
    this.name = "OrcaRuleCompensationConflictError";
  }
}

type ThreadPlan = {
  accountId: string;
  threadId: string;
  expectedRevision: number;
  lane: { laneId: string; reason: string; traceCandidateId: string } | null;
  facets: Array<{ facetId: string; operation: "set" | "unset"; value: Scalar | null; traceCandidateId: string }>;
  trace: OrcaEvaluationTrace;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`;
}

function sameRequest(left: unknown, right: unknown): boolean {
  return canonicalOrganizationJson(left) === canonicalOrganizationJson(right);
}

function parseReplay(row: typeof organizationChangeSets.$inferSelect, request: unknown): OrcaRuleChangeSetResult {
  const stored = JSON.parse(row.commandJson) as { request?: unknown; response?: OrcaRuleChangeSetResult };
  if (!stored.response || !sameRequest(stored.request, request)) {
    throw new OrcaRuleChangeSetError("duplicate_idempotency_key", "The idempotency key belongs to a different Change Set request");
  }
  return stored.response;
}

function proposedWinners(trace: OrcaEvaluationTrace, revisionId: string) {
  return trace.winners.filter((winner) => winner.revisionId === revisionId);
}

function buildThreadPlans(
  preparation: ReturnType<ReturnType<typeof createHistoricalRuleSimulationService>["prepare"]>,
  revisionId: string,
): ThreadPlan[] {
  return preparation.evaluations.flatMap(({ context, result }): ThreadPlan[] => {
    const winners = proposedWinners(result.trace, revisionId);
    const laneWinner = winners.find((winner) => winner.action.kind === "route_lane");
    const lane = laneWinner?.action.kind === "route_lane" && laneWinner.action.laneId !== context.thread.lanePlacement.primaryLaneId
      ? { laneId: laneWinner.action.laneId, reason: laneWinner.reason, traceCandidateId: laneWinner.candidateId }
      : null;
    const facets: ThreadPlan["facets"] = [];
    for (const winner of winners) {
      const action = winner.action;
      if (action.kind === "set_facet") {
        if (context.thread.facets[action.facetId] !== action.value) {
          facets.push({ facetId: action.facetId, operation: "set", value: action.value, traceCandidateId: winner.candidateId });
        }
      }
      if (action.kind === "unset_facet") {
        if (context.thread.facets[action.facetId] !== undefined) {
          facets.push({ facetId: action.facetId, operation: "unset", value: null, traceCandidateId: winner.candidateId });
        }
      }
    }
    if (!lane && facets.length === 0) return [];
    if (context.thread.organizationRevision === null) {
      throw new OrcaRuleChangeSetError("expected_revision_required", `Thread ${context.thread.id} lacks an Organization revision`);
    }
    return [{
      accountId: context.thread.accountId,
      threadId: context.thread.id,
      expectedRevision: context.thread.organizationRevision,
      lane,
      facets,
      trace: result.trace,
    }];
  });
}

function changeSetCommand(
  workspaceId: string,
  changeSetId: string,
  ruleId: string,
  revisionId: string,
  simulationId: string,
  ruleSetRevision: number,
  plans: ThreadPlan[],
): OrganizationCommand {
  return organizationCommandSchema.parse({
    id: changeSetId,
    intents: [
      {
        kind: "mutate_rule",
        resourceId: `rule:${ruleId}`,
        mutation: "update",
        changes: { activeRevisionId: revisionId, simulationId },
      },
      {
        kind: "mutate_rule",
        resourceId: `rule_set:${workspaceId}`,
        mutation: "update",
        changes: { revision: ruleSetRevision + 1, simulationId },
      },
      ...plans.map((plan) => ({
        kind: "organize_thread" as const,
        resourceId: `thread:${plan.accountId}:${plan.threadId}`,
        mutation: "update" as const,
        changes: {
          planDigest: digest({ lane: plan.lane, facets: plan.facets }),
          revision: plan.expectedRevision + 1,
        },
      })),
    ],
  });
}

type StoredInverseThread = {
  accountId: string;
  threadId: string;
  expectedRevisionAfter: number;
  beforeLane: Record<string, unknown> | null;
  beforeFacets: Array<Record<string, unknown>>;
  beforeRevision: number;
};

type StoredApplyInverse = {
  rule: { activeRevisionId: string | null };
  ruleSetRevision: number;
  threads: StoredInverseThread[];
};

function parseApplyEvidence(row: typeof organizationChangeSets.$inferSelect): {
  response: OrcaRuleChangeSetResult;
  inverse: StoredApplyInverse;
  request: { accountIds: string[] };
} {
  try {
    const command = JSON.parse(row.commandJson) as {
      request?: { accountIds?: unknown };
      response?: OrcaRuleChangeSetResult;
    };
    const inverse = JSON.parse(row.inverseJson) as StoredApplyInverse;
    if (!command.response
      || !command.request
      || !Array.isArray(command.request.accountIds)
      || !inverse.rule
      || !Number.isInteger(inverse.ruleSetRevision)
      || !Array.isArray(inverse.threads)
      || inverse.threads.some((thread) => !thread.accountId || !thread.threadId
        || !Number.isInteger(thread.expectedRevisionAfter)
        || !Array.isArray(thread.beforeFacets))) {
      throw new Error("incomplete evidence");
    }
    return {
      response: command.response,
      inverse,
      request: { accountIds: command.request.accountIds as string[] },
    };
  } catch {
    throw new OrcaRuleChangeSetError("invalid_change_set", "The original Change Set lacks complete inverse evidence");
  }
}

function sameAccountScope(left: string[], right: string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((accountId, index) => accountId === [...right].sort()[index]);
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new OrcaRuleChangeSetError("invalid_change_set", "Inverse evidence contains an invalid timestamp");
  return parsed;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new OrcaRuleChangeSetError("invalid_change_set", `Inverse evidence lacks ${field}`);
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, "a nullable string");
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new OrcaRuleChangeSetError("invalid_change_set", "Inverse evidence lacks a boolean safety lock");
  return value;
}

function revertCommand(
  workspaceId: string,
  changeSetId: string,
  evidence: ReturnType<typeof parseApplyEvidence>,
  currentRuleSetRevision: number,
): OrganizationCommand {
  return organizationCommandSchema.parse({
    id: changeSetId,
    intents: [
      {
        kind: "mutate_rule",
        resourceId: `rule:${evidence.response.ruleId}`,
        mutation: "update",
        changes: { activeRevisionId: evidence.inverse.rule.activeRevisionId, revertsChangeSetId: evidence.response.changeSetId },
      },
      {
        kind: "mutate_rule",
        resourceId: `rule_set:${workspaceId}`,
        mutation: "update",
        changes: { revision: currentRuleSetRevision + 1, revertsChangeSetId: evidence.response.changeSetId },
      },
      ...evidence.inverse.threads.map((thread) => ({
        kind: "organize_thread" as const,
        resourceId: `thread:${thread.accountId}:${thread.threadId}`,
        mutation: "update" as const,
        changes: {
          revision: thread.expectedRevisionAfter + 1,
          compensationDigest: digest({ beforeLane: thread.beforeLane, beforeFacets: thread.beforeFacets }),
        },
      })),
    ],
  });
}

export function createSqliteRuleChangeSetService(db: Database, options: {
  id?: () => string;
  now?: () => Date;
} = {}) {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const simulations = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));

  return {
    activate(input: {
      actor: OrganizationActor;
      capabilitySnapshot: OrganizationCapabilitySnapshot | unknown;
      workspaceId: string;
      request: unknown;
    }): OrcaRuleChangeSetResult {
      const request = orcaRuleActivationRequestSchema.parse(input.request);
      const capabilitySnapshot = organizationCapabilitySnapshotSchema.parse(input.capabilitySnapshot);
      const replay = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
      )).get();
      if (replay) return parseReplay(replay, request);

      const revisionRow = db.select().from(organizationRuleRevisions).where(and(
        eq(organizationRuleRevisions.workspaceId, input.workspaceId),
        eq(organizationRuleRevisions.ruleId, request.ruleId),
        eq(organizationRuleRevisions.id, request.revisionId),
      )).get();
      if (!revisionRow) throw new OrcaRuleChangeSetError("simulation_binding_conflict", "The simulated Rule Revision is unavailable");
      const preparation = simulations.prepare({
        actor: input.actor,
        workspaceId: input.workspaceId,
        request: {
          ruleId: request.ruleId,
          revisionId: request.revisionId,
          workspaceSchemaRevision: revisionRow.workspaceSchemaRevision,
          accountIds: request.accountIds,
          maximumThreads: request.maximumThreads,
        },
      });
      if (preparation.report.simulationId !== request.simulationId
        || preparation.report.state !== "simulated"
        || preparation.report.binding.workspaceRevision !== request.expectedWorkspaceRevision) {
        throw new OrcaRuleChangeSetError("simulation_binding_conflict", "Activation requires the exact current successful Simulation");
      }

      const workspace = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
      const rule = db.select().from(organizationRules).where(and(
        eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
      )).get();
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
      if (!workspace || !rule || !ruleSet) throw new OrcaRuleChangeSetError("revision_conflict", "Rule activation roots are unavailable");
      if (workspace.revision !== request.expectedWorkspaceRevision
        || rule.latestRevision !== request.expectedRuleRevision
        || revisionRow.revision !== request.expectedRuleRevision
        || ruleSet.revision !== request.expectedRuleSetRevision) {
        throw new OrcaRuleChangeSetError("revision_conflict", "Rule activation expected revisions are stale");
      }

      const plans = buildThreadPlans(preparation, request.revisionId);
      const changeSetId = id();
      const command = changeSetCommand(
        input.workspaceId,
        changeSetId,
        request.ruleId,
        request.revisionId,
        request.simulationId,
        ruleSet.revision,
        plans,
      );
      const expectedResources = Object.fromEntries([
        [`rule:${request.ruleId}`, rule.latestRevision],
        [`rule_set:${input.workspaceId}`, ruleSet.revision],
        ...plans.map((plan) => [`thread:${plan.accountId}:${plan.threadId}`, plan.expectedRevision] as const),
      ]);
      const ownedAccounts = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
        .where(eq(oauthAccounts.userId, input.workspaceId)).orderBy(asc(oauthAccounts.id)).all().map(({ id: accountId }) => accountId);
      const liveResourceRevisions = {
        ...expectedResources,
      };
      const reservedKeys = db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
        .where(eq(organizationChangeSets.workspaceId, input.workspaceId)).all().map(({ key }) => key);
      const authority = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot,
        operation: "apply",
        scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
        command,
        expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: { workspaceId: input.workspaceId, accountIds: ownedAccounts },
        capability: { snapshot: capabilitySnapshot, revokedAt: null },
        workspaceRevision: workspace.revision,
        resourceRevisions: liveResourceRevisions,
        reservedIdempotencyKeys: reservedKeys,
      });
      if (!authority.allowed) throw new OrcaRuleChangeSetError(authority.code, authority.reason);

      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const duplicate = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
        )).get();
        if (duplicate) return parseReplay(duplicate, request);

        const currentWorkspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
        )).get();
        const currentRuleSet = executor.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
        const currentAccounts = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, input.workspaceId)).orderBy(asc(oauthAccounts.id)).all().map(({ id: accountId }) => accountId);
        if (!currentWorkspace || currentWorkspace.revision !== request.expectedWorkspaceRevision
          || !currentRule || currentRule.latestRevision !== request.expectedRuleRevision
          || !currentRuleSet || currentRuleSet.revision !== request.expectedRuleSetRevision
          || request.accountIds.some((accountId) => !currentAccounts.includes(accountId))) {
          throw new OrcaRuleChangeSetError("revision_conflict", "Activation state changed before the Change Set transaction");
        }
        for (const plan of plans) {
          const state = executor.select().from(organizationThreadStates).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, plan.accountId),
            eq(organizationThreadStates.threadId, plan.threadId),
          )).get();
          if (!state || state.revision !== plan.expectedRevision) {
            throw new OrcaRuleChangeSetError("revision_conflict", `Thread ${plan.threadId} changed after Simulation`);
          }
        }

        const timestamp = now();
        const inverseThreads: Array<Record<string, unknown>> = [];
        const actionRows: Array<typeof organizationChangeActions.$inferInsert> = [];
        let actionPosition = 0;
        actionRows.push({
          workspaceId: input.workspaceId,
          changeId: changeSetId,
          position: actionPosition++,
          actionKind: "activate_rule_revision",
          resourceFamily: "rule",
          resourceId: request.ruleId,
          beforeJson: JSON.stringify({ activeRevisionId: currentRule.activeRevisionId, ruleSetRevision: currentRuleSet.revision }),
          afterJson: JSON.stringify({ activeRevisionId: request.revisionId, ruleSetRevision: currentRuleSet.revision + 1 }),
        });

        for (const plan of plans) {
          const beforeLane = executor.select().from(organizationThreadLaneStates).where(and(
            eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
            eq(organizationThreadLaneStates.accountId, plan.accountId),
            eq(organizationThreadLaneStates.threadId, plan.threadId),
          )).get();
          const beforeFacets = executor.select().from(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, plan.accountId),
            eq(organizationThreadFacetValues.threadId, plan.threadId),
          )).all();
          inverseThreads.push({
            accountId: plan.accountId,
            threadId: plan.threadId,
            expectedRevisionAfter: plan.expectedRevision + 1,
            beforeLane,
            beforeFacets,
            beforeRevision: plan.expectedRevision,
          });
          if (plan.lane) {
            if (!beforeLane) throw new OrcaRuleChangeSetError("revision_conflict", `Thread ${plan.threadId} has no Lane placement`);
            executor.update(organizationThreadLaneStates).set({
              primaryLaneId: plan.lane.laneId,
              placementSource: "rule_revision",
              sourceId: request.revisionId,
              actorId: input.actor.id,
              actorType: input.actor.type,
              reason: plan.lane.reason,
              revision: beforeLane.revision + 1,
              updatedAt: timestamp,
            }).where(and(
              eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
              eq(organizationThreadLaneStates.accountId, plan.accountId),
              eq(organizationThreadLaneStates.threadId, plan.threadId),
              eq(organizationThreadLaneStates.revision, beforeLane.revision),
            )).run();
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: "route_lane", resourceFamily: "lane", resourceId: `thread:${plan.accountId}:${plan.threadId}`,
              beforeJson: JSON.stringify(beforeLane),
              afterJson: JSON.stringify({ laneId: plan.lane.laneId, revision: beforeLane.revision + 1, traceCandidateId: plan.lane.traceCandidateId }),
            });
          }
          for (const facet of plan.facets) {
            const before = beforeFacets.find((item) => item.facetId === facet.facetId) ?? null;
            if (facet.operation === "unset") {
              executor.delete(organizationThreadFacetValues).where(and(
                eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
                eq(organizationThreadFacetValues.facetId, facet.facetId),
                eq(organizationThreadFacetValues.accountId, plan.accountId),
                eq(organizationThreadFacetValues.threadId, plan.threadId),
              )).run();
            } else if (before) {
              executor.update(organizationThreadFacetValues).set({ value: JSON.stringify(facet.value), updatedAt: timestamp }).where(and(
                eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
                eq(organizationThreadFacetValues.facetId, facet.facetId),
                eq(organizationThreadFacetValues.accountId, plan.accountId),
                eq(organizationThreadFacetValues.threadId, plan.threadId),
              )).run();
            } else {
              executor.insert(organizationThreadFacetValues).values({
                workspaceId: input.workspaceId, facetId: facet.facetId, accountId: plan.accountId,
                threadId: plan.threadId, value: JSON.stringify(facet.value), updatedAt: timestamp,
              }).run();
            }
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: facet.operation === "set" ? "set_facet" : "unset_facet",
              resourceFamily: "facet", resourceId: `thread:${plan.accountId}:${plan.threadId}:facet:${facet.facetId}`,
              beforeJson: before ? JSON.stringify(before) : null,
              afterJson: facet.operation === "set" ? JSON.stringify({ value: facet.value, traceCandidateId: facet.traceCandidateId }) : null,
            });
          }
          executor.update(organizationThreadStates).set({
            revision: plan.expectedRevision + 1,
            updatedAt: timestamp,
          }).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, plan.accountId),
            eq(organizationThreadStates.threadId, plan.threadId),
            eq(organizationThreadStates.revision, plan.expectedRevision),
          )).run();
        }

        const workspaceRevisionAfter = request.expectedWorkspaceRevision + 1;
        const ruleSetRevisionAfter = request.expectedRuleSetRevision + 1;
        executor.update(organizationRules).set({ activeRevisionId: request.revisionId, updatedAt: timestamp }).where(and(
          eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
        )).run();
        executor.update(organizationRuleSets).set({ revision: ruleSetRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationRuleSets.workspaceId, input.workspaceId), eq(organizationRuleSets.revision, request.expectedRuleSetRevision),
        )).run();
        executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationWorkspaceStates.workspaceId, input.workspaceId), eq(organizationWorkspaceStates.revision, request.expectedWorkspaceRevision),
        )).run();

        const response: OrcaRuleChangeSetResult = {
          changeSetId,
          status: "active",
          operation: "apply",
          ruleId: request.ruleId,
          revisionId: request.revisionId,
          simulationId: request.simulationId,
          revertsChangeSetId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          ruleSetRevisionAfter,
          traceCount: preparation.evaluations.length,
          risk: preparation.report.risk,
          conflicts: [],
        };
        const resultingRevisions = {
          workspace: workspaceRevisionAfter,
          ruleSet: ruleSetRevisionAfter,
          rule: currentRule.latestRevision,
          threads: Object.fromEntries(plans.map((plan) => [`${plan.accountId}:${plan.threadId}`, plan.expectedRevision + 1])),
        };
        executor.insert(organizationChangeSets).values({
          workspaceId: input.workspaceId,
          id: changeSetId,
          idempotencyKey: request.idempotencyKey,
          commandDigest: authority.executionContext.command.digest,
          authorityTrace: JSON.stringify(authority.trace),
          resourceFamily: "rule",
          operation: "apply",
          commandJson: JSON.stringify({ request, response }),
          revertsChangeId: null,
          simulationId: request.simulationId,
          risk: preparation.report.risk,
          traceJson: JSON.stringify(preparation.evaluations.map(({ result }) => result.trace)),
          inverseJson: JSON.stringify({
            rule: { activeRevisionId: currentRule.activeRevisionId },
            ruleSetRevision: currentRuleSet.revision,
            threads: inverseThreads,
          }),
          resultingRevisionsJson: JSON.stringify(resultingRevisions),
          status: "active",
          revertedByChangeId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          createdAt: timestamp,
        }).run();
        if (actionRows.length) executor.insert(organizationChangeActions).values(actionRows).run();
        return response;
      });
    },
    revert(input: {
      actor: OrganizationActor;
      capabilitySnapshot: OrganizationCapabilitySnapshot | unknown;
      workspaceId: string;
      request: unknown;
    }): OrcaRuleChangeSetResult {
      const request = orcaRuleRevertRequestSchema.parse(input.request);
      const capabilitySnapshot = organizationCapabilitySnapshotSchema.parse(input.capabilitySnapshot);
      const replay = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
      )).get();
      if (replay) return parseReplay(replay, request);

      const original = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.id, request.changeSetId),
      )).get();
      if (!original || original.operation !== "apply" || original.resourceFamily !== "rule") {
        throw new OrcaRuleChangeSetError("change_set_not_found", "The applied Rule Change Set is unavailable");
      }
      if (original.status !== "active" || original.revertedByChangeId) {
        throw new OrcaRuleChangeSetError("change_set_already_reverted", "The Rule Change Set was already reverted");
      }
      const evidence = parseApplyEvidence(original);
      if (!sameAccountScope(request.accountIds, evidence.request.accountIds)
        || evidence.inverse.threads.some((thread) => !request.accountIds.includes(thread.accountId))) {
        throw new OrcaRuleChangeSetError("account_denied", "Revert requires the exact Account scope of the applied Change Set");
      }

      const workspace = db.select().from(organizationWorkspaceStates)
        .where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
      const rule = db.select().from(organizationRules).where(and(
        eq(organizationRules.workspaceId, input.workspaceId),
        eq(organizationRules.id, evidence.response.ruleId),
      )).get();
      const ruleSet = db.select().from(organizationRuleSets)
        .where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
      if (!workspace || !rule || !ruleSet) {
        throw new OrcaRuleChangeSetError("revision_conflict", "Rule revert roots are unavailable");
      }
      if (workspace.revision !== request.expectedWorkspaceRevision
        || original.workspaceRevisionAfter !== request.expectedWorkspaceRevision) {
        throw new OrcaRuleChangeSetError("revision_conflict", "The expected Workspace revision is stale");
      }

      const conflicts: OrcaRuleChangeSetResult["conflicts"] = [];
      if (rule.activeRevisionId !== evidence.response.revisionId) {
        conflicts.push({ resourceId: `rule:${rule.id}`, expectedRevision: evidence.response.ruleSetRevisionAfter - 1, actualRevision: rule.latestRevision });
      }
      if (ruleSet.revision !== evidence.response.ruleSetRevisionAfter) {
        conflicts.push({ resourceId: `rule_set:${input.workspaceId}`, expectedRevision: evidence.response.ruleSetRevisionAfter, actualRevision: ruleSet.revision });
      }
      for (const thread of evidence.inverse.threads) {
        const current = db.select().from(organizationThreadStates).where(and(
          eq(organizationThreadStates.workspaceId, input.workspaceId),
          eq(organizationThreadStates.accountId, thread.accountId),
          eq(organizationThreadStates.threadId, thread.threadId),
        )).get();
        if (!current || current.revision !== thread.expectedRevisionAfter) {
          conflicts.push({
            resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            expectedRevision: thread.expectedRevisionAfter,
            actualRevision: current?.revision ?? null,
          });
        }
      }
      if (conflicts.length) throw new OrcaRuleCompensationConflictError(conflicts);

      const changeSetId = id();
      const command = revertCommand(input.workspaceId, changeSetId, evidence, ruleSet.revision);
      const expectedResources = Object.fromEntries([
        [`rule:${rule.id}`, rule.latestRevision],
        [`rule_set:${input.workspaceId}`, ruleSet.revision],
        ...evidence.inverse.threads.map((thread) => [
          `thread:${thread.accountId}:${thread.threadId}`,
          thread.expectedRevisionAfter,
        ] as const),
      ]);
      const ownedAccounts = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
        .where(eq(oauthAccounts.userId, input.workspaceId)).orderBy(asc(oauthAccounts.id)).all()
        .map(({ id: accountId }) => accountId);
      const reservedKeys = db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
        .where(eq(organizationChangeSets.workspaceId, input.workspaceId)).all().map(({ key }) => key);
      const authority = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot,
        operation: "revert",
        scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
        command,
        expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: { workspaceId: input.workspaceId, accountIds: ownedAccounts },
        capability: { snapshot: capabilitySnapshot, revokedAt: null },
        workspaceRevision: workspace.revision,
        resourceRevisions: expectedResources,
        reservedIdempotencyKeys: reservedKeys,
      });
      if (!authority.allowed) throw new OrcaRuleChangeSetError(authority.code, authority.reason);

      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const duplicate = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
        )).get();
        if (duplicate) return parseReplay(duplicate, request);

        const currentOriginal = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.id, request.changeSetId),
        )).get();
        const currentWorkspace = executor.select().from(organizationWorkspaceStates)
          .where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.workspaceId),
          eq(organizationRules.id, evidence.response.ruleId),
        )).get();
        const currentRuleSet = executor.select().from(organizationRuleSets)
          .where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
        const currentAccounts = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, input.workspaceId)).all().map(({ id: accountId }) => accountId);
        if (!currentOriginal || currentOriginal.status !== "active" || currentOriginal.revertedByChangeId
          || !currentWorkspace || currentWorkspace.revision !== request.expectedWorkspaceRevision
          || !currentRule || currentRule.activeRevisionId !== evidence.response.revisionId
          || !currentRuleSet || currentRuleSet.revision !== evidence.response.ruleSetRevisionAfter
          || request.accountIds.some((accountId) => !currentAccounts.includes(accountId))) {
          throw new OrcaRuleChangeSetError("revision_conflict", "Organization state changed before the compensating transaction");
        }
        for (const thread of evidence.inverse.threads) {
          const current = executor.select().from(organizationThreadStates).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, thread.accountId),
            eq(organizationThreadStates.threadId, thread.threadId),
          )).get();
          if (!current || current.revision !== thread.expectedRevisionAfter) {
            throw new OrcaRuleCompensationConflictError([{
              resourceId: `thread:${thread.accountId}:${thread.threadId}`,
              expectedRevision: thread.expectedRevisionAfter,
              actualRevision: current?.revision ?? null,
            }]);
          }
        }

        const timestamp = now();
        const inverseThreads: Array<Record<string, unknown>> = [];
        const actionRows: Array<typeof organizationChangeActions.$inferInsert> = [];
        let actionPosition = 0;
        actionRows.push({
          workspaceId: input.workspaceId,
          changeId: changeSetId,
          position: actionPosition++,
          actionKind: "revert_rule_revision",
          resourceFamily: "rule",
          resourceId: currentRule.id,
          beforeJson: JSON.stringify({ activeRevisionId: currentRule.activeRevisionId, ruleSetRevision: currentRuleSet.revision }),
          afterJson: JSON.stringify({ activeRevisionId: evidence.inverse.rule.activeRevisionId, ruleSetRevision: currentRuleSet.revision + 1 }),
        });

        for (const thread of evidence.inverse.threads) {
          const currentLane = executor.select().from(organizationThreadLaneStates).where(and(
            eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
            eq(organizationThreadLaneStates.accountId, thread.accountId),
            eq(organizationThreadLaneStates.threadId, thread.threadId),
          )).get();
          const currentFacets = executor.select().from(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, thread.accountId),
            eq(organizationThreadFacetValues.threadId, thread.threadId),
          )).all();
          inverseThreads.push({
            accountId: thread.accountId,
            threadId: thread.threadId,
            expectedRevisionAfter: thread.expectedRevisionAfter + 1,
            beforeLane: currentLane,
            beforeFacets: currentFacets,
            beforeRevision: thread.expectedRevisionAfter,
          });

          if (thread.beforeLane) {
            const beforeLane = thread.beforeLane;
            executor.update(organizationThreadLaneStates).set({
              primaryLaneId: asString(beforeLane.primaryLaneId, "the original Lane"),
              placementSource: asString(beforeLane.placementSource, "the original placement source"),
              sourceId: asString(beforeLane.sourceId, "the original source"),
              actorId: asString(beforeLane.actorId, "the original Actor"),
              actorType: asString(beforeLane.actorType, "the original Actor type"),
              reason: asString(beforeLane.reason, "the original reason"),
              manualOverrideLaneId: asNullableString(beforeLane.manualOverrideLaneId),
              manualOverrideActorId: asNullableString(beforeLane.manualOverrideActorId),
              manualOverrideActorType: asNullableString(beforeLane.manualOverrideActorType),
              manualOverrideReason: asNullableString(beforeLane.manualOverrideReason),
              manualOverrideAt: asNullableDate(beforeLane.manualOverrideAt),
              safetyLocked: asBoolean(beforeLane.safetyLocked),
              safetyLockActorId: asNullableString(beforeLane.safetyLockActorId),
              safetyLockActorType: asNullableString(beforeLane.safetyLockActorType),
              safetyLockReason: asNullableString(beforeLane.safetyLockReason),
              safetyLockUpdatedAt: asNullableDate(beforeLane.safetyLockUpdatedAt),
              revision: (currentLane?.revision ?? Number(beforeLane.revision)) + 1,
              updatedAt: timestamp,
            }).where(and(
              eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
              eq(organizationThreadLaneStates.accountId, thread.accountId),
              eq(organizationThreadLaneStates.threadId, thread.threadId),
            )).run();
          } else if (currentLane) {
            executor.delete(organizationThreadLaneStates).where(and(
              eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
              eq(organizationThreadLaneStates.accountId, thread.accountId),
              eq(organizationThreadLaneStates.threadId, thread.threadId),
            )).run();
          }
          actionRows.push({
            workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
            actionKind: "restore_lane", resourceFamily: "lane", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            beforeJson: currentLane ? JSON.stringify(currentLane) : null,
            afterJson: thread.beforeLane ? JSON.stringify(thread.beforeLane) : null,
          });

          executor.delete(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, thread.accountId),
            eq(organizationThreadFacetValues.threadId, thread.threadId),
          )).run();
          for (const beforeFacet of thread.beforeFacets) {
            executor.insert(organizationThreadFacetValues).values({
              workspaceId: input.workspaceId,
              facetId: asString(beforeFacet.facetId, "the original Facet"),
              accountId: thread.accountId,
              threadId: thread.threadId,
              value: asString(beforeFacet.value, "the original Facet value"),
              updatedAt: timestamp,
            }).run();
          }
          actionRows.push({
            workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
            actionKind: "restore_facets", resourceFamily: "facet", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            beforeJson: JSON.stringify(currentFacets),
            afterJson: JSON.stringify(thread.beforeFacets),
          });
          executor.update(organizationThreadStates).set({
            revision: thread.expectedRevisionAfter + 1,
            updatedAt: timestamp,
          }).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, thread.accountId),
            eq(organizationThreadStates.threadId, thread.threadId),
            eq(organizationThreadStates.revision, thread.expectedRevisionAfter),
          )).run();
        }

        const workspaceRevisionAfter = request.expectedWorkspaceRevision + 1;
        const ruleSetRevisionAfter = currentRuleSet.revision + 1;
        executor.update(organizationRules).set({
          activeRevisionId: evidence.inverse.rule.activeRevisionId,
          updatedAt: timestamp,
        }).where(and(
          eq(organizationRules.workspaceId, input.workspaceId),
          eq(organizationRules.id, currentRule.id),
        )).run();
        executor.update(organizationRuleSets).set({ revision: ruleSetRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationRuleSets.workspaceId, input.workspaceId),
          eq(organizationRuleSets.revision, currentRuleSet.revision),
        )).run();
        executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationWorkspaceStates.workspaceId, input.workspaceId),
          eq(organizationWorkspaceStates.revision, request.expectedWorkspaceRevision),
        )).run();

        const response: OrcaRuleChangeSetResult = {
          changeSetId,
          status: "reverted",
          operation: "revert",
          ruleId: evidence.response.ruleId,
          revisionId: evidence.response.revisionId,
          simulationId: evidence.response.simulationId,
          revertsChangeSetId: original.id,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          ruleSetRevisionAfter,
          traceCount: evidence.response.traceCount,
          risk: evidence.response.risk,
          conflicts: [],
        };
        const resultingRevisions = {
          workspace: workspaceRevisionAfter,
          ruleSet: ruleSetRevisionAfter,
          rule: currentRule.latestRevision,
          threads: Object.fromEntries(evidence.inverse.threads.map((thread) => [
            `${thread.accountId}:${thread.threadId}`,
            thread.expectedRevisionAfter + 1,
          ])),
        };
        executor.insert(organizationChangeSets).values({
          workspaceId: input.workspaceId,
          id: changeSetId,
          idempotencyKey: request.idempotencyKey,
          commandDigest: authority.executionContext.command.digest,
          authorityTrace: JSON.stringify(authority.trace),
          resourceFamily: "rule",
          operation: "revert",
          commandJson: JSON.stringify({ request, response }),
          revertsChangeId: original.id,
          simulationId: evidence.response.simulationId,
          risk: evidence.response.risk,
          traceJson: original.traceJson,
          inverseJson: JSON.stringify({
            rule: { activeRevisionId: currentRule.activeRevisionId },
            ruleSetRevision: currentRuleSet.revision,
            threads: inverseThreads,
          }),
          resultingRevisionsJson: JSON.stringify(resultingRevisions),
          status: "reverted",
          revertedByChangeId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          createdAt: timestamp,
        }).run();
        executor.update(organizationChangeSets).set({
          status: "reverted",
          revertedByChangeId: changeSetId,
        }).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.id, original.id),
          eq(organizationChangeSets.status, "active"),
        )).run();
        if (actionRows.length) executor.insert(organizationChangeActions).values(actionRows).run();
        return response;
      });
    },
  };
}
