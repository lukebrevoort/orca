import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createGmailDraftClient } from "./client.ts";
import { encodeDraftMime } from "./drafts.ts";

describe("Gmail draft mirroring", () => {
  test("encodes a URL-safe MIME message without leaking header newlines", () => {
    const raw = encodeDraftMime({
      to: [{ name: "Maya Chen", email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "A durable thought\r\nBcc: attacker@example.com",
      body: { text: "Hello from Orca", html: null },
      context: null,
      attachments: [],
    });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(mime, /^To: "Maya Chen" <maya@example.com>/);
    const encodedSubject = mime.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)?.[1];
    assert.equal(Buffer.from(encodedSubject ?? "", "base64").toString("utf8"), "A durable thought Bcc: attacker@example.com");
    assert.equal(mime.includes("\r\nBcc: attacker@example.com"), false);
    assert.match(mime, /\r\n\r\nHello from Orca$/);
  });

  test("creates, updates, and deletes the same Gmail draft ID", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "gmail-draft-1", message: { id: "message-1", threadId: "thread-1" } });
    };
    const client = createGmailDraftClient(fetchImpl as typeof fetch);

    await client.createDraft("token", "raw-one", "thread-1");
    await client.updateDraft("token", "gmail-draft-1", "raw-two", "thread-1");
    await client.deleteDraft("token", "gmail-draft-1");

    assert.deepEqual(calls.map(({ method }) => method), ["POST", "PUT", "DELETE"]);
    assert.match(calls[0]!.url, /\/drafts$/);
    assert.match(calls[1]!.url, /\/drafts\/gmail-draft-1$/);
    assert.equal((calls[1]!.body as { id: string }).id, "gmail-draft-1");
  });
});
