import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { importanceMutationSchema, importancePreviewRequestSchema, importanceUndoSchema, importantQuerySchema, importanceAddressSchema } from "@orca/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { ImportanceError, authorizeImportance, mutateImportance, previewImportance, readConversationImportance, readImportantPage, reconcileImportance, undoImportance } from "./store.ts";

const accountQuery = z.object({ accountId: z.string().trim().min(1).max(1024) }).strict();
const senderQuery = accountQuery.extend({ address: importanceAddressSchema });
export function createImportanceApp(options: { dbFactory?: typeof createDatabaseClient; now?: () => Date } = {}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  for (const path of ["/v1/importance/*", "/v1/important"]) {
    app.use(path, requireAuth({ dbFactory }));
    app.use(path, bodyLimit({ maxSize: 16 * 1024 }));
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      if (c.req.method === "POST" && !/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: { code: "validation_error", message: "JSON content type required" } }, 400);
      await next();
    });
  }
  app.onError((error, c) => {
    if (error instanceof ImportanceError) return c.json({ error: { code: error.code, message: error.message, ...(error.current ? { current: error.current } : {}) } }, error.code === "not_found" ? 404 : error.code === "invalid_cursor" ? 400 : 409);
    throw error;
  });
  function snapshot<T>(userId: string, accountId: string, read: (sqlite: ReturnType<typeof dbFactory>["sqlite"]) => T): T {
    const { sqlite } = dbFactory();
    try { return sqlite.transaction(() => { authorizeImportance(sqlite, { userId, accountId }); return read(sqlite); }).deferred(); }
    finally { sqlite.close(); }
  }
  app.get("/v1/importance/conversations/:threadId", c => {
    const input = accountQuery.safeParse(c.req.query());
    if (!input.success || c.req.param("threadId").length > 1024) return c.json({ error: { code: "validation_error", message: "Invalid conversation scope" } }, 400);
    return c.json(snapshot(c.get("auth").userId, input.data.accountId, sqlite => ({ accountId: input.data.accountId, threadId: c.req.param("threadId"), importance: readConversationImportance(sqlite, input.data.accountId, c.req.param("threadId")) })));
  });
  app.get("/v1/importance/senders", c => {
    const input = senderQuery.safeParse(c.req.query());
    if (!input.success) return c.json({ error: { code: "validation_error", message: "Invalid sender scope" } }, 400);
    return c.json(snapshot(c.get("auth").userId, input.data.accountId, sqlite => {
      const current = sqlite.query("SELECT choice,revision FROM importance_choices WHERE account_id=? AND kind='sender' AND target=?").get(input.data.accountId, input.data.address);
      const known = current || sqlite.query("SELECT 1 FROM importance_participants WHERE account_id=? AND address=? LIMIT 1").get(input.data.accountId, input.data.address);
      if (!known) throw new ImportanceError("not_found", "Sender not found");
      return { accountId: input.data.accountId, address: input.data.address, current: current ?? { choice: null, revision: 0 } };
    }));
  });
  app.post("/v1/importance/preview", async c => {
    const input = importancePreviewRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: "validation_error", message: "Invalid exact-sender preview" } }, 400);
    const scope = { userId: c.get("auth").userId, accountId: input.data.accountId };
    return c.json(snapshot(scope.userId, scope.accountId, sqlite => previewImportance(sqlite, scope, input.data, options.now?.().getTime())));
  });
  app.post("/v1/importance/choices", async c => {
    const input = importanceMutationSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: { code: "validation_error", message: "Invalid importance command" } }, 400);
    const { sqlite } = dbFactory();
    try { return c.json(mutateImportance(sqlite, { userId: c.get("auth").userId, accountId: input.data.accountId }, input.data, options.now?.().getTime())); }
    finally { sqlite.close(); }
  });
  app.get("/v1/importance/operations/:operationId", c => {
    const input = accountQuery.safeParse(c.req.query());
    if (!input.success || !z.string().uuid().safeParse(c.req.param("operationId")).success) return c.json({ error: { code: "validation_error", message: "Invalid operation scope" } }, 400);
    const scope = { userId: c.get("auth").userId, accountId: input.data.accountId };
    return c.json(snapshot(scope.userId, scope.accountId, sqlite => reconcileImportance(sqlite, scope, c.req.param("operationId"))));
  });
  app.post("/v1/importance/operations/:operationId/undo", async c => {
    const input = importanceUndoSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success || !z.string().uuid().safeParse(c.req.param("operationId")).success) return c.json({ error: { code: "validation_error", message: "Invalid Undo command" } }, 400);
    const { sqlite } = dbFactory();
    try { return c.json(undoImportance(sqlite, { userId: c.get("auth").userId, accountId: input.data.accountId }, c.req.param("operationId"), input.data, options.now?.().getTime())); }
    finally { sqlite.close(); }
  });
  app.get("/v1/important", c => {
    const input = importantQuerySchema.safeParse(c.req.query());
    if (!input.success) return c.json({ error: { code: "validation_error", message: "Invalid Important page scope" } }, 400);
    const { sqlite } = dbFactory();
    try { return c.json(readImportantPage(sqlite, { userId: c.get("auth").userId, accountId: input.data.accountId }, input.data.limit, input.data.cursor)); }
    finally { sqlite.close(); }
  });
  return app;
}
