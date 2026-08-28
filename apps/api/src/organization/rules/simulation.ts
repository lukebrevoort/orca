import { createHash } from "node:crypto";

import {
  orcaHistoricalSimulationRequestSchema,
  orcaHistoricalSimulationResponseSchema,
  type OrcaHistoricalSimulationResponse,
  type OrcaEvaluationResult,
  type OrcaRule,
  type OrcaRuleRevision,
  type OrcaWorkspaceSnapshot,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
} from "@orca/shared";

import { canonicalOrganizationJson } from "../authority.ts";
import { compileOrcaRule } from "./compiler.ts";
import { evaluateOrcaRules, type OrcaActiveRuleRevision, type OrcaEvaluationInput } from "./evaluator.ts";

export class HistoricalSimulationBindingError extends Error {
  readonly code = "simulation_binding_conflict" as const;
}

export type HistoricalRuleRevision = {
  rule: OrcaRule;
  revision: OrcaRuleRevision;
  compilationWorkspace: OrcaWorkspaceSnapshot;
};

export type HistoricalRuleSimulationRepository = {
  loadRuleRevision(workspaceId: string, ruleId: string, revisionId: string): HistoricalRuleRevision | null;
  loadWorkspaceSnapshot(workspaceId: string): OrcaWorkspaceSnapshot;
  loadRuleSetRevision(workspaceId: string): number;
  listHistoricalEvaluationInputs(
    workspaceId: string,
    accountIds: readonly string[],
    maximumThreads: number,
  ): OrcaEvaluationInput[];
  /** Test-only sentinel: Simulation deliberately has no mutation callback. */
  recordWrite?(): void;
};

export type HistoricalRuleSimulationPreparation = {
  report: OrcaHistoricalSimulationResponse;
  evaluations: Array<{ context: OrcaEvaluationInput; result: OrcaEvaluationResult }>;
};

