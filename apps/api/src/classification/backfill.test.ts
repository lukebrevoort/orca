import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import * as schema from "../db/schema.ts";

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
  test("an all-current account checks only a covering index and does not hydrate evidence", () => {
    const { sqlite } = createMigratedClient();
    try {
      sqlite.exec(`
        INSERT INTO users(id,email) VALUES ('user','fixture@example.com');
        INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id)
          VALUES ('account','user','gmail','fixture@example.com','fixture');
        INSERT INTO threads(id,account_id,provider_thread_id) VALUES ('thread','account','thread');
      `);
      const insert = sqlite.prepare(`
        INSERT INTO emails(id,account_id,thread_id,provider_message_id,received_at,
          human_classifier_version,body_text,human_classification_evidence)
        VALUES (?,'account','thread',?,?,?, ?,?)
      `);
      sqlite.transaction(() => {
        for (let i = 0; i < 200; i++) {
          insert.run(String(i), String(i), i, humanClassifierVersion, "wide body".repeat(1000), JSON.stringify(evidence()));
        }
      })();
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const db = drizzle(sqlite, { schema, logger: {
        logQuery(sql, params) { queries.push({ sql, params }); },
      } });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 2 }), {
        accountId: "account", processed: 0, hasMore: false,
      });
      assert.equal(queries.length, 1, "zero stale rows must not issue an evidence hydration query");
      const lookup = queries[0]!;
      const plan = sqlite.query("EXPLAIN QUERY PLAN " + lookup.sql)
        .all(...lookup.params as SQLQueryBindings[]) as Array<{ detail: string }>;
      assert.ok(plan.some(({ detail }) => detail.includes("USING COVERING INDEX emails_account_classifier_lookup_idx")),
        JSON.stringify(plan));
      assert.doesNotMatch(lookup.sql, /human_classification_evidence/);
    } finally {
      sqlite.close();
    }
  });

  test("hydrates at most limit+1 stale IDs and processes received_at,id order across versions", () => {
    const { sqlite, db: fixtureDb } = createMigratedClient();
    try {
      fixtureDb.insert(users).values({ id: "user", email: "fixture@example.com" }).run();
      fixtureDb.insert(oauthAccounts).values({
        id: "account", userId: "user", provider: "gmail", providerEmail: "fixture@example.com", providerId: "fixture",
      }).run();
      fixtureDb.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      fixtureDb.insert(emails).values([
        { id: "z_undated", receivedAt: null, humanClassifierVersion: null },
        { id: "a_current", receivedAt: new Date(1), humanClassifierVersion },
        { id: "z_early", receivedAt: new Date(2), humanClassifierVersion: "old" },
        { id: "b_tied", receivedAt: new Date(3), humanClassifierVersion: "older" },
        { id: "a_tied", receivedAt: new Date(3), humanClassifierVersion: null },
        { id: "a_late", receivedAt: new Date(4), humanClassifierVersion: "old" },
      ].map((row) => ({
        ...row, accountId: "account", threadId: "thread", providerMessageId: row.id,
        humanClassificationEvidence: JSON.stringify(evidence()),
      }))).run();
      const queries: Array<{ sql: string; params: unknown[] }> = [];
      const db = drizzle(sqlite, { schema, logger: {
        logQuery(sql, params) { queries.push({ sql, params }); },
      } });
      const result = backfillHumanClassifications(db, { accountId: "account", limit: 3 });
      assert.deepEqual(result, { accountId: "account", processed: 3, hasMore: true });
      const hydration = queries.filter(({ sql }) => sql.startsWith("select") && sql.includes("human_classification_evidence"));
      assert.equal(hydration.length, 1);
      assert.deepEqual(hydration[0]!.params, ["z_undated", "z_early", "a_tied", "b_tied"]);
      const updates = queries.filter(({ sql }) => sql.startsWith("update"));
      const processedIds = updates.map(({ params }) => params.find((param) =>
        ["z_undated", "z_early", "a_tied", "b_tied", "a_late"].includes(String(param))));
      assert.deepEqual(processedIds, ["z_undated", "z_early", "a_tied"]);
      assert.deepEqual(sqlite.query(
        "select id from emails where human_classifier_version != ? or human_classifier_version is null order by received_at,id",
      ).all(humanClassifierVersion), [{ id: "b_tied" }, { id: "a_late" }]);
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 0 }), {
        accountId: "account", processed: 1, hasMore: true,
      });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 1 }), {
        accountId: "account", processed: 1, hasMore: false,
      });
    } finally {
      sqlite.close();
    }
  });

  test("caps an oversized request at 500 and hydrates only 501 candidates", () => {
    const { sqlite, db: fixtureDb } = createMigratedClient();
    try {
      fixtureDb.insert(users).values({ id: "user", email: "fixture@example.com" }).run();
      fixtureDb.insert(oauthAccounts).values({
        id: "account", userId: "user", provider: "gmail", providerEmail: "fixture@example.com", providerId: "fixture",
      }).run();
      fixtureDb.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      const insert = sqlite.prepare(`
        INSERT INTO emails(id,account_id,thread_id,provider_message_id,received_at)
        VALUES (?,'account','thread',?,?)
      `);
      sqlite.transaction(() => {
        for (let i = 0; i < 502; i++) insert.run(String(i), String(i), i);
      })();
      let hydratedIds: unknown[] = [];
      let hydrationPlan: unknown[] = [];
      const db = drizzle(sqlite, { schema, logger: {
        logQuery(sql, params) {
          if (sql.startsWith("select") && sql.includes("human_classification_evidence")) {
            hydratedIds = params;
            hydrationPlan = sqlite.query("EXPLAIN QUERY PLAN " + sql).all(...params as SQLQueryBindings[]);
          }
        },
      } });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 999 }), {
        accountId: "account", processed: 500, hasMore: true,
      });
      assert.match(JSON.stringify(hydrationPlan), /USING INDEX sqlite_autoindex_emails_1 \(id=\?\)/);
      assert.equal(hydratedIds.length, 501);
      assert.equal(hydratedIds.at(-1), "500");
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 999 }), {
        accountId: "account", processed: 2, hasMore: false,
      });
    } finally {
      sqlite.close();
    }
  });

  test("retries candidates changed between ID selection and hydration without overwriting sync", () => {
    const { sqlite, db: fixtureDb } = createMigratedClient();
    try {
      fixtureDb.insert(users).values({ id: "user", email: "fixture@example.com" }).run();
      fixtureDb.insert(oauthAccounts).values({
        id: "account", userId: "user", provider: "gmail", providerEmail: "fixture@example.com", providerId: "fixture",
      }).run();
      fixtureDb.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
      fixtureDb.insert(oauthAccounts).values({
        id: "other_account", userId: "user", provider: "gmail", providerEmail: "other@example.com", providerId: "other",
      }).run();
      fixtureDb.insert(threads).values({
        id: "other_thread", accountId: "other_account", providerThreadId: "other_thread",
      }).run();
      fixtureDb.insert(emails).values(["deleted", "refreshed", "reparented", "unchanged"].map((id) => ({
        id, accountId: "account", threadId: "thread", providerMessageId: id,
        receivedAt: new Date(1), humanClassificationEvidence: JSON.stringify(evidence()),
      }))).run();
      let refreshed = false;
      const db = drizzle(sqlite, { schema, logger: {
        logQuery(sql) {
          if (!refreshed && sql.startsWith("select") && sql.includes("human_classification_evidence")) {
            refreshed = true;
            sqlite.exec("DELETE FROM emails WHERE id = 'deleted'");
            fixtureDb.update(emails).set({
              accountId: "other_account", threadId: "other_thread",
            }).where(eq(emails.id, "reparented")).run();
            // Refresh the version alone: evidence equality must not defeat the version guard.
            fixtureDb.update(emails).set({
              humanClassifierVersion, humanClassification: "automated_or_bulk", humanSignal: 2,
            }).where(eq(emails.id, "refreshed")).run();
          }
        },
      } });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 4 }), {
        accountId: "account", processed: 1, hasMore: true,
      });
      assert.deepEqual(sqlite.query(
        "SELECT account_id, human_classifier_version, human_signal FROM emails WHERE id = 'reparented'",
      ).get(), { account_id: "other_account", human_classifier_version: null, human_signal: null });
      assert.deepEqual(sqlite.query("SELECT human_signal FROM emails WHERE id = 'refreshed'").get(), { human_signal: 2 });
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account", limit: 4 }), {
        accountId: "account", processed: 0, hasMore: false,
      });
    } finally {
      sqlite.close();
    }
  });

  test("upgrades a pre-index database without changing stored mail", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-classifier-upgrade-"));
    tempDirectories.push(directory);
    const partial = join(directory, "partial");
    mkdirSync(join(partial, "meta"), { recursive: true });
    const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const preceding = journal.entries.filter(({ idx }) => idx < 39);
    for (const entry of preceding) {
      writeFileSync(join(partial, entry.tag + ".sql"), readFileSync(join(migrationsFolder, entry.tag + ".sql")));
    }
    writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries: preceding }));
    const { db, sqlite } = createDatabaseClient(join(directory, "upgrade.sqlite"));
    try {
      migrate(db, { migrationsFolder: partial });
      sqlite.exec(`
        INSERT INTO users(id,email) VALUES ('user','fixture@example.com');
        INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id)
          VALUES ('account','user','gmail','fixture@example.com','fixture');
        INSERT INTO threads(id,account_id,provider_thread_id) VALUES ('thread','account','thread');
        INSERT INTO emails(id,account_id,thread_id,provider_message_id,body_text,human_classifier_version)
          VALUES ('email','account','thread','message','Synthetic upgrade fixture','old');
      `);
      assert.deepEqual(sqlite.query("PRAGMA index_info(emails_account_classifier_lookup_idx)").all(), []);
      const before = sqlite.query("SELECT * FROM emails").all();
      migrate(db, { migrationsFolder });
      migrate(db, { migrationsFolder });
      assert.deepEqual(sqlite.query("SELECT * FROM emails").all(), before);
      const columns = sqlite.query("PRAGMA index_info(emails_account_classifier_lookup_idx)").all() as Array<{ name: string }>;
      assert.deepEqual(columns.map(({ name }) => name), ["account_id", "human_classifier_version", "received_at", "id"]);
      assert.deepEqual(sqlite.query("PRAGMA foreign_key_check").all(), []);
      assert.deepEqual(backfillHumanClassifications(db, { accountId: "account" }), {
        accountId: "account", processed: 1, hasMore: false,
      });
    } finally {
      sqlite.close();
    }
  });

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
