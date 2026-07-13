import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { collectionThreads, collections, emailAttachments, emailLabels, emails, labels, oauthAccounts, pins, senderAttentionRules, threadReminders, threads, users } from "./db/schema.ts";
import { app, createApp } from "./index.ts";
import { GmailSyncError } from "./providers/gmail/sync.ts";

describe("Orca API", () => {
  test("requires a session before returning auth state", async () => {
    const response = await app.request("/v1/auth/session");

    assert.equal(response.status, 401);
  });

  test("requires a session before returning an account", async () => {
    const response = await app.request("/v1/me");

    assert.equal(response.status, 401);
  });

  test("requires a session before returning inbox data", async () => {
    const response = await app.request("/v1/inbox");

    assert.equal(response.status, 401);
  });

  test("rejects blank inbox cursors", async () => {
    const response = await app.request("/v1/inbox?cursor=");
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "validation_error");
    assert.equal(body.error.message, "Invalid inbox query parameters");
    assert.equal(body.error.issues.length, 1);
    assert.equal(body.error.issues[0].path, "cursor");
    assert.match(body.error.issues[0].message, /1 character/);
  });

  test("returns an account-scoped, chronological reader snapshot with sanitized HTML", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values([
        { id: "user_1", email: "luke@example.com", displayName: "Luke" },
        { id: "user_2", email: "other@example.com", displayName: "Other" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" },
        { id: "acct_2", userId: "user_1", provider: "gmail", providerEmail: "luke.work@example.com", providerId: "gmail-user-2" },
        { id: "acct_3", userId: "user_2", provider: "gmail", providerEmail: "other@example.com", providerId: "gmail-user-3" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_1", accountId: "acct_1", providerThreadId: "provider-thread-1", subject: "Reader contract", latestReceivedAt: new Date("2026-07-08T13:00:00.000Z"), messageCount: 2, isRead: false },
        { id: "thread_2", accountId: "acct_2", providerThreadId: "provider-thread-2", subject: "Second account", latestReceivedAt: new Date(), messageCount: 0, isRead: true },
        { id: "thread_3", accountId: "acct_3", providerThreadId: "provider-thread-3", subject: "Private", latestReceivedAt: new Date(), messageCount: 1, isRead: true },
      ]).run();
      db.insert(emails).values([
        {
          id: "email_old", accountId: "acct_1", threadId: "thread_1", providerMessageId: "provider-old",
          fromAddress: "maya@example.com", fromName: "Maya", toRecipients: JSON.stringify([{ name: "Luke", email: "luke@example.com" }]), ccRecipients: "[]", bccRecipients: "[]",
          subject: "Reader contract", snippet: "First", bodyText: null, bodyHtml: "<p>Hello <strong>Luke</strong><script>alert(1)</script></p>", receivedAt: new Date("2026-07-08T12:00:00.000Z"), internalDate: new Date("2026-07-08T12:00:00.000Z"), isRead: true,
        },
        {
          id: "email_new", accountId: "acct_1", threadId: "thread_1", providerMessageId: "provider-new",
          fromAddress: "luke@example.com", fromName: "Luke", toRecipients: JSON.stringify([{ name: "Maya", email: "maya@example.com" }]), ccRecipients: null, bccRecipients: null,
          subject: "Reader contract", snippet: "Second", bodyText: null, bodyHtml: null, receivedAt: new Date("2026-07-08T13:00:00.000Z"), internalDate: new Date("2026-07-08T13:00:00.000Z"), isRead: false, isStarred: true, humanSignal: 7,
        },
      ]).run();
      db.insert(emailAttachments).values({ id: "attachment_1", emailId: "email_old", providerAttachmentId: "a1", filename: "notes.pdf", mimeType: "application/pdf", size: 42 }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });

      const response = await testApp.request("/v1/threads/thread_1?accountId=acct_1", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.messages.map((message: { id: string }) => message.id), ["email_old", "email_new"]);
      assert.equal(body.messages[0].bodyHtml, "<p>Hello <strong>Luke</strong></p>");
      assert.equal(body.messages[0].bodyText, "Hello Luke");
      assert.equal(body.messages[1].bodyHtml, null);
      assert.equal(body.messages[1].bodyText, null);
      assert.deepEqual(body.messages[0].attachments, [{ id: "attachment_1", filename: "notes.pdf", mimeType: "application/pdf", size: 42 }]);
      assert.deepEqual(body.thread.participants, [{ name: "Maya", email: "maya@example.com" }, { name: "Luke", email: "luke@example.com" }]);
      assert.deepEqual(body.thread.attention, { hasUnread: true, hasStarred: true, hasDraft: false, humanSignal: 7 });

      const secondOwnedAccount = await testApp.request("/v1/threads/thread_2?accountId=acct_2", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(secondOwnedAccount.status, 200);
      const wrongOwnedAccount = await testApp.request("/v1/threads/thread_1?accountId=acct_2", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(wrongOwnedAccount.status, 404);
      const crossAccount = await testApp.request("/v1/threads/thread_3?accountId=acct_3", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(crossAccount.status, 404);
      const unknown = await testApp.request("/v1/threads/missing?accountId=acct_1", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(unknown.status, 404);
      const missingAccount = await testApp.request("/v1/threads/thread_1", { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(missingAccount.status, 400);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("filters and deterministically sorts explainable attention views", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-attention-inbox-test-"));
    const dbPath = join(tempDir, "attention.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com", displayName: "Luke" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" }).run();
      db.insert(threads).values(["bank", "family", "news", "hidden"].map((id) => ({ id: `thread_${id}`, accountId: "acct_1", providerThreadId: id, subject: id, latestReceivedAt: new Date("2026-07-08T13:00:00.000Z"), messageCount: 1, isRead: false }))).run();
      db.insert(emails).values([
        { id: "email_bank", accountId: "acct_1", threadId: "thread_bank", providerMessageId: "bank", fromAddress: "alerts@bank.example", subject: "Bank", receivedAt: new Date("2026-07-08T12:00:00.000Z"), isRead: false, humanSignal: 0 },
        { id: "email_family", accountId: "acct_1", threadId: "thread_family", providerMessageId: "family", fromAddress: "family@example.com", subject: "Family", receivedAt: new Date("2026-07-08T11:00:00.000Z"), isRead: false, humanSignal: 10 },
        { id: "email_news", accountId: "acct_1", threadId: "thread_news", providerMessageId: "news", fromAddress: "daily@news.example", subject: "News", receivedAt: new Date("2026-07-08T14:00:00.000Z"), isRead: false, humanSignal: 0 },
        { id: "email_hidden", accountId: "acct_1", threadId: "thread_hidden", providerMessageId: "hidden", fromAddress: "robot@hidden.example", subject: "Hidden", receivedAt: new Date("2026-07-08T15:00:00.000Z"), isRead: false, humanSignal: 0 },
      ]).run();
      const now = new Date("2026-07-08T16:00:00.000Z");
      db.insert(senderAttentionRules).values([
        { id: "rule_bank", accountId: "acct_1", scope: "address", value: "alerts@bank.example", behavior: "focus", source: "user_choice", createdAt: now, updatedAt: now },
        { id: "rule_family", accountId: "acct_1", scope: "address", value: "family@example.com", behavior: "notify", source: "user_choice", createdAt: now, updatedAt: now },
        { id: "rule_news", accountId: "acct_1", scope: "domain", value: "news.example", behavior: "quiet", source: "user_choice", createdAt: now, updatedAt: now },
        { id: "rule_hidden", accountId: "acct_1", scope: "domain", value: "hidden.example", behavior: "hidden", source: "user_choice", createdAt: now, updatedAt: now },
      ]).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const request = (view: string) => testApp.request(`/v1/inbox?view=${view}`, { headers: { cookie: `orca_session=${session.token}` } });

      const focus = await (await request("focus")).json();
      assert.deepEqual(focus.messages.map((message: { id: string }) => message.id), ["email_family", "email_bank"]);
      assert.equal(focus.messages[0].humanSignal, 10);
      assert.equal(focus.messages[1].humanSignal, 0);
      assert.deepEqual(focus.counts, { focus: 2, normal: 0, quiet: 1, hidden: 1, all: 4 });
      assert.deepEqual((await (await request("quiet")).json()).messages.map((message: { id: string }) => message.id), ["email_news"]);
      assert.deepEqual((await (await request("hidden")).json()).messages.map((message: { id: string }) => message.id), ["email_hidden"]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("keeps collections additive, orders pins deterministically, and deletes only organization metadata", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-collections-test-"));
    const dbPath = join(tempDir, "collections.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com", displayName: "Luke" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" }).run();
      db.insert(threads).values({ id: "thread_1", accountId: "acct_1", providerThreadId: "provider-thread-1", subject: "Additive", latestReceivedAt: new Date(), messageCount: 1, isRead: false }).run();
      db.insert(emails).values({ id: "email_1", accountId: "acct_1", threadId: "thread_1", providerMessageId: "provider-email-1", fromAddress: "maya@example.com", subject: "Additive", receivedAt: new Date(), isRead: false }).run();
      db.insert(labels).values({ id: "label_1", accountId: "acct_1", providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
      db.insert(emailLabels).values({ id: "email-label_1", emailId: "email_1", labelId: "label_1" }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const createCollection = (name: string) => testApp.request("/v1/collections", { method: "POST", headers, body: JSON.stringify({ name }) });
      const work = await (await createCollection("Work")).json();
      const reference = await (await createCollection("Reference")).json();
      const recolored = await (await testApp.request(`/v1/collections/${work.id}`, { method: "PATCH", headers, body: JSON.stringify({ color: "#83728d" }) })).json();
      assert.equal(recolored.color, "#83728d");
      assert.equal((await testApp.request(`/v1/collections/${work.id}/threads/thread_1`, { method: "PUT", headers })).status, 200);
      assert.equal((await testApp.request(`/v1/collections/${reference.id}/threads/thread_1`, { method: "PUT", headers })).status, 200);
      const both = await (await testApp.request("/v1/collections", { headers })).json();
      assert.deepEqual(both.map((item: { threadIds: string[] }) => item.threadIds), [["thread_1"], ["thread_1"]]);
      assert.deepEqual(both.map((item: { color: string }) => item.color), ["#83728d", "#70867d"]);

      const firstPin = await (await testApp.request("/v1/pins", { method: "POST", headers, body: JSON.stringify({ kind: "sender", targetId: "maya@example.com", label: "Maya" }) })).json();
      const secondPin = await (await testApp.request("/v1/pins", { method: "POST", headers, body: JSON.stringify({ kind: "thread", targetId: "thread_1", label: "Additive" }) })).json();
      await testApp.request(`/v1/pins/${secondPin.id}`, { method: "PATCH", headers, body: JSON.stringify({ position: 0 }) });
      const orderedPins = await (await testApp.request("/v1/pins", { headers })).json();
      assert.deepEqual(orderedPins.map((item: { id: string; position: number }) => [item.id, item.position]), [[secondPin.id, 0], [firstPin.id, 1]]);

      assert.equal((await testApp.request(`/v1/collections/${work.id}`, { method: "DELETE", headers })).status, 204);
      const verification = createDatabaseClient(dbPath);
      try {
        assert.equal(verification.db.select().from(collections).all().length, 1);
        assert.equal(verification.db.select().from(collectionThreads).all().length, 1);
        assert.equal(verification.db.select().from(threads).all().length, 1);
        assert.equal(verification.db.select().from(emails).all().length, 1);
        assert.equal(verification.db.select().from(labels).all().length, 1);
        assert.equal(verification.db.select().from(emailLabels).all().length, 1);
        assert.equal(verification.db.select().from(pins).all().length, 2);
      } finally {
        verification.sqlite.close();
      }
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("schedules, resurfaces, completes, and cancels thread reminders with a controllable clock", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-reminders-test-"));
    const dbPath = join(tempDir, "reminders.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    let clock = new Date("2026-07-12T16:00:00.000Z");
    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" }).run();
      db.insert(threads).values({ id: "thread_1", accountId: "acct_1", providerThreadId: "provider-thread-1", subject: "Later", latestReceivedAt: clock, messageCount: 1, isRead: false }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath), now: () => clock });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const schedule = async (scheduledFor: string) => testApp.request("/v1/reminders", { method: "POST", headers, body: JSON.stringify({ threadId: "thread_1", scheduledFor, timezone: "America/Los_Angeles", notify: true }) });

      assert.equal((await schedule("2026-07-12T15:00:00.000Z")).status, 400);
      assert.equal((await testApp.request("/v1/reminders", { method: "POST", headers, body: JSON.stringify({ threadId: "thread_1", scheduledFor: "2026-07-13T16:00:00.000Z", timezone: "No/Such_Zone" }) })).status, 400);
      const created = await (await schedule("2026-07-13T16:00:00.000Z")).json();
      assert.equal(created.status, "scheduled");
      assert.equal(created.notify, true);
      assert.equal((await (await testApp.request("/v1/reminders", { headers })).json())[0].status, "scheduled");

      clock = new Date("2026-07-14T16:00:00.000Z");
      const due = await (await testApp.request("/v1/reminders", { headers })).json();
      assert.equal(due[0].status, "resurfaced");
      assert.equal(due[0].resurfacedAt, clock.toISOString());
      const done = await (await testApp.request(`/v1/reminders/${created.id}/done`, { method: "POST", headers })).json();
      assert.equal(done.status, "completed");
      assert.equal((await testApp.request(`/v1/reminders/${created.id}`, { method: "DELETE", headers })).status, 204);
      assert.equal((await testApp.request(`/v1/reminders/${created.id}`, { method: "DELETE", headers })).status, 204);
      assert.equal(db.select().from(threadReminders).all().length, 1);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("upgrades a database at migration 0003 with the reader storage migrations", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orca-migration-upgrade-test-"));
    const dbPath = join(tempDir, "upgrade.sqlite");
    const partialMigrations = join(tempDir, "migrations");
    const fullMigrations = resolve(import.meta.dir, "../drizzle");
    mkdirSync(join(partialMigrations, "meta"), { recursive: true });

    try {
      const initialMigrationNames = [
        "0000_melted_fenris.sql",
        "0001_legal_tempest.sql",
        "0002_overjoyed_lockjaw.sql",
        "0003_google_login.sql",
      ];
      for (const name of initialMigrationNames) {
        writeFileSync(join(partialMigrations, name), readFileSync(join(fullMigrations, name)));
      }
      const journal = JSON.parse(readFileSync(join(fullMigrations, "meta/_journal.json"), "utf8"));
      writeFileSync(join(partialMigrations, "meta/_journal.json"), JSON.stringify({
        ...journal,
        entries: journal.entries.slice(0, 4),
      }));

      const { db, sqlite } = createDatabaseClient(dbPath);
      try {
        migrate(db, { migrationsFolder: partialMigrations });
        migrate(db, { migrationsFolder: fullMigrations });

        const tables = sqlite.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
        assert.ok(tables.some((table) => table.name === "email_attachments"));
        assert.ok(tables.some((table) => table.name === "collections"));
        assert.ok(tables.some((table) => table.name === "collection_threads"));
        assert.ok(tables.some((table) => table.name === "pins"));
        const emailColumns = sqlite.query("pragma table_info('emails')").all() as Array<{ name: string }>;
        assert.deepEqual(emailColumns.filter((column) => ["to_recipients", "cc_recipients", "bcc_recipients"].includes(column.name)).map((column) => column.name), ["to_recipients", "cc_recipients", "bcc_recipients"]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("runs the manual Gmail sync endpoint for an authenticated user", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "../drizzle"),
    });

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
      }).run();

      const session = await createSession(db, "user_1");
      const syncCalls: string[] = [];
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        syncPage: async (_db, input) => {
          syncCalls.push(input.accountId);
          return {
            accountId: input.accountId,
            emailCount: 1,
            threadCount: 1,
            labelCount: 2,
            contactCount: 2,
            nextCursor: null,
            lastSyncedAt: "2026-07-08T12:00:00.000Z",
          };
        },
      });

      const response = await testApp.request("/v1/sync/gmail", {
        method: "POST",
        headers: {
          cookie: `orca_session=${session.token}`,
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accountId: "acct_1",
        emailCount: 1,
        threadCount: 1,
        labelCount: 2,
        contactCount: 2,
        nextCursor: null,
        lastSyncedAt: "2026-07-08T12:00:00.000Z",
        pages: 1,
      });
      assert.deepEqual(syncCalls, ["acct_1"]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("reports per-account sync status and last successful sync time", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com", displayName: "Luke" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
        accessTokenEncrypted: "access", refreshTokenEncrypted: "refresh", lastSyncedAt: new Date("2026-07-08T12:00:00.000Z"),
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });

      const response = await testApp.request("/api/sync/status", { headers: { cookie: `orca_session=${session.token}` } });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accounts: [{
          id: "acct_1", provider: "gmail", email: "luke@example.com", displayName: "Luke",
          state: "idle", lastSyncedAt: "2026-07-08T12:00:00.000Z", error: null,
        }],
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("maps provider sync failures to a bounded public error response", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "../drizzle"),
    });

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
      }).run();

      const session = await createSession(db, "user_1");
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        syncPage: async () => {
          throw new GmailSyncError("raw upstream detail acct_1", "provider_error");
        },
      });

      const response = await testApp.request("/v1/sync/gmail", {
        method: "POST",
        headers: {
          cookie: `orca_session=${session.token}`,
        },
      });

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: {
          code: "provider_error",
          message: "Gmail sync is temporarily unavailable",
        },
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("persists account-scoped sender rules, resolves precedence, and resets to the next rule", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-attention-test-"));
    const dbPath = join(tempDir, "attention.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const domainResponse = await testApp.request("/v1/attention/rules", {
        method: "POST", headers,
        body: JSON.stringify({ scope: "domain", value: "Example.COM", behavior: "quiet", source: "user_choice" }),
      });
      assert.equal(domainResponse.status, 200);
      assert.equal((await domainResponse.json()).value, "example.com");

      const addressResponse = await testApp.request("/v1/attention/rules", {
        method: "POST", headers,
        body: JSON.stringify({ scope: "address", value: "Maya@Example.com", behavior: "focus", source: "suggestion_accepted" }),
      });
      const addressRule = await addressResponse.json();
      assert.equal(addressResponse.status, 200);

      const exact = await testApp.request("/v1/attention/resolve?address=maya%40example.com", { headers });
      assert.deepEqual(await exact.json(), {
        behavior: "focus",
        rule: { ...addressRule, value: "maya@example.com" },
      });
      const domain = await testApp.request("/v1/attention/resolve?address=other%40example.com", { headers });
      assert.equal((await domain.json()).behavior, "quiet");

      const reset = await testApp.request(`/v1/attention/rules/${addressRule.id}`, { method: "DELETE", headers });
      assert.equal(reset.status, 204);
      const afterReset = await testApp.request("/v1/attention/resolve?address=maya%40example.com", { headers });
      assert.equal((await afterReset.json()).behavior, "quiet");
      const defaultRule = await testApp.request("/v1/attention/resolve?address=elsewhere%40other.example", { headers });
      assert.deepEqual(await defaultRule.json(), { behavior: "normal", rule: null });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("persists presentation independently of attention behavior", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-attention-views-test-"));
    const dbPath = join(tempDir, "views.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const listed = await testApp.request("/v1/attention/view-settings", { headers });
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).length, 5);
      const updated = await testApp.request("/v1/attention/view-settings/normal", {
        method: "PATCH", headers,
        body: JSON.stringify({ displayName: "Everyday", icon: "mail", color: "#123456", position: 0 }),
      });
      assert.deepEqual(await updated.json(), {
        behavior: "normal", displayName: "Everyday", icon: "mail", color: "#123456", position: 0,
      });
      const settings = await testApp.request("/v1/attention/view-settings", { headers });
      const values = await settings.json();
      assert.deepEqual(values.map((value: { behavior: string; position: number }) => [value.behavior, value.position]), [
        ["normal", 0], ["notify", 1], ["focus", 2], ["quiet", 3], ["hidden", 4],
      ]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });
});
