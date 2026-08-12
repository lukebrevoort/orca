import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { m5NormalizedFixtureMessages } from "@orca/shared";
import {
  normalizeGmailLabel,
  normalizeGmailMessage,
  normalizeGmailThread,
} from "./normalizer.ts";
import { gmailMessageFixture } from "./fixtures/message.fixture.ts";

describe("Gmail normalizer", () => {
  test("maps Gmail messages to normalized Orca messages", () => {
    const normalized = normalizeGmailMessage(gmailMessageFixture, {
      accountId: "acct_123",
      accountEmail: "luke@example.com",
    });

    assert.equal(normalized.provider, "gmail");
    assert.equal(normalized.providerMessageId, "msg_123");
    assert.equal(normalized.threadId, "gmail:acct_123:thread_123");
    assert.deepEqual(normalized.from, {
      name: "Maya Chen",
      email: "maya@example.com",
    });
    assert.deepEqual(normalized.to, [
      {
        name: "Luke Brevoort",
        email: "luke@example.com",
      },
    ]);
    assert.equal(normalized.subject, "Provider test");
    assert.equal(normalized.bodyText, "Hello from Gmail");
    assert.equal(normalized.unread, true);
    assert.deepEqual(normalized.raw, {
      provider: "gmail",
      accountId: "acct_123",
      messageId: "msg_123",
      threadId: "thread_123",
      labelIds: ["INBOX", "UNREAD", "Label_42"],
    });
    assert.deepEqual(normalized.classificationEvidence, {
      sender: { name: "Maya Chen", email: "maya@example.com" },
      recipients: [{ name: "Luke Brevoort", email: "luke@example.com" }],
      recipientRelationship: "direct",
      reply: { hasInReplyTo: false, referenceCount: 0 },
      headerSignals: [],
      providerSignals: [],
    });
  });

  test("reduces Gmail list headers and categories to safe classifier evidence", () => {
    const normalized = normalizeGmailMessage({
      ...gmailMessageFixture,
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"],
      payload: {
        ...gmailMessageFixture.payload,
        headers: [
          ...(gmailMessageFixture.payload?.headers ?? []),
          { name: "List-Id", value: "<weekly.example>" },
          { name: "List-Unsubscribe", value: "<https://example.com/unsubscribe>" },
          { name: "Precedence", value: "bulk" },
        ],
      },
    }, { accountId: "acct_123", accountEmail: "luke@example.com" });

    assert.deepEqual(normalized.classificationEvidence?.headerSignals, ["list_id", "list_unsubscribe", "precedence_bulk"]);
    assert.deepEqual(normalized.classificationEvidence?.providerSignals, ["promotions_label", "automated_category"]);
  });

  test("keeps the M5 Gmail category cases aligned with adapter evidence", () => {
    const fixtures = m5NormalizedFixtureMessages.filter((message) => ["m5_gmail_transactional", "m5_gmail_override"].includes(message.id));

    for (const fixture of fixtures) {
      const normalized = normalizeGmailMessage({
        id: fixture.raw.messageId,
        threadId: fixture.raw.threadId,
        labelIds: fixture.raw.labelIds,
        snippet: fixture.snippet,
        internalDate: String(Date.parse(fixture.receivedAt)),
        payload: {
          headers: [
            { name: "From", value: `${fixture.from.name} <${fixture.from.email}>` },
            { name: "To", value: fixture.to.map((recipient) => `${recipient.name} <${recipient.email}>`).join(", ") },
            { name: "Subject", value: fixture.subject },
          ],
        },
      }, { accountId: fixture.accountId, accountEmail: "luke@gmail.com" });

      assert.deepEqual(normalized.raw, fixture.raw, fixture.id);
      assert.deepEqual(normalized.classificationEvidence?.providerSignals, fixture.classificationEvidence?.providerSignals, fixture.id);
    }
  });

  test("maps Gmail labels to normalized labels", () => {
    assert.deepEqual(normalizeGmailLabel({ id: "INBOX", name: "Inbox" }), {
      id: "gmail:INBOX",
      provider: "gmail",
      providerLabelId: "INBOX",
      name: "Inbox",
      type: "system",
    });

    assert.equal(normalizeGmailLabel({ id: "Label_42", name: "Customers" }).type, "user");
  });

  test("accepts an angle-bracket address without a display name", () => {
    const normalized = normalizeGmailMessage({
      ...gmailMessageFixture,
      payload: {
        ...gmailMessageFixture.payload,
        headers: [
          { name: "From", value: "<news@example.com>" },
          { name: "To", value: "<luke@example.com>" },
        ],
      },
    }, { accountId: "acct_123" });

    assert.deepEqual(normalized.from, { name: null, email: "news@example.com" });
  });

  test("extracts attachment metadata without fetching attachment content", () => {
    const normalized = normalizeGmailMessage({
      ...gmailMessageFixture,
      payload: {
        ...gmailMessageFixture.payload,
        parts: [
          ...(gmailMessageFixture.payload?.parts ?? []),
          { mimeType: "application/pdf", filename: "notes.pdf", body: { attachmentId: "attachment_1", size: 42 } },
        ],
      },
    }, { accountId: "acct_123" });

    assert.deepEqual(normalized.attachments, [{
      id: "gmail:acct_123:msg_123:attachment:attachment_1",
      filename: "notes.pdf",
      mimeType: "application/pdf",
      size: 42,
    }]);
  });

  test("maps normalized messages to a normalized thread", () => {
    const message = normalizeGmailMessage(gmailMessageFixture, {
      accountId: "acct_123",
    });

    assert.deepEqual(normalizeGmailThread([message]), {
      id: "gmail:acct_123:thread_123",
      provider: "gmail",
      providerThreadId: "thread_123",
      subject: "Provider test",
      latestReceivedAt: "2026-06-28T18:30:00.000Z",
      messageCount: 1,
      labels: ["INBOX", "UNREAD", "Label_42"],
    });
  });
});
