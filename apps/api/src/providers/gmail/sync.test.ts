import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { GmailOAuthConfig } from "../../auth/gmail/config.ts";
import { readProviderTokens, storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { humanClassifierVersion } from "../../classification/human-signal.ts";
import { GmailApiError, type GmailClient } from "./client.ts";
import { GmailSyncError, syncGmailAccountPage } from "./sync.ts";
import type { GmailLabel, GmailMessage } from "./types.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const testOAuthConfig: GmailOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3000/v1/auth/gmail/callback",
  scopes: [],
  composeScopes: [],
  tokenEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  stateSecret: "test-state-secret",
  successRedirectUrl: null,
  errorRedirectUrl: null,
  webOrigin: "http://localhost:5173",
};

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
  test("refreshes an expired access token before syncing and persists rotated credentials", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();
    const now = new Date("2026-08-15T12:00:00.000Z");
    const seenTokens: string[] = [];
    const refreshBodies: URLSearchParams[] = [];
    const message = createMessage({
      id: "refresh-message",
      threadId: "refresh-thread",
      internalDate: "1783512000000",
      labelIds: ["INBOX"],
      from: "Maya Chen <maya@example.com>",
      to: "Luke Brevoort <luke@example.com>",
      subject: "Refreshed sync",
      snippet: "Refreshed sync",
    });
    const gmailClient: GmailClient = {
      async getMessage(accessToken) {
        seenTokens.push(accessToken);
        return message;
      },
      async listInboxMessagePage({ accessToken }) {
        seenTokens.push(accessToken);
        return { messageIds: [message.id], nextCursor: null };
      },
      async listLabels(accessToken) {
        seenTokens.push(accessToken);
        return [{ id: "INBOX", name: "Inbox" }];
      },
    };
    const tokenFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      refreshBodies.push(new URLSearchParams(String(init?.body ?? "")));
      return Response.json({
        access_token: "refreshed-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });
    };

    try {
      db.insert(users).values({ id: "user_refresh", email: "refresh@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_refresh",
        userId: "user_refresh",
        provider: "gmail",
        providerEmail: "refresh@example.com",
        providerId: "gmail-refresh-user",
      }).run();
      await storeProviderTokens(db, {
        oauthAccountId: "acct_refresh",
        accessToken: "expired-access-token",
        refreshToken: "original-refresh-token",
        tokenExpiry: new Date(now.getTime() - 1_000),
      });

      const result = await syncGmailAccountPage(db, {
        accountId: "acct_refresh",
        gmailClient,
        now,
        oauthConfig: testOAuthConfig,
        tokenFetch,
      });

      assert.equal(result.emailCount, 1);
      assert.deepEqual(seenTokens, [
        "refreshed-access-token",
        "refreshed-access-token",
        "refreshed-access-token",
      ]);
      assert.equal(refreshBodies.length, 1);
      assert.equal(refreshBodies[0]?.get("grant_type"), "refresh_token");
      assert.equal(refreshBodies[0]?.get("refresh_token"), "original-refresh-token");
      assert.equal(refreshBodies[0]?.get("client_id"), testOAuthConfig.clientId);

      const stored = await readProviderTokens(db, "acct_refresh");
      assert.equal(stored?.accessToken, "refreshed-access-token");
      assert.equal(stored?.refreshToken, "rotated-refresh-token");
      assert.equal(stored?.tokenExpiry?.toISOString(), "2026-08-15T13:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  test("refreshes and retries a sync once after Gmail rejects an access token", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();
    const now = new Date("2026-08-15T12:00:00.000Z");
    const labelTokens: string[] = [];
    const inboxTokens: string[] = [];
    const message = createMessage({
      id: "retry-message",
      threadId: "retry-thread",
      internalDate: "1783512000000",
      labelIds: ["INBOX"],
      from: "Maya Chen <maya@example.com>",
      to: "Luke Brevoort <luke@example.com>",
      subject: "Retried sync",
      snippet: "Retried sync",
    });
    const gmailClient: GmailClient = {
      async getMessage(accessToken) {
        assert.equal(accessToken, "retry-access-token");
        return message;
      },
      async listInboxMessagePage({ accessToken }) {
        inboxTokens.push(accessToken);
        return { messageIds: [message.id], nextCursor: null };
      },
      async listLabels(accessToken) {
        labelTokens.push(accessToken);
        if (accessToken === "expired-access-token") {
          throw new GmailApiError("expired", 401);
        }
        return [{ id: "INBOX", name: "Inbox" }];
      },
    };
    let refreshCalls = 0;
    const tokenFetch = async () => {
      refreshCalls += 1;
      return Response.json({
        access_token: "retry-access-token",
        refresh_token: "rotated-retry-refresh-token",
        expires_in: 1800,
      });
    };

    try {
      db.insert(users).values({ id: "user_retry", email: "retry@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_retry",
        userId: "user_retry",
        provider: "gmail",
        providerEmail: "retry@example.com",
        providerId: "gmail-retry-user",
      }).run();
      await storeProviderTokens(db, {
        oauthAccountId: "acct_retry",
        accessToken: "expired-access-token",
        refreshToken: "retry-refresh-token",
        tokenExpiry: new Date(now.getTime() + 3_600_000),
      });

      const result = await syncGmailAccountPage(db, {
        accountId: "acct_retry",
        gmailClient,
        now,
        oauthConfig: testOAuthConfig,
        tokenFetch,
      });

      assert.equal(result.emailCount, 1);
      assert.deepEqual(labelTokens, ["expired-access-token", "retry-access-token"]);
      assert.deepEqual(inboxTokens, ["expired-access-token", "retry-access-token"]);
      assert.equal(refreshCalls, 1);

      const stored = await readProviderTokens(db, "acct_retry");
      assert.equal(stored?.accessToken, "retry-access-token");
      assert.equal(stored?.refreshToken, "rotated-retry-refresh-token");
      assert.equal(stored?.tokenExpiry?.toISOString(), "2026-08-15T12:30:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  test("surfaces reconnect only when Google rejects the refresh token", async () => {
    setAuthEnv();

    const { db, sqlite } = createMigratedClient();
    const gmailClient: GmailClient = {
      async getMessage() {
        throw new Error("message fetch should not run");
      },
      async listInboxMessagePage() {
        return { messageIds: [], nextCursor: null };
      },
      async listLabels() {
        throw new GmailApiError("expired", 401);
      },
    };
    let refreshCalls = 0;
    const tokenFetch = async () => {
      refreshCalls += 1;
      return Response.json(
        { error: "invalid_grant", error_description: "Token has been revoked" },
        { status: 400 },
      );
    };

    try {
      db.insert(users).values({ id: "user_revoked", email: "revoked@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_revoked",
        userId: "user_revoked",
        provider: "gmail",
        providerEmail: "revoked@example.com",
        providerId: "gmail-revoked-user",
      }).run();
      await storeProviderTokens(db, {
        oauthAccountId: "acct_revoked",
        accessToken: "expired-access-token",
        refreshToken: "revoked-refresh-token",
        tokenExpiry: null,
      });

      await assert.rejects(
        () => syncGmailAccountPage(db, {
          accountId: "acct_revoked",
          gmailClient,
          now: new Date("2026-08-15T12:00:00.000Z"),
          oauthConfig: testOAuthConfig,
          tokenFetch,
        }),
        (error: unknown) => error instanceof GmailSyncError && error.code === "provider_auth_error",
      );
      assert.equal(refreshCalls, 1);

      const stored = await readProviderTokens(db, "acct_revoked");
      assert.equal(stored?.accessToken, "expired-access-token");
      assert.equal(stored?.refreshToken, "revoked-refresh-token");
    } finally {
      sqlite.close();
    }
  });

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

      const classifications = sqlite.query(
        `select provider_message_id, human_signal, human_classification,
                human_classification_reasons, human_classifier_version,
                human_classification_evidence
         from emails
         order by provider_message_id`,
      ).all() as Array<{
        provider_message_id: string;
        human_signal: number | null;
        human_classification: string | null;
        human_classification_reasons: string | null;
        human_classifier_version: string | null;
        human_classification_evidence: string | null;
      }>;
      assert.deepEqual(classifications.map((row) => ({
        providerMessageId: row.provider_message_id,
        score: row.human_signal,
        classification: row.human_classification,
        reasons: JSON.parse(row.human_classification_reasons ?? "[]"),
        version: row.human_classifier_version,
      })), [
        {
          providerMessageId: "msg-1",
          score: 7,
          classification: "likely_human",
          reasons: ["direct_recipient"],
          version: humanClassifierVersion,
        },
        {
          providerMessageId: "msg-2",
          score: null,
          classification: "unclassified",
          reasons: ["insufficient_evidence"],
          version: humanClassifierVersion,
        },
      ]);
      assert.equal(JSON.parse(classifications[0]?.human_classification_evidence ?? "{}").recipientRelationship, "direct");
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
