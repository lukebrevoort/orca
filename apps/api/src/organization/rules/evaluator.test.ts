import { describe, expect, test } from "bun:test";

import { evaluateOrcaRules, serializeOrcaEvaluation, type OrcaEvaluationInput } from "./evaluator.ts";

const compiled = (input: {
  name: string;
  predicates?: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["predicates"];
  actions: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["actions"];
  capabilities?: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["requiredCapabilities"];
  because: string;
}) => ({
  languageVersion: 1 as const,
  workspaceId: "workspace-1",
  workspaceSchemaRevision: 7,
  name: input.name,
  event: { kind: "message.received" as const },
  predicates: input.predicates ?? [{ name: null, expression: { kind: "compare" as const, field: "subject", operator: "contains" as const, value: "failed", valueType: "text" as const, optional: true, missingBehavior: "false" as const } }],
  actions: input.actions,
  because: input.because,
  requiredCapabilities: input.capabilities ?? ["organization_thread" as const],
  risk: "low" as const,
});

function evaluationInput(): OrcaEvaluationInput {
  return {
    event: {
      id: "event-1",
      kind: "message.received",
      cause: "provider",
      occurredAt: "2026-08-26T12:00:00.000Z",
      workspaceId: "workspace-1",
      accountId: "account-1",
      threadId: "thread-1",
      messageId: "message-1",
    },
    thread: {
      workspaceId: "workspace-1",
      accountId: "account-1",
      id: "thread-1",
      subject: "Production deploy failed",
      sender: { email: "alerts@vercel.com", domain: "vercel.com" },
      messageCount: 1,
      unread: true,
      latestReceivedAt: "2026-08-26T12:00:00.000Z",
      humanSignal: 0.92,
      facets: {},
      workflowStateId: null,
      collectionIds: [],
      contextIds: [],
      lanePlacement: {
        accountId: "account-1",
        threadId: "thread-1",
        primaryLaneId: "lane-fallback",
        manualOverride: null,
        safetyLock: { locked: false, actor: null, reason: null, updatedAt: null },
        evidence: {
          winningSource: "workspace_fallback",
          sourceId: "lane-fallback",
          precedenceLevel: "5_workspace_fallback",
          actor: { id: "system:workspace-fallback", type: "system" },
          reason: "Workspace fallback",
        },
        revision: 1,
      },
    },
    workspaceSchema: {
      workspaceId: "workspace-1",
      revision: 7,
      fallbackLaneId: "lane-fallback",
      lanes: [
        { id: "lane-focus", name: "Focus", defaultPolicyId: "policy-focus" },
        { id: "lane-fallback", name: "Everything else", defaultPolicyId: "policy-default" },
      ],
      lanePolicies: [
        { id: "policy-focus", interruption: "notify", review: "continuous", retention: { mode: "keep", days: null } },
        { id: "policy-default", interruption: "badge", review: "daily", retention: { mode: "keep", days: null } },
      ],
      facets: [{ id: "facet-urgency", cardinality: "single" }],
    },
    ruleSet: {
      id: "rule-set-1",
      revision: 3,
      revisions: [
        {
          ruleId: "rule-production",
          revisionId: "rule-production-r2",
          revision: 2,
          order: 10,
          compiled: compiled({
            name: "Production failures",
            predicates: [
              { name: "from_vercel", expression: { kind: "compare", field: "sender.domain", operator: "equals", value: "vercel.com", valueType: "domain", optional: true, missingBehavior: "false" } },
              { name: "failed", expression: { kind: "compare", field: "subject", operator: "contains", value: "failed", valueType: "text", optional: true, missingBehavior: "false" } },
              { name: null, expression: { kind: "all", predicates: ["from_vercel", "failed"] } },
            ],
            actions: [
              { kind: "route_lane", laneId: "lane-focus" },
              { kind: "set_workflow_state", stateId: "state-review" },
              { kind: "set_facet", facetId: "facet-urgency", value: "urgent" },
              { kind: "add_collection", collectionId: "collection-launch" },
              { kind: "link_context", contextTypeId: "context-type-project", contextId: "context-orca" },
              { kind: "notify", urgency: "immediate" },
            ],
            capabilities: ["organization_attention", "organization_thread"],
            because: "A failed deploy blocks work",
          }),
        },
        {
          ruleId: "rule-general",
          revisionId: "rule-general-r1",
          revision: 1,
          order: 20,
          compiled: compiled({
            name: "General failures",
            actions: [
              { kind: "route_lane", laneId: "lane-fallback" },
              { kind: "add_collection", collectionId: "collection-failures" },
            ],
            because: "All failures remain reviewable",
          }),
        },
      ],
    },
    actor: { id: "system:gmail-sync", type: "system" },
    capabilities: {
      id: "capability-sync-1",
      revision: 4,
      actor: { id: "system:gmail-sync", type: "system" },
      scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
      operations: ["apply"],
      resourceFamilies: ["thread", "lane", "facet", "context", "workflow_state", "trace", "change_set"],
      actionFamilies: ["organization_thread", "organization_attention"],
    },
    logicalTime: "2026-08-26T12:00:00.000Z",
    budgets: { maximumRuleRevisions: 50, maximumPredicateSteps: 500, maximumCandidates: 200 },
  };
}

