import { test, expect } from "bun:test";
import { setMobilePushTestEnv, clearMobilePushTestEnv, createMobilePushTestDb, seedAccount } from "../mobile-push/test-helpers.ts";
test("BRE-455 migration enforces owner/account/message boundaries and leaves stable importance migrations intact", () => {
  setMobilePushTestEnv(); const f = createMobilePushTestDb();
  try {
    seedAccount(f.sqlite, "u", "a"); seedAccount(f.sqlite, "v", "b");
    f.sqlite.query(`INSERT INTO important_notification_installations(user_id,channel,installation_id,session_id,enabled,permission,revision,generation,created_at,updated_at) VALUES('u','open_app','browser','session-u',1,'granted',1,1,1,1)`).run();
    expect(() => f.sqlite.query("INSERT INTO important_notification_accounts VALUES('u','open_app','browser','b',1,0,0)").run()).toThrow();
    expect(() => f.sqlite.query("INSERT INTO important_notification_accounts VALUES('u','open_app','unknown','a',1,0,0)").run()).toThrow();
    expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sqlite.query("SELECT count(*) n FROM important_notification_arrivals").get()).toEqual({ n: 0 });
    f.sqlite.query("DELETE FROM users WHERE id='u'").run();
    expect(f.sqlite.query("SELECT count(*) n FROM important_notification_installations").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
});

test("BRE-455 upgrade from installed parent0054 applies feature0055 once without skipping policy tables", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { createDatabaseClient } = await import("../db/client.ts"); const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const dir = mkdtempSync(join(tmpdir(), "orca-bre455-upgrade-")), client = createDatabaseClient(join(dir, "test.sqlite"));
  const source = resolve(import.meta.dir, "../../drizzle"), parent = join(dir, "parent"); mkdirSync(join(parent, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
  writeFileSync(join(parent, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 54) }));
  for (const file of readdirSync(source)) if (file.endsWith(".sql") && Number(file.slice(0, 4)) <= 54) copyFileSync(join(source, file), join(parent, file));
  try {
    migrate(client.db, { migrationsFolder: parent });
    expect(client.sqlite.query("SELECT name FROM sqlite_master WHERE name='important_notification_installations'").get()).toBeNull();
    expect(client.sqlite.query("SELECT max(created_at) timestamp FROM __drizzle_migrations").get()).toEqual({ timestamp: 1791907200000 });
    migrate(client.db, { migrationsFolder: source });
    expect(client.sqlite.query("SELECT name FROM sqlite_master WHERE name='important_notification_installations'").get()).toEqual({ name: "important_notification_installations" });
    expect(client.sqlite.query("SELECT max(created_at) timestamp FROM __drizzle_migrations").get()).toEqual({ timestamp: 1791993600000 });
    const before = client.sqlite.query("SELECT * FROM __drizzle_migrations").all(); migrate(client.db, { migrationsFolder: source });
    expect(client.sqlite.query("SELECT * FROM __drizzle_migrations").all()).toEqual(before); expect(client.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { client.sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
