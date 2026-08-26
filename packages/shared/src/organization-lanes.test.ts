import { describe, expect, test } from "bun:test";

import { lanePolicySchema, organizationLaneApplySchema, organizationLaneConfigurationFixture } from "./index.ts";

describe("BRE-311 Lane contracts", () => {
  test("keeps Lane Policy defaults typed and categorically excludes provider deletion", () => {
    const policy = organizationLaneConfigurationFixture.policies[0]!;
    expect(lanePolicySchema.parse(policy).providerDeletion).toBe(false);
    expect(lanePolicySchema.safeParse({ ...policy, providerDeletion: true }).success).toBe(false);
  });

  test("requires Account-qualified, revision-checked Manual Overrides", () => {
    expect(organizationLaneApplySchema.safeParse({
      id: "change", idempotencyKey: "lane:change", expectedWorkspaceRevision: 1,
      actions: [{ kind: "set_thread_manual_override", accountId: "account_a", threadId: "thread_a", laneId: "lane_a", reason: "Human choice", expectedThreadRevision: 1 }],
    }).success).toBe(true);
    expect(organizationLaneApplySchema.safeParse({
      id: "change", idempotencyKey: "lane:change", expectedWorkspaceRevision: 1,
      actions: [{ kind: "set_thread_manual_override", threadId: "thread_a", laneId: "lane_a", reason: "Human choice", expectedThreadRevision: 1 }],
    }).success).toBe(false);
  });
});
