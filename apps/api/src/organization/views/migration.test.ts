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
      assert.equal(journal.entries.at(-1)?.tag, "0027_organization_live_views");
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
