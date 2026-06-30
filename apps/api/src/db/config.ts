import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultDatabasePath = "./data/orca.sqlite";

export function getDatabasePath() {
  return resolve(process.cwd(), process.env.DATABASE_PATH ?? defaultDatabasePath);
}

export function ensureDatabaseDirectory(databasePath = getDatabasePath()) {
  mkdirSync(dirname(databasePath), { recursive: true });

  return databasePath;
}
