import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, threads, users } from "../../db/schema.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");

describe("BRE-311 Lane migration", () => {
  test("is journal-ordered, provisions one Fallback Lane, and assigns every new Thread", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-bre-311-lanes-"));
    const client = createDatabaseClient(join(directory, "lanes.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: migrations });
      const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
      assert.deepEqual(journal.entries.at(-1), { idx: 26, version: "7", when: 1787695200000, tag: "0026_organization_lanes", breakpoints: true });
      client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
      client.db.insert(oauthAccounts).values([
        { id: "account_owner", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "owner" },
        { id: "account_private", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private" },
      ]).run();
      client.db.insert(threads).values([
        { id: "thread_owner", accountId: "account_owner", providerThreadId: "owner" },
        { id: "thread_private", accountId: "account_private", providerThreadId: "private" },
      ]).run();
      const ownerSettings = client.sqlite.query("SELECT fallback_lane_id FROM organization_workspace_lane_settings WHERE workspace_id = 'owner'").get() as { fallback_lane_id: string };
      const ownerPlacement = client.sqlite.query("SELECT workspace_id,account_id,thread_id,primary_lane_id FROM organization_thread_lane_states WHERE workspace_id = 'owner'").all() as Array<Record<string, string>>;
      assert.equal(ownerPlacement.length, 1);
      assert.equal(ownerPlacement[0]?.primary_lane_id, ownerSettings.fallback_lane_id);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_lanes WHERE workspace_id = 'owner'").get() as { count: number }).count, 1);
      assert.throws(() => client.sqlite.exec("UPDATE organization_lane_policies SET provider_deletion = 1 WHERE workspace_id = 'owner'"));
      assert.throws(() => client.sqlite.exec(`UPDATE organization_thread_lane_states SET account_id = 'account_private' WHERE workspace_id = 'owner'`));
      assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), []);
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
