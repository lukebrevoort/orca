import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { collectionThreads, collections, emailAttachments, emailLabels, emails, gmailLabelCollectionImports, gmailLabelMigrations, labels, messageDrafts, oauthAccounts, pins, senderAttentionRules, threadReminders, threads, users } from "./db/schema.ts";
import { app, createApp } from "./index.ts";
import { GmailSyncError } from "./providers/gmail/sync.ts";
import { gmailProvider } from "./providers/gmail/provider.ts";
import { GmailTransportError, type GmailTransport } from "./providers/gmail/transport.ts";
import { outlookProvider } from "./providers/outlook/provider.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import type { MailProviderAdapter, ProviderTransport } from "./providers/shared/interfaces.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous draft work");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Orca API", () => {
  test("requires a session before returning auth state", async () => {
    const response = await app.request("/v1/auth/session");

    assert.equal(response.status, 401);
  });

  test("requires a session before returning an account", async () => {
    const response = await app.request("/v1/me");

    assert.equal(response.status, 401);
  });

  test("lists every connected provider and disconnects only owned accounts with local data", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-accounts-test-"));
    const dbPath = join(tempDir, "accounts.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values([
        { id: "accounts_user", email: "owner@example.com", displayName: "Owner" },
        { id: "accounts_other", email: "other@example.com", displayName: "Other" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "gmail_account", userId: "accounts_user", provider: "gmail", providerEmail: "owner@gmail.com", providerId: "gmail-owner", scope: "https://www.googleapis.com/auth/gmail.readonly", accessTokenEncrypted: "gmail-access", refreshTokenEncrypted: "gmail-refresh", createdAt: new Date(1) },
        { id: "outlook_account", userId: "accounts_user", provider: "outlook", providerEmail: "owner@outlook.com", providerId: "outlook-owner", accessTokenEncrypted: "outlook-access", refreshTokenEncrypted: "outlook-refresh", createdAt: new Date(2) },
        { id: "other_account", userId: "accounts_other", provider: "gmail", providerEmail: "other@gmail.com", providerId: "gmail-other", createdAt: new Date(3) },
      ]).run();
      db.insert(threads).values({ id: "outlook_thread", accountId: "outlook_account", providerThreadId: "provider-thread" }).run();
      const session = await createSession(db, "accounts_user");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}` };

      const list = await testApp.request("/v1/accounts", { headers });
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), {
        items: [
          { id: "gmail_account", provider: "gmail", email: "owner@gmail.com", displayName: "Owner", capabilities: { read: true, draft: false, send: false } },
          { id: "outlook_account", provider: "outlook", email: "owner@outlook.com", displayName: "Owner", capabilities: { read: false, draft: false, send: false } },
        ],
        nextCursor: null,
      });

      assert.equal((await testApp.request("/v1/accounts/other_account", { method: "DELETE", headers })).status, 404);
      assert.ok(db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "other_account")).get());

      assert.equal((await testApp.request("/v1/accounts/outlook_account", { method: "DELETE", headers })).status, 204);
      assert.equal(db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "outlook_account")).get(), undefined);
      assert.equal(db.select().from(threads).where(eq(threads.id, "outlook_thread")).get(), undefined);
      assert.equal((await testApp.request("/v1/accounts/outlook_account", { method: "DELETE", headers })).status, 404);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("keeps Gmail-only routes on Gmail when Outlook was connected first", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-mixed-provider-test-"));
    const dbPath = join(tempDir, "mixed-provider.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "mixed_user", email: "mixed@example.com", displayName: "Mixed" }).run();
      db.insert(oauthAccounts).values([
        {
          id: "outlook_account",
          userId: "mixed_user",
          provider: "outlook",
          providerEmail: "mixed@outlook.com",
          providerId: "outlook-mixed",
          createdAt: new Date(1),
        },
        {
          id: "gmail_account",
          userId: "mixed_user",
          provider: "gmail",
          providerEmail: "mixed@gmail.com",
          providerId: "gmail-mixed",
          scope: "https://www.googleapis.com/auth/gmail.compose",
          lastSyncedAt: new Date("2026-08-09T12:00:00.000Z"),
          createdAt: new Date(2),
        },
      ]).run();
      db.insert(threads).values({
        id: "gmail_thread",
        accountId: "gmail_account",
        providerThreadId: "gmail-thread",
        subject: "Gmail inbox",
        latestReceivedAt: new Date("2026-08-09T13:00:00.000Z"),
        messageCount: 1,
      }).run();
      db.insert(emails).values({
        id: "gmail_email",
        accountId: "gmail_account",
        threadId: "gmail_thread",
        providerMessageId: "gmail-message",
        fromAddress: "maya@example.com",
        subject: "Gmail inbox",
        snippet: "Gmail message",
        receivedAt: new Date("2026-08-09T13:00:00.000Z"),
      }).run();
      db.insert(labels).values([
        { id: "outlook_label", accountId: "outlook_account", providerLabelId: "outlook-work", name: "Outlook label", type: "user" },
        { id: "gmail_label", accountId: "gmail_account", providerLabelId: "gmail-work", name: "Gmail label", type: "user" },
      ]).run();
      db.insert(emailLabels).values({ id: "gmail_email_label", emailId: "gmail_email", labelId: "gmail_label" }).run();
      db.insert(senderAttentionRules).values([
        { id: "outlook_rule", accountId: "outlook_account", scope: "domain", value: "outlook.com", behavior: "quiet", source: "user_choice" },
        { id: "gmail_rule", accountId: "gmail_account", scope: "domain", value: "example.com", behavior: "focus", source: "user_choice" },
      ]).run();

      const syncCalls: string[] = [];
      const mirrorCalls: string[] = [];
      const transportCalls: string[] = [];
      const session = await createSession(db, "mixed_user");
      const headers = { cookie: `orca_session=${session.token}` };
      const jsonHeaders = { ...headers, "content-type": "application/json" };
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        syncPage: async (_database, input) => {
          syncCalls.push(input.accountId);
          return { accountId: input.accountId, emailCount: 1, threadCount: 1, labelCount: 1, contactCount: 1, nextCursor: null, lastSyncedAt: "2026-08-09T13:00:00.000Z" };
        },
        mirrorDraft: async (_database, input) => {
          mirrorCalls.push(input.accountId);
          return { providerDraftId: "gmail-draft", providerMessageId: "gmail-draft-message", providerThreadId: null };
        },
        gmailTransport: {
          async saveDraft() { return { providerDraftId: "gmail-draft" }; },
          async deleteDraft() {},
          async send(_database, accountId) {
            transportCalls.push(accountId);
            return { providerMessageId: "gmail-sent", providerThreadId: "gmail-thread" };
          },
        },
      });

      const accounts = await testApp.request("/v1/accounts", { headers });
      assert.deepEqual((await accounts.json()).items.map((account: { id: string }) => account.id), ["outlook_account", "gmail_account"]);

      const me = await testApp.request("/v1/me", { headers });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).id, "gmail_account");

      const inbox = await testApp.request("/v1/inbox?view=all", { headers });
      assert.equal(inbox.status, 200);
      const inboxBody = await inbox.json();
      assert.deepEqual(inboxBody.accounts.map((account: { id: string }) => account.id), ["outlook_account", "gmail_account"]);
      assert.deepEqual(inboxBody.messages.map((message: { id: string; accountId: string }) => [message.id, message.accountId]), [["gmail_email", "gmail_account"]]);

      const attention = await testApp.request("/v1/attention/rules", { headers });
      assert.deepEqual((await attention.json()).map((rule: { id: string; accountId: string }) => [rule.id, rule.accountId]), [["gmail_rule", "gmail_account"]]);

      const labelMigration = await testApp.request("/v1/gmail-label-migration", { headers });
      assert.deepEqual((await labelMigration.json()).labels.map((label: { id: string; name: string }) => [label.id, label.name]), [["gmail_label", "Gmail label"]]);

      const sync = await testApp.request("/v1/sync/gmail", { method: "POST", headers });
      assert.equal(sync.status, 200);
      assert.deepEqual(syncCalls, ["gmail_account"]);

      const draftResponse = await testApp.request("/v1/drafts", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ subject: "Mixed-provider draft" }),
      });
      assert.equal(draftResponse.status, 201);
      const draft = await draftResponse.json();
      assert.equal(draft.accountId, "gmail_account");
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, draft.id)).get()?.providerSyncStatus === "synced");
      assert.deepEqual(mirrorCalls, ["gmail_account"]);

      const send = await testApp.request(`/v1/drafts/${draft.id}/send`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ revision: draft.revision, idempotencyKey: "mixed-provider-send" }),
      });
      assert.equal(send.status, 200);
      assert.equal((await send.json()).status, "sent");
      assert.deepEqual(transportCalls, ["gmail_account"]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("requires a session before returning inbox data", async () => {
    const response = await app.request("/v1/inbox");

    assert.equal(response.status, 401);
  });

  test("persists account-level writing and reminder preferences", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-preferences-test-"));
    const dbPath = join(tempDir, "preferences.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "preferences_user", email: "preferences@example.com" }).run();
      const session = await createSession(db, "preferences_user");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      assert.deepEqual(await (await testApp.request("/v1/preferences", { headers })).json(), { signature: "", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false });
      const saved = await testApp.request("/v1/preferences", { method: "PATCH", headers, body: JSON.stringify({ signature: "Warmly,\nLuke", composeFormat: "rich", replyBehavior: "reply_all", notifyByDefault: true }) });
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), { signature: "Warmly,\nLuke", composeFormat: "rich", replyBehavior: "reply_all", notifyByDefault: true });
      assert.equal((await testApp.request("/v1/preferences", { method: "PATCH", headers, body: JSON.stringify({}) })).status, 400);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("persists onboarding completion and exposes it on later session checks", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-onboarding-test-"));
    const dbPath = join(tempDir, "onboarding.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    const completedAt = new Date("2026-08-08T20:00:00.000Z");
    try {
      db.insert(users).values({ id: "onboarding_user", email: "onboarding@example.com" }).run();
      const session = await createSession(db, "onboarding_user");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath), now: () => completedAt });
      const headers = { cookie: `orca_session=${session.token}` };

      const before = await testApp.request("/v1/auth/session", { headers });
      assert.equal(before.status, 200);
      assert.equal((await before.json()).onboardingCompletedAt, null);

      const complete = await testApp.request("/v1/auth/onboarding/complete", { method: "POST", headers });
      assert.equal(complete.status, 200);
      assert.deepEqual(await complete.json(), { ok: true });

      const after = await testApp.request("/v1/auth/session", { headers });
      assert.equal(after.status, 200);
      assert.equal((await after.json()).onboardingCompletedAt, completedAt.toISOString());
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("creates account-owned drafts with revisions and a safe delivery boundary", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-drafts-test-"));
    const dbPath = join(tempDir, "drafts.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values([
        { id: "draft_user", email: "writer@example.com" },
        { id: "other_user", email: "other@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "draft_account", userId: "draft_user", provider: "gmail", providerEmail: "writer@example.com", providerId: "gmail-writer" },
        { id: "other_account", userId: "other_user", provider: "gmail", providerEmail: "other@example.com", providerId: "gmail-other" },
      ]).run();
      const writer = await createSession(db, "draft_user");
      const other = await createSession(db, "other_user");
      let reserveDraftId: string | null = null;
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        now: () => {
          if (reserveDraftId) {
            const draftId = reserveDraftId;
            reserveDraftId = null;
            db.update(messageDrafts).set({ deliveryStatus: "sending", sendIdempotencyKey: "worker-reserved-key" }).where(eq(messageDrafts.id, draftId)).run();
          }
          return new Date("2026-07-18T20:00:00.000Z");
        },
      });
      const headers = { cookie: `orca_session=${writer.token}`, "content-type": "application/json" };

      const createdResponse = await testApp.request("/v1/drafts", {
        method: "POST", headers,
        body: JSON.stringify({
          to: [{ name: "Maya Chen", email: "MAYA@EXAMPLE.COM" }], subject: "Launch notes",
          body: { text: "Hi Maya", html: "<p>Hi <strong>Maya</strong><script>nope()</script></p>" },
          context: { kind: "reply", threadId: "thread_1", messageId: "message_1", providerMessageId: "provider-message-1", providerThreadId: "provider-thread-1", inReplyTo: "<message_1@example.com>", references: [] },
        }),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      assert.equal(created.revision, 0);
      assert.equal(created.to[0].email, "maya@example.com");
      assert.equal(created.body.html.includes("script"), false);

      const reloaded = await (await testApp.request(`/v1/drafts/${created.id}`, { headers })).json();
      assert.equal(reloaded.subject, "Launch notes");
      assert.equal((await (await testApp.request("/v1/drafts", { headers })).json()).length, 1);

      const updatedResponse = await testApp.request(`/v1/drafts/${created.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Updated launch notes" }),
      });
      assert.equal(updatedResponse.status, 200);
      const updated = await updatedResponse.json();
      assert.equal(updated.revision, 1);
      assert.equal(updated.subject, "Updated launch notes");

      const stale = await testApp.request(`/v1/drafts/${created.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Too late" }),
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, "stale_draft");

      const crossAccount = await testApp.request(`/v1/drafts/${created.id}`, {
        headers: { cookie: `orca_session=${other.token}` },
      });
      assert.equal(crossAccount.status, 404);

      const tooLarge = await testApp.request("/v1/drafts", {
        method: "POST", headers,
        body: JSON.stringify({ attachments: [{ id: "file_1", filename: "large.zip", mimeType: "application/zip", size: 26 * 1024 * 1024 }] }),
      });
      assert.equal(tooLarge.status, 400);
      assert.equal((await tooLarge.json()).error.code, "attachment_limit");

      const send = await testApp.request(`/v1/drafts/${created.id}/send`, {
        method: "POST", headers, body: JSON.stringify({ revision: 1, idempotencyKey: "a-safe-send-command-key" }),
      });
      assert.equal(send.status, 501);
      assert.equal((await send.json()).error.code, "missing_capability");

      assert.equal((await testApp.request(`/v1/drafts/${created.id}`, { method: "DELETE", headers })).status, 204);
      assert.equal((await testApp.request(`/v1/drafts/${created.id}`, { headers })).status, 404);

      const reserved = await (await testApp.request("/v1/drafts", { method: "POST", headers, body: JSON.stringify({ subject: "Reserved draft" }) })).json();
      reserveDraftId = reserved.id;
      const racingUpdate = await testApp.request(`/v1/drafts/${reserved.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Must not save" }),
      });
      assert.equal(racingUpdate.status, 409);
      assert.equal((await racingUpdate.json()).error.code, "ambiguous_delivery");
      const reservedRecord = db.select().from(messageDrafts).where(eq(messageDrafts.id, reserved.id)).get()!;
      assert.equal(reservedRecord.subject, "Reserved draft");
      assert.equal(reservedRecord.deliveryStatus, "sending");
      assert.equal((await testApp.request(`/v1/drafts/${reserved.id}`, { method: "DELETE", headers })).status, 409);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("persists Gmail drafts and sends exactly once after reserving the idempotency key", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-transport-test-"));
    const dbPath = join(tempDir, "transport.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "user", email: "writer@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerEmail: "writer@example.com", providerId: "gmail-writer", scope: "https://www.googleapis.com/auth/gmail.compose" }).run();
      const calls: string[] = [];
      const transport: GmailTransport = {
        async saveDraft() { return { providerDraftId: "gmail-draft-1" }; },
        async deleteDraft() {},
        async send() { calls.push("send"); return { providerMessageId: "gmail-message-1", providerThreadId: "gmail-thread-1" }; },
      };
      const session = await createSession(db, "user");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        gmailTransport: transport,
        mirrorDraft: async (_db, input) => {
          calls.push(`mirror:${input.providerDraftId ?? "new"}`);
          return { providerDraftId: "gmail-draft-1", providerMessageId: null, providerThreadId: input.content.context?.threadId ?? null };
        },
      });
      const createdResponse = await testApp.request("/v1/drafts", { method: "POST", headers, body: JSON.stringify({ to: [{ name: null, email: "maya@example.com" }], subject: "Hi", body: { text: "Hello", html: null } }) });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      assert.equal(created.providerSyncStatus, "pending");
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, created.id)).get()?.providerSyncStatus === "synced");
      const synced = await (await testApp.request(`/v1/drafts/${created.id}`, { headers })).json();
      assert.equal(synced.providerDraftId, "gmail-draft-1");
      const sent = await testApp.request(`/v1/drafts/${created.id}/send`, { method: "POST", headers, body: JSON.stringify({ revision: synced.revision, idempotencyKey: "idempotency-key-123" }) });
      assert.equal(sent.status, 200);
      assert.deepEqual(await sent.json(), { draftId: created.id, status: "sent", providerMessageId: "gmail-message-1", providerThreadId: "gmail-thread-1", error: null });
      const repeated = await testApp.request(`/v1/drafts/${created.id}/send`, { method: "POST", headers, body: JSON.stringify({ revision: synced.revision, idempotencyKey: "idempotency-key-123" }) });
      assert.equal(repeated.status, 200);
      assert.deepEqual(calls, ["mirror:new", "send"]);
    } finally {
      sqlite.close(); rmSync(tempDir, { recursive: true, force: true }); delete process.env.SESSION_SECRET; delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("marks an unconfirmed Gmail send as ambiguous instead of retrying it", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-ambiguous-send-test-"));
    const dbPath = join(tempDir, "ambiguous.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "user", email: "writer@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerEmail: "writer@example.com", providerId: "gmail-writer", scope: "https://www.googleapis.com/auth/gmail.compose" }).run();
      const transport: GmailTransport = {
        async saveDraft() { return { providerDraftId: "gmail-draft-1" }; }, async deleteDraft() {},
        async send() { throw new GmailTransportError("The delivery outcome could not be confirmed", "ambiguous", true); },
      };
      const session = await createSession(db, "user"); const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath), gmailTransport: transport });
      const createdResponse = await testApp.request("/v1/drafts", { method: "POST", headers, body: JSON.stringify({ to: [{ name: null, email: "maya@example.com" }] }) });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      const response = await testApp.request(`/v1/drafts/${created.id}/send`, { method: "POST", headers, body: JSON.stringify({ revision: 0, idempotencyKey: "idempotency-key-456" }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "ambiguous");
    } finally {
      sqlite.close(); rmSync(tempDir, { recursive: true, force: true }); delete process.env.SESSION_SECRET; delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("mirrors durable drafts asynchronously and keeps failed provider cleanup recoverable", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-draft-mirror-test-"));
    const dbPath = join(tempDir, "draft-mirror.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "mirror_user", email: "mirror@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "mirror_account",
        userId: "mirror_user",
        provider: "gmail",
        providerEmail: "mirror@example.com",
        providerId: "gmail-mirror",
        scope: "https://www.googleapis.com/auth/gmail.compose",
      }).run();
      const session = await createSession(db, "mirror_user");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      let failMirror = false;
      let failDelete = true;
      let holdMirror = false;
      const mirrorGate: { release: (() => void) | null } = { release: null };
      const mirroredSubjects: string[] = [];
      const mirroredProviderIds: Array<string | null> = [];
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        mirrorDraft: async (_database, input) => {
          mirroredSubjects.push(input.content.subject);
          mirroredProviderIds.push(input.providerDraftId);
          if (holdMirror) await new Promise<void>((resolve) => { mirrorGate.release = resolve; });
          if (failMirror) throw new Error("Gmail is temporarily unavailable");
          return { providerDraftId: input.providerDraftId ?? "gmail-draft-1", providerMessageId: "gmail-message-1", providerThreadId: null };
        },
        deleteProviderDraft: async () => {
          if (failDelete) throw new Error("Gmail delete failed");
        },
      });

      const empty = await testApp.request("/v1/drafts", { method: "POST", headers, body: "{}" });
      assert.equal(empty.status, 400);
      assert.equal(db.select().from(messageDrafts).all().length, 0);

      const createdResponse = await testApp.request("/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ subject: "Mirrored thought", body: { text: "Safe immediately", html: null } }),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      assert.equal(created.providerSyncStatus, "pending");
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, created.id)).get()?.providerSyncStatus === "synced");
      assert.deepEqual(mirroredSubjects, ["Mirrored thought"]);

      failMirror = true;
      const updatedResponse = await testApp.request(`/v1/drafts/${created.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ revision: 0, subject: "Still durable" }),
      });
      assert.equal(updatedResponse.status, 200);
      assert.equal((await updatedResponse.json()).providerSyncStatus, "pending");
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, created.id)).get()?.providerSyncStatus === "failed");
      const failed = await (await testApp.request(`/v1/drafts/${created.id}`, { headers })).json();
      assert.equal(failed.subject, "Still durable");
      assert.equal(failed.providerSyncStatus, "failed");
      assert.equal(failed.providerDraftId, "gmail-draft-1");

      const failedDiscard = await testApp.request(`/v1/drafts/${created.id}`, { method: "DELETE", headers });
      assert.equal(failedDiscard.status, 502);
      assert.equal((await failedDiscard.json()).error.retryable, true);
      assert.ok(db.select().from(messageDrafts).where(eq(messageDrafts.id, created.id)).get());

      failDelete = false;
      assert.equal((await testApp.request(`/v1/drafts/${created.id}`, { method: "DELETE", headers })).status, 204);
      assert.equal(db.select().from(messageDrafts).where(eq(messageDrafts.id, created.id)).get(), undefined);

      failMirror = false;
      holdMirror = true;
      const racingCreated = await (await testApp.request("/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ subject: "Race one" }),
      })).json();
      await waitFor(() => mirroredSubjects.includes("Race one"));
      assert.equal((await testApp.request(`/v1/drafts/${racingCreated.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ revision: 0, subject: "Race two" }),
      })).status, 200);
      holdMirror = false;
      mirrorGate.release?.();
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, racingCreated.id)).get()?.providerSyncStatus === "synced");
      assert.deepEqual(mirroredSubjects.slice(-2), ["Race one", "Race two"]);
      assert.equal(mirroredProviderIds.at(-1), "gmail-draft-1");
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("dispatches account lifecycle through a partial custom registry", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 15).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-provider-registry-app-test-"));
    const dbPath = join(tempDir, "provider-registry.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "provider_user", email: "provider@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "provider_account",
        userId: "provider_user",
        provider: "gmail",
        providerEmail: "provider@example.com",
        providerId: "custom-gmail",
      }).run();
      const session = await createSession(db, "provider_user");
      const calls: string[] = [];
      const transport: ProviderTransport = {
        async saveDraft(_db, accountId, draft) {
          calls.push(`save:${accountId}:${draft.subject}`);
          return {
            providerDraftId: "custom-draft",
            providerMessageId: "custom-message",
            providerThreadId: "custom-thread",
          };
        },
        async deleteDraft(_db, accountId, providerDraftId) {
          calls.push(`delete:${accountId}:${providerDraftId}`);
        },
        async send(_db, accountId, draft) {
          calls.push(`send:${accountId}:${draft.subject}`);
          return { providerMessageId: "sent-message", providerThreadId: "sent-thread" };
        },
      };
      const customProvider: MailProviderAdapter = {
        ...gmailProvider,
        detectCapabilities: () => ({ read: true, draft: true, send: true }),
        async syncPage(_db, input) {
          calls.push(`sync:${input.accountId}`);
          return { nextCursor: null, emailCount: 1, threadCount: 1, labelCount: 0, contactCount: 1 };
        },
        createTransport: () => transport,
      };
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        providerRegistry: new ProviderRegistry([customProvider]),
      });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const accountResponse = await testApp.request("/v1/me", { headers });
      assert.equal(accountResponse.status, 200);
      assert.deepEqual((await accountResponse.json()).capabilities, { read: true, draft: true, send: true });

      const syncResponse = await testApp.request("/v1/sync/gmail", { method: "POST", headers });
      assert.equal(syncResponse.status, 200);
      assert.deepEqual(calls, ["sync:provider_account"]);

      const draftResponse = await testApp.request("/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ subject: "Custom provider draft" }),
      });
      assert.equal(draftResponse.status, 201);
      const draft = await draftResponse.json();
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, draft.id)).get()?.providerSyncStatus === "synced");

      const sendResponse = await testApp.request(`/v1/drafts/${draft.id}/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ revision: 0, idempotencyKey: "custom-provider-send" }),
      });
      assert.equal(sendResponse.status, 200);
      assert.equal((await sendResponse.json()).providerMessageId, "sent-message");

      const deletableResponse = await testApp.request("/v1/drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ subject: "Delete me" }),
      });
      const deletable = await deletableResponse.json();
      await waitFor(() => db.select().from(messageDrafts).where(eq(messageDrafts.id, deletable.id)).get()?.providerSyncStatus === "synced");
      assert.equal((await testApp.request(`/v1/drafts/${deletable.id}`, { method: "DELETE", headers })).status, 204);

      assert.deepEqual(calls, [
        "sync:provider_account",
        "save:provider_account:Custom provider draft",
        "send:provider_account:Custom provider draft",
        "save:provider_account:Delete me",
        "delete:provider_account:custom-draft",
      ]);
      assert.equal((await testApp.request("/v1/auth/gmail/connect")).status, 401);
      assert.equal((await testApp.request("/v1/auth/outlook/connect")).status, 404);

      const outlookOnlyApp = createApp({ providerRegistry: new ProviderRegistry([outlookProvider]) });
      assert.equal((await outlookOnlyApp.request("/v1/auth/outlook/connect")).status, 401);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("dispatches a registered Outlook account and keeps unsupported sync explicit", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-outlook-provider-app-test-"));
    const dbPath = join(tempDir, "outlook-provider.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values({ id: "outlook_user", email: "outlook@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "outlook_account",
        userId: "outlook_user",
        provider: "outlook",
        providerEmail: "outlook@example.com",
        providerId: "microsoft-account",
      }).run();
      const session = await createSession(db, "outlook_user");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}` };

      const accountResponse = await testApp.request("/v1/me", { headers });
      assert.equal(accountResponse.status, 200);
      assert.deepEqual(await accountResponse.json(), {
        id: "outlook_account",
        provider: "outlook",
        email: "outlook@example.com",
        displayName: "outlook",
        capabilities: { read: false, draft: false, send: false },
      });

      const syncResponse = await testApp.request("/v1/sync/gmail", { method: "POST", headers });
      assert.equal(syncResponse.status, 501);
      assert.deepEqual(await syncResponse.json(), {
        error: {
          code: "provider_not_implemented",
          message: "Outlook sync is not implemented",
        },
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
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
          subject: "Reader contract", snippet: "First", bodyText: null, bodyHtml: "<div data-email-preheader=\"true\" style=\"visibility:hidden;height:0;width:0;overflow:hidden;opacity:0\">Hidden preheader</div><div style=\"visibility:hidden;height:0;width:0;overflow:hidden;opacity:0\">Hidden spacer</div><h2>Hello <strong>Luke</strong></h2><table role=\"presentation\"><tr><td><p>Readable layout copy</p></td></tr></table><p><a href=\"https://example.com\">Read more</a></p><img src=\"https://tracker.example/pixel.gif\"><script>alert(1)</script>", receivedAt: new Date("2026-07-08T12:00:00.000Z"), internalDate: new Date("2026-07-08T12:00:00.000Z"), isRead: true,
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
      assert.equal(body.messages[0].bodyHtml, "<h2>Hello <strong>Luke</strong></h2><table><tr><td><p>Readable layout copy</p></td></tr></table><p><a href=\"https://example.com\" target=\"_blank\" rel=\"noopener noreferrer\">Read more</a></p><img src=\"https://tracker.example/pixel.gif\" />");
      assert.equal(body.messages[0].bodyText, "Hello LukeReadable layout copyRead more");
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

  test("merges two owned accounts with account-local attention rules, metadata, and cursors", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-unified-inbox-test-"));
    const dbPath = join(tempDir, "unified-inbox.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values([
        { id: "user_1", email: "luke@example.com", displayName: "Luke" },
        { id: "user_2", email: "other@example.com", displayName: "Other" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "acct_primary", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-primary", createdAt: new Date("2026-07-01T00:00:00.000Z") },
        { id: "acct_secondary", userId: "user_1", provider: "gmail", providerEmail: "luke.work@example.com", providerId: "gmail-secondary", createdAt: new Date("2026-07-02T00:00:00.000Z") },
        { id: "acct_private", userId: "user_2", provider: "gmail", providerEmail: "other@example.com", providerId: "gmail-private", createdAt: new Date("2026-07-03T00:00:00.000Z") },
      ]).run();
      db.insert(threads).values([
        { id: "thread_primary_focus", accountId: "acct_primary", providerThreadId: "primary-focus", subject: "Primary focus", latestReceivedAt: new Date("2026-07-08T12:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_primary_normal", accountId: "acct_primary", providerThreadId: "primary-normal", subject: "Primary normal", latestReceivedAt: new Date("2026-07-08T11:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_secondary_notify", accountId: "acct_secondary", providerThreadId: "secondary-notify", subject: "Secondary notify", latestReceivedAt: new Date("2026-07-08T10:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_secondary_quiet", accountId: "acct_secondary", providerThreadId: "secondary-quiet", subject: "Secondary quiet", latestReceivedAt: new Date("2026-07-08T15:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_private", accountId: "acct_private", providerThreadId: "private", subject: "Private", latestReceivedAt: new Date("2026-07-08T18:00:00.000Z"), messageCount: 1, isRead: false },
      ]).run();
      db.insert(emails).values([
        { id: "primary_focus", accountId: "acct_primary", threadId: "thread_primary_focus", providerMessageId: "primary-focus", fromAddress: "shared@example.com", fromName: "Shared sender", subject: "Primary focus", snippet: "Focus from primary", receivedAt: new Date("2026-07-08T12:00:00.000Z"), isRead: false, humanSignal: 8 },
        { id: "primary_normal", accountId: "acct_primary", threadId: "thread_primary_normal", providerMessageId: "primary-normal", fromAddress: "normal@primary.example", subject: "Primary normal", snippet: "Normal from primary", receivedAt: new Date("2026-07-08T11:00:00.000Z"), isRead: false, humanSignal: 4 },
        { id: "secondary_notify", accountId: "acct_secondary", threadId: "thread_secondary_notify", providerMessageId: "secondary-notify", fromAddress: "urgent@secondary.example", subject: "Secondary notify", snippet: "Notify from secondary", receivedAt: new Date("2026-07-08T10:00:00.000Z"), isRead: false, humanSignal: 9 },
        { id: "secondary_quiet", accountId: "acct_secondary", threadId: "thread_secondary_quiet", providerMessageId: "secondary-quiet", fromAddress: "shared@example.com", subject: "Secondary quiet", snippet: "Quiet from secondary", receivedAt: new Date("2026-07-08T15:00:00.000Z"), isRead: false, humanSignal: 1 },
        { id: "private_message", accountId: "acct_private", threadId: "thread_private", providerMessageId: "private", fromAddress: "private@example.com", subject: "Private", snippet: "Not owned by user_1", receivedAt: new Date("2026-07-08T18:00:00.000Z"), isRead: false, humanSignal: 10 },
      ]).run();
      db.insert(labels).values([
        { id: "label_primary", accountId: "acct_primary", providerLabelId: "INBOX", name: "Inbox", type: "system" },
        { id: "label_secondary", accountId: "acct_secondary", providerLabelId: "INBOX", name: "Inbox", type: "system" },
        { id: "label_private", accountId: "acct_private", providerLabelId: "INBOX", name: "Inbox", type: "system" },
      ]).run();
      db.insert(emailLabels).values([
        { id: "join_primary_focus", emailId: "primary_focus", labelId: "label_primary" },
        { id: "join_primary_normal", emailId: "primary_normal", labelId: "label_primary" },
        { id: "join_secondary_notify", emailId: "secondary_notify", labelId: "label_secondary" },
        { id: "join_secondary_quiet", emailId: "secondary_quiet", labelId: "label_secondary" },
        { id: "join_private", emailId: "private_message", labelId: "label_private" },
      ]).run();
      const now = new Date("2026-07-08T16:00:00.000Z");
      db.insert(senderAttentionRules).values([
        { id: "rule_primary_shared", accountId: "acct_primary", scope: "address", value: "shared@example.com", behavior: "focus", source: "user_choice", createdAt: now, updatedAt: now },
        { id: "rule_secondary_shared", accountId: "acct_secondary", scope: "address", value: "shared@example.com", behavior: "quiet", source: "user_choice", createdAt: now, updatedAt: now },
        { id: "rule_secondary_urgent", accountId: "acct_secondary", scope: "address", value: "urgent@secondary.example", behavior: "notify", source: "user_choice", createdAt: now, updatedAt: now },
      ]).run();

      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}` };
      const firstResponse = await testApp.request("/v1/inbox?view=all&limit=2", { headers });
      assert.equal(firstResponse.status, 200);
      const firstPage = await firstResponse.json();
      assert.deepEqual(firstPage.accounts, [
        { id: "acct_primary", provider: "gmail", email: "luke@example.com", displayName: "Luke", capabilities: { read: true, draft: false, send: false } },
        { id: "acct_secondary", provider: "gmail", email: "luke.work@example.com", displayName: "Luke", capabilities: { read: true, draft: false, send: false } },
      ]);
      assert.deepEqual(firstPage.messages.map((message: { id: string; accountId: string; attentionBehavior: string }) => ({ id: message.id, accountId: message.accountId, attentionBehavior: message.attentionBehavior })), [
        { id: "secondary_notify", accountId: "acct_secondary", attentionBehavior: "notify" },
        { id: "primary_focus", accountId: "acct_primary", attentionBehavior: "focus" },
      ]);
      assert.deepEqual(firstPage.counts, { focus: 2, normal: 1, quiet: 1, hidden: 0, all: 4 });
      assert.equal(typeof firstPage.nextCursor, "string");

      const secondResponse = await testApp.request(`/v1/inbox?view=all&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers });
      assert.equal(secondResponse.status, 200);
      const secondPage = await secondResponse.json();
      assert.deepEqual(secondPage.messages.map((message: { id: string; accountId: string; attentionBehavior: string }) => ({ id: message.id, accountId: message.accountId, attentionBehavior: message.attentionBehavior })), [
        { id: "primary_normal", accountId: "acct_primary", attentionBehavior: "normal" },
        { id: "secondary_quiet", accountId: "acct_secondary", attentionBehavior: "quiet" },
      ]);
      assert.equal(secondPage.nextCursor, null);
      assert.equal(secondPage.messages.some((message: { id: string }) => message.id === "private_message"), false);

      const focus = await (await testApp.request("/v1/inbox?view=focus", { headers })).json();
      assert.deepEqual(focus.messages.map((message: { id: string }) => message.id), ["secondary_notify", "primary_focus"]);
      const normal = await (await testApp.request("/v1/inbox?view=normal", { headers })).json();
      assert.deepEqual(normal.messages.map((message: { id: string }) => message.id), ["primary_normal"]);
      const quiet = await (await testApp.request("/v1/inbox?view=quiet", { headers })).json();
      assert.deepEqual(quiet.messages.map((message: { id: string }) => message.id), ["secondary_quiet"]);
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

  test("imports selected Gmail labels once, supports skip, and handles accounts with no user labels", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-label-migration-test-"));
    const dbPath = join(tempDir, "label-migration.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    try {
      db.insert(users).values([
        { id: "user_import", email: "import@example.com" },
        { id: "user_skip", email: "skip@example.com" },
        { id: "user_empty", email: "empty@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "acct_import", userId: "user_import", provider: "gmail", providerEmail: "import@example.com", providerId: "gmail-import", lastSyncedAt: new Date() },
        { id: "acct_skip", userId: "user_skip", provider: "gmail", providerEmail: "skip@example.com", providerId: "gmail-skip", lastSyncedAt: new Date() },
        { id: "acct_empty", userId: "user_empty", provider: "gmail", providerEmail: "empty@example.com", providerId: "gmail-empty", lastSyncedAt: new Date() },
      ]).run();
      db.insert(threads).values([
        { id: "thread_import_1", accountId: "acct_import", providerThreadId: "provider-thread-1", subject: "One", messageCount: 2 },
        { id: "thread_import_2", accountId: "acct_import", providerThreadId: "provider-thread-2", subject: "Two", messageCount: 1 },
      ]).run();
      db.insert(emails).values([
        { id: "email_import_1", accountId: "acct_import", threadId: "thread_import_1", providerMessageId: "provider-email-1" },
        { id: "email_import_2", accountId: "acct_import", threadId: "thread_import_1", providerMessageId: "provider-email-2" },
        { id: "email_import_3", accountId: "acct_import", threadId: "thread_import_2", providerMessageId: "provider-email-3" },
      ]).run();
      db.insert(labels).values([
        { id: "label_work", accountId: "acct_import", providerLabelId: "Label_1", name: "Work", type: "user" },
        { id: "label_travel", accountId: "acct_import", providerLabelId: "Label_2", name: "Travel", type: "user" },
        { id: "label_inbox", accountId: "acct_import", providerLabelId: "INBOX", name: "Inbox", type: "system" },
        { id: "label_skip", accountId: "acct_skip", providerLabelId: "Label_3", name: "Receipts", type: "user" },
      ]).run();
      db.insert(emailLabels).values([
        { id: "join_1", emailId: "email_import_1", labelId: "label_work" },
        { id: "join_2", emailId: "email_import_2", labelId: "label_work" },
        { id: "join_3", emailId: "email_import_3", labelId: "label_travel" },
        { id: "join_4", emailId: "email_import_1", labelId: "label_inbox" },
      ]).run();

      const sessions = {
        import: await createSession(db, "user_import"),
        skip: await createSession(db, "user_skip"),
        empty: await createSession(db, "user_empty"),
      };
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headersFor = (token: string) => ({ cookie: `orca_session=${token}`, "content-type": "application/json" });

      const preview = await (await testApp.request("/v1/gmail-label-migration", { headers: headersFor(sessions.import.token) })).json();
      assert.deepEqual(preview.labels.map((label: { name: string; threadCount: number }) => [label.name, label.threadCount]), [["Travel", 1], ["Work", 1]]);
      db.update(oauthAccounts).set({ lastSyncedAt: null }).where(eq(oauthAccounts.id, "acct_import")).run();
      const preSyncImport = await testApp.request("/v1/gmail-label-migration/import", { method: "POST", headers: headersFor(sessions.import.token), body: JSON.stringify({ labelIds: [] }) });
      assert.equal(preSyncImport.status, 409);
      assert.deepEqual(await preSyncImport.json(), { error: { code: "sync_incomplete", message: "Gmail must finish its initial sync before labels can be imported" } });
      assert.equal(db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, "acct_import")).get(), undefined);
      db.update(oauthAccounts).set({ lastSyncedAt: new Date() }).where(eq(oauthAccounts.id, "acct_import")).run();
      assert.equal((await testApp.request("/v1/gmail-label-migration/import", { method: "POST", headers: headersFor(sessions.import.token), body: JSON.stringify({ labelIds: ["label_inbox"] }) })).status, 400);

      const importRequest = () => testApp.request("/v1/gmail-label-migration/import", { method: "POST", headers: headersFor(sessions.import.token), body: JSON.stringify({ labelIds: ["label_work", "label_travel"] }) });
      const imported = await (await importRequest()).json();
      assert.equal(imported.status, "completed");
      assert.deepEqual(imported.labels.map((label: { imported: boolean }) => label.imported), [true, true]);
      assert.equal((await importRequest()).status, 200);
      assert.equal(db.select().from(collections).where(eq(collections.accountId, "acct_import")).all().length, 2);
      assert.equal(db.select().from(collectionThreads).all().length, 2);
      assert.equal(db.select().from(gmailLabelCollectionImports).all().length, 2);

      const skipped = await (await testApp.request("/v1/gmail-label-migration/skip", { method: "POST", headers: headersFor(sessions.skip.token) })).json();
      assert.equal(skipped.status, "skipped");
      assert.equal(db.select().from(collections).where(eq(collections.accountId, "acct_skip")).all().length, 0);
      const importedLater = await (await testApp.request("/v1/gmail-label-migration/import", { method: "POST", headers: headersFor(sessions.skip.token), body: JSON.stringify({ labelIds: ["label_skip"] }) })).json();
      assert.equal(importedLater.status, "completed");
      assert.equal(db.select().from(collections).where(eq(collections.accountId, "acct_skip")).all().length, 1);

      const emptyPreview = await (await testApp.request("/v1/gmail-label-migration", { headers: headersFor(sessions.empty.token) })).json();
      assert.deepEqual(emptyPreview.labels, []);
      const emptyImport = await (await testApp.request("/v1/gmail-label-migration/import", { method: "POST", headers: headersFor(sessions.empty.token), body: JSON.stringify({ labelIds: [] }) })).json();
      assert.equal(emptyImport.status, "completed");
      assert.equal(db.select().from(gmailLabelMigrations).all().length, 3);
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
        sqlite.run("insert into users (id, email, created_at) values ('upgrade-user', 'upgrade@example.com', 1)");
        sqlite.run("insert into oauth_accounts (id, user_id, provider, provider_email, provider_id, sync_cursor, last_synced_at, created_at, updated_at) values ('upgrade-account', 'upgrade-user', 'gmail', 'upgrade@example.com', 'gmail-upgrade', 'cursor-before-upgrade', 1234, 1, 1)");
        migrate(db, { migrationsFolder: fullMigrations });

        const tables = sqlite.query("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
        assert.ok(tables.some((table) => table.name === "email_attachments"));
        assert.ok(tables.some((table) => table.name === "collections"));
        assert.ok(tables.some((table) => table.name === "collection_threads"));
        assert.ok(tables.some((table) => table.name === "pins"));
        assert.ok(tables.some((table) => table.name === "gmail_label_migrations"));
        assert.ok(tables.some((table) => table.name === "gmail_label_collection_imports"));
        assert.ok(tables.some((table) => table.name === "message_drafts"));
        const emailColumns = sqlite.query("pragma table_info('emails')").all() as Array<{ name: string }>;
        assert.deepEqual(emailColumns.filter((column) => ["to_recipients", "cc_recipients", "bcc_recipients"].includes(column.name)).map((column) => column.name), ["to_recipients", "cc_recipients", "bcc_recipients"]);
        assert.deepEqual(emailColumns.filter((column) => ["internet_message_id", "references"].includes(column.name)).map((column) => column.name), ["internet_message_id", "references"]);
        assert.deepEqual(sqlite.query("select sync_cursor, last_synced_at from oauth_accounts where id = 'upgrade-account'").get(), { sync_cursor: null, last_synced_at: null });
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
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1", scope: "https://www.googleapis.com/auth/gmail.readonly",
        accessTokenEncrypted: "access", refreshTokenEncrypted: "refresh", lastSyncedAt: new Date("2026-07-08T12:00:00.000Z"),
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });

      const response = await testApp.request("/api/sync/status", { headers: { cookie: `orca_session=${session.token}` } });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accounts: [{
          id: "acct_1", provider: "gmail", email: "luke@example.com", displayName: "Luke",
          capabilities: { read: true, draft: false, send: false },
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

  test("marks entire thread as read including all emails", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-read-test-"));
    const dbPath = join(tempDir, "read.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
      }).run();
      db.insert(threads).values({
        id: "thread_1", accountId: "acct_1", providerThreadId: "t1", isRead: false,
      }).run();
      db.insert(emails).values([
        { id: "email_1", accountId: "acct_1", threadId: "thread_1", providerMessageId: "e1", isRead: false },
        { id: "email_2", accountId: "acct_1", threadId: "thread_1", providerMessageId: "e2", isRead: false },
      ]).run();

      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}` };

      const response = await testApp.request("/v1/threads/thread_1/read?accountId=acct_1", { method: "PATCH", headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });

      const emailRows = sqlite.query("select id, is_read from emails where thread_id = 'thread_1' order by id").all() as Array<{ id: string; is_read: number }>;
      assert.deepEqual(emailRows, [
        { id: "email_1", is_read: 1 },
        { id: "email_2", is_read: 1 },
      ]);

      const threadRow = sqlite.query("select is_read from threads where id = 'thread_1'").get() as { is_read: number };
      assert.equal(threadRow.is_read, 1);

      const missingAccount = await testApp.request("/v1/threads/thread_1/read?accountId=acct_1", { method: "PATCH" });
      assert.equal(missingAccount.status, 401);

      const missingQuery = await testApp.request("/v1/threads/thread_1/read", { method: "PATCH", headers });
      assert.equal(missingQuery.status, 400);

      const missingThread = await testApp.request("/v1/threads/nonexistent/read?accountId=acct_1", { method: "PATCH", headers });
      assert.equal(missingThread.status, 404);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });
});
