import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type { OrcaRule, OrcaRuleRevision, OrcaWorkspaceSnapshot } from "@orca/shared";

import { compileOrcaRule } from "./compiler.ts";
import { reviewerEvaluationInput } from "./evaluator-fixtures.ts";
import { createHistoricalRuleSimulationService } from "./simulation.ts";

const source = `orca 1
rule "Production failures"
event message.received
predicate from_vercel = sender.domain equals "vercel.com"
predicate failed = subject contains "failed"
when all(from_vercel, failed)
action route lane "Focus"
action set facet "Ticket" = "Present"
action notify immediate
because "A failed deploy blocks work"`;

function fixture() {
  const context = reviewerEvaluationInput();
  const workspace: OrcaWorkspaceSnapshot = {
    workspaceId: context.workspaceSchema.workspaceId,
    revision: context.workspaceSchema.revision,
    lanes: context.workspaceSchema.lanes.map(({ id, name }) => ({ id, name })),
    workflowStates: context.workspaceSchema.workflowStates,
    facets: context.workspaceSchema.facets,
    collections: context.workspaceSchema.collections,
    contextTypes: context.workspaceSchema.contextTypes,
    contexts: context.workspaceSchema.contexts,
  };
  const compiled = compileOrcaRule({ source, workspace });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("production compiler rejected the historical Rule fixture");
  const rule: OrcaRule = {
    id: "rule-production-failure",
    workspaceId: "workspace-1",
    name: "Production failures",
    latestRevision: 3,
    activeRevisionId: null,
    position: 0,
    createdAt: "2026-08-26T10:00:00.000Z",
    updatedAt: "2026-08-26T11:00:00.000Z",
  };
  const revision: OrcaRuleRevision = {
    id: "rule-production-failure-r3",
    ruleId: rule.id,
    workspaceId: rule.workspaceId,
    revision: 3,
    source,
    sourceDigest: `sha256:${new Bun.CryptoHasher("sha256").update(source).digest("hex")}`,
    compiled: compiled.revision,
    actor: { id: "workspace-1", type: "human" },
    createdAt: "2026-08-26T11:00:00.000Z",
  };
  const losingCompiled = compileOrcaRule({
    workspace,
    source: `orca 1\nrule "Old triage"\nevent message.received\nwhen subject contains "failed"\naction route lane "Everything else"\nbecause "The old fallback kept failures quiet"`,
  });
  assert.equal(losingCompiled.ok, true);
  if (!losingCompiled.ok) throw new Error("losing Rule fixture did not compile");
  context.ruleSet.revisions = [{
    ruleId: "rule-old-triage",
    revisionId: "rule-old-triage-r2",
    revision: 2,
    order: 1,
    compilationWorkspace: workspace,
    compiled: losingCompiled.revision,
  }];
  context.ruleSet.activeRevisionCount = 1;
  return { context, workspace, rule, revision };
}

describe("BRE-317 production-semantics historical Simulation", () => {
  test("recompiles through the production compiler, evaluates with production precedence, and never mutates its repository or snapshots", () => {
    const { context, workspace, rule, revision } = fixture();
    const originalContext = structuredClone(context);
    let writeCount = 0;
    const service = createHistoricalRuleSimulationService({
      loadRuleRevision(workspaceId, ruleId, revisionId) {
        assert.equal(workspaceId, "workspace-1");
        assert.equal(ruleId, rule.id);
        assert.equal(revisionId, revision.id);
        return { rule, revision, compilationWorkspace: workspace };
      },
      loadWorkspaceSnapshot() { return workspace; },
      loadRuleSetRevision() { return context.ruleSet.revision; },
      listHistoricalEvaluationInputs(workspaceId, accountIds, maximumThreads) {
        assert.equal(workspaceId, "workspace-1");
        assert.deepEqual(accountIds, ["account-1"]);
        assert.equal(maximumThreads, 500);
        return [context];
      },
      recordWrite() { writeCount += 1; },
    });

    const result = service.simulate({
      actor: { id: "workspace-1", type: "human" },
      workspaceId: "workspace-1",
      request: {
        ruleId: rule.id,
        revisionId: revision.id,
        workspaceSchemaRevision: 7,
        accountIds: ["account-1"],
        maximumThreads: 500,
      },
    });

    assert.equal(writeCount, 0);
    assert.deepEqual(context, originalContext);
    assert.equal(result.state, "simulated");
    assert.equal(result.binding.ruleRevision, 3);
    assert.equal(result.binding.ruleSetRevision, context.ruleSet.revision);
    assert.deepEqual(result.counts, { evaluatedThreads: 1, affectedThreads: 1, candidateActions: 6, conflicts: 2 });
    assert.deepEqual(result.laneChanges, [{ fromLaneId: "lane-fallback", toLaneId: "lane-focus", count: 1 }]);
    assert.deepEqual(result.facetChanges, [{ facetId: "facet-ticket", operation: "set", count: 1 }]);
    assert.deepEqual(result.losingRules, [{ ruleId: "rule-old-triage", revisionId: "rule-old-triage-r2", losses: 1 }]);
    assert.deepEqual(result.attentionImpact, { notifications: 1, interruptionsSuppressed: 0, estimatedMinutesSaved: 2 });
    assert.equal(result.representativeThreads[0]?.traceId, "evaluation:event-1:rules-1:7");
  });

  test("fails closed when the requested Workspace Schema revision is stale before reading history", () => {
    const { workspace, rule, revision } = fixture();
    let historyReads = 0;
    const service = createHistoricalRuleSimulationService({
      loadRuleRevision: () => ({ rule, revision, compilationWorkspace: workspace }),
      loadWorkspaceSnapshot: () => workspace,
      loadRuleSetRevision: () => 1,
      listHistoricalEvaluationInputs: () => { historyReads += 1; return []; },
    });

    assert.throws(() => service.simulate({
      actor: { id: "workspace-1", type: "human" },
      workspaceId: "workspace-1",
      request: { ruleId: rule.id, revisionId: revision.id, workspaceSchemaRevision: 6, accountIds: ["account-1"], maximumThreads: 500 },
    }), /Workspace Schema revision 6 is stale/);
    assert.equal(historyReads, 0);
  });

  test("fails closed when stored source provenance is not bound to its immutable digest", () => {
    const { workspace, rule, revision } = fixture();
    let historyReads = 0;
    const service = createHistoricalRuleSimulationService({
      loadRuleRevision: () => ({
        rule,
        revision: { ...revision, sourceDigest: `sha256:${"0".repeat(64)}` },
        compilationWorkspace: workspace,
      }),
      loadWorkspaceSnapshot: () => workspace,
      loadRuleSetRevision: () => 1,
      listHistoricalEvaluationInputs: () => { historyReads += 1; return []; },
    });

    assert.throws(() => service.simulate({
      actor: { id: "workspace-1", type: "human" },
      workspaceId: "workspace-1",
      request: { ruleId: rule.id, revisionId: revision.id, workspaceSchemaRevision: 7, accountIds: ["account-1"], maximumThreads: 500 },
    }), /source digest/);
    assert.equal(historyReads, 0);
  });
});
