import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");

test("BRE-315 Trace migration is ordered, Account-bound, Event-idempotent, and immutable", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-315-migration-"));
  const client = createDatabaseClient(join(directory, "trace.sqlite"));
  try {
    migrate(client.db, { migrationsFolder: migrations });
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    assert.equal(journal.entries.find((entry) => entry.idx === 29)?.tag, "0029_orca_rule_evaluations");
    client.sqlite.exec("INSERT INTO users(id,email) VALUES ('owner','owner@example.com'),('private','private@example.com')");
    client.sqlite.exec("INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id) VALUES ('account-owner','owner','gmail','owner@example.com','owner'),('account-private','private','gmail','private@example.com','private')");
    client.sqlite.exec("INSERT INTO threads(id,account_id,provider_thread_id) VALUES ('thread-owner','account-owner','owner'),('thread-private','account-private','private')");
    const trace = JSON.stringify({ test: true }).replaceAll("'", "''");
    client.sqlite.exec(`INSERT INTO organization_evaluation_traces(workspace_id,id,account_id,thread_id,event_id,event_kind,rule_set_revision,trace_json,actions_json,logical_time,created_at) VALUES ('owner','trace-1','account-owner','thread-owner','event-1','message.received',1,'${trace}','[]',1,1)`);
    assert.throws(() => client.sqlite.exec("UPDATE organization_evaluation_traces SET trace_json = '{}' WHERE id = 'trace-1'"), /immutable/);
    assert.throws(() => client.sqlite.exec("DELETE FROM organization_evaluation_traces WHERE id = 'trace-1'"), /immutable/);
    assert.throws(() => client.sqlite.exec(`INSERT INTO organization_evaluation_traces(workspace_id,id,account_id,thread_id,event_id,event_kind,rule_set_revision,trace_json,actions_json,logical_time,created_at) VALUES ('owner','trace-2','account-owner','thread-owner','event-1','message.received',1,'${trace}','[]',1,1)`));
    assert.throws(() => client.sqlite.exec(`INSERT INTO organization_evaluation_traces(workspace_id,id,account_id,thread_id,event_id,event_kind,rule_set_revision,trace_json,actions_json,logical_time,created_at) VALUES ('owner','trace-3','account-private','thread-private','event-3','message.received',1,'${trace}','[]',1,1)`));
    assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
  } finally {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
