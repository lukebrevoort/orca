import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import type { GmailClient } from "./client.ts";
import type { GmailPushConfig } from "./push-config.ts";
import {
  createGmailSyncCoordinator,
  GmailSyncLeaseLostError,
} from "./sync-coordinator.ts";
import { createDefaultGmailSyncCoordinator } from "./sync-runtime.ts";

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];
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
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}

async function setup() {
  setAuthEnv();
  const directory = mkdtempSync(join(tmpdir(), "orca-sync-runtime-"));
  directories.push(directory);
  const path = join(directory, "runtime.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder });
  client.db.insert(users).values({ id: "user", email: "user@example.com" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account",
    userId: "user",
    provider: "gmail",
    providerEmail: "user@example.com",
    providerId: "provider-user",
    syncHistoryId: "10",
    lastSyncedAt: new Date("2026-08-10T00:00:00.000Z"),
    watchExpirationAt: new Date("2026-08-10T00:00:00.000Z"),
    watchTopic: config.topicName,
  }).run();
  await storeProviderTokens(client.db, {
    oauthAccountId: "account",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: null,
  });
  return { ...client, path, dbFactory: () => createDatabaseClient(path) };
}

function gmailClient(calls: string[]): GmailClient {
  return {
    async getMessage() { throw new Error("not used"); },
    async listInboxMessagePage() {
      calls.push("inbox");
      return { messageIds: [], nextCursor: null };
    },
    async listLabels() { return []; },
    async listHistory() {
      calls.push("history");
      return { messageIds: [], deletedMessageIds: [], nextCursor: null, historyId: "11" };
    },
    async watch() {
      calls.push("watch");
      return { historyId: "11", expiration: "1800000000000" };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

test("combined queued push and fallback runs history then renews the Gmail watch", async () => {
  const { sqlite, dbFactory } = await setup();
  const calls: string[] = [];
  const coordinator = createDefaultGmailSyncCoordinator({
    dbFactory,
    gmailClient: gmailClient(calls),
    config,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
  });
  try {
    coordinator.enqueue({ accountId: "account", source: "push", historyId: "11" });
    coordinator.enqueue({ accountId: "account", source: "fallback" });

    const result = await coordinator.drainAccount("account");

    assert.equal(result.completed, true);
    assert.equal(result.runs, 1);
    assert.deepEqual(calls, ["history", "watch"]);
    assert.equal((result.result?.watch as { historyId?: string } | undefined)?.historyId, "11");
  } finally {
    sqlite.close();
  }
});

test("persists a combined history success and watch failure as a retryable partial failure", async () => {
  const { sqlite, dbFactory } = await setup();
  const calls: string[] = [];
  const client = gmailClient(calls);
  let watchAttempts = 0;
  client.watch = async () => {
    calls.push("watch");
    watchAttempts += 1;
    if (watchAttempts === 1) throw new Error("watch topic is unavailable");
    return { historyId: "11", expiration: "1800000000000" };
  };
  let clock = new Date("2026-08-11T00:00:00.000Z");
  const coordinator = createDefaultGmailSyncCoordinator({
    dbFactory,
    gmailClient: client,
    config,
    now: () => clock,
  });
  try {
    coordinator.enqueue({ accountId: "account", source: "push", historyId: "11" });
    coordinator.enqueue({ accountId: "account", source: "fallback" });

    const result = await coordinator.drainAccount("account");

    assert.equal(result.completed, false);
    assert.equal((result.error as Error | null)?.message, "watch topic is unavailable");
    assert.deepEqual(calls, ["history", "watch"]);
    assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'account'").get() as { sync_history_id: string }).sync_history_id, "11");
    const job = sqlite.query("select state, pending_sources, pending_history_id, last_error from gmail_sync_jobs where account_id = 'account'").get() as {
      state: string;
      pending_sources: number;
      pending_history_id: string | null;
      last_error: string | null;
    };
    assert.deepEqual(job, {
      state: "queued",
      pending_sources: 4,
      pending_history_id: null,
      last_error: "watch topic is unavailable",
    });
    const run = sqlite.query("select status, sources, history_id, db_prepare_count, error from gmail_sync_runs where account_id = 'account'").get() as {
      status: string;
      sources: number;
      history_id: string | null;
      db_prepare_count: number;
      error: string | null;
    };
    assert.equal(run.status, "failed");
    assert.equal(run.sources, 5);
    assert.equal(run.history_id, "11");
    assert.ok(run.db_prepare_count > 0);
    assert.equal(run.error, "watch topic is unavailable");

    clock = new Date(clock.getTime() + 1_000);
    const retried = await coordinator.drainAccount("account");
    assert.equal(retried.completed, true);
    assert.deepEqual(calls, ["history", "watch", "watch", "inbox"]);
    const runs = sqlite.query("select status, sources, history_id from gmail_sync_runs where account_id = 'account' order by finished_at, lease_version").all() as Array<{
      status: string;
      sources: number;
      history_id: string | null;
    }>;
    assert.deepEqual(runs, [
      { status: "failed", sources: 5, history_id: "11" },
      { status: "succeeded", sources: 4, history_id: null },
    ]);
  } finally {
    sqlite.close();
  }
});

test("stale takeover runs recovered push history and fallback watch through the default runtime", async () => {
  const { sqlite, dbFactory } = await setup();
  const calls: string[] = [];
  const started = deferred<void>();
  const release = deferred<void>();
  let clock = new Date("2026-08-11T00:00:00.000Z");
  const crashed = createGmailSyncCoordinator({
    dbFactory,
    ownerId: "crashed-process",
    leaseMs: 1_000,
    now: () => clock,
    worker: async () => {
      started.resolve();
      await release.promise;
      return {};
    },
  });
  const recovery = createDefaultGmailSyncCoordinator({
    dbFactory,
    gmailClient: gmailClient(calls),
    config,
    now: () => clock,
    ownerId: "recovery-process",
  });
  let staleDrain: ReturnType<typeof crashed.drainAccount> | null = null;
  try {
    crashed.enqueue({ accountId: "account", source: "push", historyId: "11" });
    staleDrain = crashed.drainAccount("account");
    await started.promise;
    recovery.enqueue({ accountId: "account", source: "fallback" });
    clock = new Date(clock.getTime() + 2_000);

    const recovered = await recovery.drainAccount("account");

    assert.equal(recovered.completed, true);
    assert.equal(recovered.runs, 1);
    assert.deepEqual(calls, ["history", "watch"]);
    assert.equal((recovered.result?.watch as { historyId?: string } | undefined)?.historyId, "11");
    release.resolve();
    const stale = await staleDrain;
    assert.equal(stale.completed, false);
    assert.ok(stale.error instanceof GmailSyncLeaseLostError);
  } finally {
    release.resolve();
    if (staleDrain) await staleDrain;
    sqlite.close();
  }
});
