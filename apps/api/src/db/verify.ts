import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "./client.ts";

const tempDir = mkdtempSync(join(tmpdir(), "orca-db-"));
const databasePath = join(tempDir, "verify.sqlite");
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");
const requiredTables = [
  "users",
  "oauth_accounts",
  "threads",
  "labels",
  "emails",
  "email_labels",
  "contacts",
];

const { db, sqlite } = createDatabaseClient(databasePath);

try {
  migrate(db, { migrationsFolder });

  const rows = sqlite
    .query(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;

  const tableNames = new Set(rows.map((row) => row.name));

  for (const tableName of requiredTables) {
    assert.ok(tableNames.has(tableName), `expected ${tableName} table to exist`);
  }

  console.log(`Verified migrations against ${databasePath}`);
} finally {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
}
