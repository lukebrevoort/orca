import { resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../apps/api/src/db/client.ts";
import { app } from "../apps/api/src/index.ts";

// Vercel's filesystem is not durable. Keep this fallback explicit for preview
// deployments; production must provide DATABASE_PATH backed by shared durable
// storage before relying on sessions or connected Gmail accounts.
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = "/tmp/orca.sqlite";
}

const migrationsFolder = resolve(process.cwd(), "apps/api/drizzle");
let databaseReady: Promise<void> | null = null;

function ensureDatabase() {
  if (!databaseReady) {
    databaseReady = Promise.resolve().then(() => {
      const { db, sqlite } = createDatabaseClient();
      try {
        migrate(db, { migrationsFolder });
      } finally {
        sqlite.close();
      }
    });
  }

  return databaseReady;
}

export function requestForApi(request: Request) {
  const url = new URL(request.url);
  const rewrittenPath = url.searchParams.get("__orca_path");
  const pathname = rewrittenPath ?? (url.pathname.replace(/^\/api(?=\/|$)/, "") || "/");

  // Vercel's protected preview/share layer forwards its own query metadata to
  // rewritten functions. It is transport state, not an Orca API parameter.
  for (const parameter of ["__orca_path", "_vercel_share", "path"]) {
    url.searchParams.delete(parameter);
  }

  const target = new URL(`${pathname}${url.search ? `?${url.searchParams}` : ""}`, request.url);
  return new Request(target, request);
}

export default {
  async fetch(request: Request) {
    await ensureDatabase();
    return app.fetch(requestForApi(request));
  },
};
