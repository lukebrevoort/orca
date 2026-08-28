import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { digestRuleOrder } from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");

test("BRE-315 migration 0030 upgrades Rule order canonically and bootstraps the revisioned Rule Set", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-315-rule-order-"));
  const partial = join(directory, "partial");
  mkdirSync(join(partial, "meta"), { recursive: true });
  try {
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    for (const entry of journal.entries.filter(({ idx }) => idx <= 29)) {
      writeFileSync(join(partial, `${entry.tag}.sql`), readFileSync(join(migrations, `${entry.tag}.sql`)));
    }
    writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 29) }));

    const client = createDatabaseClient(join(directory, "ordering.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: partial });
      client.sqlite.exec("INSERT INTO users(id,email) VALUES ('owner','owner@example.com')");
      const insert = client.sqlite.query("INSERT INTO organization_rules(workspace_id,id,name,latest_revision,created_at,updated_at) VALUES ('owner',?,?,1,?,?)");
      insert.run("rule-z", "Third", 20, 20);
      insert.run("rule-b", "Second", 10, 10);
      insert.run("rule-a", "First", 10, 10);

      migrate(client.db, { migrationsFolder: migrations });
      migrate(client.db, { migrationsFolder: migrations });

      assert.deepEqual(client.sqlite.query("SELECT id,position FROM organization_rules WHERE workspace_id='owner' ORDER BY position").all(), [
        { id: "rule-a", position: 0 },
        { id: "rule-b", position: 1 },
        { id: "rule-z", position: 2 },
      ]);
      const root = client.sqlite.query("SELECT revision,rule_count,order_digest FROM organization_rule_sets WHERE workspace_id='owner'").get() as { revision: number; rule_count: number; order_digest: string };
      assert.equal(root.revision, 1);
      assert.equal(root.rule_count, 3);
      assert.equal(root.order_digest, digestRuleOrder(["rule-a", "rule-b", "rule-z"]));
      assert.throws(() => client.sqlite.query("UPDATE organization_rules SET position=0 WHERE workspace_id='owner' AND id='rule-z'").run());
      assert.throws(() => client.sqlite.query("INSERT INTO organization_rules(workspace_id,id,name,latest_revision,position) VALUES ('owner','rule-negative','No',1,-1)").run());
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);

      const withFuture = [...journal.entries, { idx: 31, tag: "0031_future" }];
      assert.deepEqual(withFuture.filter(({ idx }) => idx >= 26 && idx <= 30).map(({ idx, tag }) => ({ idx, tag })), [
        { idx: 26, tag: "0026_organization_lanes" },
        { idx: 27, tag: "0027_organization_live_views" },
        { idx: 28, tag: "0028_orca_rule_revisions" },
        { idx: 29, tag: "0029_orca_rule_evaluations" },
        { idx: 30, tag: "0030_rule_set_ordering" },
      ]);
    } finally { client.sqlite.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
