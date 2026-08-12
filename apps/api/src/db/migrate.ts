import { resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "./client.ts";
import { getDatabasePath } from "./config.ts";

const { db } = createDatabaseClient();
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");

migrate(db, { migrationsFolder });
console.log(`Applied migrations to ${getDatabasePath()}`);
