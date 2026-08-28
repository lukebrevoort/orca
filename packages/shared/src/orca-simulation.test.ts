import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  orcaHistoricalSimulationRequestSchema,
  orcaHistoricalSimulationResponseSchema,
  orcaRuleActivationRequestSchema,
  orcaRuleRevertRequestSchema,
} from "./orca-simulation.ts";

describe("BRE-317 historical Simulation contracts", () => {
  test("binds one compiled Rule Revision, Workspace Schema revision, and bounded Account scope", () => {
    const request = {
      ruleId: "rule-production-failure",
      revisionId: "rule-production-failure-r3",
      workspaceSchemaRevision: 12,
      accountIds: ["account-primary", "account-support"],
      maximumThreads: 500,
    };

    assert.deepEqual(orcaHistoricalSimulationRequestSchema.parse(request), request);
    assert.equal(orcaHistoricalSimulationRequestSchema.safeParse({ ...request, accountIds: [] }).success, false);
    assert.equal(orcaHistoricalSimulationRequestSchema.safeParse({ ...request, accountIds: ["account-primary", "account-primary"] }).success, false);
    assert.equal(orcaHistoricalSimulationRequestSchema.safeParse({ ...request, maximumThreads: 5_001 }).success, false);
  });

  test("requires historical impact, representative Threads, conflicts, losing Rules, risk, and attention estimates", () => {
    const response = {
      simulationId: `sha256:${"a".repeat(64)}`,
      state: "simulated",
      binding: {
        ruleId: "rule-production-failure",
        revisionId: "rule-production-failure-r3",
        ruleRevision: 3,
        sourceDigest: `sha256:${"b".repeat(64)}`,
        workspaceSchemaRevision: 12,
        workspaceRevision: 12,
        ruleSetRevision: 7,
      },
      scope: { accountIds: ["account-primary"], maximumThreads: 500 },
      counts: { evaluatedThreads: 2, affectedThreads: 1, candidateActions: 4, conflicts: 1 },
      laneChanges: [{ fromLaneId: "lane-everything", toLaneId: "lane-focus", count: 1 }],
      facetChanges: [{ facetId: "facet-severity", operation: "set", count: 1 }],
      representativeThreads: [{
        accountId: "account-primary",
        threadId: "thread-prod-failure",
        subject: "Production checkout failure",
        lane: { before: "lane-everything", after: "lane-focus" },
        facets: [{ facetId: "facet-severity", before: null, after: "critical" }],
        conflictCount: 1,
        traceId: "simulation:thread-prod-failure",
      }],
      conflicts: [{
        accountId: "account-primary",
        threadId: "thread-prod-failure",
        slot: "lane",
        winningCandidateId: "rule:manual-override",
        losingCandidateIds: ["rule:production-failure"],
      }],
      losingRules: [{ ruleId: "rule-old-triage", revisionId: "rule-old-triage-r2", losses: 1 }],
      risk: "medium",
      attentionImpact: { notifications: 1, interruptionsSuppressed: 0, estimatedMinutesSaved: 6 },
    };

    assert.deepEqual(orcaHistoricalSimulationResponseSchema.parse(response), response);
    const { conflicts: _conflicts, ...withoutConflicts } = response;
    assert.equal(orcaHistoricalSimulationResponseSchema.safeParse(withoutConflicts).success, false);
  });
});

describe("BRE-317 activation and compensating revert contracts", () => {
  test("requires exact successful Simulation and expected revisions before activation", () => {
    const request = {
      ruleId: "rule-production-failure",
      revisionId: "rule-production-failure-r3",
      simulationId: `sha256:${"a".repeat(64)}`,
      accountIds: ["account-primary"],
      maximumThreads: 500,
      expectedWorkspaceRevision: 12,
      expectedRuleRevision: 3,
      expectedRuleSetRevision: 7,
      idempotencyKey: "activate-production-failure-r3",
    };
    assert.deepEqual(orcaRuleActivationRequestSchema.parse(request), request);
    assert.equal(orcaRuleActivationRequestSchema.safeParse({ ...request, simulationId: "simulation-latest" }).success, false);
    assert.equal(orcaRuleActivationRequestSchema.safeParse({ ...request, idempotencyKey: " " }).success, false);
  });

  test("requires the original Change Set and fresh Workspace revision for revert", () => {
    const request = {
      changeSetId: "change-activate-production-failure-r3",
      accountIds: ["account-primary"],
      expectedWorkspaceRevision: 13,
      idempotencyKey: "revert-production-failure-r3",
    };
    assert.deepEqual(orcaRuleRevertRequestSchema.parse(request), request);
    assert.equal(orcaRuleRevertRequestSchema.safeParse({ ...request, changeSetId: "" }).success, false);
  });
});
