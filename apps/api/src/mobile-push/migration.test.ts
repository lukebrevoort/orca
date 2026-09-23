import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";

const migrations = resolve(import.meta.dir, "../../drizzle");

test("mobile push commit-order migration replays from the earliest unprocessed sequence", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-mobile-push-migration-"));
  const partial = join(directory, "partial");
  mkdirSync(join(partial, "meta"), { recursive: true });
  try {
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
    };
    assert.deepEqual(journal.entries.find(({ idx }) => idx === 48), {
      idx: 48,
      version: "7",
      when: 1790035200000,
      tag: "0048_mobile_push_commit_order",
      breakpoints: true,
    });
    assert.deepEqual(journal.entries.find(({ idx }) => idx === 49), {
      idx: 49,
      version: "7",
      when: 1790121600000,
      tag: "0049_mobile_push_destinations",
      breakpoints: true,
    });
    for (const entry of journal.entries.filter(({ idx }) => idx <= 47)) {
      writeFileSync(join(partial, `${entry.tag}.sql`), readFileSync(join(migrations, `${entry.tag}.sql`)));
    }
    writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({
      ...journal,
      entries: journal.entries.filter(({ idx }) => idx <= 47),
    }));

    const client = createDatabaseClient(join(directory, "upgrade.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: partial });
      client.sqlite.exec(`
        INSERT INTO users(id,email,created_at) VALUES ('user','user@example.com',1);
        INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES ('session','user',9999999999999,1);
        INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id,created_at,updated_at)
          VALUES ('account','user','gmail','user@example.com','provider-user',1,1);
        INSERT INTO threads(id,account_id,provider_thread_id,created_at,updated_at)
          VALUES ('thread','account','thread',1,1);
        INSERT INTO emails(id,account_id,thread_id,provider_message_id,created_at,updated_at) VALUES
          ('newer-first','account','thread','newer-first',3000,3000),
          ('watermark-second','account','thread','watermark-second',2000,2000);
        INSERT INTO mobile_push_devices(user_id,installation_id,session_id,token_encrypted,token_hash,environment,notification_mode,
          generation,eligible_after_at,watermark_created_at,watermark_email_id,registered_at,last_seen_at,updated_at) VALUES
          ('user','phone-replay','session','encrypted','hash-replay','sandbox','all',1,1000,2000,'watermark-second',1000,1000,1000),
          ('user','phone-current','session','encrypted','hash-current','sandbox','all',1,1000,3000,'newer-first',1000,1000,1000),
          ('user','phone-human','session','encrypted','hash-human','sandbox','human',1,1000,3000,'newer-first',1000,1000,1000),
          ('user','phone-off','session','encrypted','hash-off','sandbox','off',1,1000,3000,'newer-first',1000,1000,1000);
      `);

      migrate(client.db, { migrationsFolder: migrations });
      const watermark = (client.sqlite.query("SELECT watermark_sequence AS value FROM mobile_push_devices WHERE installation_id='phone-replay'").get() as { value: number }).value;
      assert.equal(watermark, 0);
      assert.equal((client.sqlite.query("SELECT watermark_sequence AS value FROM mobile_push_devices WHERE installation_id='phone-current'").get() as { value: number }).value, 2);
      assert.deepEqual(client.sqlite.query("SELECT installation_id AS installationId,notify_inbox AS notifyInbox FROM mobile_push_devices ORDER BY installation_id").all(), [
        { installationId: "phone-current", notifyInbox: 1 },
        { installationId: "phone-human", notifyInbox: 1 },
        { installationId: "phone-off", notifyInbox: 0 },
        { installationId: "phone-replay", notifyInbox: 1 },
      ]);
      assert.deepEqual(client.sqlite.query("SELECT email_id AS emailId FROM mobile_push_email_sequence WHERE sequence>? ORDER BY sequence").all(watermark), [
        { emailId: "newer-first" },
        { emailId: "watermark-second" },
      ]);
      client.sqlite.query("INSERT INTO emails(id,account_id,thread_id,provider_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run("after", "account", "thread", "after", 1_000, 1_000);
      assert.deepEqual(client.sqlite.query("SELECT email_id AS emailId,sequence FROM mobile_push_email_sequence ORDER BY sequence").all(), [
        { emailId: "newer-first", sequence: 1 },
        { emailId: "watermark-second", sequence: 2 },
        { emailId: "after", sequence: 3 },
      ]);
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      client.sqlite.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
