import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultDatabasePath = "./data/orca.sqlite";
const apiRootDirectory = resolve(import.meta.dir, "../..");

export function getDatabasePath() {
  return resolve(apiRootDirectory, process.env.DATABASE_PATH ?? defaultDatabasePath);
}

export function ensureDatabaseDirectory(databasePath = getDatabasePath()) {
  mkdirSync(dirname(databasePath), { recursive: true });

  return databasePath;
}
