import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "./client.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

function createMigratedClient() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-db-client-test-"));
  tempDirs.push(tempDir);
  const databasePath = join(tempDir, "test.sqlite");
  const client = createDatabaseClient(databasePath);

  migrate(client.db, { migrationsFolder });

  return client;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("createDatabaseClient", () => {
  test("enables SQLite foreign key enforcement", () => {
    const { sqlite } = createMigratedClient();

    try {
      const row = sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number } | null;
      assert.equal(row?.foreign_keys, 1);
    } finally {
      sqlite.close();
    }
  });

  test("rejects oauth accounts that reference missing users", () => {
    const { sqlite } = createMigratedClient();

    try {
      assert.throws(() => {
        sqlite
          .query(
            `insert into oauth_accounts (id, user_id, provider, provider_email, provider_id)
             values ('acct-1', 'missing-user', 'google', 'missing@example.com', 'provider-1')`,
          )
          .run();
      });
    } finally {
      sqlite.close();
    }
  });
});
