import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";

describe("BRE-313 Views migration", () => {
  test("stores definitions without membership and installs supporting query indexes", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-313-views-migration-"));
    const migrations = resolve(import.meta.dir, "../../../drizzle");
    const client = createDatabaseClient(join(directory, "views.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: migrations });
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      assert.deepEqual(journal.entries.find((entry) => entry.idx === 27), {
        idx: 27,
        version: "7",
        when: 1787702400000,
        tag: "0027_organization_live_views",
        breakpoints: true,
      });
      const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'organization_view%' ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map((item) => item.name), ["organization_views"]);
      const indexes = client.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('organization_views_workspace_position_unique_idx','organization_thread_facet_values_lookup_idx','emails_thread_view_evidence_idx','threads_view_order_idx') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(indexes.map((item) => item.name), ["emails_thread_view_evidence_idx", "organization_thread_facet_values_lookup_idx", "organization_views_workspace_position_unique_idx", "threads_view_order_idx"]);
      const ordering = client.sqlite.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='threads_view_order_idx'").get() as { sql: string };
      assert.match(ordering.sql, /COALESCE\(`latest_received_at`,`created_at`\) DESC,`account_id`,`id`/);
      client.sqlite.query("INSERT INTO users (id,email,display_name,created_at) VALUES ('position_owner','position@example.com',NULL,0)").run();
      const insert = client.sqlite.query("INSERT INTO organization_views (workspace_id,id,name,description,color,position,definition,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
      insert.run("position_owner", "first", "First", "", "#0b9b84", 0, JSON.stringify({ revision: 1 }), 1, 0, 0);
      assert.throws(() => insert.run("position_owner", "duplicate", "Duplicate", "", "#0b9b84", 0, JSON.stringify({ revision: 1 }), 1, 0, 0));
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("Inbox policy upgrades old views default-off and persists opt-in across reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-view-policy-migration-"));
  const path = join(directory, "views.sqlite");
  const folder = resolve(import.meta.dir, "../../../drizzle");
  let client = createDatabaseClient(path);
  try {
    const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    for (const migration of journal.entries.filter(entry => entry.idx < 45)) client.sqlite.exec(readFileSync(join(folder, `${migration.tag}.sql`), "utf8"));
    client.sqlite.exec(`INSERT INTO users(id,email) VALUES ('owner','owner@example.com');
      INSERT INTO organization_views(workspace_id,id,name,color,position,definition) VALUES ('owner','old','Old','#0b9b84',0,'{"revision":1}');`);
    client.sqlite.exec(readFileSync(join(folder, "0045_view_inbox_policy.sql"), "utf8"));
    assert.deepEqual(client.sqlite.query("SELECT skip_inbox FROM organization_views WHERE id='old'").get(), { skip_inbox: 0 });
    assert.throws(() => client.sqlite.exec("UPDATE organization_views SET skip_inbox=2"));
    client.sqlite.exec("UPDATE organization_views SET skip_inbox=1 WHERE id='old'");
    client.sqlite.close();
    client = createDatabaseClient(path);
    assert.deepEqual(client.sqlite.query("SELECT skip_inbox FROM organization_views WHERE id='old'").get(), { skip_inbox: 1 });
  } finally {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
