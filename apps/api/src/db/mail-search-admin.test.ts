import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";

const script = new URL("./mail-search-admin.ts", import.meta.url).pathname;
function run(...args: string[]) {
  return Bun.spawnSync({ cmd: [process.execPath, script, ...args], stdout: "pipe", stderr: "pipe" });
}

test("admin refuses missing/nonexistent targets and malformed options without creating a database", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-admin-test-"));
  try {
    const path = join(directory, "missing.sqlite");
    for (const args of [["status"], ["--database", path, "status"], ["--database", path, "backfill", "--batch-rows"], ["--database", path, "status", "--surprise", "1"]]) {
      const result = run(...args);
      assert.notEqual(result.exitCode, 0);
      assert.equal(existsSync(path), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

test("admin rehearsal builds, verifies, enables and disables only the explicitly named disposable database", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-admin-test-"));
  try {
    const path = join(directory, "mail.sqlite");
    const sqlite = new Database(path);
    sqlite.exec(`pragma foreign_keys=ON;
      create table oauth_accounts(id text primary key, user_id text not null);
      create table emails(id text primary key, account_id text not null references oauth_accounts(id) on delete cascade,
        from_name text, from_address text, subject text, snippet text, body_text text);
      insert into oauth_accounts values('a','owner');
      insert into emails(id,account_id,body_text) values('first','a','hello'),('second','a','world');`);
    sqlite.exec(readFileSync(new URL("../../drizzle/0051_indexed_mail_search.sql", import.meta.url), "utf8"));
    sqlite.close();
    const invoke = (...args: string[]) => {
      const result = run("--database", path, ...args);
      assert.equal(result.exitCode, 0, result.stderr.toString());
      return result.stdout.toString();
    };
    assert.equal(JSON.parse(invoke("status")).enabled, false);
    assert.equal(run("--database", path, "enable").exitCode, 1);
    assert.match(invoke("backfill", "--batch-rows", "1"), /"complete":false/);
    assert.match(invoke("backfill", "--batch-rows", "1", "--max-batches", "2", "--pause-ms", "0"), /"complete":true/);
    assert.equal(JSON.parse(invoke("verify")).enabled, false);
    assert.equal(JSON.parse(invoke("enable")).enabled, true);
    const disabled = JSON.parse(invoke("disable"));
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.canonicalMessages, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
