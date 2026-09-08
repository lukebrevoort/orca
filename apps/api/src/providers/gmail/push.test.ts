import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, oauthAccounts, organizationRules, organizationEvaluationTraces, threads, users } from "../../db/schema.ts";
import { createSqliteRuleRevisionRepository } from "../../organization/rules/sqlite-repository.ts";
import { createRuleRevisionService } from "../../organization/rules/service.ts";
import type { GmailClient } from "./client.ts";
import {
  ensureGmailWatch,
  parseGmailPubSubNotification,
  verifyGmailPushToken,
  syncGmailAccountHistory,
  watchGmailAccount,
} from "./push.ts";
import type { GmailPushConfig } from "./push-config.ts";
import { GmailApiError } from "./client.ts";
import type { GmailMessage } from "./types.ts";

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

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-push-"));
  tempDirs.push(tempDir);
  const client = createDatabaseClient(join(tempDir, "push.sqlite"));
  migrate(client.db, { migrationsFolder });
  return client;
}

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
}

function createMessage(id: string): GmailMessage {
  return {
    id,
    threadId: "thread-1",
    internalDate: "1783512000000",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Push message",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Maya Chen <maya@example.com>" },
        { name: "To", value: "Luke Brevoort <luke@example.com>" },
        { name: "Subject", value: "Push message" },
      ],
      body: { data: Buffer.from("Push message body").toString("base64") },
    },
  };
}

