import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import type { HumanClassificationEvidence } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { emails, humanClassificationOverrides, oauthAccounts, threads, users } from "../db/schema.ts";
import { applyBackfillClassification, backfillHumanClassifications } from "./backfill.ts";
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

  test("retains account-scoped user corrections while automatic fields are reclassified", () => {
    const { db, sqlite } = createMigratedClient();
    try {
      db.insert(users).values({ id: "user", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail" }).run();
      db.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      db.insert(emails).values({
        id: "message",
        accountId: "account",
        threadId: "thread",
        providerMessageId: "message",
        receivedAt: new Date("2026-08-10T12:00:00.000Z"),
        humanClassificationEvidence: JSON.stringify(evidence({ recipientRelationship: "not_direct", headerSignals: ["list_id"] })),
      }).run();
      db.insert(humanClassificationOverrides).values({
        id: "override",
        accountId: "account",
        targetType: "message",
        targetValue: "message",
        classification: "likely_human",
        source: "user_choice",
      }).run();

      assert.equal(backfillHumanClassifications(db, { accountId: "account" }).processed, 1);
      const automatic = sqlite.query("select human_classification, human_signal from emails where id = 'message'").get() as {
        human_classification: string;
        human_signal: number;
      };
      assert.deepEqual(automatic, { human_classification: "automated_or_bulk", human_signal: 2 });
      assert.deepEqual(
        sqlite.query("select account_id, target_type, target_value, classification from human_classification_overrides where id = 'override'").get(),
        { account_id: "account", target_type: "message", target_value: "message", classification: "likely_human" },
      );
    } finally {
      sqlite.close();
    }
  });

  test("reclassifies persisted m5-v1 rows when metadata semantics change", () => {
    const { db, sqlite } = createMigratedClient();
    try {
      const timestamp = new Date("2026-08-10T12:00:00.000Z");
      db.insert(users).values({ id: "user", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "outlook", providerEmail: "luke@example.com", providerId: "outlook" }).run();
      db.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      db.insert(emails).values({
        id: "message",
        accountId: "account",
        threadId: "thread",
        providerMessageId: "message",
        receivedAt: timestamp,
        humanSignal: 4,
        humanClassification: "uncertain",
        humanClassificationReasons: JSON.stringify(["auto_submitted_header"]),
        humanClassifierVersion: "m5-v1",
        humanClassificationEvidence: JSON.stringify(evidence({
          headerSignals: ["x_auto_response_suppress"],
        })),
      }).run();

      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", now: timestamp }), {
        accountId: "account",
        processed: 1,
        hasMore: false,
      });
      assert.deepEqual(sqlite.query(
        "select human_signal, human_classification, human_classifier_version from emails where id = 'message'",
      ).get(), {
        human_signal: 7,
        human_classification: "likely_human",
        human_classifier_version: humanClassifierVersion,
      });
    } finally {
      sqlite.close();
    }
  });

  test("does not overwrite a sync refresh that lands after a batch row was selected", () => {
    const { db, sqlite } = createMigratedClient();
    try {
      const timestamp = new Date("2026-08-10T12:00:00.000Z");
      const selectedEvidence = JSON.stringify(evidence());
      const refreshedEvidence = JSON.stringify(evidence({
        recipientRelationship: "not_direct",
        headerSignals: ["list_id"],
      }));
      db.insert(users).values({ id: "user", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail" }).run();
      db.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      db.insert(emails).values({
        id: "message",
        accountId: "account",
        threadId: "thread",
        providerMessageId: "message",
        receivedAt: timestamp,
        humanClassificationEvidence: selectedEvidence,
        humanClassifierVersion: "m4-v0",
      }).run();

      const selected = db.select({
        id: emails.id,
        humanClassificationEvidence: emails.humanClassificationEvidence,
        humanClassifierVersion: emails.humanClassifierVersion,
      }).from(emails).where(eq(emails.id, "message")).get()!;
      db.update(emails).set({
        humanSignal: 2,
        humanClassification: "automated_or_bulk",
        humanClassificationReasons: JSON.stringify(["list_id_header"]),
        humanClassifierVersion,
        humanClassificationEvidence: refreshedEvidence,
        updatedAt: timestamp,
      }).where(eq(emails.id, "message")).run();

      assert.equal(applyBackfillClassification(db, {
        accountId: "account",
        row: selected,
        updatedAt: timestamp,
      }), false);
      assert.deepEqual(sqlite.query(
        "select human_signal, human_classification, human_classifier_version, human_classification_evidence from emails where id = 'message'",
      ).get(), {
        human_signal: 2,
        human_classification: "automated_or_bulk",
        human_classifier_version: humanClassifierVersion,
        human_classification_evidence: refreshedEvidence,
      });
    } finally {
      sqlite.close();
    }
  });
});
