import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
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