function insertAccount(db: ReturnType<typeof createDatabaseClient>["db"], input: { historyId?: string | null; lastSyncedAt?: Date | null } = {}) {
  db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
  db.insert(oauthAccounts).values({
    id: "acct_1",
    userId: "user_1",
    provider: "gmail",
    providerEmail: "luke@example.com",
    providerId: "gmail-user-1",
    syncHistoryId: input.historyId,
    lastSyncedAt: input.lastSyncedAt,
  }).run();
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Gmail push sync", () => {
  test("stores watch history and renews only when the watch is close to expiry", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async watch(_token, topicName) {
        calls.push(topicName);
        return { historyId: "123", expiration: "1800000000000" };
      },
    };

    try {
      insertAccount(db);
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: new Date("2026-08-12T00:00:00.000Z"),
      });

      const now = new Date("2026-08-11T00:00:00.000Z");
      const first = await watchGmailAccount(db, { accountId: "acct_1", gmailClient, config, now });
      const second = await ensureGmailWatch(db, { accountId: "acct_1", gmailClient, config, now });

      assert.equal(first.historyId, "123");
      assert.deepEqual(second, first);
      assert.deepEqual(calls, ["projects/orca/topics/gmail"]);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "123");
    } finally {
      sqlite.close();
    }
  });

  test("drains pending history before replacing the cursor during watch renewal", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const calls: string[] = [];
    const gmailClient: GmailClient = {
      async getMessage(_token, messageId) {
        calls.push(`message:${messageId}`);
        return createMessage(messageId);
      },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() {
        calls.push("labels");
        return [{ id: "INBOX", name: "Inbox" }];
      },
      async listHistory(input) {
        calls.push(`history:${input.startHistoryId}`);
        return { messageIds: ["pending-message"], deletedMessageIds: [], nextCursor: null, historyId: "150" };
      },
      async watch() {
        calls.push("watch");
        return { historyId: "150", expiration: "1800000000000" };
      },
    };

    try {
      insertAccount(db, { historyId: "100", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      db.update(oauthAccounts).set({
        watchTopic: config.topicName,
        watchExpirationAt: new Date("2026-08-11T00:00:30.000Z"),
      }).where(eq(oauthAccounts.id, "acct_1")).run();
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await ensureGmailWatch(db, {
        accountId: "acct_1",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.equal(result?.historyId, "150");
      assert.deepEqual(calls, ["watch", "history:100", "message:pending-message", "message:pending-message", "labels"]);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "150");
      assert.equal((sqlite.query("select count(*) as count from emails where provider_message_id = 'pending-message'").get() as { count: number }).count, 1);
    } finally {
      sqlite.close();
    }
  });

  test("records freshness when an incremental notification is already at the stored cursor", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async listHistory() { throw new Error("already-current history must not be fetched"); },
    };

    try {
      insertAccount(db, { historyId: "100", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await syncGmailAccountHistory(db, {
        accountId: "acct_1",
        historyId: "100",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.equal(result.usedBackfill, false);
      assert.deepEqual(
        sqlite.query("select sync_history_id, last_synced_at from oauth_accounts where id = 'acct_1'").get(),
        { sync_history_id: "100", last_synced_at: Date.parse("2026-08-11T00:00:00.000Z") },
      );
    } finally {
      sqlite.close();
    }
  });

  test("advances the cursor when a changed message disappears before fetch", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage() { throw new GmailApiError("message no longer exists", 404); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async listHistory() {
        return { messageIds: ["gone-message"], deletedMessageIds: [], nextCursor: null, historyId: "120" };
      },
    };

    try {
      insertAccount(db, { historyId: "100", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await syncGmailAccountHistory(db, {
        accountId: "acct_1",
        historyId: "120",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.equal(result.deletedEmailCount, 0);
      assert.equal(result.historyId, "120");
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "120");
    } finally {
      sqlite.close();
    }
  });

  test("syncs history changes and advances the cursor only after message persistence", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage(_token, messageId) { return createMessage(messageId); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async listHistory() {
        return { messageIds: ["message-1"], deletedMessageIds: [], nextCursor: null, historyId: "110" };
      },
    };

    try {
      insertAccount(db, { historyId: "100", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await syncGmailAccountHistory(db, {
        accountId: "acct_1",
        historyId: "105",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.deepEqual(result, {
        accountId: "acct_1",
        historyId: "110",
        emailCount: 1,
        deletedEmailCount: 0,
        threadCount: 1,
        labelCount: 2,
        contactCount: 2,
        usedBackfill: false,
        lastSyncedAt: "2026-08-11T00:00:00.000Z",
      });
      assert.equal((sqlite.query("select count(*) as count from emails where provider_message_id = 'message-1'").get() as { count: number }).count, 1);
      assert.deepEqual(
        sqlite.query("select sync_history_id, last_synced_at from oauth_accounts where id = 'acct_1'").get(),
        {
          sync_history_id: "110",
          last_synced_at: Date.parse("2026-08-11T00:00:00.000Z"),
        },
      );
    } finally {
      sqlite.close();
    }
  });

  test("backfills existing messages when the first push arrives without a stored history cursor", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage(_token, messageId) { return createMessage(messageId); },
      async listInboxMessagePage() { return { messageIds: ["existing-message"], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
    };

    try {
      insertAccount(db);
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await syncGmailAccountHistory(db, {
        accountId: "acct_1",
        historyId: "200",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.equal(result.usedBackfill, true);
      assert.equal(result.emailCount, 1);
      assert.equal((sqlite.query("select sync_history_id from oauth_accounts where id = 'acct_1'").get() as { sync_history_id: string | null }).sync_history_id, "200");
      assert.equal((sqlite.query("select count(*) as count from emails").get() as { count: number }).count, 1);
    } finally {
      sqlite.close();
    }
  });

  test("falls back to an existing-message backfill when Gmail history has expired", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage(_token, messageId) { return createMessage(messageId); },
      async listInboxMessagePage() { return { messageIds: ["recovered-message"], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
      async listHistory() { throw new GmailApiError("history expired", 404); },
    };

    try {
      insertAccount(db, { historyId: "1", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiry: null,
      });

      const result = await syncGmailAccountHistory(db, {
        accountId: "acct_1",
        historyId: "300",
        gmailClient,
        config,
        now: new Date("2026-08-11T00:00:00.000Z"),
      });

      assert.equal(result.usedBackfill, true);
      assert.equal(result.emailCount, 1);
      assert.deepEqual(
        sqlite.query("select sync_history_id, last_synced_at from oauth_accounts where id = 'acct_1'").get(),
        {
          sync_history_id: "300",
          last_synced_at: Date.parse("2026-08-11T00:00:00.000Z"),
        },
      );
    } finally {
      sqlite.close();
    }
  });

  test("removes deleted history messages and empty local threads", async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage() { throw new Error("not used"); },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() { return []; },
      async listHistory() { return { messageIds: [], deletedMessageIds: ["deleted-message"], nextCursor: null, historyId: "20" }; },
    };

    try {
      insertAccount(db, { historyId: "10", lastSyncedAt: new Date("2026-08-10T00:00:00.000Z") });
      db.insert(threads).values({ id: "gmail:acct_1:thread-1", accountId: "acct_1", providerThreadId: "thread-1", messageCount: 1 }).run();
      db.insert(emails).values({ id: "gmail:acct_1:deleted-message", accountId: "acct_1", threadId: "gmail:acct_1:thread-1", providerMessageId: "deleted-message", subject: "Gone" }).run();
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "access-token", refreshToken: "refresh-token", tokenExpiry: null });

      const result = await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "20", gmailClient, config, now: new Date("2026-08-11T00:00:00.000Z") });

      assert.equal(result.deletedEmailCount, 1);
      assert.equal((sqlite.query("select count(*) as count from emails").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("select count(*) as count from threads").get() as { count: number }).count, 0);
    } finally {
      sqlite.close();
    }
  });

  test("requires a verified Pub/Sub token and parses the Gmail notification envelope", () => {
    const encoded = Buffer.from(JSON.stringify({ emailAddress: "Luke@Example.com", historyId: "42" })).toString("base64url");
    const body = { message: { data: encoded } };
    const request = new Request("https://orca.example/v1/webhooks/gmail?token=push-secret", { method: "POST" });

    assert.deepEqual(parseGmailPubSubNotification(body), { emailAddress: "luke@example.com", historyId: "42" });
    assert.equal(verifyGmailPushToken(request, config), true);
    assert.equal(verifyGmailPushToken(new Request("https://orca.example/v1/webhooks/gmail?token=wrong"), config), false);
    assert.equal(parseGmailPubSubNotification({ message: { data: "not-json" } }), null);
  });
});

test("history persists bounded batches in global date/id order and counts distinct identities", { timeout: 15_000 }, async () => {
  setAuthEnv();
  const { db, sqlite } = createMigratedClient();
  try {
    insertAccount(db, { historyId: "100" });
    await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "test", refreshToken: "test", tokenExpiry: null });
    const service = createRuleRevisionService(createSqliteRuleRevisionRepository(db));
    const compiled = service.compile({ actor: { id: "user_1", type: "human" }, workspaceId: "user_1", request: {
      idempotencyKey: "bounded-history", expectedRuleRevision: null, workspaceSchemaRevision: 1,
      source: `orca 1
rule "History boundary"
event thread.updated
predicate count = thread.message_count equals 26
when count
action notify immediate
because "Observe the first event of the second batch"`,
    } });
    assert.equal(compiled.ok, true);
    if (!compiled.ok) throw new Error("Rule compilation failed");
    db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
    const ids = Array.from({ length: 61 }, (_, i) => `bounded-${String(i).padStart(3, "0")}`);
    const fetched: string[] = [];
    let metadataInFlight = 0;
    let maxMetadataInFlight = 0;
    const message = (id: string) => ({ ...createMessage(id), internalDate: id === ids[0] ? undefined : id === ids[1] ? "2026-07-08T12:00:00.000Z" : String(1783512000000 + Math.floor(Number(id.slice(-3)) / 2)) });
    const gmailClient: GmailClient & { getMessageMetadata: GmailClient["getMessage"] } = {
      async getMessageMetadata(_token, id) {
        metadataInFlight++;
        maxMetadataInFlight = Math.max(maxMetadataInFlight, metadataInFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        metadataInFlight--;
        const m = message(id);
        return { id, threadId: m.threadId, internalDate: m.internalDate };
      },
      async getMessage(_token, id) {
        if (fetched.length === 60) assert.ok(db.select().from(emails).all().length > 0, "persist before final body fetch");
        fetched.push(id);
        return message(id);
      },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }, { id: "unused", name: "Unused" }]; },
      async listInboxMessagePage() { throw new Error("unexpected backfill"); },
      async listHistory({ cursor }) {
        return { messageIds: cursor ? ids.slice(0, 30).reverse() : ids.slice(30).reverse(), deletedMessageIds: [], nextCursor: cursor ? null : "page2", historyId: "200" };
      },
    };
    const providerDurations: number[] = [];
    const result = await syncGmailAccountHistory(db, {
      accountId: "acct_1", historyId: "200", gmailClient,
      metrics: { recordProviderFetch(ms) { providerDurations.push(ms); }, recordDbWrite() {} },
    });
    // Two history pages, 61 metadata reads, 61 body reads and one label list.
    assert.equal(providerDurations.length, 125);
    assert.ok(providerDurations.every((ms) => Number.isFinite(ms) && ms >= 0));
    assert.deepEqual(fetched, ids);
    assert.ok(maxMetadataInFlight > 1 && maxMetadataInFlight <= 5);
    const traces = db.select().from(organizationEvaluationTraces).all();
    assert.equal(traces.length, 61);
    for (let index = 1; index < ids.length; index++) {
      const trace = traces.find((row) => row.eventId === `thread.updated:gmail:acct_1:${ids[index]}`);
      assert.ok(trace);
      const observed = JSON.parse(trace.traceJson).observedValues.find((value: { field: string }) => value.field === "thread.message_count");
      assert.equal(observed.value, index + 1);
    }
    assert.equal(result.emailCount, 61);
    assert.equal(result.threadCount, 1);
    assert.equal(result.contactCount, 2);
    assert.equal(result.labelCount, 3);
    assert.equal(db.select().from(oauthAccounts).get()?.syncHistoryId, "200");
    // Simulate losing the final checkpoint after all row/rule transactions.
    db.update(oauthAccounts).set({ syncHistoryId: "100" }).run();
    await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "200", gmailClient });
    assert.equal(db.select().from(organizationEvaluationTraces).all().length, 61);
    assert.equal(db.select().from(emails).all().length, 61);
  } finally { sqlite.close(); }
});

