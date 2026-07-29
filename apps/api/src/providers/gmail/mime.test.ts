import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeGmailMessage } from "./mime.ts";

function decodeRaw(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("Gmail MIME", () => {
  test("adds RFC threading headers to replies and keeps forwards independent", () => {
    const base = {
      to: [{ name: "Maya Chen", email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Reader notes",
      body: { text: "A reply", html: null },
      attachments: [],
    };
    const reply = decodeRaw(encodeGmailMessage({
      ...base,
      context: {
        kind: "reply",
        threadId: "thread",
        messageId: "message",
        providerMessageId: "gmail-message",
        providerThreadId: "gmail-thread",
        inReplyTo: "<new@example.com>",
        references: ["<old@example.com>", "<new@example.com>"],
      },
    }));
    assert.match(reply, /In-Reply-To: <new@example\.com>/);
    assert.match(reply, /References: <old@example\.com> <new@example\.com>/);

    const forward = decodeRaw(encodeGmailMessage({
      ...base,
      subject: "Fwd: Reader notes",
      context: {
        kind: "forward",
        threadId: "thread",
        messageId: "message",
        providerMessageId: "gmail-message",
        providerThreadId: "gmail-thread",
        inReplyTo: "<new@example.com>",
        references: ["<old@example.com>"],
      },
    }));
    assert.doesNotMatch(forward, /In-Reply-To|References:/);
  });

  test("encodes attachment bytes in a multipart message", () => {
    const raw = decodeRaw(encodeGmailMessage({
      to: [{ name: null, email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "Notes",
      body: { text: "Attached", html: null },
      context: null,
      attachments: [{ id: "file", filename: "notes.txt", mimeType: "text/plain", size: 5, contentBase64: Buffer.from("hello").toString("base64") }],
    }));
    assert.match(raw, /Content-Type: multipart\/mixed/);
    assert.match(raw, /Content-Disposition: attachment; filename="notes\.txt"/);
    assert.match(raw, /aGVsbG8=/);
  });

  test("quotes ASCII display names and encodes Unicode names safely", () => {
    const raw = decodeRaw(encodeGmailMessage({
      to: [
        { name: "Doe, Jane", email: "jane@example.com" },
        { name: "José 🐋", email: "jose@example.com" },
      ],
      cc: [],
      bcc: [],
      subject: "Olá from Orca",
      body: { text: "Hello", html: null },
      context: null,
      attachments: [],
    }));

    assert.match(raw, /To: "Doe, Jane" <jane@example\.com>,/);
    assert.match(raw, /=\?UTF-8\?B\?.+\?=\r\n <jose@example\.com>/);
    assert.match(raw, /Subject: =\?UTF-8\?B\?.+\?=/);
  });

  test("folds long recipient and References headers below the RFC hard limit", () => {
    const raw = decodeRaw(encodeGmailMessage({
      to: Array.from({ length: 40 }, (_, index) => ({ name: `Recipient ${index}`, email: `person-${index}@example.com` })),
      cc: [],
      bcc: [],
      subject: "Long conversation",
      body: { text: "Hello", html: null },
      context: {
        kind: "reply_all",
        threadId: "thread",
        messageId: "message",
        providerMessageId: "gmail-message",
        providerThreadId: "gmail-thread",
        inReplyTo: "<latest@example.com>",
        references: Array.from({ length: 60 }, (_, index) => `<message-${index}@example.com>`),
      },
      attachments: [],
    }));

    assert.match(raw, /To: .+\r\n /);
    assert.match(raw, /References: .+\r\n /);
    for (const line of raw.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 998, `header line exceeded 998 octets: ${line.length}`);
  });

  test("rejects CRLF media-type injection and sanitizes unstructured headers", () => {
    assert.throws(() => encodeGmailMessage({
      to: [{ name: null, email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "Safe\r\nX-Injected: no",
      body: { text: "Hello", html: null },
      context: null,
      attachments: [{ id: "file", filename: "notes.txt", mimeType: "text/plain\r\nX-Injected: yes", size: 5, contentBase64: "aGVsbG8=" }],
    }), /Invalid attachment media type/);

    const raw = decodeRaw(encodeGmailMessage({
      to: [{ name: null, email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "Safe\r\nX-Injected: no",
      body: { text: "Hello", html: null },
      context: null,
      attachments: [],
    }));
    assert.match(raw, /Subject: Safe X-Injected: no/);
    assert.doesNotMatch(raw, /\r\nX-Injected:/);
  });
});
