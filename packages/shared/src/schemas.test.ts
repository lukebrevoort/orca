import assert from "node:assert/strict";
import test from "node:test";
import {
  accountFixture,
  createProviderPageSchema,
  inboxFixture,
  inboxResponseSchema,
  mailAccountSchema,
  normalizedLabelSchema,
  normalizedMessageSchema,
  normalizedThreadSchema,
} from "./index.ts";

const normalizedMessageFixture = normalizedMessageSchema.parse({
  id: "gmail:acct_local_gmail:gmail_msg_local_1",
  provider: "gmail",
  providerMessageId: "gmail_msg_local_1",
  threadId: "gmail:acct_local_gmail:thread_local_1",
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
  subject: "First Orca preview",
  snippet: "A quiet shell for human messages is ready for real inbox data.",
  receivedAt: "2026-06-28T17:30:00.000Z",
  unread: true,
  labels: ["INBOX"],
  bodyText: "A quiet shell for human messages is ready for real inbox data.",
  bodyHtml: "<p>A quiet shell for human messages is ready for real inbox data.</p>",
  raw: {
    provider: "gmail",
    accountId: "acct_local_gmail",
    messageId: "gmail_msg_local_1",
    threadId: "thread_local_1",
    labelIds: ["INBOX"],
  },
});

test("shared fixtures satisfy the exported schemas", () => {
  assert.deepStrictEqual(mailAccountSchema.parse(accountFixture), accountFixture);
  assert.deepStrictEqual(
    inboxResponseSchema.parse({
      account: accountFixture,
      messages: inboxFixture,
      nextCursor: null,
    }),
    {
      account: accountFixture,
      messages: inboxFixture,
      nextCursor: null,
    },
  );
});

test("provider page schemas stay reusable across normalized payloads", () => {
  const normalizedMessagePageSchema = createProviderPageSchema(normalizedMessageSchema);
  const normalizedMessagePage = {
    items: [normalizedMessageFixture],
    nextCursor: "cursor_2",
  };

  assert.deepStrictEqual(
    normalizedMessagePageSchema.parse(normalizedMessagePage),
    normalizedMessagePage,
  );
});

test("thread and label contracts validate normalized provider output", () => {
  const normalizedThread = {
    id: normalizedMessageFixture.threadId,
    provider: normalizedMessageFixture.provider,
    providerThreadId: normalizedMessageFixture.raw.threadId,
    subject: normalizedMessageFixture.subject,
    latestReceivedAt: normalizedMessageFixture.receivedAt,
    messageCount: 1,
    labels: normalizedMessageFixture.labels,
  };

  const normalizedLabel = {
    id: "gmail:INBOX",
    provider: "gmail",
    providerLabelId: "INBOX",
    name: "Inbox",
    type: "system",
  } as const;

  assert.deepStrictEqual(normalizedThreadSchema.parse(normalizedThread), normalizedThread);
  assert.deepStrictEqual(normalizedLabelSchema.parse(normalizedLabel), normalizedLabel);
});
