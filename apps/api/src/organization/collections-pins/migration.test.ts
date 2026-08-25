import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

import { createSession } from "../../auth/session-store.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

describe("BRE-309 clean M8 migration", () => {
  test("backfills legacy filter Pins with stable saved-query identity without discarding their definition", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-309-migration-"));
    const sqlite = new Database(join(directory, "legacy.sqlite"));
    try {
      sqlite.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id text PRIMARY KEY NOT NULL);
        CREATE TABLE oauth_accounts (id text PRIMARY KEY NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE threads (id text PRIMARY KEY NOT NULL, account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE);
        CREATE TABLE collections (
          id text PRIMARY KEY NOT NULL,
          account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
          name text NOT NULL,
          color text NOT NULL,
          position integer NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        CREATE TABLE pins (
          id text PRIMARY KEY NOT NULL,
          account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
          kind text NOT NULL,
          target_id text NOT NULL,
          label text NOT NULL,
          icon text NOT NULL,
          color text NOT NULL,
          position integer NOT NULL,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        );
        INSERT INTO users (id) VALUES ('workspace_1');
        INSERT INTO oauth_accounts (id, user_id) VALUES ('account_1', 'workspace_1');
        INSERT INTO pins (id, account_id, kind, target_id, label, icon, color, position, created_at, updated_at)
        VALUES (
          'pin_legacy',
          'account_1',
          'filter',
          '{"mailbox":"focus","attention":"focus","classification":"human","person":null,"query":"launch"}',
          'Launch',
          'search',
          '#70867d',
          0,
          1787500000000,
          1787500000000
        ), (
          'pin_same_label',
          'account_1',
          'filter',
          '{"mailbox":"all","attention":"all","classification":"all","person":null,"query":"roadmap"}',
          'Launch',
          'search',
          '#70867d',
          1,
          1787500000000,
          1787500000000
        );
      `);
      const migration = readFileSync(resolve(import.meta.dir, "../../../drizzle/0024_organization_collections_pins.sql"), "utf8");
      for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) sqlite.exec(statement);

      const pin = sqlite.query("SELECT target_id, target_type, saved_query_id, revision FROM pins WHERE id = 'pin_legacy'").get() as Record<string, unknown>;
      assert.equal(pin.target_type, "query");
      assert.equal(pin.saved_query_id, "query:legacy:pin_legacy");
      assert.equal(pin.revision, 1);
      assert.equal(String(pin.target_id).includes("mailbox"), true);

      const query = sqlite.query("SELECT id, definition_json FROM organization_saved_queries WHERE id = 'query:legacy:pin_legacy'").get() as Record<string, unknown>;
      assert.equal(query.id, "query:legacy:pin_legacy");
      assert.equal(String(query.definition_json).includes("launch"), true);
      const sameNameQueries = sqlite.query("SELECT COUNT(*) AS count FROM organization_saved_queries WHERE name = 'Launch'").get() as { count: number };
      assert.equal(sameNameQueries.count, 2);
      assert.equal(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organization_collection_pin_audits'").get() !== null, true);
      const journal = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../drizzle/meta/_journal.json"), "utf8")) as {
        entries: Array<{ idx: number; tag: string }>;
      };
      assert.deepEqual(journal.entries.at(-1), {
        idx: 24,
        version: "6",
        when: 1787551200001,
        tag: "0024_organization_collections_pins",
        breakpoints: true,
      });
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("upgrades a database already at 0023 through the complete journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-309-from-0023-"));
    const partialMigrations = join(directory, "migrations");
    const fullMigrations = resolve(import.meta.dir, "../../../drizzle");
    mkdirSync(join(partialMigrations, "meta"), { recursive: true });
    try {
      const journal = JSON.parse(readFileSync(join(fullMigrations, "meta/_journal.json"), "utf8")) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      for (const entry of journal.entries.filter((item) => item.idx <= 23)) {
        writeFileSync(join(partialMigrations, `${entry.tag}.sql`), readFileSync(join(fullMigrations, `${entry.tag}.sql`)));
      }
      writeFileSync(join(partialMigrations, "meta/_journal.json"), JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 23),
      }));

      const { createDatabaseClient } = await import("../../db/client.ts");
      const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
      const databasePath = join(directory, "from-0023.sqlite");
      const client = createDatabaseClient(databasePath);
      try {
        migrate(client.db, { migrationsFolder: partialMigrations });
        const legacyFilter = JSON.stringify({
          mailbox: "focus", attention: "focus", classification: "human", person: null, query: "launch",
        });
        client.db.insert(users).values({ id: "workspace_migrated", email: "migrated@example.com" }).run();
        client.db.insert(oauthAccounts).values({
          id: "account_migrated", userId: "workspace_migrated", provider: "gmail",
          providerEmail: "migrated@example.com", providerId: "provider-migrated",
        }).run();
        client.sqlite.query(`
          INSERT INTO pins (id, account_id, kind, target_id, label, icon, color, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run("pin_migrated", "account_migrated", "filter", legacyFilter, "Migrated", "search", "#70867d", 0, 1787500000000, 1787500000000);
        migrate(client.db, { migrationsFolder: fullMigrations });
        const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        assert.equal(tables.some((table) => table.name === "organization_saved_queries"), true);
        assert.equal(tables.some((table) => table.name === "organization_collection_pin_audits"), true);
        const pinColumns = client.sqlite.query("PRAGMA table_info('pins')").all() as Array<{ name: string }>;
        assert.equal(pinColumns.some((column) => column.name === "saved_query_id"), true);

        process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
        process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 30).toString("base64");
        const session = await createSession(client.db, "workspace_migrated");
        const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });
        const response = await app.request("/v1/pins", { headers: { cookie: `orca_session=${session.token}` } });
        assert.equal(response.status, 200);
        const migratedPin = (await response.json()).find((item: { id: string }) => item.id === "pin_migrated");
        assert.deepEqual(JSON.parse(migratedPin.targetId), JSON.parse(legacyFilter));
      } finally {
        delete process.env.SESSION_SECRET;
        delete process.env.TOKEN_ENCRYPTION_KEY;
        client.sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