for (const failure of ["provider", "lease", "ordering"] as const) {
  test(`history ${failure} failure after a committed batch preserves cursor and replays idempotently`, async () => {
    setAuthEnv();
    const { db, sqlite } = createMigratedClient();
    try {
      insertAccount(db, { historyId: "100" });
      await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "test", refreshToken: "test", tokenExpiry: null });
      const ids = Array.from({ length: 55 }, (_, i) => `replay-${String(i).padStart(3, "0")}`);
      let fail = true;
      let lostLease = false;
      const gmailClient: GmailClient = {
        async getMessageMetadata(_token, id) { return { id, threadId: "thread-1", internalDate: "1783512000000" }; },
        async getMessage(_token, id) {
          if (fail && id === ids[30]) {
            if (failure === "provider") throw new GmailApiError("synthetic failure", 500);
            if (failure === "lease") lostLease = true;
            if (failure === "ordering") return { ...createMessage(id), internalDate: "1783512000001" };
          }
          return createMessage(id);
        },
        async listLabels() { return []; },
        async listInboxMessagePage() { throw new Error("unexpected backfill"); },
        async listHistory() { return { messageIds: ids, deletedMessageIds: [], nextCursor: null, historyId: "200" }; },
      };
      const leaseGuard = { accountId: "acct_1", owner: "test", version: 1, renew: () => true, assert() { if (lostLease) throw new Error("synthetic lease lost"); } };
      await assert.rejects(() => syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "200", gmailClient, leaseGuard }));
      assert.equal(db.select().from(oauthAccounts).get()?.syncHistoryId, "100");
      assert.equal(db.select().from(emails).all().length, 25);
      const firstRow = db.select().from(emails).where(eq(emails.providerMessageId, ids[0]!)).get()!;
      fail = false;
      lostLease = false;
      const result = await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "200", gmailClient, leaseGuard });
      assert.equal(result.emailCount, 55);
      assert.equal(result.threadCount, 1);
      assert.equal(result.contactCount, 2);
      assert.equal(db.select().from(emails).all().length, 55);
      assert.equal(db.select().from(threads).get()?.messageCount, 55);
      assert.equal(db.select().from(emails).where(eq(emails.providerMessageId, ids[0]!)).get()?.updatedAt.getTime(), firstRow.updatedAt.getTime());
      assert.equal(db.select().from(oauthAccounts).get()?.syncHistoryId, "200");
    } finally { sqlite.close(); }
  });
}

