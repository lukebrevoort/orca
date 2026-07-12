import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { syncGmailAccountPage } from "./sync.ts";
import type { GmailClient } from "./client.ts";
import type { GmailLabel, GmailMessage } from "./types.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
}

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-sync-"));
  tempDirs.push(tempDir);
  const databasePath = join(tempDir, "sync.sqlite");
  const client = createDatabaseClient(databasePath);

  migrate(client.db, { migrationsFolder });

  return client;
}

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("syncGmailAccountPage", () => {
  test("persists paginated Gmail inbox data and remains safe to rerun", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();

    const messageOne = createMessage({
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1783512000000",
      labelIds: ["INBOX", "UNREAD", "Label_42"],
      from: "Maya Chen <maya@example.com>",
      to: "Luke Brevoort <luke@example.com>",
      cc: "Product Ops <ops@example.com>",
      subject: "First sync page",
      snippet: "First page preview",
    });

    const messageTwo = createMessage({
      id: "msg-2",
      threadId: "thread-1",
      internalDate: "1783515600000",
      labelIds: ["INBOX", "STARRED"],
      from: "Luke Brevoort <luke@example.com>",
      to: "Maya Chen <maya@example.com>",
      subject: "Second sync page",
      snippet: "Second page preview",
    });

    const gmailClient: GmailClient = {
      async getMessage(_accessToken, messageId) {
        if (messageId === "msg-1") {
          return messageOne;
        }

        if (messageId === "msg-2") {
          return messageTwo;
        }

        throw new Error(`Unknown message: ${messageId}`);
      },

      async listInboxMessagePage({ cursor }) {
        if (cursor === "page-2") {
          return {
            messageIds: ["msg-2"],
            nextCursor: null,
          };
        }

        return {
          messageIds: ["msg-1"],
          nextCursor: "page-2",
        };
      },

      async listLabels() {
        return [
          { id: "INBOX", name: "Inbox" },
          { id: "UNREAD", name: "Unread" },
          { id: "STARRED", name: "Starred" },
          { id: "Label_42", name: "Customers" },
        ] satisfies GmailLabel[];
      },
    };

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_gmail_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
      }).run();

      await storeProviderTokens(db, {
        oauthAccountId: "acct_gmail_1",
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token",
        tokenExpiry: new Date("2026-07-15T00:00:00.000Z"),
      });

      const firstRun = await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-08T12:00:00.000Z"),
      });

      assert.equal(firstRun.emailCount, 1);
      assert.equal(firstRun.threadCount, 1);
      assert.equal(firstRun.contactCount, 3);
      assert.equal(firstRun.nextCursor, "page-2");

      const secondRun = await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-08T12:05:00.000Z"),
      });

      assert.equal(secondRun.emailCount, 1);
      assert.equal(secondRun.threadCount, 1);
      assert.equal(secondRun.nextCursor, null);

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        cursor: "page-2",
        now: new Date("2026-07-08T12:10:00.000Z"),
      });

      const counts = sqlite
        .query(
          `select
             (select count(*) from emails) as email_count,
             (select count(*) from threads) as thread_count,
             (select count(*) from labels) as label_count,
             (select count(*) from email_labels) as email_label_count,
             (select count(*) from contacts) as contact_count`,
        )
        .get() as {
        email_count: number;
        thread_count: number;
        label_count: number;
        email_label_count: number;
        contact_count: number;
      };

      assert.deepEqual(counts, {
        email_count: 2,
        thread_count: 1,
        label_count: 4,
        email_label_count: 5,
        contact_count: 3,
      });

      const thread = sqlite
        .query(
          `select provider_thread_id, subject, message_count, is_read, latest_received_at
           from threads
           where id = 'gmail:acct_gmail_1:thread-1'`,
        )
        .get() as {
        provider_thread_id: string;
        subject: string;
        message_count: number;
        is_read: number;
        latest_received_at: number;
      };

      assert.equal(thread.provider_thread_id, "thread-1");
      assert.equal(thread.subject, "Second sync page");
      assert.equal(thread.message_count, 2);
      assert.equal(thread.is_read, 0);
      assert.equal(new Date(thread.latest_received_at).toISOString(), "2026-07-08T13:00:00.000Z");

      const syncState = sqlite
        .query(
          `select sync_cursor, last_synced_at
           from oauth_accounts
           where id = 'acct_gmail_1'`,
        )
        .get() as {
        sync_cursor: string | null;
        last_synced_at: number;
      };

      assert.equal(syncState.sync_cursor, null);
      assert.equal(
        new Date(syncState.last_synced_at).toISOString(),
        "2026-07-08T12:10:00.000Z",
      );
    } finally {
      sqlite.close();
    }
  });

  test("reuses the original sync window when resuming a later page", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();
    const sinceValues: string[] = [];

    const gmailClient: GmailClient = {
      async getMessage() {
        return createMessage({
          id: "msg-1",
          threadId: "thread-1",
          internalDate: "1783512000000",
          labelIds: ["INBOX"],
          from: "Maya Chen <maya@example.com>",
          to: "Luke Brevoort <luke@example.com>",
          subject: "Window anchor test",
          snippet: "Window anchor",
        });
      },

      async listInboxMessagePage({ cursor, since }) {
        sinceValues.push(`${cursor ?? "first"}:${since.toISOString()}`);

        return {
          messageIds: ["msg-1"],
          nextCursor: cursor || since.getTime() > 0 ? null : "page-2",
        };
      },

      async listLabels() {
        return [{ id: "INBOX", name: "Inbox" }];
      },
    };

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_gmail_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
      }).run();

      await storeProviderTokens(db, {
        oauthAccountId: "acct_gmail_1",
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token",
        tokenExpiry: new Date("2026-07-15T00:00:00.000Z"),
      });

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-08T12:00:00.000Z"),
      });

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-09T15:30:00.000Z"),
      });

      const completedCheckpoint = sqlite
        .query("select last_synced_at from oauth_accounts where id = 'acct_gmail_1'")
        .get() as { last_synced_at: number };

      assert.equal(
        new Date(completedCheckpoint.last_synced_at).toISOString(),
        "2026-07-08T12:00:00.000Z",
      );

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-10T09:00:00.000Z"),
      });

      assert.deepEqual(sinceValues, [
        "first:1970-01-01T00:00:00.000Z",
        "page-2:1970-01-01T00:00:00.000Z",
        "first:2026-07-08T12:00:00.000Z",
      ]);

      const storedCursor = sqlite
        .query("select sync_cursor from oauth_accounts where id = 'acct_gmail_1'")
        .get() as { sync_cursor: string | null };

      assert.equal(storedCursor.sync_cursor, null);
    } finally {
      sqlite.close();
    }
  });

  test("removes stale email label joins when Gmail labels change", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();
    let currentMessage = createMessage({
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1783512000000",
      labelIds: ["INBOX", "UNREAD"],
      from: "Maya Chen <maya@example.com>",
      to: "Luke Brevoort <luke@example.com>",
      subject: "Label reconciliation",
      snippet: "Initial labels",
    });

    const gmailClient: GmailClient = {
      async getMessage() {
        return currentMessage;
      },

      async listInboxMessagePage() {
        return {
          messageIds: ["msg-1"],
          nextCursor: null,
        };
      },

      async listLabels() {
        return [
          { id: "INBOX", name: "Inbox" },
          { id: "UNREAD", name: "Unread" },
        ];
      },
    };

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_gmail_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-user-1",
      }).run();

      await storeProviderTokens(db, {
        oauthAccountId: "acct_gmail_1",
        accessToken: "gmail-access-token",
        refreshToken: "gmail-refresh-token",
        tokenExpiry: new Date("2026-07-15T00:00:00.000Z"),
      });

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-08T12:00:00.000Z"),
      });

      currentMessage = createMessage({
        id: "msg-1",
        threadId: "thread-1",
        internalDate: "1783512000000",
        labelIds: ["INBOX"],
        from: "Maya Chen <maya@example.com>",
        to: "Luke Brevoort <luke@example.com>",
        subject: "Label reconciliation",
        snippet: "Updated labels",
      });

      await syncGmailAccountPage(db, {
        accountId: "acct_gmail_1",
        gmailClient,
        now: new Date("2026-07-08T12:10:00.000Z"),
      });

      const labelJoins = sqlite
        .query(
          `select l.provider_label_id
           from email_labels el
           join labels l on l.id = el.label_id
           where el.email_id = 'gmail:acct_gmail_1:msg-1'
           order by l.provider_label_id`,
        )
        .all() as Array<{ provider_label_id: string }>;

      assert.deepEqual(labelJoins, [{ provider_label_id: "INBOX" }]);
    } finally {
      sqlite.close();
    }
  });
});

function createMessage(input: {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds: string[];
  from: string;
  to: string;
  cc?: string;
  subject: string;
  snippet: string;
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    internalDate: input.internalDate,
    labelIds: input.labelIds,
    snippet: input.snippet,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: input.from },
        { name: "To", value: input.to },
        { name: "Cc", value: input.cc ?? "" },
        { name: "Subject", value: input.subject },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from(`${input.subject} plain body`).toString("base64"),
          },
        },
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from(`<p>${input.subject} html body</p>`).toString("base64url"),
          },
        },
      ],
    },
  };
}
