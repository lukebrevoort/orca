import { describe, expect, test } from "bun:test";
import { accountFixture, inboxFixture, threadDetailSchema } from "./index.ts";

// The reader validates the complete response, including optional image metadata.
// Keep this synthetic response separate from the API's serialization code.
function responseWith(messageFields: Record<string, unknown>) {
  const message = inboxFixture[0]!;
  return {
    account: accountFixture,
    thread: {
      id: message.threadId, provider: message.provider,
      providerThreadId: "synthetic-thread", subject: message.subject,
      latestReceivedAt: message.receivedAt, messageCount: 1, labels: [],
      participants: [message.from], readState: "read",
      attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: null },
    },
    messages: [{
      id: message.id, accountId: accountFixture.id, provider: message.provider,
      providerMessageId: message.providerMessageId, from: message.from,
      subject: message.subject, snippet: message.snippet,
      receivedAt: message.receivedAt, unread: false, labels: [],
      to: [], cc: [], bcc: [], bodyText: "Synthetic message", bodyHtml: null,
      internetMessageId: null, references: [], humanSignal: null, attachments: [],
      ...messageFields,
    }],
  };
}

describe("thread reader image wire contract", () => {
  for (const available of [true, false]) {
    test(`accepts imageLoadAvailable=${available} without changing message identity or body`, () => {
      const response = responseWith({ imageLoadAvailable: available });
      const parsed = threadDetailSchema.parse(JSON.parse(JSON.stringify(response)));
      expect(parsed.messages[0]).toEqual({ ...response.messages[0], humanClassification: null });
      expect(parsed.account.id).toBe(response.messages[0]!.accountId);
    });
  }

  test("accepts an older response without image metadata", () => {
    const parsed = threadDetailSchema.parse(responseWith({}));
    expect(parsed.messages[0]).not.toHaveProperty("imageLoadAvailable");
  });

  test("rejects malformed image metadata and unrelated unknown keys", () => {
    for (const value of [null, "true", 1, {}, []]) {
      const result = threadDetailSchema.safeParse(responseWith({ imageLoadAvailable: value }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.path).toEqual(["messages", 0, "imageLoadAvailable"]);
    }
    const result = threadDetailSchema.safeParse(responseWith({ imageLoadAvailable: true, unexpectedField: true }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["unexpectedField"], path: ["messages", 0] }),
    ]);
  });
});
