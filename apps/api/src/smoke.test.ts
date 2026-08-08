import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { emailLabels, emails, labels, oauthAccounts, threads, users } from "./db/schema.ts";
import { createApp } from "./index.ts";

const tempDirs: string[] = [];

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
}

function createSmokeDatabase() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-api-smoke-"));
  tempDirs.push(tempDir);
  const databasePath = join(tempDir, "smoke.sqlite");
  const client = createDatabaseClient(databasePath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  return { ...client, databasePath };
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("first-slice API smoke test", () => {
  test("authenticates a seeded user, triggers Gmail sync, and returns their inbox", async () => {
    setAuthEnv();
    const { db, sqlite, databasePath } = createSmokeDatabase();

    try {
      const syncedAt = new Date("2026-07-08T12:00:00.000Z");
      db.insert(users).values({ id: "user_smoke", email: "luke@example.com", displayName: "Luke" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_smoke", userId: "user_smoke", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-smoke", lastSyncedAt: syncedAt,
      }).run();
      db.insert(threads).values({
        id: "thread_smoke", accountId: "acct_smoke", providerThreadId: "thread-smoke", subject: "Smoke coverage", latestReceivedAt: syncedAt, messageCount: 1, isRead: false,
      }).run();
      db.insert(emails).values({
        id: "email_smoke", accountId: "acct_smoke", threadId: "thread_smoke", providerMessageId: "message-smoke", fromAddress: "maya@example.com", fromName: "Maya Chen", subject: "Smoke coverage", snippet: "A seeded inbox message", receivedAt: syncedAt, internalDate: syncedAt, isRead: false,
      }).run();
      db.insert(labels).values({ id: "label_smoke", accountId: "acct_smoke", providerLabelId: "INBOX", name: "Inbox", type: "system" }).run();
      db.insert(emailLabels).values({ id: "email_label_smoke", emailId: "email_smoke", labelId: "label_smoke" }).run();

      const session = await createSession(db, "user_smoke");
      const syncCalls: string[] = [];
      const api = createApp({
        dbFactory: () => createDatabaseClient(databasePath),
        syncPage: async (_db, input) => {
          syncCalls.push(input.accountId);
          return { accountId: input.accountId, emailCount: 0, threadCount: 0, labelCount: 0, contactCount: 0, nextCursor: null, lastSyncedAt: syncedAt.toISOString() };
        },
      });
      const headers = { cookie: `orca_session=${session.token}` };

      const sessionResponse = await api.request("/v1/auth/session", { headers });
      assert.equal(sessionResponse.status, 200);
      assert.deepEqual(await sessionResponse.json(), {
        isAuthenticated: true,
        user: { id: "user_smoke", email: "luke@example.com", name: "Luke" },
        expiresAt: session.expiresAt.toISOString(),
        onboardingCompletedAt: null,
      });

      const syncResponse = await api.request("/v1/sync/gmail", { method: "POST", headers });
      assert.equal(syncResponse.status, 200);
      assert.deepEqual(syncCalls, ["acct_smoke"]);

      const inboxResponse = await api.request("/v1/inbox", { headers });
      assert.equal(inboxResponse.status, 200);
      const inbox = await inboxResponse.json();
      assert.equal(inbox.account.email, "luke@example.com");
      assert.deepEqual(inbox.messages, [{
        id: "email_smoke", provider: "gmail", providerMessageId: "message-smoke", threadId: "thread_smoke",
        from: { name: "Maya Chen", email: "maya@example.com" }, subject: "Smoke coverage", snippet: "A seeded inbox message",
        receivedAt: syncedAt.toISOString(), unread: true, labels: ["Inbox"], attentionBehavior: "normal", humanSignal: null,
      }]);
      assert.deepEqual(inbox.counts, { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 });
    } finally {
      sqlite.close();
    }
  });
});