test("history byte budget flushes large bodies before the count limit", async () => {
  setAuthEnv();
  const { db, sqlite } = createMigratedClient();
  try {
    insertAccount(db, { historyId: "100" });
    await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "test", refreshToken: "test", tokenExpiry: null });
    const gmailClient: GmailClient = {
      async getMessageMetadata(_token, id) { return { id, threadId: "thread-1", internalDate: "1783512000000" }; },
      async getMessage(_token, id) {
        if (id === "large-3") assert.equal(db.select({ id: emails.id }).from(emails).all().length, 1);
        const message = createMessage(id);
        message.payload!.body = { data: Buffer.alloc(1_800_000, "a").toString("base64") };
        return message;
      },
      async listLabels() { return []; },
      async listInboxMessagePage() { throw new Error("unexpected backfill"); },
      async listHistory() { return { messageIds: ["large-1", "large-2", "large-3"], deletedMessageIds: [], nextCursor: null, historyId: "200" }; },
    };
    const result = await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "200", gmailClient });
    assert.equal(result.emailCount, 3);
  } finally { sqlite.close(); }
});

test("history reconciles pages and metadata/body 404s, deletes in bounded fenced batches, and replays after lease loss", async () => {
  setAuthEnv();
  const { db, sqlite } = createMigratedClient();
  try {
    insertAccount(db, { historyId: "100" });
    await storeProviderTokens(db, { oauthAccountId: "acct_1", accessToken: "test", refreshToken: "test", tokenExpiry: null });
    const ids = Array.from({ length: 62 }, (_, i) => `delete-${String(i).padStart(3, "0")}`);
    let deleting = false;
    const gmailClient: GmailClient = {
      async getMessageMetadata(_token, id) {
        if (deleting && id === ids[59]) throw new GmailApiError("missing metadata", 404);
        return { id, threadId: id, internalDate: "1783512000000" };
      },
      async getMessage(_token, id) {
        if (deleting && id === ids[60]) throw new GmailApiError("missing body", 404);
        return { ...createMessage(id), threadId: id };
      },
      async listLabels() { return []; },
      async listInboxMessagePage() { throw new Error("unexpected backfill"); },
      async listHistory({ cursor }) {
        if (!deleting) return { messageIds: ids, deletedMessageIds: [], nextCursor: null, historyId: "200" };
        return cursor
          ? { messageIds: [ids[61]!], deletedMessageIds: [ids[0]!], nextCursor: null, historyId: "300" }
          : { messageIds: [ids[0]!, ids[59]!, ids[60]!], deletedMessageIds: [...ids.slice(1, 59), ids[61]!], nextCursor: "p2", historyId: "300" };
      },
    };
    await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "200", gmailClient });
    deleting = true;
    const leaseGuard = { accountId: "acct_1", owner: "test", version: 1, renew: () => true, assert() {
      if (db.select({ id: emails.id }).from(emails).all().length < 62) throw new Error("lease lost after first deletion batch");
    } };
    await assert.rejects(() => syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "300", gmailClient, leaseGuard }));
    assert.equal(db.select().from(oauthAccounts).get()?.syncHistoryId, "200");
    assert.equal(db.select({ id: emails.id }).from(emails).all().length, 37);
    const result = await syncGmailAccountHistory(db, { accountId: "acct_1", historyId: "300", gmailClient });
    assert.equal(result.deletedEmailCount, 36);
    assert.equal(result.emailCount, 1);
    assert.deepEqual(db.select({ id: emails.providerMessageId }).from(emails).all(), [{ id: ids[61] }]);
    assert.equal(db.select().from(threads).all().length, 1);
    assert.equal(db.select().from(oauthAccounts).get()?.syncHistoryId, "300");
  } finally { sqlite.close(); }
});
