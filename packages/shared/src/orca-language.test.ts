import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import {
  orcaCompiledRuleRevisionSchema,
  orcaEvaluationEventKindSchema,
  orcaEventKindSchema,
  orcaRuleRevisionListQuerySchema,
  orcaRuleRevisionPageDefaultLimit,
  orcaRuleRevisionPageMaximumLimit,
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
