import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { persistGmailMessages } from "./sync.ts";
import type { GmailMessage } from "./types.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "orca-sync-persistence-"));
  tempDirs.push(directory);
  const client = createDatabaseClient(join(directory, "persistence.sqlite"));
  migrate(client.db, { migrationsFolder });
  client.db.insert(users).values({ id: "user", email: "user@example.com" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account",
    userId: "user",
    provider: "gmail",
    providerEmail: "user@example.com",
    providerId: "provider-user",
  }).run();
  return client;
}

function messages(count: number): GmailMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    threadId: `thread-${index}`,
    internalDate: String(Date.UTC(2026, 8, 2, 12, index)),
    labelIds: ["INBOX", index % 2 === 0 ? "UNREAD" : "STARRED"],
    snippet: `Batch message ${index}`,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Sender ${index} <sender-${index}@example.com>` },
        { name: "To", value: "User <user@example.com>" },
        { name: "Subject", value: `Batch message ${index}` },
      ],
      body: { data: Buffer.from(`Batch body ${index}`).toString("base64") },
    },
  }));
}

function countPrepares<T>(sqlite: ReturnType<typeof setup>["sqlite"], task: () => Promise<T>) {
  let count = 0;
  const original = sqlite.prepare.bind(sqlite);
  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value(query: string) {
      count += 1;
      return original(query);
    },
  });
  return task().then((result) => ({ result, count }));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Gmail batch persistence", () => {
  test("writes 25 changed messages in bounded batches and skips an unchanged replay", async () => {
    const { db, sqlite } = setup();
    const batch = messages(25);
    try {
      const first = await countPrepares(sqlite, () => persistGmailMessages(db, {
        accountId: "account",
        accountEmail: "user@example.com",
        gmailMessages: batch,
        labelList: [
          { id: "INBOX", name: "Inbox" },
          { id: "UNREAD", name: "Unread" },
          { id: "STARRED", name: "Starred" },
        ],
        now: new Date("2026-09-02T12:30:00.000Z"),
        propagationTrigger: "sync",
        propagationOptions: { enabled: false },
      }));
      assert.equal(first.result.changedEmailCount, 25);
      assert.equal(first.result.unchangedEmailCount, 0);
      assert.ok(first.count < 60, `25-message batch prepared ${first.count} statements`);
      assert.equal((sqlite.query("select count(*) as count from emails").get() as { count: number }).count, 25);
      assert.equal((sqlite.query("select count(*) as count from threads where message_count = 1").get() as { count: number }).count, 25);

      const second = await countPrepares(sqlite, () => persistGmailMessages(db, {
        accountId: "account",
        accountEmail: "user@example.com",
        gmailMessages: batch,
        labelList: [
          { id: "INBOX", name: "Inbox" },
          { id: "UNREAD", name: "Unread" },
          { id: "STARRED", name: "Starred" },
        ],
        now: new Date("2026-09-02T12:31:00.000Z"),
        propagationTrigger: "sync",
        propagationOptions: { enabled: false },
      }));
      assert.equal(second.result.changedEmailCount, 0);
      assert.equal(second.result.unchangedEmailCount, 25);
      assert.ok(second.count < 10, `unchanged replay prepared ${second.count} statements`);
      assert.equal((sqlite.query("select count(*) as count from organization_evaluation_traces").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("select count(*) as count from agent_events").get() as { count: number }).count, 0);
    } finally {
      sqlite.close();
    }
  });

  test("rolls back mail and aggregate writes when a batch projection fails", async () => {
    const { db, sqlite } = setup();
    try {
      await assert.rejects(() => persistGmailMessages(db, {
        accountId: "account",
        accountEmail: "user@example.com",
        gmailMessages: messages(25),
        labelList: [{ id: "INBOX", name: "Inbox" }],
        now: new Date("2026-09-02T12:30:00.000Z"),
        propagationTrigger: "sync",
        propagationOptions: { enabled: false },
        afterPersist() { throw new Error("projection failed"); },
      }), /projection failed/);
      assert.equal((sqlite.query("select count(*) as count from emails").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("select count(*) as count from threads").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("select count(*) as count from labels").get() as { count: number }).count, 0);
    } finally {
      sqlite.close();
    }
  });
});
