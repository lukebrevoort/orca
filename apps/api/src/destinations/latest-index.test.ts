import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";

const migrations = resolve(import.meta.dir, "../../drizzle");
const indexName = "emails_thread_latest_destination_idx";
const latestSql = `SELECT id FROM emails WHERE account_id='account' AND thread_id='thread'
  ORDER BY received_at DESC, created_at DESC, id ASC LIMIT 1`;

for (const upgrade of [false, true]) {
  test(`latest destination index preserves deterministic sender ordering on ${upgrade ? "0042 upgrade" : "fresh initialization"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-destination-index-"));
    const { db, sqlite } = createDatabaseClient(join(directory, "index.sqlite"));
    try {
      if (upgrade) {
        const baseline = join(directory, "baseline");
        mkdirSync(join(baseline, "meta"), { recursive: true });
        const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
        journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 42);
        for (const entry of journal.entries) copyFileSync(join(migrations, `${entry.tag}.sql`), join(baseline, `${entry.tag}.sql`));
        writeFileSync(join(baseline, "meta/_journal.json"), JSON.stringify(journal));
        migrate(db, { migrationsFolder: baseline });
        expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(indexName)).toBeNull();
      } else {
        migrate(db, { migrationsFolder: migrations });
      }
      sqlite.run("INSERT INTO users(id,email) VALUES ('owner','owner@example.com')");
      sqlite.run("INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id) VALUES ('account','owner','gmail','owner@example.com','provider')");
      sqlite.run("INSERT INTO threads(id,account_id,provider_thread_id) VALUES ('thread','account','thread')");
      const insert = sqlite.query("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,received_at,created_at) VALUES (?,'account','thread',?,?,?,?)");
      insert.run("null-time", "null-time", "null@example.com", null, 9000);
      insert.run("older-received", "older-received", "older@example.com", 999, 9000);
      insert.run("older-created", "older-created", "created@example.com", 1000, 1000);
      insert.run("tie-z", "tie-z", "z@example.com", 1000, 2000);
      insert.run("tie-a", "tie-a", "a@example.com", 1000, 2000);
      expect(sqlite.query(latestSql).get()).toEqual({ id: "tie-a" });
      const before = sqlite.query("SELECT id,from_address,received_at,created_at FROM emails ORDER BY id").all();
      const fallback = sqlite.query("SELECT fallback_lane_id FROM organization_workspace_lane_settings WHERE workspace_id='owner'").get();
      if (upgrade) migrate(db, { migrationsFolder: migrations });
      expect(sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(indexName)).toEqual({ name: indexName });
      const plan = sqlite.query(`EXPLAIN QUERY PLAN ${latestSql}`).all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes(indexName))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
      expect(sqlite.query(latestSql).get()).toEqual({ id: "tie-a" });
      expect(sqlite.query("SELECT id,from_address,received_at,created_at FROM emails ORDER BY id").all()).toEqual(before);
      expect(sqlite.query("SELECT fallback_lane_id FROM organization_workspace_lane_settings WHERE workspace_id='owner'").get()).toEqual(fallback);
      migrate(db, { migrationsFolder: migrations });
      expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