describe("evaluateOrcaRules", () => {
  test("matches each canonical Event family without allowing evaluator-origin recursion", () => {
    for (const event of ["message.received", "thread.updated", "schedule.reached", "user.corrected"] as const) {
      const input = evaluationInput();
      input.event.kind = event;
      input.ruleSet.revisions[0]!.compiled.event.kind = event;

      const result = evaluateOrcaRules(input);

      expect(result.trace.event.kind).toBe(event);
      expect(result.trace.consideredRevisions[0]).toMatchObject({ eventMatched: true, predicateMatched: true });
    }

    const recursive = evaluationInput();
    recursive.event.kind = "thread.updated";
    recursive.event.cause = "evaluator";
    recursive.ruleSet.revisions[0]!.compiled.event.kind = "thread.updated";
    expect(evaluateOrcaRules(recursive).trace.consideredRevisions[0]?.reason).toBe("event_loop_blocked");
  });

  test("combines compatible Actions, selects exact exclusive winners, and returns a complete deterministic Trace", () => {
    const input = evaluationInput();

    const first = evaluateOrcaRules(input);
    const second = evaluateOrcaRules(structuredClone(input));

    expect(first.actions).toEqual([
      { kind: "route_lane", laneId: "lane-focus" },
      { kind: "set_workflow_state", stateId: "state-review" },
      { kind: "set_facet", facetId: "facet-urgency", value: "urgent" },
      { kind: "add_collection", collectionId: "collection-launch" },
      { kind: "link_context", contextTypeId: "context-type-project", contextId: "context-orca" },
      { kind: "notify", urgency: "immediate" },
      { kind: "add_collection", collectionId: "collection-failures" },
    ]);
    expect(first.trace.consideredRevisions.map((item) => [item.revisionId, item.eventMatched, item.predicateMatched])).toEqual([
      ["rule-production-r2", true, true],
      ["rule-general-r1", true, true],
    ]);
    expect(first.trace.observedValues).toEqual(expect.arrayContaining([
      { field: "sender.domain", present: true, value: "vercel.com" },
      { field: "subject", present: true, value: "Production deploy failed" },
    ]));
    expect(first.trace.predicateResults.some((item) => item.kind === "all" && item.result)).toBe(true);
    expect(first.trace.winners).toHaveLength(7);
    expect(first.trace.losers.some((item) => item.action.kind === "route_lane" && item.reason === "higher_precedence_candidate")).toBe(true);
    expect(first.trace.actor).toEqual(input.actor);
    expect(first.trace.capabilities).toEqual(input.capabilities);
    expect(first.trace.reason).toBe("Production failures: A failed deploy blocks work");
    expect(first.trace.budget.exhausted).toBe(false);
    expect(serializeOrcaEvaluation(first)).toBe(serializeOrcaEvaluation(second));
  });

  test("enforces Safety Lock then Manual Override before ordered Rule, Lane Policy, and Workspace fallback", () => {
    const unlocked = evaluationInput();
    unlocked.thread.lanePlacement.manualOverride = {
      laneId: "lane-fallback",
      actor: { id: "human-1", type: "human" },
      reason: "Keep this thread where I put it",
      updatedAt: "2026-08-26T11:00:00.000Z",
    };
    expect(evaluateOrcaRules(unlocked).actions[0]).toEqual({ kind: "route_lane", laneId: "lane-fallback" });
    expect(evaluateOrcaRules(unlocked).trace.winners[0]?.precedence).toBe("manual_override");

    const locked = structuredClone(unlocked);
    locked.thread.lanePlacement.primaryLaneId = "lane-focus";
    locked.thread.lanePlacement.safetyLock = {
      locked: true,
      actor: { id: "human-2", type: "human" },
      reason: "Do not move this incident",
      updatedAt: "2026-08-26T11:30:00.000Z",
    };
    const lockedResult = evaluateOrcaRules(locked);
    expect(lockedResult.actions[0]).toEqual({ kind: "route_lane", laneId: "lane-focus" });
    expect(lockedResult.trace.winners[0]).toMatchObject({
      candidateId: "safety-lock:lane",
      precedence: "safety_lock",
      actor: { id: "human-2", type: "human" },
      reason: "Do not move this incident",
    });
    expect(lockedResult.trace.losers.find((candidate) => candidate.precedence === "manual_override")).toMatchObject({
      winnerCandidateId: "safety-lock:lane",
      reason: "higher_precedence_candidate",
    });

    const noRules = evaluationInput();
    noRules.ruleSet.revisions = [];
    const fallback = evaluateOrcaRules(noRules);
    expect(fallback.actions[0]).toEqual({ kind: "route_lane", laneId: "lane-fallback" });
    expect(fallback.trace.winners.find((item) => item.slot === "lane")?.precedence).toBe("workspace_fallback");
    expect(fallback.trace.winners.find((item) => item.slot === "attention")?.precedence).toBe("lane_policy");
  });

  test("records missing data and capability denial without activating unsafe behavior", () => {
    const input = evaluationInput();
    input.thread.sender = null;
    input.ruleSet.revisions[0]!.compiled.predicates = [
      { name: null, expression: { kind: "compare", field: "sender.domain", operator: "equals", value: "vercel.com", valueType: "domain", optional: true, missingBehavior: "false" } },
    ];
    input.ruleSet.revisions[1]!.compiled.actions = [{ kind: "propose_provider_deletion" }];
    input.ruleSet.revisions[1]!.compiled.requiredCapabilities = ["provider_delete"];

    const result = evaluateOrcaRules(input);

    expect(result.trace.observedValues).toContainEqual({ field: "sender.domain", present: false });
    expect(result.trace.consideredRevisions[0]?.predicateMatched).toBe(false);
    expect(result.actions).not.toContainEqual({ kind: "propose_provider_deletion" });
    expect(result.trace.losers).toContainEqual(expect.objectContaining({ authorized: false, reason: "capability_denied" }));
  });

  test("resists evaluator-origin event loops and stops fan-out graphs at explicit deterministic budgets", () => {
    const loop = evaluationInput();
    loop.event.cause = "evaluator";
    expect(evaluateOrcaRules(loop).trace.consideredRevisions.every((item) => item.reason === "event_loop_blocked")).toBe(true);

    const bounded = evaluationInput();
    bounded.budgets.maximumPredicateSteps = 2;
    const result = evaluateOrcaRules(bounded);
    expect(result.trace.budget.exhausted).toBe(true);
    expect(result.trace.reason).toBe("Evaluation budget exhausted; only non-Rule precedence sources were resolved.");
    expect(result.actions.some((action) => action.kind === "route_lane" && action.laneId === "lane-fallback")).toBe(true);
  });
});
