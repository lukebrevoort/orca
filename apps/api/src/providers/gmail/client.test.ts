import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGmailClient, GmailApiError } from "./client.ts";

describe("Gmail push API client", () => {
  test("requests a watch and parses history changes across all change types", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      if (url.endsWith("/watch")) {
        return Response.json({ historyId: "100", expiration: "1783519200000" });
      }

      return Response.json({
        historyId: "110",
        history: [
          { messagesAdded: [{ message: { id: "added", threadId: "thread" } }] },
          { labelsAdded: [{ message: { id: "labeled", threadId: "thread" } }] },
          { labelsRemoved: [{ message: { id: "labeled", threadId: "thread" } }] },
          { messagesDeleted: [{ message: { id: "deleted", threadId: "thread" } }] },
        ],
      });
    };

    const client = createGmailClient(fetchImpl as typeof fetch);
    const watch = await client.watch!("access-token", "projects/orca/topics/gmail");
    const history = await client.listHistory!({ accessToken: "access-token", startHistoryId: "100" });

    assert.deepEqual(watch, { historyId: "100", expiration: "1783519200000" });
    assert.deepEqual(history, {
      messageIds: ["added", "labeled"],
      deletedMessageIds: ["deleted"],
      nextCursor: null,
      historyId: "110",
    });
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      topicName: "projects/orca/topics/gmail",
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
    assert.match(calls[1]?.url ?? "", /startHistoryId=100/);
    assert.match(calls[1]?.url ?? "", /historyTypes=messageAdded/);
    assert.match(calls[1]?.url ?? "", /historyTypes=labelRemoved/);
  });

  test("surfaces Gmail HTTP failures without provider response details", async () => {
    const client = createGmailClient((async () => new Response("secret upstream detail", { status: 404 })) as unknown as typeof fetch);

    await assert.rejects(
      () => client.listHistory!({ accessToken: "access-token", startHistoryId: "100" }),
      (error: unknown) => error instanceof GmailApiError && error.status === 404 && error.message === "Gmail API request failed",
    );
  });
});
