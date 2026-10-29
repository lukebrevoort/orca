import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "./db/client.ts";
import { users, oauthAccounts } from "./db/schema.ts";
import { checkDraftQuota, draftStorageBytes, maxDraftsPerAccount, maxDraftBytesPerAccount } from "./draft-quota.ts";

function fixture(run: (sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orca-draft-quota-"));
  const { db, sqlite } = createDatabaseClient(join(dir, "test.sqlite"));
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(users).values({ id: "owner", email: "owner@example.test" }).run();
    for (const id of ["a", "b"]) db.insert(oauthAccounts).values({ id, userId: "owner", provider: "gmail", providerId: id, providerEmail: `${id}@example.test` }).run();
    run(sqlite);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
}
const empty = { toRecipients: "", ccRecipients: "", bccRecipients: "", subject: "", bodyText: "", bodyHtml: null, context: null, attachments: "" };
const denied = { status: 413, code: "draft_quota_exceeded", message: "Draft storage quota exceeded." };

test("count boundaries and replacement at the count cap", () => fixture(sqlite => {
  assert.equal(maxDraftsPerAccount, 200);
  const insert = sqlite.query("INSERT INTO message_drafts (id, account_id) VALUES (?, 'a')");
  sqlite.transaction(() => { for (let i = 0; i < 199; i++) insert.run(String(i)); })();
  assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: 0 }), null);
  insert.run("199");
  assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes: 0 }), denied);
  assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: 0, replacingDraftId: "0" }), null);
}));

test("byte boundaries include all stored UTF-8 fields and nullable content", () => fixture(sqlite => {
  assert.equal(maxDraftBytesPerAccount, 209715200);
  assert.equal(draftStorageBytes(empty), 0);
  const content = { toRecipients: "é", ccRecipients: "界", bccRecipients: "🙂", subject: "\0", bodyText: "<script>secret</script>", bodyHtml: "é", context: "界", attachments: "🙂" };
  assert.equal(draftStorageBytes(content), Object.values(content).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  // SQLite creates the large fixture without allocating a large JS string.
  sqlite.query("INSERT INTO message_drafts (id, account_id, to_recipients, cc_recipients, bcc_recipients, attachments, body_text) VALUES ('large', 'a', '', '', '', '', printf('%.*c', ?, 'x'))").run(maxDraftBytesPerAccount - 100);
  for (const [newBytes, expected] of [[99, null], [100, null], [101, denied]] as const) {
    assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes }), expected);
  }
  sqlite.query("UPDATE message_drafts SET subject = 'é🙂' WHERE id = 'large'").run();
  assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes: 95 }), denied);
  assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: 94 }), null);
  assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: maxDraftBytesPerAccount, replacingDraftId: "large" }), null);
  assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes: maxDraftBytesPerAccount + 1, replacingDraftId: "large" }), denied);
}));

test("SQL measures every content column in bytes, including embedded NUL", () => fixture(sqlite => {
  const content = { ...empty, toRecipients: "é", ccRecipients: "界", bccRecipients: "🙂", subject: "a\0b", bodyText: "é", bodyHtml: "界", context: "🙂", attachments: "é" };
  sqlite.query("INSERT INTO message_drafts (id, account_id, to_recipients, cc_recipients, bcc_recipients, subject, body_text, body_html, context, attachments) VALUES ('all', 'a', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(content.toRecipients, content.ccRecipients, content.bccRecipients, content.subject, content.bodyText, content.bodyHtml, content.context, content.attachments);
  const bytes = Object.values(content).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: maxDraftBytesPerAccount - bytes }), null);
  assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes: maxDraftBytesPerAccount - bytes + 1 }), denied);
}));

test("account and status isolation, transaction safety, and immutable existing data", () => fixture(sqlite => {
  const insert = sqlite.query("INSERT INTO message_drafts (id, account_id, delivery_status, body_text, attachments) VALUES (?, ?, ?, ?, ?)");
  sqlite.transaction(() => {
    for (let i = 0; i < 200; i++) insert.run(`foreign-${i}`, "b", "draft", "private-content", "[]");
    for (const status of ["sent", "sending", "queued", "rejected", "ambiguous"]) insert.run(status, "a", status, "secret <script>🙂</script>", "large-attachment");
  })();
  const before = sqlite.query("SELECT * FROM message_drafts ORDER BY id").all();
  sqlite.transaction(() => {
    assert.equal(checkDraftQuota(sqlite, { accountId: "a", newBytes: maxDraftBytesPerAccount }), null);
    assert.equal(checkDraftQuota(sqlite, { accountId: "missing", newBytes: 0 }), null);
    assert.deepEqual(checkDraftQuota(sqlite, { accountId: "b", newBytes: 0, replacingDraftId: "sent" }), null);
    const error = checkDraftQuota(sqlite, { accountId: "b", newBytes: 0 });
    assert.deepEqual(error, denied);
    assert.ok(!error!.message.includes("private-content"));
  })();
  assert.deepEqual(sqlite.query("SELECT * FROM message_drafts ORDER BY id").all(), before);
}));

test("malformed byte counts fail closed with a static error", () => fixture(sqlite => {
  for (const newBytes of [NaN, -1, 0.5, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(checkDraftQuota(sqlite, { accountId: "a", newBytes }), denied);
  }
}));
