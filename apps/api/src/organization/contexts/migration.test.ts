import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, threads, users } from "../../db/schema.ts";

const fullMigrations = resolve(import.meta.dir, "../../../drizzle");

describe("BRE-312 Context migration", () => {
  test("is journal-ordered, fresh-safe, and foreign-key clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-312-fresh-"));
    const client = createDatabaseClient(join(directory, "fresh.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: fullMigrations });
      const journal = JSON.parse(readFileSync(join(fullMigrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      assert.equal(journal.entries.at(-1)?.idx, 26);
      assert.equal(journal.entries.at(-1)?.tag, "0026_oauth_transactions");
      const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      for (const table of ["organization_context_types", "organization_context_relationship_types", "organization_contexts", "organization_thread_context_relationships", "organization_change_actions"]) {
        assert.equal(tables.some((item) => item.name === table), true, table);
      }
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("upgrades 0024, replays safely, and rejects cross-Workspace and mismatched typed edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-312-upgrade-"));
    const partialMigrations = join(directory, "migrations");
    mkdirSync(join(partialMigrations, "meta"), { recursive: true });
    try {
      const journal = JSON.parse(readFileSync(join(fullMigrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
      for (const entry of journal.entries.filter((item) => item.idx <= 24)) writeFileSync(join(partialMigrations, `${entry.tag}.sql`), readFileSync(join(fullMigrations, `${entry.tag}.sql`)));
      writeFileSync(join(partialMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 24) }));
      const client = createDatabaseClient(join(directory, "upgrade.sqlite"));
      try {
        migrate(client.db, { migrationsFolder: partialMigrations });
        migrate(client.db, { migrationsFolder: fullMigrations });
        migrate(client.db, { migrationsFolder: fullMigrations });
        client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
        client.db.insert(oauthAccounts).values([
          { id: "account_owner", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "owner" },
          { id: "account_private", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private" },
        ]).run();
        client.db.insert(threads).values([
          { id: "thread_owner", accountId: "account_owner", providerThreadId: "owner", subject: "Owner" },
          { id: "thread_private", accountId: "account_private", providerThreadId: "private", subject: "Private" },
        ]).run();
        client.sqlite.exec(`
          INSERT INTO organization_context_types (workspace_id,id,name,position) VALUES ('owner','type_project','Project',0),('owner','type_customer','Customer',1);
          INSERT INTO organization_context_relationship_types (workspace_id,id,context_type_id,name,inverse_name,direction,position,maximum_per_thread) VALUES ('owner','rel_project','type_project','concerns','has incident','thread_to_context',0,4);
          INSERT INTO organization_contexts (workspace_id,id,context_type_id,name) VALUES ('owner','context_customer','type_customer','Acme');
        `);
        assert.throws(() => client.sqlite.exec("INSERT INTO organization_thread_context_relationships (workspace_id,id,account_id,thread_id,context_type_id,context_id,relationship_type_id,direction) VALUES ('owner','edge_mismatch','account_owner','thread_owner','type_project','context_customer','rel_project','thread_to_context')"));
        client.sqlite.exec("INSERT INTO organization_contexts (workspace_id,id,context_type_id,name) VALUES ('owner','context_project','type_project','Orca')");
        assert.throws(() => client.sqlite.exec("INSERT INTO organization_thread_context_relationships (workspace_id,id,account_id,thread_id,context_type_id,context_id,relationship_type_id,direction) VALUES ('owner','edge_direction','account_owner','thread_owner','type_project','context_project','rel_project','context_to_thread')"));
        assert.throws(() => client.sqlite.exec("INSERT INTO organization_thread_context_relationships (workspace_id,id,account_id,thread_id,context_type_id,context_id,relationship_type_id,direction) VALUES ('owner','edge_private','account_private','thread_private','type_project','context_project','rel_project','thread_to_context')"));
        assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
      } finally {
        client.sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
