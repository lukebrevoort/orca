import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  organizationViewCreateRequestSchema,
  organizationViewCommitRequestSchema,
  organizationViewDefinitionSchema,
  organizationViewDefinitionKind,
  organizationViewPreparationInputSchema,
  organizationViewReviewedDraftSchema,
  organizationViewReorderRequestSchema,
  organizationViewResultPageSchema,
  summarizeOrganizationViewDefinition,
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

describe("BRE-381 reviewed View draft contracts", () => {
  const definition = organizationViewDefinitionSchema.parse({
    revision: 1,
    accountIds: ["account_gmail"],
    sender: { addresses: ["Maya@Example.com"] },
    thread: { readState: "unread" },
  });

  test("accepts typed adapter output without interpreting search or selection input", () => {
    const input = organizationViewPreparationInputSchema.parse({
      kind: "typed_definition",
      source: { kind: "sender_selection", label: "Selected message senders", returnTarget: "/?destination=inbox" },
      identity: { name: "Maya", description: "", color: "#0b9b84", position: 0 },
      definition,
      unsupportedClauses: [],
    });
    assert.equal(input.kind, "typed_definition");
    if (input.kind === "typed_definition") assert.deepEqual(input.definition.sender?.addresses, ["maya@example.com"]);
  });

  test("accepts authoritative selected-message references without client-supplied senders", () => {
    const input = organizationViewPreparationInputSchema.parse({
      kind: "selected_senders",
      source: { kind: "sender_selection", label: "Selected message senders", returnTarget: "/?destination=inbox" },
      identity: { name: "Selected senders", description: "", color: "#0b9b84", position: 0 },
      references: [
        { accountId: "account_gmail", threadId: "thread_maya", messageId: "message_maya" },
        { accountId: "account_gmail", threadId: "thread_ari", messageId: "message_ari" },
      ],
    });
    assert.equal(input.kind, "selected_senders");
    if (input.kind === "selected_senders") {
      assert.deepEqual(input.references[0], { accountId: "account_gmail", threadId: "thread_maya", messageId: "message_maya" });
      assert.equal("sender" in input, false);
    }
  });

  test("rejects empty, duplicate, oversized, or client-enriched selected-message references", () => {
    const base = {
      kind: "selected_senders",
      source: { kind: "sender_selection", label: "Selected message senders" },
      identity: { name: "Selected senders", description: "", color: "#0b9b84", position: 0 },
    } as const;
    const reference = { accountId: "account_gmail", threadId: "thread_maya", messageId: "message_maya" };
    assert.equal(organizationViewPreparationInputSchema.safeParse({ ...base, references: [] }).success, false);
    assert.equal(organizationViewPreparationInputSchema.safeParse({ ...base, references: [reference, reference] }).success, false);
    assert.equal(organizationViewPreparationInputSchema.safeParse({ ...base, references: Array.from({ length: 51 }, (_, index) => ({ ...reference, messageId: `message_${index}` })) }).success, false);
    assert.equal(organizationViewPreparationInputSchema.safeParse({ ...base, references: [{ ...reference, fromAddress: "spoof@example.com" }] }).success, false);
  });

  test("distinguishes match-all definitions from filtered zero-result definitions", () => {
    assert.equal(organizationViewDefinitionKind({ revision: 1 }), "match_all");
    assert.equal(organizationViewDefinitionKind(definition), "filtered");
    assert.match(summarizeOrganizationViewDefinition({ revision: 1 }).text, /All Threads/);
    assert.match(summarizeOrganizationViewDefinition(definition).text, /at least one unread message/);
  });

  test("rejects structurally empty predicate objects instead of treating them as filters", () => {
    assert.equal(organizationViewDefinitionSchema.safeParse({ revision: 1, humanSignal: {} }).success, false);
    assert.equal(organizationViewDefinitionSchema.safeParse({ revision: 1, humanSignal: { minimumScore: undefined } }).success, false);
  });

  test("summarizes every maximum-size valid definition within the response contract", () => {
    const maximumSenders = organizationViewDefinitionSchema.parse({
      revision: 1,
      sender: { addresses: Array.from({ length: 50 }, (_, index) => `sender${index}@example.com`) },
    });
    const summary = summarizeOrganizationViewDefinition(maximumSenders);
    assert.match(summary.text, /50 sender addresses/);
    assert.equal(summary.clauses.every((clause) => clause.length <= 500), true);
  });

  test("binds reviewed drafts and zero-match confirmation to a definition digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const draft = organizationViewReviewedDraftSchema.parse({
      mode: "create",
      viewId: null,
      source: { kind: "manual", label: "New View" },
      identity: { name: "Maya", description: "", color: "#0b9b84", position: 0 },
      definition,
      unsupportedClauses: [],
      definitionDigest: digest,
      definitionKind: "filtered",
      effectiveAccountIds: ["account_gmail"],
      summary: summarizeOrganizationViewDefinition(definition),
      saveEligibility: { allowed: true, code: null, detail: "Ready to save." },
    });
    assert.equal(organizationViewCommitRequestSchema.parse({
      draft,
      expectedRevisions: { workspace: 2, view: null },
      retryKey: "retry-1",
      confirmedZeroMatchDigest: digest,
    }).confirmedZeroMatchDigest, digest);
    assert.equal(organizationViewCommitRequestSchema.safeParse({
      draft,
      expectedRevisions: { workspace: 2, view: 1 },
      retryKey: "retry-1",
    }).success, false);
  });
});
