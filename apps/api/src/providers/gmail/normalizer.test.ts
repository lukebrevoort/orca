import { describe, expect, test } from "bun:test";
import {
  normalizeGmailLabel,
  normalizeGmailMessage,
  normalizeGmailThread,
} from "./normalizer";
import type { GmailMessage } from "./types";

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

    expect(normalized.provider).toBe("gmail");
    expect(normalized.providerMessageId).toBe("msg_123");
    expect(normalized.threadId).toBe("gmail:acct_123:thread_123");
    expect(normalized.from).toEqual({
      name: "Maya Chen",
      email: "maya@example.com",
    });
    expect(normalized.to).toEqual([
      {
        name: "Luke Brevoort",
        email: "luke@example.com",
      },
    ]);
    expect(normalized.subject).toBe("Provider test");
    expect(normalized.bodyText).toBe("Hello from Gmail");
    expect(normalized.unread).toBe(true);
    expect(normalized.raw).toEqual({
      provider: "gmail",
      accountId: "acct_123",
      messageId: "msg_123",
      threadId: "thread_123",
      labelIds: ["INBOX", "UNREAD", "Label_42"],
    });
  });

  test("maps Gmail labels to normalized labels", () => {
    expect(normalizeGmailLabel({ id: "INBOX", name: "Inbox" })).toEqual({
      id: "gmail:INBOX",
      provider: "gmail",
      providerLabelId: "INBOX",
      name: "Inbox",
      type: "system",
    });

    expect(normalizeGmailLabel({ id: "Label_42", name: "Customers" }).type).toBe("user");
  });

  test("maps normalized messages to a normalized thread", () => {
    const message = normalizeGmailMessage(gmailMessage, {
      accountId: "acct_123",
    });

    expect(normalizeGmailThread([message])).toEqual({
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
