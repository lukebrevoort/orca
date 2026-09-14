import type { Hono } from "hono";
import { ZodError } from "zod";
import { attentionRoutingQuerySchema, attentionSenderLookupQuerySchema, attentionSenderLookupResultSchema } from "@orca/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { AttentionRoutingError, createAttentionRouting } from "./routing.ts";

export function registerAttentionRoutingRoutes(app: Hono<{ Variables: AuthVariables }>, { dbFactory = createDatabaseClient }: { dbFactory?: typeof createDatabaseClient } = {}) {
  app.get("/v1/attention/senders", requireAuth({ dbFactory }), c => {
    const client = dbFactory();
    try {
      const query = attentionSenderLookupQuerySchema.parse(c.req.query());
      // Same ownership boundary as routing; candidates never create choices.
      createAttentionRouting(client.db, c.get("auth").userId).read(query.accountId);
      const term = `%${query.query.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`;
      const rows = client.sqlite.query(`
        select address, max(name) as name from (
          select lower(trim(from_address)) as address, from_name as name
          from emails where account_id = ? and from_address is not null
          union all
          select lower(trim(email)) as address, name from contacts where account_id = ?
        ) where (address like ? escape '\\' or lower(coalesce(name,'')) like ? escape '\\')
          and address like '%@%.%'
        group by address order by address asc limit 31
      `).all(query.accountId, query.accountId, term, term) as Array<{ address: string; name: string | null }>;
      // Provider data can contain malformed addresses. Do not offer unsaveable candidates.
      const candidates = rows.slice(0, 30).filter(row => attentionSenderLookupResultSchema.shape.candidates.element.safeParse(row).success);
      return c.json(attentionSenderLookupResultSchema.parse({ accountId: query.accountId, candidates, truncated: rows.length > 30 }));
    } catch (error) {
      if (error instanceof AttentionRoutingError) return c.json({ error: { code: "not_found", message: error.message } }, error.status);
      if (error instanceof ZodError) return c.json({ error: { code: "validation_error", message: "Choose an account and a search of at most 200 characters." } }, 400);
      throw error;
    } finally { client.sqlite.close(); }
  });
  for (const method of ["get", "put"] as const) app[method]("/v1/attention/routing", requireAuth({ dbFactory }), async c => {
    const client = dbFactory();
    try {
      const query = attentionRoutingQuerySchema.parse(c.req.query());
      const service = createAttentionRouting(client.db, c.get("auth").userId);
      const result = method === "get" ? service.read(query.accountId,
        query.threadId ? { scope: "conversation", threadId: query.threadId }
          : query.address ? { scope: "sender", address: query.address } : { scope: "account" })
        : service.save(query.accountId, await c.req.json());
      return c.json(result);
    } catch (error) {
      if (error instanceof AttentionRoutingError) return c.json({ error: { code: error.status === 409 ? "conflict" : "not_found", message: error.message } }, error.status);
      if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: "validation_error", message: "Check account, sender, conversation, destination, and revision." } }, 400);
      throw error;
    } finally { client.sqlite.close(); }
  });
}
