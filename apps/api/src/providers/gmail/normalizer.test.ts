import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
