import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";

const migrations = resolve(import.meta.dir, "../../drizzle");

describe("BRE-319 G2 migration", () => {
  test("is journal-ordered, fresh/0032-upgrade safe, replay-safe, bounded-schema, and foreign-key clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-g2-migration-"));
    const partial = join(directory, "migrations");
    mkdirSync(join(partial, "meta"), { recursive: true });
    try {
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      assert.deepEqual(journal.entries.find((entry) => entry.idx === 33), {
        idx: 33, version: "7", when: 1787756400000, tag: "0033_g2_authority_concurrency", breakpoints: true,
      });
      for (const entry of journal.entries.filter((item) => item.idx <= 32)) {
        writeFileSync(join(partial, `${entry.tag}.sql`), readFileSync(join(migrations, `${entry.tag}.sql`)));
      }
      writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 32),
      }));

      const client = createDatabaseClient(join(directory, "upgrade.sqlite"));
      try {
        migrate(client.db, { migrationsFolder: partial });
        client.sqlite.exec(`
          INSERT INTO users (id,email) VALUES ('workspace','owner@example.com');
          INSERT INTO mcp_oauth_clients (id,name,redirect_uris) VALUES ('client','Client','[]');
          INSERT INTO oauth_accounts (id,user_id,provider,provider_email,provider_id) VALUES ('account','workspace','gmail','owner@example.com','provider');
          INSERT INTO mcp_connections (id,user_id,client_id,resource,scopes) VALUES ('connection','workspace','client','https://api.orca.test/mcp','organization:control');
          INSERT INTO mcp_connection_accounts (id,connection_id,account_id) VALUES ('binding','connection','account');
        `);
        migrate(client.db, { migrationsFolder: migrations });
        migrate(client.db, { migrationsFolder: migrations });
        const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mcp_organization_approvals','organization_mutation_attempts') ORDER BY name").all() as Array<{ name: string }>;
        assert.deepEqual(tables.map(({ name }) => name), ["mcp_organization_approvals", "organization_mutation_attempts"]);
        const indexes = client.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%organization_%' ORDER BY name").all() as Array<{ name: string }>;
        assert.ok(indexes.some(({ name }) => name === "mcp_organization_approvals_connection_simulation_unique_idx"));
        assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='mcp_connections_workspace_connection_unique_idx'").get() as { count: number }).count, 1);
        assert.ok(indexes.some(({ name }) => name === "organization_mutation_attempts_workspace_operation_key_unique_idx"));
        const attemptColumns = client.sqlite.query("PRAGMA table_info(organization_mutation_attempts)").all() as Array<{ name: string }>;
        assert.equal(attemptColumns.some(({ name }) => /token|bearer|secret|body|payload|source|message/i.test(name)), false);
        assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM mcp_connections WHERE id='connection'").get() as { count: number }).count, 1);
        client.sqlite.exec("INSERT INTO users (id,email) VALUES ('other-workspace','other@example.com')");
        assert.throws(() => client.sqlite.query(`
          INSERT INTO mcp_organization_approvals (
            id,workspace_id,connection_id,client_id,approver_user_id,operation,account_ids_digest,
            command_digest,simulation_id,risk,revisions_json,expires_at,consumed_at,consumed_by_idempotency_key
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run("cross-workspace", "other-workspace", "connection", "client", "other-workspace", "apply", "digest", "digest", "simulation", "low", "{}", 9_999_999_999_999, 1, "key"), /FOREIGN KEY constraint failed/);
        assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
        assert.equal((client.sqlite.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
        assert.equal((client.sqlite.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5_000);
      } finally { client.sqlite.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
