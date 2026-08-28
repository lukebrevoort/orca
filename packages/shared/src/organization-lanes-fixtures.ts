import type { OrganizationLaneApply, OrganizationLaneConfiguration, ThreadLanePlacement } from "./organization-lanes.ts";

export const organizationLaneConfigurationFixture: OrganizationLaneConfiguration = {
  workspaceRevision: 7,
  fallbackLaneId: "lane_everything_else",
  policies: [
    { id: "policy_focus", visibility: "prominent", interruption: "notify", review: "continuous", retention: { mode: "keep", days: null }, providerDeletion: false, revision: 1 },
    { id: "policy_fallback", visibility: "standard", interruption: "badge", review: "daily", retention: { mode: "review_after", days: 30 }, providerDeletion: false, revision: 1 },
  ],
  lanes: [
    { id: "lane_focus", name: "Focus", position: 0, defaultPolicyId: "policy_focus", retiredAt: null, revision: 1 },
    { id: "lane_everything_else", name: "Everything else", position: 1, defaultPolicyId: "policy_fallback", retiredAt: null, revision: 1 },
  ],
};

export const organizationFallbackPlacementFixture: ThreadLanePlacement = {
  accountId: "account_personal",
  threadId: "thread_fallback",
  primaryLaneId: "lane_everything_else",
  manualOverride: null,
  safetyLock: { locked: false, actor: null, reason: null, updatedAt: null },
  evidence: {
    winningSource: "workspace_fallback",
    sourceId: "lane_everything_else",
    precedenceLevel: "5_workspace_fallback",
    actor: { id: "system:workspace-fallback", type: "system" },
    reason: "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.",
  },
  revision: null,
};

export const organizationLaneApplyFixture: OrganizationLaneApply = {
  id: "change_lane_override",
  idempotencyKey: "fixture:lane-override:1",
  expectedWorkspaceRevision: 7,
  actions: [{
    kind: "set_thread_manual_override",
    accountId: "account_personal",
    threadId: "thread_fallback",
    laneId: "lane_focus",
    reason: "Keep the launch conversation in view.",
    expectedThreadRevision: null,
  }],
};
