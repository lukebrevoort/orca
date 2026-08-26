import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import {
  orcaCompiledRuleRevisionSchema,
  orcaEvaluationEventKindSchema,
  orcaEvaluationEventSchema,
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

  test("binds every Event family to authoritative cause and subject provenance", () => {
    const base = { id: "event-1", occurredAt: "2026-08-26T12:00:00.000Z", workspaceId: "workspace-1", accountId: "account-1", threadId: "thread-1" };
    const valid = [
      { ...base, kind: "message.received", cause: "provider", messageId: "message-1" },
      { ...base, kind: "thread.updated", cause: "provider" },
      { ...base, kind: "thread.updated", cause: "internal" },
      { ...base, kind: "schedule.reached", cause: "scheduler" },
      { ...base, kind: "user.corrected", cause: "user" },
    ];
    for (const event of valid) expect(orcaEvaluationEventSchema.safeParse(event).success).toBe(true);

    const invalid = [
      { ...base, kind: "message.received", cause: "user", messageId: "message-1" },
      { ...base, kind: "message.received", cause: "provider" },
      { ...base, kind: "schedule.reached", cause: "provider" },
      { ...base, kind: "schedule.reached", cause: "scheduler", messageId: "forged" },
      { ...base, kind: "user.corrected", cause: "provider" },
      { ...base, kind: "user.corrected", cause: "user", messageId: "forged" },
      { ...base, kind: "thread.updated", cause: "scheduler" },
      { ...base, kind: "thread.updated", cause: "internal", messageId: "forged" },
      { ...base, accountId: undefined, kind: "message.received", cause: "provider", messageId: "message-1" },
      { ...base, kind: "message.received", cause: "provider", messageId: "message-1", source: "caller:forged" },
      { ...base, kind: "thread.updated", cause: "evaluator" },
    ];
    for (const event of invalid) expect(orcaEvaluationEventSchema.safeParse(event).success).toBe(false);
  });

  test("rejects crafted Action capability and risk downgrades at the shared revision seam", () => {
    const destructive = {
      languageVersion: 1,
      workspaceId: "workspace-1",
      workspaceSchemaRevision: 1,
      name: "Crafted downgrade",
      event: { kind: "message.received" },
      predicates: [{
        name: null,
        expression: { kind: "exists", field: "subject", valueType: "text", optional: true },
      }],
      actions: [{ kind: "propose_provider_deletion" }],
      because: "A label must never downgrade a resolved Action",
      requiredCapabilities: ["organization_thread"],
      risk: "low",
    };

    expect(orcaCompiledRuleRevisionSchema.safeParse(destructive).success).toBe(false);
    expect(orcaCompiledRuleRevisionSchema.safeParse({
      ...destructive,
      requiredCapabilities: ["provider_delete"],
      risk: "destructive",
    }).success).toBe(true);

    const attentionOnly = {
      ...destructive,
      actions: [{ kind: "notify", urgency: "immediate" }],
      requiredCapabilities: ["organization_attention"],
      risk: "medium",
    };
    expect(orcaCompiledRuleRevisionSchema.safeParse(attentionOnly).success).toBe(false);
    expect(orcaCompiledRuleRevisionSchema.safeParse({
      ...attentionOnly,
      requiredCapabilities: ["organization_attention", "organization_thread"],
    }).success).toBe(true);
  });
});
