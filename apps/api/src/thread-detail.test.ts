import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { threadDetailSchema, type ThreadDetail } from "@orca/shared";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { createApp, threadDetailLimits } from "./index.ts";
import { persistGmailMessages } from "./providers/gmail/sync.ts";

test("thread detail rejects count, individual and aggregate body overflows before fetching bodies", async () => {
  const oldSecret = process.env.SESSION_SECRET;
  const oldKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "thread-detail-budget-test-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-thread-budget-"));
  const dbPath = join(directory, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  const observed: string[] = [];
  let concurrentSync = false;
  let briefInvocations = 0;
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(schema.users).values({ id: "owner", email: "owner@example.com" }).run();
    db.insert(schema.oauthAccounts).values({ id: "a", userId: "owner", provider: "gmail", providerId: "a", providerEmail: "owner@example.com" }).run();
    db.insert(schema.threads).values({ id: "thread", accountId: "a", providerThreadId: "thread", messageCount: 1 }).run();
    db.insert(schema.emails).values({ id: "m0", accountId: "a", threadId: "thread", providerMessageId: "m0", bodyText: "hello", bodyHtml: "<p>hello</p>" }).run();
    const session = await createSession(db, "owner");
    const app = createApp({ replyBriefAvailability: async () => { briefInvocations++; return null; }, dbFactory: () => {
      const client = createDatabaseClient(dbPath);
      return { ...client, db: drizzle(client.sqlite, { schema, logger: { logQuery(query) {
        observed.push(query);
        if (concurrentSync && /"body_text"\s*,\s*"body_html"/i.test(query.split(/\bfrom\b/i)[0]!)) {
          concurrentSync = false;
          sqlite.query("update emails set body_text = ? where id = 'm0'").run("x".repeat(threadDetailLimits.bodyBytes + 1));
        }
      } } }) };
    } });
    const headers = { cookie: `orca_session=${session.token}` };
    const request = () => app.request("/v1/threads/thread?accountId=a", { headers });
    const reject = async () => {
      observed.length = 0;
      const response = await request();
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, "payload_limit");
      assert.equal(observed.some((query) => /^select\b/i.test(query) && /"body_text"\s*,\s*"body_html"/i.test(query.split(/\bfrom\b/i)[0]!)), false, "rejected thread must not fetch full bodies");
      assert.equal(observed.some((query) => /^select\b/i.test(query) && /"subject"\s*,\s*"snippet"/i.test(query.split(/\bfrom\b/i)[0]!)), false, "rejected thread must not fetch message metadata");
    };
    assert.equal((await request()).status, 200);
    // Each representation reaches a later SELECT; none may enter JS on overflow.
    for (const column of ["subject", "snippet", "to_recipients", "cc_recipients", "bcc_recipients", "references"]) {
      sqlite.query(`update emails set "${column}" = ? where id = 'm0'`).run("é".repeat(threadDetailLimits.metadataBytes / 2 + 1));
      await reject();
      sqlite.query(`update emails set "${column}" = null where id = 'm0'`).run();
    }
    sqlite.query("update threads set subject = ? where id = 'thread'").run("x".repeat(threadDetailLimits.metadataBytes + 1));
    await reject();
    sqlite.run("update threads set subject = null where id = 'thread'");
    sqlite.query("update emails set subject = ?, snippet = ? where id = 'm0'").run("x".repeat(threadDetailLimits.metadataBytes / 2), "x".repeat(threadDetailLimits.metadataBytes / 2));
    await reject();
    sqlite.run("update emails set subject = 'Hello', snippet = 'A short preview' where id = 'm0'");
    assert.equal((await request()).status, 200, "ordinary metadata remains readable");
    db.insert(schema.labels).values({ id: "label", accountId: "a", providerLabelId: "label", name: "Work", type: "user" }).run();
    db.insert(schema.emailLabels).values({ id: "link", emailId: "m0", labelId: "label" }).run();
    db.insert(schema.emailAttachments).values({ id: "attachment", emailId: "m0", providerAttachmentId: "attachment", filename: "file.pdf", mimeType: "application/pdf", size: 1 }).run();
    for (const [table, column] of [["labels", "name"], ["email_attachments", "filename"], ["email_attachments", "mime_type"]]) {
      sqlite.query(`update ${table} set ${column} = ?`).run("x".repeat(threadDetailLimits.metadataBytes + 1));
      await reject();
      sqlite.query(`update ${table} set ${column} = ?`).run("normal");
    }
    sqlite.run("delete from email_attachments");
    sqlite.run("delete from email_labels");
    // Gmail sync persists provider snippet verbatim before this shared read.
    await persistGmailMessages(db, { accountId: "a", accountEmail: "owner@example.com", gmailMessages: [{
      id: "provider-message", threadId: "provider-thread", snippet: "x".repeat(threadDetailLimits.metadataBytes + 1),
      payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: "Hello" }] },
    }], labelList: [], now: new Date(), propagationTrigger: "sync", propagationOptions: { enabled: false } });
    const providerResponse = await app.request("/v1/threads/gmail:a:provider-thread?accountId=a", { headers });
    assert.equal(providerResponse.status, 413);
    assert.equal((await providerResponse.json()).error.code, "payload_limit");
    // A sync commit between the probe and body SELECT cannot change the
    // snapshot being read. The next request sees and rejects the larger body.
    concurrentSync = true;
    const snapshot = await request();
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).messages[0].bodyText, "hello");
    assert.equal(concurrentSync, false, "the concurrent write must happen before the body SELECT");
    await reject();
    // Embedded NUL and multibyte characters must be counted as UTF-8 bytes.
    sqlite.query("update emails set body_text = ?, body_html = null where id = 'm0'").run("\0" + "é".repeat(threadDetailLimits.bodyBytes / 2));
    await reject();
    sqlite.query("update emails set body_text = null, body_html = ? where id = 'm0'").run("x".repeat(threadDetailLimits.bodyBytes + 1));
    await reject();
    sqlite.query("update emails set body_text = ?, body_html = null where id = 'm0'").run("x".repeat(threadDetailLimits.bodyBytes));
    assert.equal((await request()).status, 200, "exact individual limit remains readable");
    for (let i = 1; i <= 3; i++) {
      db.insert(schema.emails).values({ id: `m${i}`, accountId: "a", threadId: "thread", providerMessageId: `m${i}`, bodyText: "x".repeat(threadDetailLimits.bodyBytes) }).run();
    }
    assert.equal((await request()).status, 200, "exact aggregate limit remains readable");
    db.insert(schema.emails).values({ id: "m4", accountId: "a", threadId: "thread", providerMessageId: "m4", bodyText: "x" }).run();
    await reject();
    const brief = await app.request("/v1/threads/thread/reply-brief?accountId=a", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ trigger: "user_invoked", accountId: "a", provider: "gmail", threadId: "thread", selectedMessageIds: ["m0"], requestedAt: "2026-08-19T18:01:00.000Z", userTimeZone: "America/Denver", calendarConnectionId: null, authorizedContext: [] }),
    });
    assert.equal(brief.status, 413);
    assert.equal((await brief.json()).error.code, "payload_limit");
    assert.equal(briefInvocations, 0, "reply guidance must not process partial context after overflow");
    sqlite.run("delete from emails where id != 'm0'");
    sqlite.run("update emails set body_text = null where id = 'm0'");
    for (let i = 1; i <= threadDetailLimits.messages; i++) {
      db.insert(schema.emails).values({ id: `m${i}`, accountId: "a", threadId: "thread", providerMessageId: `m${i}` }).run();
    }
    await reject();
    sqlite.run(`delete from emails where id = 'm${threadDetailLimits.messages}'`);
    assert.equal((await request()).status, 200, "exact message count remains readable");
    sqlite.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${threadDetailLimits.associations + 1}) INSERT INTO email_attachments (id, email_id, provider_attachment_id, filename, mime_type, size) SELECT 'file' || i, 'm0', 'file' || i, 'f', 'text/plain', 1 FROM n`);
    await reject();
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = oldKey;
  }
});

// Observe executed SQL through Drizzle's public logger, then replay only body
// SELECTs against synthetic data. Returned bytes catch join amplification without
// depending on GC timing, process RSS, or a particular number of metadata queries.
test("thread detail loads bodies once while preserving multi-message labels, attachments and isolation", async () => {
  const priorEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "thread-detail-test-secret-long-enough";
  const directory = mkdtempSync(join(tmpdir(), "orca-thread-detail-"));
  const dbPath = join(directory, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  const observed: Array<{ query: string; params: unknown[] }> = [];
  const parse = threadDetailSchema.parse;
  const validatedResponses: ThreadDetail[] = [];
  const parseSpy = spyOn(threadDetailSchema, "parse").mockImplementation((value, options) => {
    const detail = parse(value, options);
    validatedResponses.push(detail);
    return detail;
  });
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(schema.users).values([
      { id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" },
    ]).run();
    db.insert(schema.oauthAccounts).values([
      { id: "a", userId: "owner", provider: "gmail", providerId: "a", providerEmail: "owner@example.com" },
      { id: "b", userId: "other", provider: "gmail", providerId: "b", providerEmail: "other@example.com" },
    ]).run();
    db.insert(schema.threads).values([
      { id: "thread", accountId: "a", providerThreadId: "shared-provider-id", messageCount: 4 },
      { id: "private", accountId: "b", providerThreadId: "shared-provider-id", messageCount: 1 },
    ]).run();
    const bodyText = "Synthetic text. ".repeat(4096);
    const bodyHtml = `<p>${"Synthetic HTML. ".repeat(4096)}</p>`;
    // Reverse insertion plus timestamp ties exercises all ordering tie-breakers.
    db.insert(schema.emails).values(["d", "c", "b", "a"].map((id) => ({
      id, accountId: "a", threadId: "thread", providerMessageId: id,
      fromAddress: "sender@example.com", bodyText, bodyHtml,
      receivedAt: new Date(id === "d" ? 2000 : 1000), createdAt: new Date(id === "c" ? 2000 : 1000),
      isRead: id !== "a", isStarred: id === "b", isDraft: id === "c",
    }))).run();
    db.insert(schema.emails).values({ id: "secret", accountId: "b", threadId: "private", providerMessageId: "a", bodyText: "PRIVATE" }).run();
    db.insert(schema.labels).values([
      { id: "l1", accountId: "a", providerLabelId: "1", name: "Work", type: "user" },
      { id: "l2", accountId: "a", providerLabelId: "2", name: "Inbox", type: "system" },
      { id: "l3", accountId: "b", providerLabelId: "1", name: "Private", type: "user" },
    ]).run();
    db.insert(schema.emailLabels).values([
      { id: "al1", emailId: "a", labelId: "l1" }, { id: "al2", emailId: "a", labelId: "l2" },
      { id: "bl1", emailId: "b", labelId: "l1" }, { id: "sl3", emailId: "secret", labelId: "l3" },
    ]).run();
    const attachment = (id: string, emailId: string) => ({ id, emailId, providerAttachmentId: id, filename: `${id}.pdf`, mimeType: "application/pdf", size: 42 });
    db.insert(schema.emailAttachments).values([attachment("a1", "a"), attachment("a2", "a"), attachment("b1", "b"), attachment("private-file", "secret")]).run();
    const session = await createSession(db, "owner");
    const app = createApp({ dbFactory: () => {
      const client = createDatabaseClient(dbPath);
      return { ...client, db: drizzle(client.sqlite, { schema, logger: { logQuery(query, params) { observed.push({ query, params }); } } }) };
    } });
    const headers = { cookie: `orca_session=${session.token}` };
    const response = await app.request("/v1/threads/thread?accountId=a", { headers });
    assert.equal(response.status, 200);
    assert.equal(
      observed.some(({ query }) => /organization_thread_lane_states/i.test(query)),
      false,
      "opening one thread must not enumerate the account's Organization lane snapshot",
    );
    assert.equal(parseSpy.mock.calls.length, 1, "the HTTP route must retain one full validation without reparsing its validated result");
    const serialized = await response.text();
    // Reproduce the old route's second parse and compare the complete response,
    // including object-key ordering, defaults and any schema transformations.
    assert.equal(serialized, JSON.stringify(parse(validatedResponses[0])));
    const detail = parse(JSON.parse(serialized));
    assert.deepEqual(detail.messages.map((message) => message.id), ["a", "b", "c", "d"]);
    assert.deepEqual(detail.messages.map((message) => [...message.labels].sort()), [["Inbox", "Work"], ["Work"], [], []]);
    assert.deepEqual([...detail.thread.labels].sort(), ["Inbox", "Work"]);
    assert.equal(detail.thread.messageCount, 4);
    assert.equal(detail.thread.attention.hasUnread, true);
    assert.equal(detail.thread.attention.hasStarred, true);
    assert.equal(detail.thread.attention.hasDraft, true);
    assert.deepEqual(detail.messages.map((message) => message.attachments.map(({ id }) => id).sort()), [["a1", "a2"], ["b1"], [], []]);
    assert.deepEqual(detail.messages[0]!.attachments[0], { id: "a1", filename: "a1.pdf", mimeType: "application/pdf", size: 42 });
    for (const message of detail.messages) {
      assert.equal(message.accountId, "a");
      assert.equal(message.bodyText, bodyText);
      assert.equal(message.bodyHtml, bodyHtml);
    }
    const bodyQueries = observed.filter(({ query }) => /^select\b/i.test(query) && /"body_(text|html)"/.test(query.split(/\bfrom\b/i)[0]!));
    assert.ok(bodyQueries.length > 0, "observer must see body reads");
    let returnedBodyBytes = 0;
    for (const { query, params } of bodyQueries) {
      for (const row of sqlite.query(query).all(...params as SQLQueryBindings[]) as Array<Record<string, unknown>>) {
        for (const key of ["body_text", "body_html"]) {
          if (typeof row[key] === "string") returnedBodyBytes += Buffer.byteLength(row[key]);
        }
      }
    }
    assert.equal(returnedBodyBytes, 4 * (Buffer.byteLength(bodyText) + Buffer.byteLength(bodyHtml)), "SQL must return each body once regardless of label/attachment fan-out");
    for (const [path, status, authenticated] of [
      ["/v1/threads/private?accountId=a", 404, true],
      ["/v1/threads/private?accountId=b", 404, true],
      ["/v1/threads/absent?accountId=a", 404, true],
      ["/v1/threads/thread", 400, true],
      ["/v1/threads/thread?accountId=a", 401, false],
    ] as const) {
      parseSpy.mockClear();
      assert.equal((await app.request(path, authenticated ? { headers } : {})).status, status);
      assert.equal(parseSpy.mock.calls.length, 0, "denied or missing threads must never reach response validation");
    }

    // Malformed persisted values must still fail at the reader's schema boundary.
    // Contact extras are intentionally rejected by the strict schema, not dropped.
    const invalidCases = [
      ["update threads set message_count = -1 where id = 'thread'", "update threads set message_count = 4 where id = 'thread'"],
      ["update email_attachments set size = -1 where id = 'a1'", "update email_attachments set size = 42 where id = 'a1'"],
      [`update emails set "references" = '[42]' where id = 'a'`, `update emails set "references" = '[]' where id = 'a'`],
      [`update emails set to_recipients = '[{"name":null,"email":"owner@example.com","extra":true}]' where id = 'a'`, `update emails set to_recipients = '[]' where id = 'a'`],
    ];
    for (const [update, restore] of invalidCases) {
      sqlite.run(update!);
      parseSpy.mockClear();
      const invalid = await app.request("/v1/threads/thread?accountId=a", { headers });
      assert.equal(invalid.status, 500);
      assert.equal(await invalid.text(), "Internal Server Error");
      assert.equal(parseSpy.mock.calls.length, 1, "invalid persisted output must be parsed and rejected");
      sqlite.run(restore!);
    }

    // Guard the idempotent defaults/transforms that make the removed parse redundant.
    const message = detail.messages[0]!;
    const raw = {
      ...detail,
      messages: [
        { ...message, humanClassification: undefined },
        { ...message, humanClassification: {
          ...message.humanClassification!, userOverride: undefined,
          effective: { ...message.humanClassification!.effective, userOverride: undefined, classifierVersion: " fixture-v1 " },
        }, destination: { destinationId: " inbox ", source: "fallback", locked: false, reason: "fixture" } },
      ],
    };
    const once = parse(raw);
    assert.equal(once.messages[0]!.humanClassification, null);
    assert.equal(once.messages[1]!.humanClassification!.effective.classifierVersion, "fixture-v1");
    assert.equal(once.messages[1]!.humanClassification!.effective.userOverride, null);
    assert.equal(once.messages[1]!.destination!.destinationId, "inbox");
    assert.equal(JSON.stringify(parse(once)), JSON.stringify(once));
  } finally {
    parseSpy.mockRestore();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    if (priorEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorEncryptionKey;
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
  }
});
