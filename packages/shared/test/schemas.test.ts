import { describe, expect, test } from "bun:test";
import {
  accountFixture,
  inboxFixture,
  inboxMessagePageSchema,
  inboxMessageSchema,
  mailAccountSchema,
  normalizedLabelPageSchema,
  normalizedLabelSchema,
  normalizedMessagePageSchema,
  normalizedMessageSchema,
  normalizedThreadPageSchema,
  normalizedThreadSchema,
} from "../src/index";

const normalizedMessageFixture = {
  id: "gmail:acct_123:msg_123",
  provider: "gmail",
  providerMessageId: "msg_123",
  threadId: "gmail:acct_123:thread_123",
  from: {
    name: "Maya Chen",
    email: "maya@example.com",
  },
  to: [
    {
      name: "Luke Brevoort",
      email: "luke@example.com",
    },
  ],
  cc: [],
  bcc: [],
  subject: "Provider test",
  snippet: "A useful preview",
  receivedAt: "2026-06-28T18:30:00.000Z",
  unread: true,
  labels: ["INBOX", "UNREAD", "Label_42"],
  bodyText: "Hello from Gmail",
  bodyHtml: "<p>Hello</p>",
  raw: {
    provider: "gmail",
    accountId: "acct_123",
    messageId: "msg_123",
    threadId: "thread_123",
    labelIds: ["INBOX", "UNREAD", "Label_42"],
  },
} as const;

describe("shared Zod contracts", () => {
  test("parses the existing shared fixtures", () => {
    expect(mailAccountSchema.parse(accountFixture)).toEqual(accountFixture);
    expect(inboxFixture.map((message) => inboxMessageSchema.parse(message))).toEqual(inboxFixture);
  });

  test("parses normalized contracts and their provider pages", () => {
    const normalizedMessage = normalizedMessageSchema.parse(normalizedMessageFixture);
    const normalizedThread = normalizedThreadSchema.parse({
      id: "gmail:acct_123:thread_123",
      provider: "gmail",
      providerThreadId: "thread_123",
      subject: "Provider test",
      latestReceivedAt: "2026-06-28T18:30:00.000Z",
      messageCount: 1,
      labels: ["INBOX", "UNREAD", "Label_42"],
    });
    const normalizedLabel = normalizedLabelSchema.parse({
      id: "gmail:INBOX",
      provider: "gmail",
      providerLabelId: "INBOX",
      name: "Inbox",
      type: "system",
    });

    expect(normalizedMessagePageSchema.parse({ items: [normalizedMessage], nextCursor: null })).toEqual(
      {
        items: [normalizedMessage],
        nextCursor: null,
      },
    );
    expect(normalizedThreadPageSchema.parse({ items: [normalizedThread], nextCursor: "cursor_2" })).toEqual(
      {
        items: [normalizedThread],
        nextCursor: "cursor_2",
      },
    );
    expect(normalizedLabelPageSchema.parse({ items: [normalizedLabel], nextCursor: null })).toEqual(
      {
        items: [normalizedLabel],
        nextCursor: null,
      },
    );
    expect(inboxMessagePageSchema.parse({ items: inboxFixture, nextCursor: null })).toEqual({
      items: inboxFixture,
      nextCursor: null,
    });
  });
});
