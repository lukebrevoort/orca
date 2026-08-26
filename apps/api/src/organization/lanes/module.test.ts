import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { organizationLaneConfigurationFixture, organizationFallbackPlacementFixture } from "@orca/shared";
import { applyLaneActions, OrganizationLaneValidationError, OrganizationSafetyLockError, type OrganizationLaneSnapshot } from "./module.ts";

const human = { id: "human_owner", type: "human" as const };
const now = "2026-08-25T18:00:00.000Z";

function snapshot(): OrganizationLaneSnapshot {
  return {
    configuration: structuredClone(organizationLaneConfigurationFixture),
    placements: [
      { ...structuredClone(organizationFallbackPlacementFixture), accountId: "account_a", threadId: "thread_a", revision: 1 },
      { ...structuredClone(organizationFallbackPlacementFixture), accountId: "account_b", threadId: "thread_b", revision: 1 },
    ],
  };
}

const context = {
  actor: human,
  authorizedAccountIds: ["account_a", "account_b"],
  existingThreads: new Set(["account_a\0thread_a", "account_b\0thread_b"]),
  now,
};

describe("BRE-311 Lane module", () => {
  test("keeps Lane identity stable across rename/reorder and keeps Policy identity separate", () => {
    const result = applyLaneActions(snapshot(), [
      { kind: "update_lane", laneId: "lane_focus", name: "Now", position: 1, expectedRevision: 1 },
      { kind: "update_lane", laneId: "lane_everything_else", position: 0, expectedRevision: 1 },
      { kind: "update_lane_policy", policyId: "policy_focus", visibility: "muted", interruption: "quiet", review: "weekly", retention: { mode: "review_after", days: 45 }, expectedRevision: 1 },
    ], context);
    const lane = result.configuration.lanes.find((item) => item.id === "lane_focus")!;
    const policy = result.configuration.policies.find((item) => item.id === "policy_focus")!;
    assert.equal(lane.id, "lane_focus");
    assert.equal(lane.name, "Now");
    assert.equal(lane.defaultPolicyId, policy.id);
    assert.deepEqual(policy.retention, { mode: "review_after", days: 45 });
    assert.equal(policy.providerDeletion, false);
  });

  test("moves unresolved Threads when the one Workspace Fallback Lane changes", () => {
    const result = applyLaneActions(snapshot(), [{ kind: "set_fallback_lane", laneId: "lane_focus" }], context);
    assert.equal(result.configuration.fallbackLaneId, "lane_focus");
    assert.deepEqual(result.placements.map((placement) => placement.primaryLaneId), ["lane_focus", "lane_focus"]);
    assert.ok(result.placements.every((placement) => placement.evidence.winningSource === "workspace_fallback"));
  });

  test("routes across authorized Accounts while preserving Account-qualified Thread identity", () => {
    const result = applyLaneActions(snapshot(), [{
      kind: "set_thread_manual_override", accountId: "account_b", threadId: "thread_b", laneId: "lane_focus",
      reason: "Customer escalation needs a human review.", expectedThreadRevision: 1,
    }], context);
    const accountA = result.placements.find((placement) => placement.accountId === "account_a")!;
    const accountB = result.placements.find((placement) => placement.accountId === "account_b")!;
    assert.equal(accountA.primaryLaneId, "lane_everything_else");
    assert.equal(accountB.primaryLaneId, "lane_focus");
    assert.deepEqual(accountB.evidence, {
      winningSource: "manual_override", sourceId: "lane_focus", precedenceLevel: "2_manual_override", actor: human,
      reason: "Customer escalation needs a human review.",
    });
    assert.throws(() => applyLaneActions(snapshot(), [{ kind: "set_thread_manual_override", accountId: "account_private", threadId: "thread_private", laneId: "lane_focus", reason: "not allowed", expectedThreadRevision: null }], context), OrganizationLaneValidationError);
  });

  test("Safety Lock blocks Manual Override until the human explicitly unlocks", () => {
    const locked = applyLaneActions(snapshot(), [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: true, reason: "Do not let automation move this launch.", expectedThreadRevision: 1 }], context);
    assert.equal(locked.placements[0]?.safetyLock.locked, true);
    assert.throws(() => applyLaneActions(locked, [{ kind: "set_thread_manual_override", accountId: "account_a", threadId: "thread_a", laneId: "lane_focus", reason: "move", expectedThreadRevision: 2 }], context), OrganizationSafetyLockError);
    const unlocked = applyLaneActions(locked, [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: false, reason: "Human reviewed the lock.", expectedThreadRevision: 2 }], context);
    assert.equal(unlocked.placements[0]?.safetyLock.locked, false);
  });

  test("cannot retire the Fallback Lane or a Lane with routed Threads", () => {
    assert.throws(() => applyLaneActions(snapshot(), [{ kind: "update_lane", laneId: "lane_everything_else", retired: true, expectedRevision: 1 }], context), OrganizationLaneValidationError);
    const overridden = applyLaneActions(snapshot(), [{ kind: "set_thread_manual_override", accountId: "account_a", threadId: "thread_a", laneId: "lane_focus", reason: "keep", expectedThreadRevision: 1 }], context);
    assert.throws(() => applyLaneActions(overridden, [{ kind: "update_lane", laneId: "lane_focus", retired: true, expectedRevision: 1 }], context), OrganizationLaneValidationError);
  });
});
