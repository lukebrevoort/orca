import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession, storeProviderTokens } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import type { GmailClient } from "./providers/gmail/client.ts";
import type { GmailPushConfig } from "./providers/gmail/push-config.ts";
import { createDefaultGmailSyncCoordinator } from "./providers/gmail/sync-runtime.ts";
import type { GmailMessage } from "./providers/gmail/types.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../drizzle");
const pushConfig: GmailPushConfig = {
  topicName: "projects/orca/topics/gmail",
  verificationToken: "push-secret",
  syncIntervalMs: 60_000,
  watchRenewalWindowMs: 60_000,
  backfillPageSize: 25,
  backfillMaxPages: 20,
};

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-route-"));
  tempDirs.push(tempDir);
  const client = createDatabaseClient(join(tempDir, "route.sqlite"));
  migrate(client.db, { migrationsFolder });
  return client;
}

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}

function createMessage(id: string): GmailMessage {
  return {
    id,
    threadId: "thread-1",
    internalDate: "1783512000000",
    labelIds: ["INBOX"],
    snippet: "A push message",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Maya Chen <maya@example.com>" },
        { name: "To", value: "Luke Brevoort <luke@example.com>" },
        { name: "Subject", value: "A push message" },
      ],
      body: { data: Buffer.from("A push message").toString("base64") },
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for asynchronous Gmail sync");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Gmail push routes", () => {
  test("accepts a verified Pub/Sub push and runs history sync without a user session", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const historyGate = deferred();
    const gmailClient: GmailClient = {
      async getMessage(_token, id) { return createMessage(id); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async listHistory() {
        await historyGate.promise;
        return { messageIds: ["push-message"], deletedMessageIds: [], nextCursor: null, historyId: "11" };
      },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
        syncHistoryId: "10",
        lastSyncedAt: new Date("2026-08-10T00:00:00.000Z"),
      }).run();
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const testApp = createApp({
        dbFactory: () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite")),
        gmailClient,
        gmailPushConfig: pushConfig,
      });
      const data = Buffer.from(JSON.stringify({ emailAddress: "LUKE@EXAMPLE.COM", historyId: "11" })).toString("base64url");
      const requestStartedAt = performance.now();
      const response = await testApp.request("/v1/webhooks/gmail?token=push-secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { data } }),
      });

      assert.equal(response.status, 204);
      assert.ok(performance.now() - requestStartedAt < 250, "valid push is acknowledged before provider fetch completes");
      assert.equal((sqlite.query("select count(*) as count from gmail_sync_jobs where account_id = 'acct_1'").get() as { count: number }).count, 1);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "10");
      historyGate.resolve();
      await waitFor(() => (sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id === "11");
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "11");
      assert.equal((sqlite.query("select count(*) as count from emails").get() as { count: number }).count, 1);
      const metrics = sqlite.query("select message_count, provider_fetch_ms, db_prepare_count, db_write_ms, freshness_ms from gmail_sync_runs where account_id = 'acct_1'").get() as {
        message_count: number;
        provider_fetch_ms: number;
        db_prepare_count: number;
        db_write_ms: number;
        freshness_ms: number;
      };
      assert.equal(metrics.message_count, 1);
      assert.ok(metrics.provider_fetch_ms >= 0);
      assert.ok(metrics.db_prepare_count > 0);
      assert.ok(metrics.db_write_ms >= 0);
      assert.ok(metrics.freshness_ms >= 0);
    } finally {
      sqlite.close();
    }
  });

  test("rejects unverified pushes and keeps the watch endpoint session-protected", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async watch() { return { historyId: "1", expiration: "1800000000000" }; },
    };

    try {
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite")),
        gmailClient,
        gmailPushConfig: pushConfig,
      });
      const data = Buffer.from(JSON.stringify({ emailAddress: "luke@example.com", historyId: "11" })).toString("base64url");

      assert.equal((await testApp.request("/v1/gmail/push?token=wrong", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { data } }),
      })).status, 401);
      assert.equal((await testApp.request("/v1/gmail/watch", { method: "POST" })).status, 401);
    } finally {
      sqlite.close();
    }
  });

  test("watch endpoint establishes a cursor before backfilling a new account", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage(_token, id) { return createMessage(id); },
      async listInboxMessagePage() { return { messageIds: ["existing-message"], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async watch() { return { historyId: "50", expiration: "1800000000000" }; },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });
      const session = await createSession(db, "user_1");
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite")),
        gmailClient,
        gmailPushConfig: pushConfig,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      });
      const partialConfigApp = createApp({
        dbFactory: () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite")),
        gmailClient,
        gmailPushConfig: { ...pushConfig, topicName: null },
      });
      assert.equal((await partialConfigApp.request("/v1/gmail/watch", {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}` },
      })).status, 503);

      const response = await testApp.request("/v1/gmail/watch", {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}` },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.watch.historyId, "50");
      assert.equal(body.backfill.emailCount, 1);
      assert.equal((sqlite.query("select sync_history_id, last_synced_at from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "50");
    } finally {
      sqlite.close();
    }
  });

  test("watch endpoint preserves renewal intent when a history push is already active", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const historyStarted = deferred();
    const releaseHistory = deferred();
    let watchCalls = 0;
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async listHistory() {
        historyStarted.resolve();
        await releaseHistory.promise;
        return { messageIds: [], deletedMessageIds: [], nextCursor: null, historyId: "11" };
      },
      async watch() {
        watchCalls += 1;
        return { historyId: "11", expiration: "1800000000000" };
      },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
        syncHistoryId: "10",
        lastSyncedAt: new Date("2026-08-10T00:00:00.000Z"),
        watchExpirationAt: new Date("2026-08-10T00:00:00.000Z"),
        watchTopic: pushConfig.topicName,
      }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });
      const session = await createSession(db, "user_1");
      const dbFactory = () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite"));
      const coordinator = createDefaultGmailSyncCoordinator({
        dbFactory,
        gmailClient,
        config: pushConfig,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      });
      const testApp = createApp({
        dbFactory,
        gmailClient,
        gmailPushConfig: pushConfig,
        gmailSyncCoordinator: coordinator,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      });

      coordinator.enqueue({ accountId: "acct_1", source: "push", historyId: "11" });
      const activePush = coordinator.drainAccount("acct_1");
      await historyStarted.promise;
      const watchResponse = testApp.request("/v1/gmail/watch", {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}` },
      });
      await waitFor(() => (sqlite.query("select total_enqueued from gmail_sync_jobs where account_id = 'acct_1'").get() as { total_enqueued: number }).total_enqueued === 2);
      releaseHistory.resolve();

      const response = await watchResponse;
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.watch.historyId, "11");
      assert.equal(watchCalls, 1);
      assert.equal((await activePush).runs, 2);
    } finally {
      releaseHistory.resolve();
      sqlite.close();
    }
  });

  test("watch endpoint reports a coalesced renewal failure after preserving history progress", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { calls.push("list"); return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async listHistory() {
        calls.push("history");
        return { messageIds: [], deletedMessageIds: [], nextCursor: null, historyId: "11" };
      },
      async watch() {
        calls.push("watch");
        throw new Error("watch topic is unavailable");
      },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
        syncHistoryId: "10",
        lastSyncedAt: new Date("2026-08-10T00:00:00.000Z"),
        watchExpirationAt: new Date("2026-08-10T00:00:00.000Z"),
        watchTopic: pushConfig.topicName,
      }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });
      const session = await createSession(db, "user_1");
      const dbFactory = () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite"));
      const coordinator = createDefaultGmailSyncCoordinator({
        dbFactory,
        gmailClient,
        config: pushConfig,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      });
      const testApp = createApp({
        dbFactory,
        gmailClient,
        gmailPushConfig: pushConfig,
        gmailSyncCoordinator: coordinator,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
      });
      coordinator.enqueue({ accountId: "acct_1", source: "push", historyId: "11" });

      const response = await testApp.request("/v1/gmail/watch", {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}` },
      });

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: { code: "provider_error", message: "Gmail push sync is temporarily unavailable" },
      });
      assert.deepEqual(calls, ["history", "watch"]);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string }).sync_history_id, "11");
    } finally {
      sqlite.close();
    }
  });

  test("full resync clears legacy checkpoints, rebuilds mail, and re-establishes the watch", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage(_token, id) { return createMessage(id); },
      async listInboxMessagePage({ since }) {
        calls.push(`list:${since.toISOString()}`);
        return { messageIds: ["reset-message"], nextCursor: null };
      },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async watch() {
        calls.push("watch");
        return { historyId: "60", expiration: "1800000000000" };
      },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
        syncCursor: "legacy-cursor",
        syncHistoryId: "50",
        watchExpirationAt: new Date("2026-08-12T00:00:00.000Z"),
        watchTopic: pushConfig.topicName,
        lastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });
      const session = await createSession(db, "user_1");
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(join(tempDirs[0]!, "route.sqlite")),
        gmailClient,
        gmailPushConfig: pushConfig,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
      });

      const response = await testApp.request("/v1/sync/gmail/reset?accountId=stale-account-id", {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}` },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(calls, ["watch", "list:1970-01-01T00:00:00.000Z"]);
      const syncState = sqlite.query("select sync_cursor, sync_history_id, last_synced_at from oauth_accounts where id = 'acct_1'").get() as { sync_cursor: string | null; sync_history_id: string | null; last_synced_at: number | null };
      assert.equal(syncState.sync_cursor, null);
      assert.equal(syncState.sync_history_id, "60");
      assert.equal(new Date(syncState.last_synced_at ?? 0).toISOString(), "2026-08-15T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });
});
