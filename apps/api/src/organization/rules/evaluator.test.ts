import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { classifyOrcaActions } from "@orca/shared";

import { OrcaEvaluationInputError, evaluateOrcaRules, serializeOrcaEvaluation, type OrcaEvaluationInput } from "./evaluator.ts";

const compiled = (input: {
  name: string;
  predicates?: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["predicates"];
  actions: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["actions"];
  capabilities?: OrcaEvaluationInput["ruleSet"]["revisions"][number]["compiled"]["requiredCapabilities"];
  because: string;
}) => {
  const classification = classifyOrcaActions(input.actions);
  return {
    languageVersion: 1 as const,
    workspaceId: "workspace-1",
    workspaceSchemaRevision: 7,
    name: input.name,
    event: { kind: "message.received" as const },
    predicates: input.predicates ?? [{ name: null, expression: { kind: "compare" as const, field: "subject", operator: "contains" as const, value: "failed", valueType: "text" as const, optional: true, missingBehavior: "false" as const } }],
    actions: input.actions,
    because: input.because,
    requiredCapabilities: input.capabilities ?? classification.requiredCapabilities,
    risk: classification.risk,
  };
};

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
      organizationRevision: 1,
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
              { kind: "add_collection", accountId: "account-1", collectionId: "collection-launch" },
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
              { kind: "add_collection", accountId: "account-1", collectionId: "collection-failures" },
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
      { kind: "add_collection", accountId: "account-1", collectionId: "collection-launch" },
      { kind: "link_context", contextTypeId: "context-type-project", contextId: "context-orca" },
      { kind: "notify", urgency: "immediate" },
      { kind: "add_collection", accountId: "account-1", collectionId: "collection-failures" },
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
    expect(first.trace.reason).toBe("A failed deploy blocks work");
    expect(first.trace.budget).toEqual({
      status: "complete",
      maximumRuleRevisions: 50,
      maximumPredicateSteps: 500,
      maximumCandidates: 200,
      maximumPredicateDepth: 16,
      ruleRevisions: 2,
      predicateSteps: 4,
      candidates: 10,
      exhausted: false,
    });
    expect(serializeOrcaEvaluation(first)).toBe(serializeOrcaEvaluation(second));
  });

  test("produces one byte-stable semantic result and Trace for equivalent fresh invocation order", () => {
    const input = evaluationInput();
    const reordered = structuredClone(input);
    reordered.ruleSet.revisions = [...reordered.ruleSet.revisions].reverse();

    const firstBytes = serializeOrcaEvaluation(evaluateOrcaRules(structuredClone(input)));
    const reorderedBytes = serializeOrcaEvaluation(evaluateOrcaRules(reordered));
    const digest = createHash("sha256").update(firstBytes).digest("hex");

    expect(reorderedBytes).toBe(firstBytes);
    expect(digest).toBe("491a9ae8a2e66079e2cad0edecbdb39498dbee652bfc36be16ab781f9e38062c");
  });

  test("reports the authoritative Safety Lock reason when it wins over a Manual Override and matching Rule", () => {
    const input = evaluationInput();
    input.thread.lanePlacement.primaryLaneId = "lane-focus";
    input.thread.lanePlacement.manualOverride = {
      laneId: "lane-fallback",
      actor: { id: "human-manual", type: "human" },
      reason: "Move after unlock",
      updatedAt: "2026-08-26T11:00:00.000Z",
    };
    input.thread.lanePlacement.safetyLock = {
      locked: true,
      actor: { id: "human-safety", type: "human" },
      reason: "Hold the incident in Focus",
      updatedAt: "2026-08-26T11:30:00.000Z",
    };

    const result = evaluateOrcaRules(input);

    expect(result.trace.winners.find((candidate) => candidate.slot === "lane")).toMatchObject({
      candidateId: "safety-lock:lane",
      precedence: "safety_lock",
      actor: { id: "human-safety", type: "human" },
      reason: "Hold the incident in Focus",
    });
    expect(result.trace.losers.find((candidate) => candidate.candidateId === "manual-override:lane")).toMatchObject({
      candidateReason: "Move after unlock",
      reason: "higher_precedence_candidate",
      winnerCandidateId: "safety-lock:lane",
    });
    expect(result.trace.losers.find((candidate) => candidate.precedence === "rule_revision" && candidate.slot === "lane")).toMatchObject({
      candidateReason: "A failed deploy blocks work",
      reason: "higher_precedence_candidate",
      winnerCandidateId: "safety-lock:lane",
    });
    expect(result.trace.reason).toBe("Hold the incident in Focus");
    expect(result.trace.lowerLanePlacement).toEqual({
      candidateId: "rule:rule-production:rule-production-r2:0",
      laneId: "lane-focus",
      placementSource: "rule_revision",
      sourceId: "rule-production-r2",
      actor: { id: "system:gmail-sync", type: "system" },
      reason: "A failed deploy blocks work",
    });
  });

  test("keeps the top-level reason aligned with the deterministic Lane winner across the precedence matrix", () => {
    const fallbackReason = "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.";
    const cases: Array<{
      name: string;
      input: OrcaEvaluationInput;
      candidateId: string;
      precedence: "safety_lock" | "manual_override" | "rule_revision" | "lane_policy" | "workspace_fallback";
      reason: string;
    }> = [];

    const safetyOverRule = evaluationInput();
    safetyOverRule.thread.lanePlacement.primaryLaneId = "lane-focus";
    safetyOverRule.thread.lanePlacement.safetyLock = {
      locked: true,
      actor: { id: "human-safety", type: "human" },
      reason: "Safety Lock keeps Focus",
      updatedAt: "2026-08-26T11:30:00.000Z",
    };
    cases.push({ name: "Safety Lock over matching Rule", input: safetyOverRule, candidateId: "safety-lock:lane", precedence: "safety_lock", reason: "Safety Lock keeps Focus" });

    const safetyOverFallback = structuredClone(safetyOverRule);
    safetyOverFallback.thread.subject = "Routine status update";
    cases.push({ name: "Safety Lock over nonmatching Rules and fallback", input: safetyOverFallback, candidateId: "safety-lock:lane", precedence: "safety_lock", reason: "Safety Lock keeps Focus" });

    const manualOverRule = evaluationInput();
    manualOverRule.thread.lanePlacement.manualOverride = {
      laneId: "lane-fallback",
      actor: { id: "human-manual", type: "human" },
      reason: "Manual Override keeps Everything else",
      updatedAt: "2026-08-26T11:00:00.000Z",
    };
    cases.push({ name: "Manual Override over Rule", input: manualOverRule, candidateId: "manual-override:lane", precedence: "manual_override", reason: "Manual Override keeps Everything else" });

    cases.push({ name: "Rule winner", input: evaluationInput(), candidateId: "rule:rule-production:rule-production-r2:0", precedence: "rule_revision", reason: "A failed deploy blocks work" });

    const lanePolicy = evaluationInput();
    lanePolicy.ruleSet.revisions = [];
    lanePolicy.thread.lanePlacement.primaryLaneId = "lane-focus";
    lanePolicy.thread.lanePlacement.evidence = {
      winningSource: "lane_policy",
      sourceId: "policy-focus",
      precedenceLevel: "4_lane_policy",
      actor: { id: "agent:lane-policy", type: "agent" },
      reason: "Lane Policy retained Focus",
    };
    cases.push({ name: "Lane Policy winner", input: lanePolicy, candidateId: "lane-policy:lane", precedence: "lane_policy", reason: "Lane Policy retained Focus" });

    const fallback = evaluationInput();
    fallback.ruleSet.revisions = [];
    cases.push({ name: "Workspace Fallback winner", input: fallback, candidateId: "workspace-fallback:lane", precedence: "workspace_fallback", reason: fallbackReason });

    const capabilityDeniedRule = evaluationInput();
    capabilityDeniedRule.capabilities.actionFamilies = ["organization_attention"];
    cases.push({ name: "capability-denied Rule", input: capabilityDeniedRule, candidateId: "workspace-fallback:lane", precedence: "workspace_fallback", reason: fallbackReason });

    const multiSlot = evaluationInput();
    multiSlot.ruleSet.revisions = [
      {
        ruleId: "rule-unrelated",
        revisionId: "rule-unrelated-r1",
        revision: 1,
        order: 1,
        compiled: compiled({
          name: "Unrelated actions",
          actions: [{ kind: "set_workflow_state", stateId: "state-review" }, { kind: "notify", urgency: "immediate" }],
          capabilities: ["organization_attention", "organization_thread"],
          because: "Workflow and attention need review",
        }),
      },
      {
        ruleId: "rule-lane",
        revisionId: "rule-lane-r1",
        revision: 1,
        order: 2,
        compiled: compiled({
          name: "Lane decision",
          actions: [{ kind: "route_lane", laneId: "lane-focus" }],
          because: "The incident belongs in Focus",
        }),
      },
    ];
    cases.push({ name: "multi-slot Actions", input: multiSlot, candidateId: "rule:rule-lane:rule-lane-r1:0", precedence: "rule_revision", reason: "The incident belongs in Focus" });

    for (const item of cases) {
      const result = evaluateOrcaRules(item.input);
      const laneWinner = result.trace.winners.find((candidate) => candidate.slot === "lane");
      expect({
        name: item.name,
        candidateId: laneWinner?.candidateId,
        precedence: laneWinner?.precedence,
        winnerReason: laneWinner?.reason,
        traceReason: result.trace.reason,
      }).toEqual({
        name: item.name,
        candidateId: item.candidateId,
        precedence: item.precedence,
        winnerReason: item.reason,
        traceReason: item.reason,
      });
    }

    const denied = evaluateOrcaRules(capabilityDeniedRule);
    expect(denied.trace.losers.some((candidate) => candidate.slot === "lane" && candidate.precedence === "rule_revision" && candidate.reason === "capability_denied")).toBe(true);
    const mixed = evaluateOrcaRules(multiSlot);
    expect(mixed.trace.winners[0]).toMatchObject({ slot: "workflow_state", reason: "Workflow and attention need review" });
    expect(mixed.trace.reason).toBe("The incident belongs in Focus");
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
    input.ruleSet.revisions[1]!.compiled.risk = "destructive";

    const result = evaluateOrcaRules(input);

    expect(result.trace.observedValues).toContainEqual({ field: "sender.domain", present: false });
    expect(result.trace.consideredRevisions[0]?.predicateMatched).toBe(false);
    expect(result.actions).not.toContainEqual({ kind: "propose_provider_deletion" });
    expect(result.trace.losers).toContainEqual(expect.objectContaining({ authorized: false, reason: "capability_denied" }));

    const attentionOnly = evaluationInput();
    attentionOnly.capabilities.actionFamilies = ["organization_attention"];
    attentionOnly.ruleSet.revisions = [{
      ruleId: "rule-attention",
      revisionId: "revision-attention",
      revision: 1,
      order: 0,
      compiled: compiled({
        name: "Attention needs Thread authority",
        actions: [{ kind: "notify", urgency: "immediate" }],
        because: "Attention remains attached to a Thread",
      }),
    }];
    const attentionResult = evaluateOrcaRules(attentionOnly);
    expect(attentionResult.trace.candidates.find((candidate) => candidate.candidateId === "rule:rule-attention:revision-attention:0"))
      .toMatchObject({ authorized: false, missingCapabilities: ["organization_thread"] });
  });

  test("denies Collection add and remove candidates bound to a different Account", () => {
    for (const kind of ["add_collection", "remove_collection"] as const) {
      const input = evaluationInput();
      input.ruleSet.revisions = [{
        ruleId: `rule-${kind}`,
        revisionId: `revision-${kind}`,
        revision: 1,
        order: 1,
        compiled: compiled({
          name: kind,
          actions: [{ kind, accountId: "account-2", collectionId: "collection-foreign" }],
          because: "The Collection belongs to another Account",
        }),
      }];

      const result = evaluateOrcaRules(input);

      expect(result.actions).not.toContainEqual({ kind, accountId: "account-2", collectionId: "collection-foreign" });
      expect(result.trace.losers).toContainEqual(expect.objectContaining({
        action: { kind, accountId: "account-2", collectionId: "collection-foreign" },
        authorized: false,
        reason: "account_denied",
      }));
    }
  });

  test("resists evaluator-origin event loops and stops fan-out graphs at explicit deterministic budgets", () => {
    const loop = evaluationInput();
    loop.event.cause = "evaluator";
    expect(evaluateOrcaRules(loop).trace.consideredRevisions.every((item) => item.reason === "event_loop_blocked")).toBe(true);

    const bounded = evaluationInput();
    bounded.budgets.maximumPredicateSteps = 2;
    const result = evaluateOrcaRules(bounded);
    expect(result.trace.budget.status).toBe("exhausted");
    expect(result.trace.budget.predicateSteps).toBe(2);
    expect(result.trace.budget.exhausted).toBe(true);
    expect(result.trace.reason).toBe("No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.");
    expect(result.actions.some((action) => action.kind === "route_lane" && action.laneId === "lane-fallback")).toBe(true);
    expect(result.trace.lowerLanePlacement).toMatchObject({ laneId: "lane-fallback", placementSource: "workspace_fallback" });
  });

  test("does not project an earlier matching Rule after a later Rule exhausts the evaluation budget", () => {
    const input = evaluationInput();
    input.budgets.maximumPredicateSteps = 3;

    const result = evaluateOrcaRules(input);

    expect(result.trace.candidates.some((candidate) => candidate.precedence === "rule_revision" && candidate.action.kind === "route_lane")).toBe(true);
    expect(result.trace.losers.some((candidate) => candidate.precedence === "rule_revision" && candidate.reason === "budget_exhausted")).toBe(true);
    expect(result.trace.lowerLanePlacement).toEqual({
      candidateId: "workspace-fallback:lane",
      laneId: "lane-fallback",
      placementSource: "workspace_fallback",
      sourceId: "lane-fallback",
      actor: { id: "system:workspace-fallback", type: "system" },
      reason: "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.",
    });
  });

  test("caps high-fan-out Action evaluation at the exact candidate budget", () => {
    const input = evaluationInput();
    input.budgets.maximumCandidates = 3;
    input.ruleSet.revisions = [{
      ruleId: "rule-wide",
      revisionId: "rule-wide-r1",
      revision: 1,
      order: 1,
      compiled: compiled({
        name: "Wide Action fan-out",
        actions: Array.from({ length: 5 }, (_, index) => ({
          kind: "add_collection" as const,
          accountId: "account-1",
          collectionId: `collection-${index}`,
        })),
        because: "Candidate work is explicitly bounded",
      }),
    }];

    const result = evaluateOrcaRules(input);

    expect(result.trace.budget).toMatchObject({ status: "exhausted", candidates: 3, exhausted: true });
    expect(result.trace.candidates).toHaveLength(3);
    expect(result.trace.winners.every((winner) => winner.precedence !== "rule_revision")).toBe(true);
  });

  test("fails closed on crafted Event provenance and compiled classification metadata", () => {
    const downgraded = evaluationInput();
    downgraded.ruleSet.revisions[0]!.compiled.actions = [{ kind: "propose_provider_deletion" }];
    downgraded.ruleSet.revisions[0]!.compiled.requiredCapabilities = ["organization_thread"];
    downgraded.ruleSet.revisions[0]!.compiled.risk = "low";
    expect(() => evaluateOrcaRules(downgraded)).toThrow(OrcaEvaluationInputError);

    const craftedEvent = evaluationInput();
    (craftedEvent.event as OrcaEvaluationInput["event"] & { source: string }).source = "rule:forged-event-source";
    expect(() => evaluateOrcaRules(craftedEvent)).toThrow(OrcaEvaluationInputError);
  });
});
