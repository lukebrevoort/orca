import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { HumanClassificationEvidence } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { backfillHumanClassifications } from "./backfill.ts";
import { humanClassifierVersion } from "./human-signal.ts";

const tempDirectories: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

function createMigratedClient() {
  const directory = mkdtempSync(join(tmpdir(), "orca-human-backfill-"));
  tempDirectories.push(directory);
  const client = createDatabaseClient(join(directory, "classification.sqlite"));
  migrate(client.db, { migrationsFolder });
  return client;
}

function evidence(overrides: Partial<HumanClassificationEvidence> = {}): HumanClassificationEvidence {
  return {
    sender: { name: "Maya", email: "maya@example.com" },
    recipients: [{ name: "Luke", email: "luke@example.com" }],
    recipientRelationship: "direct",
    reply: { hasInReplyTo: false, referenceCount: 0 },
    headerSignals: [],
    providerSignals: [],
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("Human Signal backfill", () => {
  test("is account-scoped, bounded, version-aware, and idempotent without provider access", () => {
    const { db, sqlite } = createMigratedClient();
    try {
      const timestamp = new Date("2026-08-10T12:00:00.000Z");
      db.insert(users).values({ id: "user", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "user", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-a" },
        { id: "account_b", userId: "user", provider: "outlook", providerEmail: "luke.work@example.com", providerId: "outlook-b" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "a", subject: "A", latestReceivedAt: timestamp },
        { id: "thread_b", accountId: "account_b", providerThreadId: "b", subject: "B", latestReceivedAt: timestamp },
      ]).run();
      db.insert(emails).values([
        { id: "a_human", accountId: "account_a", threadId: "thread_a", providerMessageId: "a-human", receivedAt: new Date("2026-08-10T10:00:00.000Z"), humanClassificationEvidence: JSON.stringify(evidence()) },
        { id: "a_bulk", accountId: "account_a", threadId: "thread_a", providerMessageId: "a-bulk", receivedAt: new Date("2026-08-10T11:00:00.000Z"), humanClassifierVersion: "m4-v0", humanClassificationEvidence: JSON.stringify(evidence({ recipientRelationship: "not_direct", headerSignals: ["list_id"] })) },
        { id: "a_missing", accountId: "account_a", threadId: "thread_a", providerMessageId: "a-missing", receivedAt: new Date("2026-08-10T12:00:00.000Z"), humanClassificationEvidence: null },
        { id: "b_private", accountId: "account_b", threadId: "thread_b", providerMessageId: "b-private", receivedAt: new Date("2026-08-10T10:00:00.000Z"), humanClassificationEvidence: JSON.stringify(evidence()) },
      ]).run();

      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account_a", limit: 2, now: timestamp }), {
        accountId: "account_a",
        processed: 2,
        hasMore: true,
      });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account_a", now: timestamp }), {
        accountId: "account_a",
        processed: 1,
        hasMore: false,
      });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account_a", now: timestamp }), {
        accountId: "account_a",
        processed: 0,
        hasMore: false,
      });

      const rows = sqlite.query(
        `select id, human_signal, human_classification, human_classifier_version
         from emails
         order by id`,
      ).all() as Array<{
        id: string;
        human_signal: number | null;
        human_classification: string | null;
        human_classifier_version: string | null;
      }>;
      assert.deepEqual(rows, [
        { id: "a_bulk", human_signal: 2, human_classification: "automated_or_bulk", human_classifier_version: humanClassifierVersion },
        { id: "a_human", human_signal: 7, human_classification: "likely_human", human_classifier_version: humanClassifierVersion },
        { id: "a_missing", human_signal: null, human_classification: "unclassified", human_classifier_version: humanClassifierVersion },
        { id: "b_private", human_signal: null, human_classification: null, human_classifier_version: null },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
