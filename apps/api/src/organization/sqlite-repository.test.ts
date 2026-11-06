import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLQueryBindings } from "bun:sqlite";

import { createDatabaseClient } from "../db/client.ts";
import {
  emailLabels,
  emails,
  humanClassificationOverrides,
  labels,
  oauthAccounts,
  senderAttentionRules,
  threads,
  users,
} from "../db/schema.ts";
import { createSqliteOrganizationRepository } from "./sqlite-repository.ts";
import { persistGmailMessages } from "../providers/gmail/sync.ts";
import * as schema from "../db/schema.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite Organization repository", () => {
  test("provider metadata and identifiers materialize once with many labels", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-fanout-"));
    tempDirectories.push(directory);
    const { db, sqlite } = createDatabaseClient(join(directory, "organization.sqlite"));
    try {
      migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
      db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "a", userId: "owner", provider: "gmail", providerId: "a", providerEmail: "owner@example.com" }).run();
      const subject = "s".repeat(128 * 1024);
      const labelList = Array.from({ length: 24 }, (_, i) => ({ id: `label-${i}`, name: `Label ${String(i).padStart(2, "0")}`, type: "user" as const }));
      await persistGmailMessages(db, { accountId: "a", accountEmail: "owner@example.com", labelList,
        gmailMessages: [{ id: "m", threadId: "t", snippet: "Provider preview", labelIds: labelList.map(label => label.id),
          payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: subject }] } }],
        now: new Date(), propagationTrigger: "sync", propagationOptions: { enabled: false } });
      const observed: Array<{ query: string; params: unknown[] }> = [];
      let beforeLabels: (() => void) | undefined;
      const traced = drizzle(sqlite, { schema, logger: { logQuery(query, params) {
        observed.push({ query, params });
        if (query.includes('from "email_labels"') && beforeLabels) { const write = beforeLabels; beforeLabels = undefined; write(); }
      } } });
      const check = (targeted: boolean, snapshot: boolean) => {
        observed.length = 0;
        const repository = createSqliteOrganizationRepository(traced);
        const filter = targeted ? { threadId: "gmail:a:t" } : undefined;
        const records = snapshot ? repository.readOrganizationSnapshot!("owner", ["a"], filter).threads : repository.listThreads(["a"], filter);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.messages.length, 1);
        assert.equal(records[0]!.messages[0]!.subject, subject);
        assert.deepEqual(records[0]!.messages[0]!.labels, labelList.map(label => label.name));
        let bytes = 0, rows = 0;
        for (const { query, params } of observed.filter(item => /^select\b/i.test(item.query) && item.query.includes('"emails"'))) {
          for (const row of sqlite.query(query).all(...params as SQLQueryBindings[]) as Array<Record<string, unknown>>) {
            rows++;
            for (const value of Object.values(row)) if (typeof value === "string") bytes += Buffer.byteLength(value);
          }
        }
        assert.ok(rows > 0, "observer must measure actual returned query rows");
        assert.ok(bytes < 512 * 1024, `metadata query materialized ${bytes} bytes; labels must not multiply wide fields`);
      };
      for (const targeted of [false, true]) for (const snapshot of [false, true]) check(targeted, snapshot);
      // The narrow association query must not repeat an oversized message ID either.
      sqlite.run("delete from emails where id = 'gmail:a:m'");
      await persistGmailMessages(db, { accountId: "a", accountEmail: "owner@example.com", labelList,
        gmailMessages: [{ id: "i".repeat(128 * 1024), threadId: "t", snippet: "Provider preview", labelIds: labelList.map(label => label.id),
          payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: subject }] } }],
        now: new Date(), propagationTrigger: "sync", propagationOptions: { enabled: false } });
      check(true, true);
      // Direct callers also retain one snapshot across metadata and label reads.
      const writer = createDatabaseClient(join(directory, "organization.sqlite"));
      try {
        beforeLabels = () => { writer.sqlite.run("update labels set name = 'After sync' where provider_label_id = 'label-20'"); };
        check(true, false);
        assert.equal(beforeLabels, undefined, "the concurrent write must run between the two reads");
        assert.ok(createSqliteOrganizationRepository(db).listThreads(["a"])[0]!.messages[0]!.labels.includes("After sync"));
      } finally { writer.sqlite.close(); }
      // Equivalent label names are retained once, empty names remain omitted.
      sqlite.run("update labels set name = 'Label 00' where provider_label_id = 'label-1'");
      sqlite.run("update labels set name = '' where provider_label_id = 'label-2'");
      const names = createSqliteOrganizationRepository(db).listThreads(["a"])[0]!.messages[0]!.labels;
      assert.equal(names.length, 22); assert.equal(names.filter(name => name === "Label 00").length, 1); assert.ok(!names.includes(""));
      // Adjacent 64-bit SQLite anchors must not collide after JS conversion.
      sqlite.run("update emails set rowid = 9007199254740992");
      sqlite.run("insert into emails(rowid,id,account_id,thread_id,provider_message_id) values(9007199254740993,'neighbor','a','gmail:a:t','neighbor')");
      const neighbors = createSqliteOrganizationRepository(db).listThreads(["a"])[0]!.messages;
      assert.equal(neighbors.length, 2);
      assert.deepEqual(neighbors.find(message => message.id === "neighbor")!.labels, []);
      assert.equal(neighbors.find(message => message.id !== "neighbor")!.labels.length, 22);
    } finally { sqlite.close(); }
  });
  test("loads provider-neutral Thread records inside the requested Account set", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-repository-"));
    tempDirectories.push(directory);
    const { db, sqlite } = createDatabaseClient(join(directory, "organization.sqlite"));
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values([
        { id: "workspace_owner", email: "owner@example.com" },
        { id: "workspace_other", email: "other@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "source-a" },
        { id: "account_private", userId: "workspace_other", provider: "outlook", providerEmail: "other@example.com", providerId: "source-private" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "provider-thread-a", subject: "Owned", latestReceivedAt: new Date("2026-08-23T12:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_unrelated", accountId: "account_a", providerThreadId: "provider-thread-unrelated", subject: "Unrelated", latestReceivedAt: new Date("2026-08-23T11:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_private", accountId: "account_private", providerThreadId: "provider-thread-private", subject: "Private", latestReceivedAt: new Date("2026-08-23T13:00:00.000Z"), messageCount: 1, isRead: false },
      ]).run();
      db.insert(emails).values([
        {
          id: "message_a", accountId: "account_a", threadId: "thread_a", providerMessageId: "source-message-a",
          fromAddress: "ada@example.com", fromName: "Ada", subject: "Owned", snippet: "Visible",
          receivedAt: new Date("2026-08-23T12:00:00.000Z"), isRead: false,
          humanSignal: 2, humanClassification: "automated_or_bulk",
          humanClassificationReasons: JSON.stringify(["provider_bulk_signal"]), humanClassifierVersion: "v1",
        },
        {
          id: "message_unrelated", accountId: "account_a", threadId: "thread_unrelated", providerMessageId: "source-message-unrelated",
          fromAddress: "unrelated@example.com", subject: "Unrelated", snippet: "Must not be fetched by a targeted read",
          receivedAt: new Date("2026-08-23T11:00:00.000Z"), isRead: false,
        },
        {
          id: "message_private", accountId: "account_private", threadId: "thread_private", providerMessageId: "source-message-private",
          fromAddress: "private@example.net", subject: "Private", snippet: "Must not leak",
          receivedAt: new Date("2026-08-23T13:00:00.000Z"), isRead: false,
        },
      ]).run();
      db.insert(labels).values({ id: "label_a", accountId: "account_a", providerLabelId: "INBOX", name: "Inbox", type: "system" }).run();
      db.insert(emailLabels).values({ id: "message_a:label_a", emailId: "message_a", labelId: "label_a" }).run();
      db.insert(senderAttentionRules).values({ id: "rule_a", accountId: "account_a", scope: "domain", value: "example.com", behavior: "focus", source: "user_choice" }).run();
      db.insert(humanClassificationOverrides).values({
        id: "override_a", accountId: "account_a", targetType: "message", targetValue: "message_a",
        classification: "likely_human", source: "user_choice",
      }).run();

      const repository = createSqliteOrganizationRepository(db);
      assert.deepEqual(repository.listAccountIds("workspace_owner"), ["account_a"]);
      assert.deepEqual(repository.listAccountIds("workspace_other"), ["account_private"]);

      const records = repository.listThreads(["account_a"]);
      assert.equal(records.length, 2);
      assert.equal(JSON.stringify(records).includes("gmail"), false);
      assert.deepEqual(records[0]?.attentionRules, [{ scope: "domain", value: "example.com", behavior: "focus" }]);
      assert.deepEqual(records[0]?.messages[0]?.labels, ["Inbox"]);
      assert.equal(records[0]?.messages[0]?.sourceId, "source-message-a");
      assert.equal(records[0]?.messages[0]?.humanClassification?.automatic?.classification, "automated_or_bulk");
      assert.equal(records[0]?.messages[0]?.humanClassification?.effective.classification, "likely_human");
      assert.equal(JSON.stringify(records).includes("Private"), false);

      const preparedSql: string[] = [];
      const originalPrepare = sqlite.prepare.bind(sqlite);
      Object.defineProperty(sqlite, "prepare", {
        configurable: true,
        value: (sql: string) => {
          preparedSql.push(sql);
          return originalPrepare(sql);
        },
      });
      const targeted = createSqliteOrganizationRepository(db).listThreads(["account_a"], { threadId: "thread_a" });
      assert.deepEqual(targeted.map((thread) => thread.id), ["thread_a"]);
      assert.deepEqual(targeted[0]?.messages.map((message) => message.id), ["message_a"]);
      assert.ok(preparedSql.some((sql) => sql.includes('from "emails"') && sql.includes('"emails"."thread_id" = ?')),
        `targeted email SQL must include a Thread predicate: ${preparedSql.join("\n")}`);
    } finally {
      sqlite.close();
    }
  });
});
