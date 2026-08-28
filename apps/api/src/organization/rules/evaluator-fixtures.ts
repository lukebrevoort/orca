import type { OrcaEvaluationInput } from "./evaluator.ts";

export function reviewerEvaluationInput(options: { safetyLock?: boolean } = {}): OrcaEvaluationInput {
  const input: OrcaEvaluationInput = {
    event: {
      id: options.safetyLock ? "event-safety" : "event-1",
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
      facets: [{ id: "facet-ticket", cardinality: "single" }],
    },
    ruleSet: {
      id: "rules-1",
      revision: 7,
      revisions: [{
        ruleId: "rule-production",
        revisionId: "rule-production-r2",
        revision: 2,
        order: 0,
        compiled: {
          languageVersion: 1,
          workspaceId: "workspace-1",
          workspaceSchemaRevision: 7,
          name: "Production failures",
          event: { kind: "message.received" },
          predicates: [
            { name: "from_vercel", expression: { kind: "compare", field: "sender.domain", operator: "equals", value: "vercel.com", valueType: "domain", optional: true, missingBehavior: "false" } },
            { name: "failed", expression: { kind: "compare", field: "subject", operator: "contains", value: "failed", valueType: "text", optional: true, missingBehavior: "false" } },
            { name: "ticket_present", expression: { kind: "exists", field: "facet:facet-ticket", valueType: "enum", optional: true, facetId: "facet-ticket" } },
            { name: null, expression: { kind: "all", predicates: ["from_vercel", "failed"] } },
          ],
          actions: [
            { kind: "route_lane", laneId: "lane-focus" },
            { kind: "set_workflow_state", stateId: "state-review" },
            { kind: "notify", urgency: "immediate" },
            { kind: "propose_provider_deletion" },
          ],
          because: "A failed deploy blocks work",
          requiredCapabilities: ["organization_attention", "organization_thread"],
          risk: "low",
        },
      }],
    },
    actor: { id: "system:gmail-sync", type: "system" },
    capabilities: {
      id: "sync-capabilities",
      revision: 1,
      actor: { id: "system:gmail-sync", type: "system" },
      scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
      operations: ["apply"],
      resourceFamilies: ["thread", "lane", "workflow_state", "trace"],
      actionFamilies: ["organization_thread", "organization_attention"],
    },
    logicalTime: "2026-08-26T12:00:00.000Z",
    budgets: { maximumRuleRevisions: 100, maximumPredicateSteps: 2_000, maximumCandidates: 1_000 },
  };

  if (options.safetyLock) {
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
  }

  return input;
}
