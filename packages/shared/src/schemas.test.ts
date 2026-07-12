import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authSessionSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  threadDetailSchema,
} from "./index.ts";
import { accountFixture, inboxFixture } from "./fixtures.ts";

describe("shared API schemas", () => {
  test("parses the fixture inbox response shape", () => {
    assert.deepEqual(
      inboxResponseSchema.parse({
        account: accountFixture,
        messages: inboxFixture,
        counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
        nextCursor: null,
      }),
      {
        account: accountFixture,
        messages: inboxFixture,
        counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
        nextCursor: null,
      },
    );
  });

  test("rejects blank inbox cursors", () => {
    const result = inboxQuerySchema.safeParse({ cursor: "" });

    assert.equal(result.success, false);
    assert.equal(result.error.issues[0]?.path.join("."), "cursor");
  });

  test("requires an authenticated user when the session is authenticated", () => {
    assert.throws(
      () =>
        authSessionSchema.parse({
          isAuthenticated: true,
          user: null,
          expiresAt: null,
        }),
      /Authenticated sessions must include a user/,
    );
  });

  test("keeps nullable body fields and attachment metadata in reader payloads", () => {
    const result = threadDetailSchema.safeParse({
      account: accountFixture,
      thread: {
        id: "thread_1", provider: "gmail", providerThreadId: "provider-thread-1", subject: "A thread", latestReceivedAt: "2026-07-08T12:00:00.000Z", messageCount: 1, labels: [], participants: [], readState: "read",
        attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: null },
      },
      messages: [{
        id: "message_1", provider: "gmail", providerMessageId: "provider-message-1", from: { name: null, email: "maya@example.com" }, to: [], cc: [], bcc: [], subject: "A thread", snippet: "", receivedAt: "2026-07-08T12:00:00.000Z", unread: false, labels: [], bodyText: null, bodyHtml: null,
        attachments: [{ id: "attachment_1", filename: "notes.pdf", mimeType: "application/pdf", size: 42 }],
      }],
    });
    assert.equal(result.success, true);
  });
});