function simulationCapability(
  actor: OrganizationActor,
  workspaceId: string,
  accountIds: string[],
): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:rule_simulation:${actor.type}:${actor.id}`,
    revision: 1,
    actor,
    scope: { workspaceId, accountIds },
    operations: ["simulate"],
    resourceFamilies: ["rule", "thread", "lane", "facet", "workflow_state", "collection", "context", "trace"],
    actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"],
  };
}

function proposedRuleRevision(binding: HistoricalRuleRevision): OrcaActiveRuleRevision {
  return {
    ruleId: binding.rule.id,
    revisionId: binding.revision.id,
    revision: binding.revision.revision,
    order: binding.rule.position,
    compiled: binding.revision.compiled,
    compilationWorkspace: binding.compilationWorkspace,
  };
}

function stableIncrement(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function createHistoricalRuleSimulationService(repository: HistoricalRuleSimulationRepository) {
  const prepare = (input: { actor: OrganizationActor; workspaceId: string; request: unknown }): HistoricalRuleSimulationPreparation => {
      const request = orcaHistoricalSimulationRequestSchema.parse(input.request);
      const currentWorkspace = repository.loadWorkspaceSnapshot(input.workspaceId);
      const currentRuleSetRevision = repository.loadRuleSetRevision(input.workspaceId);
      const binding = repository.loadRuleRevision(input.workspaceId, request.ruleId, request.revisionId);
      if (!binding
        || binding.rule.workspaceId !== input.workspaceId
        || binding.revision.workspaceId !== input.workspaceId
        || binding.revision.ruleId !== request.ruleId
        || binding.revision.id !== request.revisionId) {
        throw new HistoricalSimulationBindingError("The requested compiled Rule Revision is unavailable in this Workspace");
      }
      if (binding.revision.compiled.workspaceSchemaRevision !== request.workspaceSchemaRevision
        || binding.compilationWorkspace.revision !== request.workspaceSchemaRevision
        || binding.compilationWorkspace.workspaceId !== input.workspaceId) {
        throw new HistoricalSimulationBindingError(
          `Workspace Schema revision ${request.workspaceSchemaRevision} is stale for the requested compiled Rule Revision`,
        );
      }
      if (currentWorkspace.revision < request.workspaceSchemaRevision) {
        throw new HistoricalSimulationBindingError("The current Workspace revision predates the compiled Rule Revision");
      }
      const sourceDigest = `sha256:${createHash("sha256").update(binding.revision.source).digest("hex")}`;
      if (sourceDigest !== binding.revision.sourceDigest) {
        throw new HistoricalSimulationBindingError("The stored Rule Revision source digest does not match its immutable source");
      }

      // Re-enter the production parser and type checker, then require byte-for-byte
      // semantic equivalence with the immutable compiled revision before history is read.
      const recompilation = compileOrcaRule({ source: binding.revision.source, workspace: binding.compilationWorkspace });
      if (!recompilation.ok
        || canonicalOrganizationJson(recompilation.revision) !== canonicalOrganizationJson(binding.revision.compiled)) {
        throw new HistoricalSimulationBindingError("The stored Rule Revision does not match production compiler output");
      }

      const requestedAccounts = [...request.accountIds].sort();
      const accountSet = new Set(requestedAccounts);
      const capability = simulationCapability(input.actor, input.workspaceId, requestedAccounts);
      const historical = repository.listHistoricalEvaluationInputs(
        input.workspaceId,
        requestedAccounts,
        request.maximumThreads,
      );
      if (historical.length > request.maximumThreads) {
        throw new HistoricalSimulationBindingError("The historical adapter exceeded the requested Thread bound");
      }

      const proposed = proposedRuleRevision(binding);
      const laneCounts = new Map<string, number>();
      const facetCounts = new Map<string, number>();
      const losingRuleCounts = new Map<string, number>();
      const representativeThreads: OrcaHistoricalSimulationResponse["representativeThreads"] = [];
      const conflicts: OrcaHistoricalSimulationResponse["conflicts"] = [];
      let affectedThreads = 0;
      let candidateActions = 0;
      let notifications = 0;
      let interruptionsSuppressed = 0;
      let proposedLosses = 0;
      const evaluations: HistoricalRuleSimulationPreparation["evaluations"] = [];

      for (const rawContext of historical) {
        if (rawContext.thread.workspaceId !== input.workspaceId || !accountSet.has(rawContext.thread.accountId)) {
          throw new HistoricalSimulationBindingError("Historical evaluation returned a Thread outside the exact Account scope");
        }
        if (rawContext.workspaceSchema.revision !== currentWorkspace.revision) {
          throw new HistoricalSimulationBindingError("Historical evaluation did not use the current activation Workspace revision");
        }
        const context = structuredClone(rawContext);
        const revisions = context.ruleSet.revisions
          .filter((item) => item.ruleId !== binding.rule.id)
          .concat(proposed)
          .sort((left, right) => left.order - right.order || left.ruleId.localeCompare(right.ruleId));
        context.ruleSet = {
          ...context.ruleSet,
          activeRevisionCount: revisions.length,
          revisions,
        };
        context.actor = input.actor;
        context.capabilities = capability;

        const result = evaluateOrcaRules(context);
        evaluations.push({ context, result });
        candidateActions += result.trace.candidates.length;
        const proposedWinners = result.trace.winners.filter((winner) => winner.revisionId === binding.revision.id);
        const proposedLosers = result.trace.losers.filter((loser) => loser.revisionId === binding.revision.id);
        proposedLosses += proposedLosers.length;

        const laneAction = proposedWinners.find((winner) => winner.action.kind === "route_lane");
        const lane = laneAction?.action.kind === "route_lane" && laneAction.action.laneId !== context.thread.lanePlacement.primaryLaneId
          ? { before: context.thread.lanePlacement.primaryLaneId, after: laneAction.action.laneId }
          : null;
        if (lane) stableIncrement(laneCounts, `${lane.before}\0${lane.after}`);

        const facets: OrcaHistoricalSimulationResponse["representativeThreads"][number]["facets"] = [];
        for (const winner of proposedWinners) {
          if (winner.action.kind !== "set_facet" && winner.action.kind !== "unset_facet") continue;
          const before = context.thread.facets[winner.action.facetId] ?? null;
          const after = winner.action.kind === "set_facet" ? winner.action.value : null;
          if (before === after) continue;
          facets.push({ facetId: winner.action.facetId, before, after });
          stableIncrement(facetCounts, `${winner.action.facetId}\0${winner.action.kind === "set_facet" ? "set" : "unset"}`);
        }
        notifications += proposedWinners.filter((winner) => winner.action.kind === "notify").length;
        interruptionsSuppressed += proposedWinners.filter((winner) => winner.action.kind === "suppress_interruption").length;

        const groupedConflicts = new Map<string, { slot: string; winnerCandidateId: string; losingCandidateIds: string[] }>();
        for (const loser of result.trace.losers) {
          if (!loser.winnerCandidateId) continue;
          const key = `${loser.slot}\0${loser.winnerCandidateId}`;
          const grouped = groupedConflicts.get(key) ?? { slot: loser.slot, winnerCandidateId: loser.winnerCandidateId, losingCandidateIds: [] };
          grouped.losingCandidateIds.push(loser.candidateId);
          groupedConflicts.set(key, grouped);
          if (loser.revisionId) {
            const considered = result.trace.consideredRevisions.find((item) => item.revisionId === loser.revisionId);
            if (considered) stableIncrement(losingRuleCounts, `${considered.ruleId}\0${considered.revisionId}`);
          }
        }
        const threadConflicts = [...groupedConflicts.values()]
          .sort((left, right) => left.slot.localeCompare(right.slot) || left.winnerCandidateId.localeCompare(right.winnerCandidateId));
        conflicts.push(...threadConflicts.map((conflict) => ({
          accountId: context.thread.accountId,
          threadId: context.thread.id,
          slot: conflict.slot,
          winningCandidateId: conflict.winnerCandidateId,
          losingCandidateIds: conflict.losingCandidateIds.sort(),
        })));

        const affected = proposedWinners.length > 0 || proposedLosers.length > 0;
        if (affected) affectedThreads += 1;
        if (affected && representativeThreads.length < 20) {
          representativeThreads.push({
            accountId: context.thread.accountId,
            threadId: context.thread.id,
            subject: context.thread.subject ?? "(No subject)",
            lane,
            facets,
            conflictCount: threadConflicts.length,
            traceId: result.trace.id,
          });
        }
      }

      const laneChanges = [...laneCounts.entries()].map(([key, count]) => {
        const [fromLaneId, toLaneId] = key.split("\0");
        return { fromLaneId: fromLaneId!, toLaneId: toLaneId!, count };
      }).sort((left, right) => left.fromLaneId.localeCompare(right.fromLaneId) || left.toLaneId.localeCompare(right.toLaneId));
      const facetChanges = [...facetCounts.entries()].map(([key, count]) => {
        const [facetId, operation] = key.split("\0") as [string, "set" | "unset"];
        return { facetId, operation, count };
      }).sort((left, right) => left.facetId.localeCompare(right.facetId) || left.operation.localeCompare(right.operation));
      const losingRules = [...losingRuleCounts.entries()].map(([key, losses]) => {
        const [ruleId, revisionId] = key.split("\0");
        return { ruleId: ruleId!, revisionId: revisionId!, losses };
      }).sort((left, right) => left.ruleId.localeCompare(right.ruleId) || left.revisionId.localeCompare(right.revisionId));

      const unsigned = {
        state: proposedLosses > 0 ? "conflicted" as const : "simulated" as const,
        binding: {
          ruleId: binding.rule.id,
          revisionId: binding.revision.id,
          ruleRevision: binding.revision.revision,
          sourceDigest: binding.revision.sourceDigest,
          workspaceSchemaRevision: request.workspaceSchemaRevision,
          workspaceRevision: currentWorkspace.revision,
          ruleSetRevision: currentRuleSetRevision,
        },
        scope: { accountIds: requestedAccounts, maximumThreads: request.maximumThreads },
        counts: {
          evaluatedThreads: historical.length,
          affectedThreads,
          candidateActions,
          conflicts: conflicts.length,
        },
        laneChanges,
        facetChanges,
        representativeThreads,
        conflicts,
        losingRules,
        risk: binding.revision.compiled.risk,
        attentionImpact: {
          notifications,
          interruptionsSuppressed,
          estimatedMinutesSaved: notifications * 2 + interruptionsSuppressed * 5,
        },
      };
      const simulationId = `sha256:${createHash("sha256").update(canonicalOrganizationJson(unsigned)).digest("hex")}`;
      return {
        report: orcaHistoricalSimulationResponseSchema.parse({ simulationId, ...unsigned }),
        evaluations,
      };
  };
  return {
    simulate(input: { actor: OrganizationActor; workspaceId: string; request: unknown }): OrcaHistoricalSimulationResponse {
      return prepare(input).report;
    },
    prepare,
  };
}
