import assert from "node:assert/strict";
import { test } from "node:test";
import { notificationPayload, type NotificationMessage } from "./payload.ts";

const message: NotificationMessage = {
  accountId: "a".repeat(36), threadId: "t".repeat(36), fromName: "Alex Rivera", fromAddress: "alex@example.com",
  subject: "Design review", snippet: "Can we review the updated screens tomorrow?", bodyText: "Full private message content",
};

test("notification preview contains sender, subject and snippet with unchanged conversation routing", () => {
  const payload = notificationPayload(message);
  assert.deepEqual(payload, {
    aps: { alert: { title: "Alex Rivera", subtitle: "Design review", body: "Can we review the updated screens tomorrow?" }, sound: "default" },
    version: 1, accountId: message.accountId, threadId: message.threadId,
  });
  assert.ok(!JSON.stringify(payload).includes(message.bodyText!));
});

test("missing content uses sender address, plain-text fallback, then readable placeholders", () => {
  assert.deepEqual(notificationPayload({ ...message, fromName: " \n", subject: null, snippet: " " }).aps.alert,
    { title: "alex@example.com", subtitle: "(No subject)", body: "Full private message content" });
  assert.deepEqual(notificationPayload({ ...message, fromName: null, fromAddress: null, subject: "", snippet: null, bodyText: null }).aps.alert,
    { title: "New email", subtitle: "(No subject)", body: "Open Orca to read this message." });
});

test("preview normalizes whitespace and control characters without interpreting plain text as HTML", () => {
  assert.equal(notificationPayload({ ...message, snippet: "Hello\n\tthere\u0000  2 < 3 & 4 > 1\u202e" }).aps.alert.body,
    "Hello there 2 < 3 & 4 > 1");
});

test("long Unicode previews remain valid and fit Apple's 4096-byte payload limit", () => {
  const payload = notificationPayload({ ...message, fromName: "😀".repeat(1000), subject: "🚀".repeat(1000), snippet: "🌊".repeat(2000) });
  assert.equal(Array.from(payload.aps.alert.title).length, 80);
  assert.equal(Array.from(payload.aps.alert.subtitle).length, 120);
  assert.equal(Array.from(payload.aps.alert.body).length, 240);
  assert.ok(payload.aps.alert.body.endsWith("…"));
  assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 4096);
  assert.ok(!JSON.stringify(payload).includes("\\ud"));
});
