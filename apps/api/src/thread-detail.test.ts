import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SQLQueryBindings } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { threadDetailSchema } from "@orca/shared";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { createApp } from "./index.ts";

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
    const detail = threadDetailSchema.parse(await response.json());
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
    assert.equal((await app.request("/v1/threads/private?accountId=a", { headers })).status, 404);
    assert.equal((await app.request("/v1/threads/private?accountId=b", { headers })).status, 404);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    if (priorEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorEncryptionKey;
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
  }
});
