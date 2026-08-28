import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");

describe("BRE-314 Rule Revision migration", () => {
  test("is journal ordered and makes persisted revisions append-only", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-314-rules-"));
    const client = createDatabaseClient(join(directory, "rules.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: migrations });
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      const journalWithLaterMigration = [...journal.entries, {
        idx: 31,
        version: "7",
        when: 1787702400003,
        tag: "0031_future_migration",
        breakpoints: true,
      }];
      const stackedChain = [26, 27, 28, 29].map((idx) => {
        const entry = journalWithLaterMigration.find((candidate) => candidate.idx === idx);
        assert.ok(entry, `missing migration journal entry ${idx}`);
        return { idx: entry.idx, tag: entry.tag };
      });
      assert.deepEqual(stackedChain, [
        { idx: 26, tag: "0026_organization_lanes" },
        { idx: 27, tag: "0027_organization_live_views" },
        { idx: 28, tag: "0028_orca_rule_revisions" },
        { idx: 29, tag: "0029_orca_rule_evaluations" },
      ]);
      assert.deepEqual(journalWithLaterMigration.find((entry) => entry.idx === 28), {
        idx: 28,
        version: "7",
        when: 1787702400001,
        tag: "0028_orca_rule_revisions",
        breakpoints: true,
      });
      assert.deepEqual(journalWithLaterMigration.find((entry) => entry.idx === 29), {
        idx: 29,
        version: "7",
        when: 1787702400002,
        tag: "0029_orca_rule_evaluations",
        breakpoints: true,
      });

      client.db.insert(users).values({ id: "workspace-1", email: "owner@example.com" }).run();
      client.sqlite.query(`INSERT INTO organization_rules (workspace_id,id,name,latest_revision,position) VALUES ('workspace-1','rule-1','Focus failures',1,0)`).run();
      client.sqlite.query(`INSERT INTO organization_rule_revisions (
        workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type
      ) VALUES (
        'workspace-1','revision-1','rule-1',1,1,1,'orca 1','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','[]','low','workspace-1','human'
      )`).run();

      assert.throws(() => client.sqlite.query("UPDATE organization_rule_revisions SET source = 'changed' WHERE id = 'revision-1'").run());
      assert.throws(() => client.sqlite.query("DELETE FROM organization_rule_revisions WHERE id = 'revision-1'").run());
      assert.throws(() => client.sqlite.query(`INSERT INTO organization_rule_revisions (
        workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type
      ) VALUES (
        'workspace-1','revision-2','rule-1',1,1,1,'orca 1','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{}','[]','low','workspace-1','human'
      )`).run());

      client.sqlite.query(`INSERT INTO organization_change_sets (
        workspace_id,id,idempotency_key,command_digest,authority_trace,resource_family,operation,command_json,workspace_revision_before,workspace_revision_after
      ) VALUES (
        'workspace-1','change-rule-1','rule-create-1','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','human:test','rule','apply','{}',1,2
      )`).run();
      client.sqlite.query(`INSERT INTO organization_change_actions (
        workspace_id,change_id,position,action_kind,resource_family,resource_id,before_json,after_json
      ) VALUES ('workspace-1','change-rule-1',0,'create_rule','rule','rule-1',NULL,'{}')`).run();

      client.sqlite.query("DELETE FROM users WHERE id = 'workspace-1'").run();
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_rules").get() as { count: number }).count, 0);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_rule_revisions").get() as { count: number }).count, 0);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE resource_family = 'rule'").get() as { count: number }).count, 0);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE resource_family = 'rule'").get() as { count: number }).count, 0);
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("upgrades 0026 through Views and Rules, replays safely, and remains foreign-key clean", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-314-stacked-upgrade-"));
    const partialMigrations = join(directory, "migrations");
    mkdirSync(join(partialMigrations, "meta"), { recursive: true });
    try {
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as {
        entries: Array<{ idx: number; tag: string; when: number }>;
      };
      for (const entry of journal.entries.filter((item) => item.idx <= 26)) {
        writeFileSync(join(partialMigrations, `${entry.tag}.sql`), readFileSync(join(migrations, `${entry.tag}.sql`)));
      }
      writeFileSync(join(partialMigrations, "meta/_journal.json"), JSON.stringify({
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 26),
      }));

      const client = createDatabaseClient(join(directory, "stacked.sqlite"));
      try {
        migrate(client.db, { migrationsFolder: partialMigrations });
        client.db.insert(users).values([
          { id: "workspace-1", email: "owner@example.com" },
          { id: "workspace-2", email: "other@example.com" },
        ]).run();
        client.sqlite.query("UPDATE organization_workspace_states SET revision = 7 WHERE workspace_id = 'workspace-1'").run();

        migrate(client.db, { migrationsFolder: migrations });
        migrate(client.db, { migrationsFolder: migrations });

        const tables = client.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('organization_views','organization_rules','organization_rule_revisions') ORDER BY name").all() as Array<{ name: string }>;
        assert.deepEqual(tables.map(({ name }) => name), ["organization_rule_revisions", "organization_rules", "organization_views"]);
        const workspaceState = client.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'workspace-1'").get() as { revision: number };
        assert.equal(workspaceState.revision, 7);

        client.sqlite.query("INSERT INTO organization_rules (workspace_id,id,name,latest_revision,position) VALUES ('workspace-1','rule-1','Focus failures',1,0)").run();
        assert.throws(() => client.sqlite.query(`INSERT INTO organization_rule_revisions (
          workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type
        ) VALUES (
          'workspace-2','revision-cross-workspace','rule-1',1,7,1,'orca 1','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','[]','low','workspace-2','human'
        )`).run());
        assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
      } finally {
        client.sqlite.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
