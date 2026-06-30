import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { ensureDatabaseDirectory } from "./config.ts";
import * as schema from "./schema.ts";

export function createDatabaseClient(databasePath = ensureDatabaseDirectory()) {
  const sqlite = new Database(databasePath);
  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
  };
}
