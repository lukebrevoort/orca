import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      assert.equal(journal.entries.at(-1)?.idx, 27);
      assert.deepEqual(journal.entries.at(-1), {
        idx: 28,
        version: "7",
        when: 1787702400001,
        tag: "0028_orca_rule_revisions",
        breakpoints: true,
      });

      client.db.insert(users).values({ id: "workspace-1", email: "owner@example.com" }).run();
      client.sqlite.query(`INSERT INTO organization_rules (workspace_id,id,name,latest_revision) VALUES ('workspace-1','rule-1','Focus failures',1)`).run();
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
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
