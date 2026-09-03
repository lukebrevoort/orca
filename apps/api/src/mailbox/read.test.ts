import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { emailLabels, emails, humanClassificationOverrides, labels, mailboxRevisions, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createMailboxReader, MailboxCursorError, MailboxScopeError, type MailboxPageQueryPlan, type MailboxReadMetric } from "./read.ts";

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
  return { ...client, authorization: { userId: "user", accountIds: ["account"] }, baseTime, dbPath };
}

function addSecondAccount(fixture: ReturnType<typeof createFixture>, messageCount = 40) {
  fixture.db.insert(oauthAccounts).values({
    id: "account-two",
    userId: "user",
    provider: "gmail",
    providerEmail: "reader-two@example.com",
    providerId: "gmail-reader-two",
    syncHistoryId: "history-two",
    lastSyncedAt: new Date(fixture.baseTime - 1_000),
    createdAt: new Date(fixture.baseTime + 1),
    updatedAt: new Date(fixture.baseTime),
  }).run();
  for (let index = 0; index < messageCount; index += 1) {
    const suffix = index.toString().padStart(5, "0");
    const receivedAt = new Date(fixture.baseTime - index * 1_000);
    fixture.db.insert(threads).values({
      id: `thread-two-${suffix}`,
      accountId: "account-two",
      providerThreadId: `provider-thread-two-${index}`,
      subject: `Second account ${index}`,
      latestReceivedAt: receivedAt,
      messageCount: 1,
      isRead: false,
      createdAt: receivedAt,
      updatedAt: new Date(fixture.baseTime),
    }).run();
    fixture.db.insert(emails).values({
      id: `message-two-${suffix}`,
      accountId: "account-two",
      threadId: `thread-two-${suffix}`,
      providerMessageId: `provider-message-two-${index}`,
      fromAddress: `second-${index}@unruled.example`,
      fromName: `Second ${index}`,
      subject: `Second account ${index}`,
      snippet: `Second fixture row ${index}`,
      receivedAt,
      isRead: false,
      humanSignal: 8,
      humanClassification: "likely_human",
      humanClassificationReasons: JSON.stringify(["direct_recipient"]),
      humanClassifierVersion: "benchmark-v1",
      createdAt: receivedAt,
      updatedAt: new Date(fixture.baseTime),
    }).run();
  }
  return { userId: "user", accountIds: ["account", "account-two"] };
}

