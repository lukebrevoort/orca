import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  organizationViewCreateRequestSchema,
  organizationViewDefinitionSchema,
  organizationViewReorderRequestSchema,
  organizationViewResultPageSchema,
} from "./organization-views.ts";

describe("BRE-313 live View contracts", () => {
  test("composes every accepted Thread predicate without persisted membership", () => {
    const definition = organizationViewDefinitionSchema.parse({
      revision: 1,
      accountIds: ["account_gmail", "account_outlook"],
      laneIds: ["lane_focus"],
      facetFilters: [{ facetId: "facet_urgency", operator: "equals", value: "urgent" }],
      contextFilters: [{ context: { contextTypeId: "context_type_project", contextId: "context_orca" }, relationshipTypeId: "relationship_concerns" }],
      workflowStateIds: ["workflow_unresolved"],
      humanSignal: { minimumScore: 7, classifications: ["likely_human"], evidenceReasonCodes: ["direct_recipient"] },
      sender: { addresses: ["ops@example.com"], domains: ["status.example.com"] },
      date: { receivedAfter: "2026-08-18T00:00:00.000Z", receivedBefore: "2026-08-26T00:00:00.000Z" },
      thread: { ids: ["thread_failure"], subjectContains: "production failure", readState: "unread" },
    });

    assert.deepEqual(definition.accountIds, ["account_gmail", "account_outlook"]);
    assert.equal("threadIds" in definition, false);
  });

  test("keeps result execution bounded and cursor-based", () => {
    assert.equal(organizationViewCreateRequestSchema.safeParse({ name: "", definition: { revision: 1 } }).success, false);
    assert.equal(organizationViewResultPageSchema.safeParse({
      viewId: "view_weekly", viewRevision: 1, accountIds: ["account_gmail"], items: [], nextCursor: null, limit: 101,
    }).success, false);
  });

  test("requires valid date bounds and unique stable identifiers", () => {
    assert.equal(organizationViewDefinitionSchema.safeParse({
      revision: 1,
      accountIds: ["account_gmail", "account_gmail"],
      date: { receivedAfter: "2026-08-26T00:00:00.000Z", receivedBefore: "2026-08-18T00:00:00.000Z" },
    }).success, false);
  });

  test("requires a complete, uniquely positioned optimistic reorder set", () => {
    const request = organizationViewReorderRequestSchema.parse({ idempotencyKey: "reorder-1", expectedWorkspaceRevision: 5, items: [
      { id: "view_weekly", expectedRevision: 2, position: 0 },
      { id: "view_all", expectedRevision: 4, position: 1 },
    ] });
    assert.deepEqual(request.items.map((item) => item.id), ["view_weekly", "view_all"]);
    assert.equal(organizationViewReorderRequestSchema.safeParse({ idempotencyKey: "reorder-2", expectedWorkspaceRevision: 5, items: [
      { id: "view_weekly", expectedRevision: 2, position: 0 },
      { id: "view_weekly", expectedRevision: 2, position: 1 },
    ] }).success, false);
    assert.equal(organizationViewReorderRequestSchema.safeParse({ idempotencyKey: "reorder-3", expectedWorkspaceRevision: 5, items: [
      { id: "view_weekly", expectedRevision: 2, position: 0 },
      { id: "view_all", expectedRevision: 4, position: 0 },
    ] }).success, false);
  });
});
