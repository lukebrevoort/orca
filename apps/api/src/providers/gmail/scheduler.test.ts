import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import type { GmailClient } from "./client.ts";
import type { GmailPushConfig } from "./push-config.ts";
import { runGmailPeriodicSync } from "./scheduler.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const config: GmailPushConfig = {
  topicName: "projects/orca/topics/gmail",
  verificationToken: "push-secret",
  syncIntervalMs: 60_000,
  watchRenewalWindowMs: 60_000,
  backfillPageSize: 25,
  backfillMaxPages: 20,
};

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
}

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-scheduler-"));
  tempDirs.push(tempDir);
  const path = join(tempDir, "scheduler.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder });
  return { path, ...client };
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Gmail periodic sync scheduler", () => {
  test("backfills a new account, establishes a watch, and reports per-account success", async () => {
    setAuthEnv();
    const { db, sqlite, path } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage() {
        return {
          id: "message-1",
          threadId: "thread-1",
          labelIds: ["INBOX"],
          internalDate: "1783512000000",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Maya <maya@example.com>" },
              { name: "To", value: "Luke <luke@example.com>" },
              { name: "Subject", value: "Periodic" },
            ],
            body: { data: Buffer.from("Periodic").toString("base64") },
          },
        };
      },
      async listInboxMessagePage() {
        calls.push("list");
        return { messageIds: ["message-1"], nextCursor: null };
      },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async watch() {
        calls.push("watch");
        return { historyId: "100", expiration: "1800000000000" };
      },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1" }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });

      const result = await runGmailPeriodicSync({
        dbFactory: () => createDatabaseClient(path),
        gmailClient,
        config,
        now: () => new Date("2026-08-11T00:00:00.000Z"),
        logger: { warn() {}, error() {} },
      });

      assert.deepEqual(result, { accounts: [{ accountId: "acct_1", ok: true, pages: 1, error: null }] });
      assert.deepEqual(calls, ["watch", "list"]);
      const cursor = sqlite.query("select sync_history_id, watch_topic, last_synced_at from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string; watch_topic: string; last_synced_at: number };
      assert.equal(cursor.sync_history_id, "100");
      assert.equal(cursor.watch_topic, config.topicName);
      assert.ok(cursor.last_synced_at > 0);
    } finally {
      sqlite.close();
    }
  });

  test("continues to use the periodic fallback when Pub/Sub is not configured", async () => {
    setAuthEnv();
    const { db, sqlite, path } = createMigratedClient();
    const noPushConfig = { ...config, topicName: null };
    let listed = false;
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { listed = true; return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });

      const result = await runGmailPeriodicSync({ dbFactory: () => createDatabaseClient(path), gmailClient, config: noPushConfig, now: () => new Date("2026-08-11T00:00:00.000Z"), logger: { warn() {}, error() {} } });
      assert.equal(result.accounts[0]?.ok, true);
      assert.equal(listed, true);
    } finally {
      sqlite.close();
    }
  });

  test("full-backfills an existing account when its first push watch is established", async () => {
    setAuthEnv();
    const { db, sqlite, path } = createMigratedClient();
    const sinceValues: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage() {
        return {
          id: "legacy-message",
          threadId: "legacy-thread",
          labelIds: ["INBOX"],
          internalDate: "1783512000000",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Maya <maya@example.com>" },
              { name: "To", value: "Luke <luke@example.com>" },
              { name: "Subject", value: "Legacy migration" },
            ],
            body: { data: Buffer.from("Legacy migration").toString("base64") },
          },
        };
      },
      async listInboxMessagePage({ since }) {
        sinceValues.push(since.toISOString());
        return { messageIds: ["legacy-message"], nextCursor: null };
      },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async watch() { return { historyId: "200", expiration: "1800000000000" }; },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
        lastSyncedAt: new Date("2026-08-04T00:00:00.000Z"),
      }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });

      const result = await runGmailPeriodicSync({
        dbFactory: () => createDatabaseClient(path),
        gmailClient,
        config,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
        logger: { warn() {}, error() {} },
      });

      assert.equal(result.accounts[0]?.ok, true);
      assert.deepEqual(sinceValues, ["1970-01-01T00:00:00.000Z"]);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string }).sync_history_id, "200");
    } finally {
      sqlite.close();
    }
  });

  test("keeps polling but reports and persists failure when watch setup fails", async () => {
    setAuthEnv();
    const { db, sqlite, path } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { calls.push("list"); return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async watch() { calls.push("watch"); throw new Error("topic is unavailable"); },
    };

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });

      const result = await runGmailPeriodicSync({ dbFactory: () => createDatabaseClient(path), gmailClient, config, now: () => new Date("2026-08-11T00:00:00.000Z"), logger: { warn() {}, error() {} } });
      assert.deepEqual(result.accounts[0], { accountId: "acct_1", ok: false, pages: 1, error: "topic is unavailable" });
      assert.deepEqual(calls, ["watch", "list"]);
      const job = sqlite.query("select state, pending_sources, last_error from gmail_sync_jobs where account_id = 'acct_1'").get() as {
        state: string;
        pending_sources: number;
        last_error: string | null;
      };
      assert.deepEqual(job, { state: "queued", pending_sources: 4, last_error: "topic is unavailable" });
      const run = sqlite.query("select status, page_count, db_prepare_count, error from gmail_sync_runs where account_id = 'acct_1'").get() as {
        status: string;
        page_count: number;
        db_prepare_count: number;
        error: string | null;
      };
      assert.equal(run.status, "failed");
      assert.equal(run.page_count, 1);
      assert.ok(run.db_prepare_count > 0);
      assert.equal(run.error, "topic is unavailable");
    } finally {
      sqlite.close();
    }
  });
});
