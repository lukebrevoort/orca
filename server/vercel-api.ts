import { resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../apps/api/src/db/client.ts";
import { app } from "../apps/api/src/index.ts";

// Vercel's Bun runtime provides a writable temporary directory for preview
// state. This keeps the existing SQLite-backed API usable for a preview while
// making its non-durable nature explicit; production persistence still belongs
// on a managed database.
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = "/tmp/orca.sqlite";
}

const migrationsFolder = resolve(process.cwd(), "apps/api/drizzle");
let databaseReady = false;

function ensureDatabase() {
  if (databaseReady) {
    return;
  }

  const { db, sqlite } = createDatabaseClient();
  try {
    migrate(db, { migrationsFolder });
    databaseReady = true;
  } finally {
    sqlite.close();
  }
}

function requestForApi(request: Request) {
  const url = new URL(request.url);
  const rewrittenPath = url.searchParams.get("__orca_path");
  const pathname = rewrittenPath ?? (url.pathname.replace(/^\/api(?=\/|$)/, "") || "/");
  url.searchParams.delete("__orca_path");
  const target = new URL(`${pathname}${url.search ? `?${url.searchParams}` : ""}`, request.url);
  return new Request(target, request);
}

export default {
  async fetch(request: Request) {
    ensureDatabase();
    return app.fetch(requestForApi(request));
  },
};
