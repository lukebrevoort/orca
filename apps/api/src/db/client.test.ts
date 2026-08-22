import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "./client.ts";
import { agentEvents, emails, oauthAccounts, threads, users } from "./schema.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-db-client-test-"));
  tempDirs.push(tempDir);
  const databasePath = join(tempDir, "test.sqlite");
  const client = createDatabaseClient(databasePath);

  migrate(client.db, { migrationsFolder });

  return client;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("createDatabaseClient", () => {
  test("enables SQLite foreign key enforcement", () => {
    const { sqlite } = createMigratedClient();

    try {
      const row = sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
      assert.equal(row?.foreign_keys, 1);
    } finally {
      sqlite.close();
    }
  });

  test("rejects oauth accounts that reference missing users", () => {
    const { sqlite } = createMigratedClient();

    try {
      assert.throws(() => {
        sqlite
          .query(
            `insert into oauth_accounts (id, user_id, provider, provider_email, provider_id)
             values ('acct-1', 'missing-user', 'google', 'missing@example.com', 'provider-1')`,
          )
          .run();
      });
    } finally {
      sqlite.close();
    }
  });

  test("enforces account-scoped, retry-safe agent event storage without message bodies", () => {
    const { db, sqlite } = createMigratedClient();

    try {
      db.insert(users).values([
        { id: "owner-1", email: "owner-1@example.com" },
        { id: "owner-2", email: "owner-2@example.com" },
      ]).run();
      db.insert(oauthAccounts).values({
        id: "account-1",
        userId: "owner-1",
        provider: "google",
        providerEmail: "owner-1@example.com",
        providerId: "provider-account-1",
      }).run();
      db.insert(threads).values({
        id: "thread-1",
        accountId: "account-1",
        providerThreadId: "provider-thread-1",
      }).run();
      db.insert(emails).values({
        id: "message-1",
        accountId: "account-1",
        threadId: "thread-1",
        providerMessageId: "provider-message-1",
      }).run();

      const event = {
        id: "event-1",
        ownerUserId: "owner-1",
        accountId: "account-1",
        messageId: "message-1",
        providerMessageId: "provider-message-1",
        threadId: "thread-1",
        provider: "gmail",
        senderAddress: "ci@example.com",
        sourceSubject: "Build failed",
        sourceReceivedAt: new Date("2026-08-19T12:00:00.000Z"),
        sourceUrl: "https://orca.example/mail/accounts/account-1/messages/message-1",
        trigger: "push",
        policyVersion: "m6-policy-v1",
        agentId: "orca-deterministic-propagator",
        agentVersion: "1.0.0",
        executionMode: "deterministic",
        eventKind: "ci_or_deploy_failure",
        importance: "high",
        relevance: "matched",
        destination: "timeline",
        reasonCodes: "[\"workflow_failed\"]",
        title: "Build failed",
        summary: "CI reports a failed build.",
        whyThisMatters: "The release is blocked.",
        deduplicationKey: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        assessmentFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evaluatedAt: new Date("2026-08-19T12:00:01.000Z"),
      };
      db.insert(agentEvents).values(event).run();

      assert.throws(() => db.insert(agentEvents).values({ ...event, id: "retry" }).run());
      assert.throws(() => db.insert(agentEvents).values({
        ...event,
        id: "wrong-owner",
        ownerUserId: "owner-2",
        deduplicationKey: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }).run());
      assert.throws(() => db.insert(agentEvents).values({
        ...event,
        id: "suppressed",
        destination: "none",
        deduplicationKey: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      }).run());

      const columns = sqlite.query("PRAGMA table_info(agent_events)").all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      assert.equal(names.has("body_text"), false);
      assert.equal(names.has("body_html"), false);
      assert.equal(names.has("headers"), false);
    } finally {
      sqlite.close();
    }
  });
});
