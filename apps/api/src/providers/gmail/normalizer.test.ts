import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeGmailLabel,
  normalizeGmailMessage,
  normalizeGmailThread,
} from "./normalizer.ts";
import type { GmailMessage } from "./types.ts";

const gmailMessage: GmailMessage = {
  id: "msg_123",
  threadId: "thread_123",
  labelIds: ["INBOX", "UNREAD", "Label_42"],
  snippet: "A useful preview",
  internalDate: "1782671400000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Maya Chen <maya@example.com>" },
      { name: "To", value: "Luke Brevoort <luke@example.com>" },
      { name: "Subject", value: "Provider test" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: {
          data: "SGVsbG8gZnJvbSBHbWFpbA==",
        },
      },
      {
        mimeType: "text/html",
        body: {
          data: "PHA-SGVsbG88L3A-",
        },
      },
    ],
  },
};

describe("Gmail normalizer", () => {
  test("maps Gmail messages to normalized Orca messages", () => {
    const normalized = normalizeGmailMessage(gmailMessage, {
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

  test("maps normalized messages to a normalized thread", () => {
    const message = normalizeGmailMessage(gmailMessage, {
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
