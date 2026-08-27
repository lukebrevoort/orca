import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureDatabaseDirectory } from "./config.ts";
import * as schema from "./schema.ts";

export function createDatabaseClient(databasePath = ensureDatabaseDirectory()) {
  const sqlite = new Database(databasePath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  const transaction = db.transaction.bind(db);
  db.transaction = ((callback, config) => transaction(callback, config ?? { behavior: "immediate" })) as typeof db.transaction;

  return {
    db,
    sqlite,
  };
}
