import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");

test("BRE-368 migration upgrades existing mail with durable coordinator tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-sync-coordinator-migration-"));
  const partial = join(directory, "partial");
  mkdirSync(join(partial, "meta"), { recursive: true });
  try {
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    assert.deepEqual(journal.entries.find(({ idx }) => idx === 37), {
      idx: 37,
      version: "7",
      when: 1788426000000,
      tag: "0037_gmail_sync_coordinator",
      breakpoints: true,
    });
    for (const entry of journal.entries.filter(({ idx }) => idx <= 36)) {
      writeFileSync(join(partial, `${entry.tag}.sql`), readFileSync(join(migrations, `${entry.tag}.sql`)));
    }
    writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({
      ...journal,
      entries: journal.entries.filter(({ idx }) => idx <= 36),
    }));

    const client = createDatabaseClient(join(directory, "upgrade.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: partial });
      client.sqlite.exec(`
        INSERT INTO users(id,email) VALUES ('user','user@example.com');
        INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id) VALUES ('account','user','gmail','user@example.com','provider-user');
        INSERT INTO threads(id,account_id,provider_thread_id,subject) VALUES ('thread','account','provider-thread','Before upgrade');
        INSERT INTO emails(id,account_id,thread_id,provider_message_id,subject) VALUES ('email','account','thread','provider-message','Before upgrade');
      `);

      migrate(client.db, { migrationsFolder: migrations });
      migrate(client.db, { migrationsFolder: migrations });

      const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gmail_sync_jobs','gmail_sync_runs') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map(({ name }) => name), ["gmail_sync_jobs", "gmail_sync_runs"]);
      const emailColumns = client.sqlite.query("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
      assert.ok(emailColumns.some(({ name }) => name === "provider_snapshot_digest"));
      assert.deepEqual(client.sqlite.query("SELECT id,subject,provider_snapshot_digest FROM emails").get(), {
        id: "email",
        subject: "Before upgrade",
        provider_snapshot_digest: null,
      });
      client.sqlite.exec(`
        INSERT INTO gmail_sync_jobs(account_id,state,pending_sources) VALUES ('account','queued',1);
        INSERT INTO gmail_sync_runs(id,account_id,request_version,lease_version,sources,status,started_at,finished_at) VALUES ('run','account',1,1,1,'succeeded',1,2);
      `);
      assert.throws(() => client.sqlite.exec("UPDATE gmail_sync_jobs SET state='invalid' WHERE account_id='account'"));
      client.sqlite.exec("DELETE FROM oauth_accounts WHERE id='account'");
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM gmail_sync_jobs").get() as { count: number }).count, 0);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM gmail_sync_runs").get() as { count: number }).count, 0);
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      client.sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
