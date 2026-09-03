import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authSessionSchema,
  batchSenderAttentionChangeSchema,
  createCollectionSchema,
  createHumanClassificationOverrideSchema,
  createPinSchema,
  createMessageDraftSchema,
  humanClassificationEvidenceSchema,
  humanClassificationResultSchema,
  normalizeHumanClassificationOverrideTarget,
  resolveHumanClassificationSchema,
  inboxMessageSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  pinFilterSchema,
  senderAttentionBatchResultSchema,
  threadDetailSchema,
  updateMessageDraftSchema,
  updateCollectionSchema,
} from "./index.ts";
import {
  accountFixture,
  inboxFixture,
  m5FixtureAccounts,
  m5FixtureExpectedClassifications,
  m5InboxFixture,
  m5NormalizedFixtureMessages,
} from "./fixtures.ts";

describe("shared API schemas", () => {
  test("parses the fixture inbox response shape", () => {
    assert.deepEqual(
      inboxResponseSchema.parse({
        accounts: [accountFixture],
        messages: inboxFixture,
        counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
        nextCursor: null,
      }),
      {
        accounts: [accountFixture],
        messages: inboxFixture,
        counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
        nextCursor: null,
      },
    );
  });

  test("keeps the M5 fixture matrix provider- and account-attributed", () => {
    assert.deepEqual(
      [...new Set(m5NormalizedFixtureMessages.map((message) => message.provider))],
      ["gmail", "outlook"],
    );
    assert.deepEqual(
      [...new Set(m5NormalizedFixtureMessages.map((message) => message.accountId))],
      ["acct_m5_gmail", "acct_m5_outlook"],
    );
    assert.deepEqual(
      [...new Set(Object.values(m5FixtureExpectedClassifications).map((assessment) => assessment.classification))].sort(),
      ["automated_or_bulk", "likely_human", "uncertain", "unclassified"],
    );
    assert.equal(m5NormalizedFixtureMessages.filter((message) => message.threadId.endsWith("mixed-thread")).length, 2);
    assert.equal(m5InboxFixture.find((message) => message.id === "m5_gmail_override")?.humanClassification?.effective.source, "user_override");
    assert.deepEqual(
      inboxResponseSchema.parse({
        accounts: m5FixtureAccounts,
        messages: m5InboxFixture,
        counts: {
          attention: { focus: 0, normal: m5InboxFixture.length, quiet: 0, hidden: 0, all: m5InboxFixture.length },
          classification: {
            likely_human: m5InboxFixture.filter((message) => message.humanClassification?.effective.classification === "likely_human").length,
            automated_or_bulk: m5InboxFixture.filter((message) => message.humanClassification?.effective.classification === "automated_or_bulk").length,
            uncertain: m5InboxFixture.filter((message) => message.humanClassification?.effective.classification === "uncertain").length,
            unclassified: m5InboxFixture.filter((message) => message.humanClassification?.effective.classification === "unclassified").length,
            all: m5InboxFixture.length,
          },
        },
        nextCursor: null,
      }).accounts.map((account) => account.provider),
      ["gmail", "outlook"],
    );
  });

  test("accepts the opt-in classification count contract alongside the legacy shape", () => {
    const parsed = inboxResponseSchema.parse({
      accounts: [accountFixture],
      messages: inboxFixture,
      counts: {
        attention: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
        classification: { likely_human: 1, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 1 },
      },
      nextCursor: null,
    });
    assert.equal("classification" in parsed.counts, true);
  });

  test("accepts a durable mailbox freshness token without rewriting legacy responses", () => {
    const parsed = inboxResponseSchema.parse({
      accounts: [accountFixture],
      messages: inboxFixture,
      counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
      freshness: {
        revision: `mailbox-v1:${"a".repeat(64)}`,
        lastSyncedAt: "2026-09-02T12:00:00.000Z",
      },
      nextCursor: null,
    });
    assert.equal(parsed.freshness?.revision, `mailbox-v1:${"a".repeat(64)}`);
  });

  test("rejects blank inbox cursors", () => {
    const result = inboxQuerySchema.safeParse({ cursor: "" });

    assert.equal(result.success, false);
    assert.equal(result.error.issues[0]?.path.join("."), "cursor");
  });

  test("coerces bounded inbox limits", () => {
    assert.deepEqual(inboxQuerySchema.parse({ limit: "25", classification: "tideline" }), { limit: 25, classification: "tideline" });
    assert.equal(inboxQuerySchema.safeParse({ limit: "0" }).success, false);
    assert.equal(inboxQuerySchema.safeParse({ limit: "101" }).success, false);
    assert.equal(inboxQuerySchema.safeParse({ classification: "machine" }).success, false);
  });

  test("normalizes unique batch sender changes and preserves canonical per-sender outcomes", () => {
    assert.deepEqual(batchSenderAttentionChangeSchema.parse({
      addresses: [" Maya@Example.com ", "jordan@example.com"],
      behavior: "quiet",
    }), {
      addresses: ["maya@example.com", "jordan@example.com"],
      behavior: "quiet",
    });
    assert.equal(batchSenderAttentionChangeSchema.safeParse({
      addresses: ["Maya@example.com", "maya@example.com"],
      behavior: "quiet",
    }).success, false);

    const result = senderAttentionBatchResultSchema.parse({
      behavior: "quiet",
      outcomes: [
        { status: "succeeded", address: "Maya@Example.com", resolution: { behavior: "quiet", rule: null } },
        {
          status: "failed",
          address: "jordan@example.com",
          retryable: true,
          error: { code: "temporarily_unavailable", message: "Try again" },
          resolution: { behavior: "normal", rule: null },
        },
      ],
    });
    assert.equal(result.outcomes[0]?.address, "maya@example.com");
    assert.equal(result.outcomes[1]?.status, "failed");
  });

  test("defines an explainable, bounded Human Signal contract", () => {
    const automatic = {
      classification: "likely_human" as const,
      score: 8,
      reasonCodes: ["direct_recipient", "reply_context"] as const,
      classifierVersion: "m5-v1",
    };
    const classification = humanClassificationResultSchema.parse({
      automatic,
      effective: { ...automatic, source: "automatic_heuristic" },
    });

    assert.equal(classification.effective.classification, "likely_human");
    assert.equal(classification.effective.score, 8);
    assert.equal(
      humanClassificationResultSchema.safeParse({
        automatic: null,
        effective: {
          classification: "likely_human",
          score: 11,
          reasonCodes: [],
          classifierVersion: "m5-v1",
          source: "automatic_heuristic",
        },
      }).success,
      false,
    );

    const evidence = humanClassificationEvidenceSchema.parse({
      sender: { name: "Maya", email: "maya@example.com" },
      recipients: [{ name: "Luke", email: "luke@example.com" }],
      recipientRelationship: "direct",
      reply: { hasInReplyTo: true, referenceCount: 1 },
      headerSignals: ["list_id"],
      providerSignals: [],
    });
    assert.deepEqual(evidence.headerSignals, ["list_id"]);

    const message = inboxMessageSchema.parse({
      ...inboxFixture[0],
      humanSignal: 8,
      humanClassification: classification,
    });
    assert.equal(message.humanClassification?.effective.source, "automatic_heuristic");
    assert.equal(message.humanClassification?.userOverride, null);

    const override = createHumanClassificationOverrideSchema.parse({
      accountId: "account_1",
      target: { scope: "sender_address", address: "MAYA@EXAMPLE.COM" },
      classification: "likely_human",
    });
    assert.equal(override.target.scope, "sender_address");
    if (override.target.scope === "sender_address") assert.equal(override.target.address, "maya@example.com");
    assert.deepEqual(normalizeHumanClassificationOverrideTarget({ scope: "sender_domain", domain: "EXAMPLE.COM" }), {
      scope: "sender_domain", domain: "example.com",
    });
    assert.equal(createHumanClassificationOverrideSchema.safeParse({
      accountId: "account_1",
      target: { scope: "sender_domain", domain: "not a domain" },
      classification: "likely_human",
    }).success, false);
    assert.equal(createHumanClassificationOverrideSchema.safeParse({
      accountId: "account_1",
      target: { scope: "message", messageId: "   " },
      classification: "likely_human",
    }).success, false);
    assert.deepEqual(resolveHumanClassificationSchema.parse({ accountId: "account_1", messageId: " message_1 " }), {
      accountId: "account_1", messageId: "message_1",
    });
  });

  test("requires an authenticated user when the session is authenticated", () => {
    assert.throws(
      () =>
        authSessionSchema.parse({
          isAuthenticated: true,
          user: null,
          expiresAt: null,
          onboardingCompletedAt: null,
        }),
      /Authenticated sessions must include a user/,
    );
  });

  test("accepts an older authenticated session response without onboarding state", () => {
    const session = authSessionSchema.parse({
      isAuthenticated: true,
      user: { id: "user_1", email: "luke@example.com", name: "Luke" },
      expiresAt: null,
    });

    assert.equal(session.onboardingCompletedAt, null);
  });

  test("keeps nullable body fields and attachment metadata in reader payloads", () => {
    const result = threadDetailSchema.safeParse({
      account: accountFixture,
      thread: {
        id: "thread_1", provider: "gmail", providerThreadId: "provider-thread-1", subject: "A thread", latestReceivedAt: "2026-07-08T12:00:00.000Z", messageCount: 1, labels: [], participants: [], readState: "read",
        attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: null },
      },
      messages: [{
        id: "message_1", accountId: accountFixture.id, provider: "gmail", providerMessageId: "provider-message-1", from: { name: null, email: "maya@example.com" }, to: [], cc: [], bcc: [], subject: "A thread", snippet: "", receivedAt: "2026-07-08T12:00:00.000Z", unread: false, labels: [], bodyText: null, bodyHtml: null, internetMessageId: null, references: [], humanSignal: null,
        attachments: [{ id: "attachment_1", filename: "notes.pdf", mimeType: "application/pdf", size: 42 }],
      }],
    });
    assert.equal(result.success, true);
  });

  test("validates organization inputs without move semantics", () => {
    assert.deepEqual(createCollectionSchema.parse({ name: "Orca launch" }), { name: "Orca launch" });
    assert.deepEqual(createCollectionSchema.parse({ name: "Orca launch", color: "#70867d" }), { name: "Orca launch", color: "#70867d" });
    assert.deepEqual(createPinSchema.parse({ kind: "thread", targetId: "thread_1", label: "Launch notes" }), { kind: "thread", targetId: "thread_1", label: "Launch notes" });
    assert.deepEqual(createPinSchema.parse({ kind: "thread", targetId: "thread_1", label: "Launch notes", icon: "star", color: "#83728d" }), { kind: "thread", targetId: "thread_1", label: "Launch notes", icon: "star", color: "#83728d" });
    assert.deepEqual(pinFilterSchema.parse({ mailbox: "inbox", attention: "focus", classification: "tideline", person: "maya@example.com", query: "launch" }), { mailbox: "inbox", attention: "focus", classification: "tideline", person: "maya@example.com", query: "launch" });
    assert.deepEqual(pinFilterSchema.parse({ mailbox: "inbox", attention: "focus", person: "maya@example.com", query: "launch" }), { mailbox: "inbox", attention: "focus", person: "maya@example.com", query: "launch" });
    assert.equal(updateCollectionSchema.safeParse({}).success, false);
    assert.equal(updateCollectionSchema.safeParse({ color: "moss" }).success, false);
    assert.equal(createPinSchema.safeParse({ kind: "folder", targetId: "thread_1", label: "Nope" }).success, false);
    assert.equal(createPinSchema.safeParse({ kind: "thread", targetId: "thread_1", label: "Nope", icon: "folder" }).success, false);
    assert.equal(createPinSchema.safeParse({ kind: "thread", targetId: "thread_1", label: "Nope", color: "moss" }).success, false);
  });

  test("normalizes outbound recipients and requires a revision to update drafts", () => {
    const draft = createMessageDraftSchema.parse({
      to: [{ name: "Maya", email: "MAYA@EXAMPLE.COM" }],
      body: { text: "Hello", html: "<p>Hello</p>" },
    });
    assert.equal(draft.to[0]?.email, "maya@example.com");
    assert.equal(draft.body.text, "Hello");
    assert.equal(updateMessageDraftSchema.safeParse({ revision: 0 }).success, false);
    assert.equal(updateMessageDraftSchema.safeParse({ revision: 0, subject: "Updated" }).success, true);
  });
});
