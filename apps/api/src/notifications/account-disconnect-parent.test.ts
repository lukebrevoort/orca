import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";

// Independent BRE-464 regression: no 0055 notification schema/fixtures required.
// Both historical baselines demonstrate the actual HTTP500 before applying 0054.
for (const cutoff of [51, 53]) test(`BRE-464 authenticated retained-mail disconnect on <=005${cutoff === 51 ? "1" : "3"} upgrades independently through 0054`, async () => {
  const prior = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "bre464-synthetic-session-secret-long-enough"; process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 14).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-bre464-"));
  const path = join(dir, "test.sqlite"), client = createDatabaseClient(path);
  const source = resolve(import.meta.dir, "../../drizzle");
  const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
  function subset(includeFix: boolean) {
    const destination = join(dir, includeFix ? "fixed" : "baseline"); mkdirSync(join(destination, "meta"), { recursive: true });
    const entries = journal.entries.filter((e: { idx: number }) => e.idx <= cutoff || (includeFix && e.idx === 54));
    writeFileSync(join(destination, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const file of readdirSync(source)) if (file.endsWith(".sql") && (Number(file.slice(0, 4)) <= cutoff || (includeFix && file.startsWith("0054_")))) copyFileSync(join(source, file), join(destination, file));
    return destination;
  }
  try {
    migrate(client.db, { migrationsFolder: subset(false) });
    client.sqlite.exec(`INSERT INTO users(id,email) VALUES('u','u@example.com'),('foreign','foreign@example.com');
      INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','u@example.com'),('b','foreign','gmail','b','foreign@example.com');
      INSERT INTO threads(id,account_id,provider_thread_id) VALUES('thread','a','thread'),('foreign-thread','b','thread');
      INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,is_read,received_at) VALUES('mail','a','thread','mail','person@example.com',0,1000),('foreign-mail','b','foreign-thread','mail','other@example.com',0,1000);
      INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES('inbox','a','INBOX','Inbox','system');
      INSERT INTO email_labels(id,email_id,label_id) VALUES('membership','mail','inbox');`);
    const session = await createSession(client.db, "u"); const headers = { cookie: `orca_session=${session.token}` };
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    expect((await app.request("/v1/accounts/b", { method: "DELETE", headers })).status).toBe(404);
    expect((await app.request("/v1/accounts/a", { method: "DELETE", headers })).status).toBe(500);
    // The failed statement rolls back every cascading delete.
    expect(client.sqlite.query("SELECT count(*) n FROM emails WHERE account_id='a'").get()).toEqual({ n: 1 });
    migrate(client.db, { migrationsFolder: subset(true) });
    const revision = () => (client.sqlite.query("SELECT revision FROM mailbox_revisions WHERE account_id='a'").get() as { revision: number }).revision;
    const before = revision(); client.sqlite.exec("DELETE FROM email_labels WHERE id='membership'"); expect(revision()).toBeGreaterThan(before);
    client.sqlite.exec("INSERT INTO email_labels(id,email_id,label_id) VALUES('membership','mail','inbox')");
    // Genuine invalid writes continue to fail their foreign-key checks.
    expect(() => client.sqlite.query("INSERT INTO mailbox_revisions(account_id,revision,updated_at) VALUES('missing',1,1)").run()).toThrow();
    const preThreadDelete = revision(); client.sqlite.exec("DELETE FROM threads WHERE id='thread'"); expect(revision()).toBeGreaterThan(preThreadDelete);
    client.sqlite.exec(`INSERT INTO threads(id,account_id,provider_thread_id) VALUES('thread','a','thread');
      INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,is_read,received_at) VALUES('mail-again','a','thread','mail-again','person@example.com',0,2000);
      INSERT INTO email_labels(id,email_id,label_id) VALUES('membership-again','mail-again','inbox');`);
    expect(revision()).toBeGreaterThan(preThreadDelete);
    expect((await app.request("/v1/accounts/a", { method: "DELETE", headers })).status).toBe(204);
    expect(client.sqlite.query("SELECT count(*) n FROM mailbox_revisions WHERE account_id='a'").get()).toEqual({ n: 0 });
    expect(client.sqlite.query("SELECT count(*) n FROM emails WHERE account_id='b'").get()).toEqual({ n: 1 });
    expect(client.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    if (cutoff === 53) for (const table of ["importance_message_state", "importance_participants", "importance_thread_state", "importance_operations"]) expect(client.sqlite.query(`SELECT count(*) n FROM ${table} WHERE account_id='a'`).get()).toEqual({ n: 0 });
  } finally { client.sqlite.close(); rmSync(dir, { recursive: true, force: true }); for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
