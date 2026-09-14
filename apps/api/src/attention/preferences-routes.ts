import type { Hono } from "hono";
import { ZodError } from "zod";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { AttentionPreferencesError, createAttentionPreferences } from "./preferences.ts";

export function registerAttentionPreferencesRoutes(app: Hono<{ Variables: AuthVariables }>, { dbFactory = createDatabaseClient }: { dbFactory?: typeof createDatabaseClient } = {}) {
  for (const method of ["get", "put"] as const) app[method]("/v1/attention/preferences", requireAuth({ dbFactory }), async c => {
    const accountId = c.req.query("accountId");
    if (!accountId || accountId.length > 256) return c.json({ error: { message: "Choose an account." } }, 400);
    const client = dbFactory();
    try {
      const preferences = createAttentionPreferences(client.db, c.get("auth").userId);
      return c.json(method === "get" ? preferences.read(accountId) : preferences.save(accountId, await c.req.json()));
    } catch (error) {
      if (error instanceof AttentionPreferencesError) return c.json({ error: { message: error.message } }, error.status);
      if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { message: "Check sender addresses, duplicate senders, and revision before saving." } }, 400);
      throw error;
    } finally { client.sqlite.close(); }
  });
}
