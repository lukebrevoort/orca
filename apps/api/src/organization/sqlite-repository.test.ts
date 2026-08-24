import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

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

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite Organization repository", () => {
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
      assert.equal(records.length, 1);
      assert.equal(JSON.stringify(records).includes("gmail"), false);
      assert.deepEqual(records[0]?.attentionRules, [{ scope: "domain", value: "example.com", behavior: "focus" }]);
      assert.deepEqual(records[0]?.messages[0]?.labels, ["Inbox"]);
      assert.equal(records[0]?.messages[0]?.sourceId, "source-message-a");
      assert.equal(records[0]?.messages[0]?.humanClassification?.automatic?.classification, "automated_or_bulk");
      assert.equal(records[0]?.messages[0]?.humanClassification?.effective.classification, "likely_human");
      assert.equal(JSON.stringify(records).includes("Private"), false);
    } finally {
      sqlite.close();
    }
  });
});
