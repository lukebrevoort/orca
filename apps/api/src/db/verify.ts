import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "./client.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>;

const tempDir = mkdtempSync(join(tmpdir(), "orca-db-verify-"));
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");
const requiredTables = [
  "users", "oauth_accounts", "threads", "labels", "emails", "email_labels", "collections", "collection_threads",
  "gmail_label_migrations", "gmail_label_collection_imports", "contacts", "mcp_oauth_clients", "mcp_authorization_codes",
  "mcp_connections", "mcp_connection_accounts", "mcp_organization_approvals", "mcp_access_tokens", "mcp_refresh_tokens",
  "organization_workspace_states", "organization_views", "organization_rules", "organization_rule_sets",
  "organization_rule_revisions", "organization_evaluation_traces", "organization_lane_policies", "organization_lanes",
  "organization_workspace_lane_settings", "organization_thread_lane_states", "organization_facets", "organization_workflow_states",
  "organization_thread_facet_values", "organization_thread_workflow_states", "organization_thread_states",
  "organization_change_sets", "organization_change_actions", "organization_context_types",
  "organization_context_relationship_types", "organization_contexts", "organization_thread_context_relationships",
  "organization_saved_queries", "organization_collection_pin_audits", "organization_mutation_attempts",
  "organization_correction_receipts",
];

function verifyTables(client: DatabaseClient, label: string) {
  const rows = client.sqlite.query("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>;
  const tableNames = new Set(rows.map((row) => row.name));
  for (const tableName of requiredTables) assert.ok(tableNames.has(tableName), `${label}: expected ${tableName} table to exist`);
  assert.deepEqual(client.sqlite.query("PRAGMA foreign_key_check").all(), [], `${label}: foreign keys must be clean`);
}

function createPartialMigrationFolder(maximumIndex: number) {
  const partial = join(tempDir, `migrations-through-${maximumIndex}`);
  mkdirSync(join(partial, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
  for (const entry of entries) writeFileSync(join(partial, `${entry.tag}.sql`), readFileSync(join(migrationsFolder, `${entry.tag}.sql`)));
  writeFileSync(join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return partial;
}

try {
  const clean = createDatabaseClient(join(tempDir, "clean.sqlite"));
  try {
    migrate(clean.db, { migrationsFolder });
    migrate(clean.db, { migrationsFolder });
    verifyTables(clean, "clean upgrade + idempotent replay");
    console.log(`PASS clean upgrade + idempotent replay (${requiredTables.length} required tables)`);
  } finally { clean.sqlite.close(); }

  const stacked = createDatabaseClient(join(tempDir, "stacked.sqlite"));
  try {
    migrate(stacked.db, { migrationsFolder: createPartialMigrationFolder(26) });
    stacked.sqlite.query("INSERT INTO users (id,email) VALUES ('verify-workspace-a','a@example.com'),('verify-workspace-b','b@example.com')").run();
    stacked.sqlite.query("UPDATE organization_workspace_states SET revision = 7 WHERE workspace_id = 'verify-workspace-a'").run();
    migrate(stacked.db, { migrationsFolder });
    migrate(stacked.db, { migrationsFolder });
    verifyTables(stacked, "stacked 0026 upgrade + idempotent replay");
    assert.equal((stacked.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'verify-workspace-a'").get() as { revision: number }).revision, 7);
    stacked.sqlite.query("INSERT INTO organization_rules (workspace_id,id,name,latest_revision,position) VALUES ('verify-workspace-a','verify-rule','Verify isolation',1,0)").run();
    assert.throws(() => stacked.sqlite.query(`INSERT INTO organization_rule_revisions (
      workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type
    ) VALUES ('verify-workspace-b','cross-workspace-revision','verify-rule',1,7,1,'orca 1','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','[]','low','verify-workspace-b','human')`).run());
    console.log("PASS stacked 0026→latest upgrade + replay + Workspace isolation");
  } finally { stacked.sqlite.close(); }

  const resetPath = join(tempDir, "reset.sqlite");
  const beforeReset = createDatabaseClient(resetPath);
  migrate(beforeReset.db, { migrationsFolder });
  beforeReset.sqlite.query("INSERT INTO users (id,email) VALUES ('reset-user','reset@example.com')").run();
  beforeReset.sqlite.close();
  rmSync(resetPath, { force: true });
  rmSync(`${resetPath}-wal`, { force: true });
  rmSync(`${resetPath}-shm`, { force: true });
  const afterReset = createDatabaseClient(resetPath);
  try {
    migrate(afterReset.db, { migrationsFolder });
    verifyTables(afterReset, "reset + clean replay");
    assert.equal((afterReset.sqlite.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 0);
    console.log("PASS destructive reset recreation (no retained user data)");
  } finally { afterReset.sqlite.close(); }

  console.log(`Verified BRE-320 database gates in ${tempDir}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