describe("bounded mailbox reader", () => {
  test("projects one keyset page while SQL aggregates the complete mailbox counts", () => {
    const fixture = createFixture();
    const observed: MailboxReadMetric[] = [];
    const plans: MailboxPageQueryPlan[] = [];
    const reader = createMailboxReader(fixture.sqlite, {
      observe: (metric) => observed.push(metric),
      observePageQueryPlan: (plan) => plans.push(plan),
    });
    const first = reader.read({ authorization: fixture.authorization, query: { view: "all", classification: "all", limit: 25 } });

    expect(fixture.sqlite.query("select name from sqlite_master where type = 'index' and name = 'emails_mailbox_page_idx'").get()).toBeNull();
    expect(fixture.sqlite.query("select name from sqlite_master where type = 'index' and name = 'emails_mailbox_account_page_idx'").get()).toEqual({ name: "emails_mailbox_account_page_idx" });
    const planDetails = plans.flatMap((plan) => plan.details);
    expect(planDetails.some((detail) => detail.includes("emails_mailbox_account_page_idx"))).toBe(true);
    expect(planDetails.some((detail) => detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    expect(first.response.messages).toHaveLength(25);
    expect(first.response.counts.attention).toEqual({ focus: 96, normal: 48, quiet: 48, hidden: 48, all: 240 });
    expect(first.response.counts.classification).toEqual({ likely_human: 120, automated_or_bulk: 120, uncertain: 0, unclassified: 0, all: 240 });
    expect(first.response.freshness).toEqual({
      revision: expect.stringMatching(/^mailbox-v2:[0-9a-f]{64}$/),
      lastSyncedAt: "2026-09-02T12:00:00.000Z",
    });
    expect(first.response.nextCursor).toBeString();
    expect(first.metric.returnedMessages).toBe(25);
    expect(first.metric.aggregateRowsReturned).toBe(1);
    expect(first.metric.pageRowsProjected).toBe(26);
    expect(first.metric.maxPageRowsBound).toBe(26);
    expect(first.metric.lookaheadRowsProjected).toBe(1);
    expect(first.metric.labelAssociationRowsLoaded).toBe(0);
    expect(first.metric.effectiveOverridesProjected).toBe(0);
    expect(observed).toEqual([first.metric]);

    const second = reader.read({ authorization: fixture.authorization, query: { view: "all", classification: "all", limit: 25, cursor: first.response.nextCursor! } });
    expect(second.response.messages).toHaveLength(25);
    expect(new Set([...first.response.messages, ...second.response.messages].map((message) => message.id)).size).toBe(50);
    fixture.sqlite.close();
  });

  test("rejects stale cursors after attention, classification, label, and concurrent email mutations", () => {
    const fixture = createFixture(60);
    const reader = createMailboxReader(fixture.sqlite);
    const readPage = () => reader.read({ authorization: fixture.authorization, query: { view: "all", classification: "all", limit: 2 } });
    const expectCursorRejectedAfter = (mutate: () => void) => {
      const page = readPage();
      expect(page.response.nextCursor).toBeString();
      const before = fixture.db.select().from(mailboxRevisions).get()!.revision;
      mutate();
      expect(fixture.db.select().from(mailboxRevisions).get()!.revision).toBeGreaterThan(before);
      expect(() => reader.read({
        authorization: fixture.authorization,
        query: { view: "all", classification: "all", limit: 2, cursor: page.response.nextCursor! },
      })).toThrow(MailboxCursorError);
      expect(readPage().response.freshness.revision).not.toBe(page.response.freshness.revision);
    };

    // Regression for the duplicate-page repro: moving the first ranked sender
    // after page one must invalidate its cursor before page two is evaluated.
    expectCursorRejectedAfter(() => fixture.sqlite.run("update sender_attention_rules set behavior = 'hidden' where id = 'rule-notify'"));
    expectCursorRejectedAfter(() => fixture.db.insert(humanClassificationOverrides).values({
      id: "override-message",
      accountId: "account",
      targetType: "message",
      targetValue: "message-00000",
      classification: "uncertain",
      source: "user_choice",
    }).run());
    fixture.db.insert(labels).values({ id: "label-review", accountId: "account", providerLabelId: "REVIEW", name: "Review", type: "user" }).run();
    expectCursorRejectedAfter(() => fixture.db.insert(emailLabels).values({ id: "message-label-review", emailId: "message-00000", labelId: "label-review" }).run());
    expectCursorRejectedAfter(() => {
      const concurrent = createDatabaseClient(fixture.dbPath);
      try {
        concurrent.sqlite.run("update emails set received_at = received_at + 5000 where id = 'message-00010'");
      } finally {
        concurrent.sqlite.close();
      }
    });

    const rollbackPage = readPage();
    const revisionBeforeRollback = fixture.db.select().from(mailboxRevisions).get()!.revision;
    expect(() => fixture.sqlite.transaction(() => {
      fixture.sqlite.run("update emails set subject = 'rolled back' where id = 'message-00010'");
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(fixture.db.select().from(mailboxRevisions).get()!.revision).toBe(revisionBeforeRollback);
    expect(() => reader.read({
      authorization: fixture.authorization,
      query: { view: "all", classification: "all", limit: 2, cursor: rollbackPage.response.nextCursor! },
    })).not.toThrow();

    const first = readPage();
    expect(() => reader.read({
      authorization: fixture.authorization,
      query: { view: "all", classification: "human", limit: 2, cursor: first.response.nextCursor! },
    })).toThrow(MailboxCursorError);
    fixture.sqlite.close();
  });

  test("owns mutable account metadata and revision in one snapshot", () => {
    const fixture = createFixture(10);
    const reader = createMailboxReader(fixture.sqlite);
    const before = reader.read({ authorization: fixture.authorization, query: { view: "all", limit: 2 } });
    const stalePriorMetadata = fixture.db.select().from(oauthAccounts).get()!;
    const concurrent = createDatabaseClient(fixture.dbPath);
    let mutationCommitted = false;
    const snapshotReader = createMailboxReader(fixture.sqlite, {
      capabilitiesFor: (_provider, scope) => {
        if (!mutationCommitted) {
          concurrent.sqlite.transaction(() => {
            concurrent.sqlite.run(`update oauth_accounts set
              provider_email = 'current@example.com',
              profile_image_url = 'https://example.com/current.png',
              scope = 'https://www.googleapis.com/auth/gmail.compose',
              last_synced_at = ?
              where id = 'account'`, [fixture.baseTime + 60_000]);
            concurrent.sqlite.run("update users set display_name = 'Current Reader' where id = 'user'");
          })();
          mutationCommitted = true;
        }
        return scope?.includes("gmail.compose")
          ? { read: false, draft: true, send: true }
          : { read: true, draft: false, send: false };
      },
    });
    try {
      const duringConcurrentCommit = snapshotReader.read({ authorization: fixture.authorization, query: { view: "all", limit: 2 } });
      expect(mutationCommitted).toBe(true);
      expect(duringConcurrentCommit.response.freshness).toEqual(before.response.freshness);
      expect(duringConcurrentCommit.response.accounts).toEqual(before.response.accounts);
    } finally {
      concurrent.sqlite.close();
    }

    expect(stalePriorMetadata.providerEmail).toBe("reader@example.com");
    const current = snapshotReader.read({ authorization: fixture.authorization, query: { view: "all", limit: 2 } });
    expect(current.response.freshness.revision).not.toBe(before.response.freshness.revision);
    expect(current.response.freshness.lastSyncedAt).toBe("2026-09-02T12:01:00.000Z");
    expect(current.response.accounts).toEqual([{
      id: "account",
      provider: "gmail",
      email: "current@example.com",
      displayName: "Current Reader",
      avatarUrl: "/v1/accounts/account/avatar",
      capabilities: { read: false, draft: true, send: true },
    }]);
    expect(current.response.messages.every((message) => message.provider === "gmail")).toBe(true);

    const revisionBeforeRollback = current.response.freshness.revision;
    const rollback = createDatabaseClient(fixture.dbPath);
    try {
      expect(() => rollback.sqlite.transaction(() => {
        rollback.sqlite.run("update oauth_accounts set provider_email = 'rolled-back@example.com', last_synced_at = ? where id = 'account'", [fixture.baseTime + 120_000]);
        rollback.sqlite.run("update users set display_name = 'Rolled Back' where id = 'user'");
        throw new Error("rollback metadata");
      })()).toThrow("rollback metadata");
    } finally {
      rollback.sqlite.close();
    }
    const afterRollback = reader.read({ authorization: fixture.authorization, query: { view: "all", limit: 2 } });
    expect(afterRollback.response.freshness.revision).toBe(revisionBeforeRollback);
    expect(afterRollback.response.accounts[0]?.email).toBe("current@example.com");
    expect(afterRollback.response.accounts[0]?.displayName).toBe("Current Reader");

    const removed = createDatabaseClient(fixture.dbPath);
    try {
      removed.sqlite.run("delete from oauth_accounts where id = 'account'");
    } finally {
      removed.sqlite.close();
    }
    expect(() => reader.read({ authorization: fixture.authorization, query: { view: "all", limit: 2 } })).toThrow(MailboxScopeError);
    fixture.sqlite.close();
  });

  test("merges two index-backed account pages without duplicates or omissions", () => {
    const fixture = createFixture(45);
    const authorization = addSecondAccount(fixture, 35);
    const plans: MailboxPageQueryPlan[] = [];
    const reader = createMailboxReader(fixture.sqlite, { observePageQueryPlan: (plan) => plans.push(plan) });
    const expected = fixture.sqlite.query<{ id: string }, []>(`
      select id from emails
      where account_id = 'account-two' or from_address like '%@group-2.example'
      order by coalesce(received_at, 0) desc, account_id asc, id asc`).all().map((row) => row.id);
    const actual: string[] = [];
    let cursor: string | undefined;
    do {
      const result = reader.read({ authorization, query: { view: "normal", classification: "all", limit: 7, ...(cursor ? { cursor } : {}) } });
      expect(result.metric.pageRowsProjected).toBeLessThanOrEqual(result.metric.maxPageRowsBound);
      expect(result.metric.maxPageRowsBound).toBe(16);
      actual.push(...result.response.messages.map((message) => message.id));
      cursor = result.response.nextCursor ?? undefined;
    } while (cursor);

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
    expect(new Set(plans.map((plan) => plan.accountId))).toEqual(new Set(["account", "account-two"]));
    expect(plans.every((plan) => plan.details.some((detail) => detail.includes("emails_mailbox_account_page_idx")))).toBe(true);
    expect(plans.every((plan) => plan.details.every((detail) => !detail.includes("USE TEMP B-TREE FOR ORDER BY")))).toBe(true);
    fixture.sqlite.close();
  });

  test("reports high-association enrichment separately and projects one effective override per message row", () => {
    const fixture = createFixture(40);
    fixture.db.insert(labels).values(["one", "two", "three"].map((name) => ({
      id: `label-${name}`, accountId: "account", providerLabelId: name.toUpperCase(), name, type: "user",
    }))).run();
    fixture.db.insert(emailLabels).values(Array.from({ length: 40 }, (_, index) => ["one", "two", "three"].map((name) => ({
      id: `message-${index}-${name}`,
      emailId: `message-${index.toString().padStart(5, "0")}`,
      labelId: `label-${name}`,
    }))).flat()).run();
    fixture.db.insert(humanClassificationOverrides).values(Array.from({ length: 40 }, (_, index) => ({
      id: `override-message-${index}`,
      accountId: "account",
      targetType: "message",
      targetValue: `message-${index.toString().padStart(5, "0")}`,
      classification: "uncertain",
      source: "user_choice",
    }))).run();

    const result = createMailboxReader(fixture.sqlite).read({ authorization: fixture.authorization, query: { view: "all", classification: "all", limit: 25 } });
    expect(result.metric.pageRowsProjected).toBe(26);
    expect(result.metric.lookaheadRowsProjected).toBe(1);
    expect(result.metric.labelAssociationRowsLoaded).toBe(75);
    expect(result.metric.effectiveOverridesProjected).toBe(25);
    expect(result.response.messages.every((message) => message.labels.length === 3)).toBe(true);
    expect(result.response.messages.every((message) => message.humanClassification?.userOverride?.target.scope === "message")).toBe(true);
    fixture.sqlite.close();
  });
});
