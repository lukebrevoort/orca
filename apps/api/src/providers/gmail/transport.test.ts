import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MessageDraft } from "@orca/shared";
import { hydrateGmailThreadingHeaders } from "./transport.ts";

const replyDraft: MessageDraft = {
  id: "draft",
  accountId: "account",
  revision: 0,
  providerDraftId: null,
  providerMessageId: null,
  providerThreadId: "gmail-thread",
  providerSyncStatus: "not_applicable",
  providerSyncError: null,
  deliveryStatus: "draft",
  to: [{ name: "Maya", email: "maya@example.com" }],
  cc: [],
  bcc: [],
  subject: "Re: Reader notes",
  body: { text: "A reply", html: null },
  context: {
    kind: "reply",
    threadId: "thread",
    messageId: "message",
    providerMessageId: "gmail-source-message",
    providerThreadId: "gmail-thread",
    inReplyTo: null,
    references: [],
  },
  attachments: [],
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

describe("Gmail transport threading metadata", () => {
  test("fetches missing Message-ID and References for a pre-migration reply target", async () => {
    const calls: string[] = [];
    const hydrated = await hydrateGmailThreadingHeaders(replyDraft, async (messageId) => {
      calls.push(messageId);
      return {
        id: messageId,
        threadId: "gmail-thread",
        labelIds: ["INBOX"],
        snippet: "",
        internalDate: "0",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Message-ID", value: "<source@example.com>" },
            { name: "References", value: "<root@example.com> <older@example.com>" },
          ],
          body: { data: "" },
        },
      };
    });

    assert.deepEqual(calls, ["gmail-source-message"]);
    assert.equal(hydrated.context?.inReplyTo, "<source@example.com>");
    assert.deepEqual(hydrated.context?.references, ["<root@example.com>", "<older@example.com>"]);
  });

  test("does not fetch when stored threading metadata is already present", async () => {
    let fetched = false;
    const hydrated = await hydrateGmailThreadingHeaders({
      ...replyDraft,
      context: { ...replyDraft.context!, inReplyTo: "<stored@example.com>" },
    }, async () => {
      fetched = true;
      throw new Error("should not fetch");
    });

    assert.equal(fetched, false);
    assert.equal(hydrated.context?.inReplyTo, "<stored@example.com>");
  });
});
