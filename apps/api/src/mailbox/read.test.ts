import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createMailboxReader, MailboxCursorError, type MailboxReadAccount, type MailboxReadMetric } from "./read.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture(messageCount = 240) {
  const directory = mkdtempSync(join(tmpdir(), "orca-mailbox-read-"));
  tempDirectories.push(directory);
  const dbPath = join(directory, "mailbox.sqlite");
  const client = createDatabaseClient(dbPath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  const baseTime = Date.parse("2026-09-02T12:00:00.000Z");
  client.db.insert(users).values({ id: "user", email: "reader@example.com", displayName: "Reader" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account",
    userId: "user",
    provider: "gmail",
    providerEmail: "reader@example.com",
    providerId: "gmail-reader",
    syncHistoryId: "history-240",
    lastSyncedAt: new Date(baseTime),
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  }).run();
  const behaviors = ["notify", "focus", "normal", "quiet", "hidden"] as const;
  client.db.insert(senderAttentionRules).values(behaviors.map((behavior, index) => ({
    id: `rule-${behavior}`,
    accountId: "account",
    scope: "domain",
    value: `group-${index}.example`,
    behavior,
    source: "user_choice",
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  }))).run();
  for (let offset = 0; offset < messageCount; offset += 40) {
    const slice = Array.from({ length: Math.min(40, messageCount - offset) }, (_, localIndex) => offset + localIndex);
    client.db.insert(threads).values(slice.map((index) => ({
      id: `thread-${index.toString().padStart(5, "0")}`,
      accountId: "account",
      providerThreadId: `provider-thread-${index}`,
      subject: `Subject ${index}`,
      latestReceivedAt: new Date(baseTime - index * 1_000),
      messageCount: 1,
      isRead: index % 2 === 0,
      createdAt: new Date(baseTime - index * 1_000),
      updatedAt: new Date(baseTime),
    }))).run();
    client.db.insert(emails).values(slice.map((index) => ({
      id: `message-${index.toString().padStart(5, "0")}`,
      accountId: "account",
      threadId: `thread-${index.toString().padStart(5, "0")}`,
      providerMessageId: `provider-message-${index}`,
      fromAddress: `sender-${index}@group-${index % behaviors.length}.example`,
      fromName: `Sender ${index}`,
      subject: `Subject ${index}`,
      snippet: `Fixture row ${index}`,
      receivedAt: new Date(baseTime - index * 1_000),
      isRead: index % 2 === 0,
      humanSignal: index % 2 === 0 ? 8 : 2,
      humanClassification: index % 2 === 0 ? "likely_human" : "automated_or_bulk",
      humanClassificationReasons: JSON.stringify([index % 2 === 0 ? "direct_recipient" : "list_id_header"]),
      humanClassifierVersion: "benchmark-v1",
      createdAt: new Date(baseTime - index * 1_000),
      updatedAt: new Date(baseTime),
    }))).run();
  }
  const row = client.db.select().from(oauthAccounts).get()!;
  const account: MailboxReadAccount = {
    id: row.id,
    provider: "gmail",
    syncHistoryId: row.syncHistoryId,
    lastSyncedAt: row.lastSyncedAt,
    updatedAt: row.updatedAt,
    serialized: {
      id: row.id,
      provider: "gmail",
      email: row.providerEmail,
      displayName: "Reader",
      capabilities: { read: true, draft: false, send: false },
    },
  };
  return { ...client, account, baseTime };
}

describe("bounded mailbox reader", () => {
  test("projects one keyset page while SQL aggregates the complete mailbox counts", () => {
    const fixture = createFixture();
    const observed: MailboxReadMetric[] = [];
    const reader = createMailboxReader(fixture.sqlite, { observe: (metric) => observed.push(metric) });
    const first = reader.read({ accounts: [fixture.account], query: { view: "all", classification: "all", limit: 25 } });

    expect(fixture.sqlite.query("select name from sqlite_master where type = 'index' and name = 'emails_mailbox_page_idx'").get()).toEqual({ name: "emails_mailbox_page_idx" });
    expect(first.response.messages).toHaveLength(25);
    expect(first.response.counts.attention).toEqual({ focus: 96, normal: 48, quiet: 48, hidden: 48, all: 240 });
    expect(first.response.counts.classification).toEqual({ likely_human: 120, automated_or_bulk: 120, uncertain: 0, unclassified: 0, all: 240 });
    expect(first.response.freshness).toEqual({
      revision: expect.stringMatching(/^mailbox-v1:[0-9a-f]{64}$/),
      lastSyncedAt: "2026-09-02T12:00:00.000Z",
    });
    expect(first.response.nextCursor).toBeString();
    expect(first.metric.returnedMessages).toBe(25);
    expect(first.metric.projectedRows).toBeLessThan(100);
    expect(observed).toEqual([first.metric]);

    const second = reader.read({ accounts: [fixture.account], query: { view: "all", classification: "all", limit: 25, cursor: first.response.nextCursor! } });
    expect(second.response.messages).toHaveLength(25);
    expect(new Set([...first.response.messages, ...second.response.messages].map((message) => message.id)).size).toBe(50);
    fixture.sqlite.close();
  });

  test("binds cursors to the durable mailbox revision and Account/filter scope", () => {
    const fixture = createFixture(60);
    const reader = createMailboxReader(fixture.sqlite);
    const first = reader.read({ accounts: [fixture.account], query: { view: "normal", classification: "human", limit: 5 } });
    expect(first.response.nextCursor).toBeString();

    const refreshedAccount = {
      ...fixture.account,
      syncHistoryId: "history-241",
      lastSyncedAt: new Date(fixture.baseTime + 1_000),
      updatedAt: new Date(fixture.baseTime + 1_000),
    };
    expect(() => createMailboxReader(fixture.sqlite).read({
      accounts: [refreshedAccount],
      query: { view: "normal", classification: "human", limit: 5, cursor: first.response.nextCursor! },
    })).toThrow(MailboxCursorError);
    expect(() => reader.read({
      accounts: [fixture.account],
      query: { view: "normal", classification: "tideline", limit: 5, cursor: first.response.nextCursor! },
    })).toThrow(MailboxCursorError);
    fixture.sqlite.close();
  });
});
