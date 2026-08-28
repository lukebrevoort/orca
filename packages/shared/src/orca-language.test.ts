import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import {
  orcaCompiledRuleRevisionSchema,
  orcaEvaluationEventKindSchema,
  orcaEventKindSchema,
  orcaRuleRevisionListQuerySchema,
  orcaRuleRevisionPageDefaultLimit,
  orcaRuleRevisionPageMaximumLimit,
  orcaRuleReorderRequestSchema,
  orcaRuleOrderResponseSchema,
} from "./orca-language.ts";

describe("Orca Rule revision history contract", () => {
  test("defaults and caps the public page size while bounding cursors", () => {
    assert.deepEqual(orcaRuleRevisionListQuerySchema.parse({}), {
      limit: orcaRuleRevisionPageDefaultLimit,
    });
    assert.equal(orcaRuleRevisionListQuerySchema.parse({ limit: String(orcaRuleRevisionPageMaximumLimit) }).limit, 100);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ cursor: "x".repeat(2_049) }).success, false);
  });
});

describe("Orca Rule Set order contract", () => {
  test("accepts bounded partial reorder semantics and rejects ambiguous duplicate IDs or positions", () => {
    const request = { idempotencyKey: "reorder-1", expectedWorkspaceRevision: 7, expectedRuleSetRevision: 3, items: [
      { id: "rule-b", position: 0, expectedRevision: 2 },
      { id: "rule-a", position: 1, expectedRevision: 4 },
    ] };
    assert.deepEqual(orcaRuleReorderRequestSchema.parse(request), request);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [request.items[0], { ...request.items[1], id: "rule-b" }] }).success, false);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [request.items[0], { ...request.items[1], position: 0 }] }).success, false);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [] }).success, false);
  });

  test("exposes the persisted aggregate revision, digest, count, and canonical positions", () => {
    const response = { workspaceId: "owner", workspaceRevision: 8, ruleSetRevision: 4, orderDigest: `order-v1:${"a".repeat(64)}`, ruleCount: 2, items: [
      { id: "rule-b", position: 0, revision: 2 }, { id: "rule-a", position: 1, revision: 4 },
    ] };
    assert.deepEqual(orcaRuleOrderResponseSchema.parse(response), response);
    assert.equal(orcaRuleOrderResponseSchema.safeParse({ ...response, orderDigest: "not-a-digest" }).success, false);
  });
});

const eventFamilies = ["message.received", "thread.updated", "schedule.reached", "user.corrected"] as const;

describe("Orca Event contracts", () => {
  test("shares one stable four-family vocabulary across compiled Rules and evaluation Trace", () => {
    for (const event of eventFamilies) {
      expect(orcaEventKindSchema.parse(event)).toBe(event);
      expect(orcaEvaluationEventKindSchema.parse(event)).toBe(event);
      expect(orcaCompiledRuleRevisionSchema.parse({
        languageVersion: 1,
        workspaceId: "workspace-1",
        workspaceSchemaRevision: 1,
        name: `${event} rule`,
        event: { kind: event },
        predicates: [{
          name: null,
          expression: { kind: "exists", field: "subject", valueType: "text", optional: true },
        }],
        actions: [{ kind: "route_lane", laneId: "lane-focus" }],
        because: "Canonical Event family",
        requiredCapabilities: ["organization_thread"],
        risk: "low",
      }).event.kind).toBe(event);
    }
  });
});
