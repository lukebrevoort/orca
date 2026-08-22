import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import type { GmailClient } from "../../providers/gmail/client.ts";
import { syncGmailAccountHistory } from "../../providers/gmail/push.ts";
import type { GmailPushConfig } from "../../providers/gmail/push-config.ts";
import { syncGmailAccountPage } from "../../providers/gmail/sync.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const pushConfig: GmailPushConfig = {
  topicName: "projects/orca/topics/gmail",
  verificationToken: "push-secret",
  syncIntervalMs: 60_000,
  watchRenewalWindowMs: 60_000,
  backfillPageSize: 25,
  backfillMaxPages: 20,
};

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Gmail propagation boundary", () => {
  test("a duplicate history push creates one event and performs no provider write", async () => {
    const { db, sqlite } = createMigratedClient();
    const reads: string[] = [];
    const message = testFlightMessage("message-push-1");
    const client: GmailClient = {
      async getMessage(_token, messageId) {
        reads.push(`get:${messageId}`);
        return message;
      },
      async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
      async listLabels() {
        reads.push("labels");
        return [{ id: "INBOX", name: "Inbox" }, { id: "CATEGORY_UPDATES", name: "Updates" }];
      },
      async listHistory() {
        reads.push("history");
        return {
          messageIds: [message.id],
          deletedMessageIds: [],
          nextCursor: null,
          historyId: "110",
        };
      },
    };

    try {
      await insertAccount(db, { syncHistoryId: "100" });
      const propagation = { enabled: true, logger: quietLogger };
      await syncGmailAccountHistory(db, {
        accountId: "account_1",
        historyId: "105",
        gmailClient: client,
        config: pushConfig,
        now: new Date("2026-08-19T16:00:01.000Z"),
        propagation,
      });
      await syncGmailAccountHistory(db, {
        accountId: "account_1",
        historyId: "105",
        gmailClient: client,
        config: pushConfig,
        now: new Date("2026-08-19T16:01:00.000Z"),
        propagation,
      });

      const rows = sqlite.query(
        "select trigger, event_kind, revision, provider_message_id from agent_events",
      ).all() as Array<{
        trigger: string;
        event_kind: string;
        revision: number;
        provider_message_id: string;
      }>;
      assert.deepEqual(rows, [{
        trigger: "push",
        event_kind: "release_available",
        revision: 1,
        provider_message_id: "message-push-1",
      }]);
      assert.deepEqual(reads, ["history", "get:message-push-1", "labels"]);
    } finally {
      sqlite.close();
    }
  });

  test("a propagation write failure cannot fail sync or lose normalized mail", async () => {
    const { db, sqlite } = createMigratedClient();
    const message = testFlightMessage("message-sync-1", "BODY_PRIVATE_MARKER");
    const logs: unknown[][] = [];
    const client: GmailClient = {
      async getMessage() { return message; },
      async listInboxMessagePage() { return { messageIds: [message.id], nextCursor: null }; },
      async listLabels() { return [{ id: "INBOX", name: "Inbox" }]; },
    };

    try {
      await insertAccount(db);
      const result = await syncGmailAccountPage(db, {
        accountId: "account_1",
        gmailClient: client,
        now: new Date("2026-08-19T16:00:01.000Z"),
        propagation: {
          enabled: true,
          store: {
            async upsert() {
              throw new Error("STORE_PRIVATE_MARKER");
            },
          },
          logger: {
            info(...args) { logs.push(args); },
            warn(...args) { logs.push(args); },
            error(...args) { logs.push(args); },
          },
        },
      });

      assert.equal(result.emailCount, 1);
      assert.equal(
        (sqlite.query("select count(*) as count from emails").get() as { count: number }).count,
        1,
      );
      assert.equal(
        (sqlite.query("select count(*) as count from agent_events").get() as { count: number }).count,
        0,
      );
      const serializedLogs = JSON.stringify(logs);
      assert.equal(serializedLogs.includes("BODY_PRIVATE_MARKER"), false);
      assert.equal(serializedLogs.includes("STORE_PRIVATE_MARKER"), false);
      assert.match(serializedLogs, /normalized mail remains stored/);
    } finally {
      sqlite.close();
    }
  });
});

const quietLogger = { info() {}, warn() {}, error() {} };

function createMigratedClient() {
  const directory = mkdtempSync(join(tmpdir(), "orca-propagation-gmail-"));
  tempDirs.push(directory);
  const client = createDatabaseClient(join(directory, "gmail.sqlite"));
  migrate(client.db, { migrationsFolder });
  return client;
}

async function insertAccount(
  db: ReturnType<typeof createDatabaseClient>["db"],
  input: { syncHistoryId?: string | null } = {},
) {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
  db.insert(oauthAccounts).values({
    id: "account_1",
    userId: "user_1",
    provider: "gmail",
    providerEmail: "luke@example.com",
    providerId: "gmail-user-1",
    syncHistoryId: input.syncHistoryId,
  }).run();
  await storeProviderTokens(db, {
    oauthAccountId: "account_1",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: null,
  });
}

function testFlightMessage(id: string, body = "A new beta build is available to test."): GmailMessage {
  return {
    id,
    threadId: "testflight-thread",
    internalDate: "1787155200000",
    labelIds: ["INBOX", "CATEGORY_UPDATES"],
    snippet: "Orca 2.1 (42) is ready to test",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "TestFlight <no_reply@email.apple.com>" },
        { name: "To", value: "Luke <luke@example.com>" },
        { name: "Subject", value: "Orca 2.1 (42) is ready to test" },
        { name: "Auto-Submitted", value: "auto-generated" },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}
