import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { readConversationImportance } from "./store.ts";

test("BRE-454 additive migration backfills existing retained mail without changing legacy state; rerun is stable", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-importance-upgrade-"));
  const oldMigrations = join(dir, "baseline"); mkdirSync(join(oldMigrations, "meta"), { recursive: true });
  const migrations = resolve(import.meta.dir, "../../drizzle");
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
  writeFileSync(join(oldMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 52) }));
  for (const file of readdirSync(migrations)) if (file.endsWith(".sql") && Number(file.slice(0, 4)) < 52) copyFileSync(join(migrations, file), join(oldMigrations, file));
  const { db, sqlite } = createDatabaseClient(join(dir, "upgrade.sqlite"));
  try {
    migrate(db, { migrationsFolder: oldMigrations });
    sqlite.exec(`INSERT INTO users(id,email) VALUES('user','user@example.com');
      INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('account','user','gmail','account','user@example.com');
      INSERT INTO threads(id,account_id,provider_thread_id) VALUES('thread','account','thread');
      INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address) VALUES
      ('inbound','account','thread','inbound',' Robot@example.com '),
      ('duplicate','account','thread','duplicate','robot@example.com'),
      ('outbound','account','thread','outbound','user@example.com'),
      ('sent-alias','account','thread','sent-alias','alias@example.com');
      INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES('sent','account','SENT','Sent','system');
      INSERT INTO email_labels(id,email_id,label_id) VALUES('sent-link','sent-alias','sent');`);
    const mail = sqlite.query("SELECT * FROM emails ORDER BY id").all();
    const placement = sqlite.query("SELECT * FROM organization_effective_destinations").all();
    migrate(db, { migrationsFolder: migrations });
    expect(readConversationImportance(sqlite, "account", "thread")).toMatchObject({ effective: "unreviewed", conversation: { revision: 0 }, participantCounts: { total: 1, unreviewed: 1 } });
    expect(sqlite.query("SELECT address,message_count FROM importance_participants").all()).toEqual([{ address: "robot@example.com", message_count: 2 }]);
    sqlite.exec("INSERT INTO importance_choices VALUES('account','sender','robot@example.com','important',1,1000)");
    expect(readConversationImportance(sqlite, "account", "thread").effective).toBe("important");
    migrate(db, { migrationsFolder: migrations });
    expect(readConversationImportance(sqlite, "account", "thread").effective).toBe("important");
    expect(sqlite.query("SELECT * FROM emails ORDER BY id").all()).toEqual(mail);
    expect(sqlite.query("SELECT * FROM organization_effective_destinations").all()).toEqual(placement);
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
