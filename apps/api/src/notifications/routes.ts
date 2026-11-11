import { Hono } from "hono";
import { z } from "zod";
import { importantNotificationCommandSchema, importantNotificationClaimSchema, importantNotificationReportSchema, notificationChannelSchema } from "@orca/shared";
import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { bodyLimit } from "../request-body.ts";
import { loadMobilePushConfig, type MobilePushConfig } from "../mobile-push/config.ts";
import { applyCommand, NotificationError, readInstallation, reconcileOperation } from "./policy.ts";
import { claimBrowser, reportBrowser } from "./browser.ts";
const installationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export function createNotificationApp(options: { dbFactory?: typeof createDatabaseClient; now?: () => Date; config?: MobilePushConfig } = {}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const dbFactory = options.dbFactory ?? createDatabaseClient, now = options.now ?? (() => new Date()), config = options.config ?? loadMobilePushConfig();
  app.use("/v1/notifications/*", requireAuth({ dbFactory }), bodyLimit({ maxSize: 32 * 1024 }), async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    if (["PUT", "POST"].includes(c.req.method) && !/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: { code: "validation_error", message: "JSON content type required" } }, 400);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof NotificationError) return c.json({ error: { code: error.code, message: error.message } }, error.code === "not_found" ? 404 : error.code === "validation_error" ? 400 : 409);
    throw error;
  });
  const invalid = () => new NotificationError("validation_error", "Invalid notification command or scope");
  function database<T>(read: (sqlite: ReturnType<typeof dbFactory>["sqlite"]) => T) {
    const { sqlite } = dbFactory();
    try { return read(sqlite); } finally { sqlite.close(); }
  }
  app.get("/v1/notifications/installations/:installationId", c => {
    const id = installationId.safeParse(c.req.param("installationId")), query = z.object({ channel: notificationChannelSchema }).strict().safeParse(c.req.query());
    if (!id.success || !query.success) throw invalid();
    return c.json(database(sqlite => sqlite.transaction(() => readInstallation(sqlite, { userId: c.get("auth").userId, installationId: id.data, channel: query.data.channel }, c.get("auth").sessionId, config, now().getTime())).deferred()));
  });
  app.put("/v1/notifications/installations/:installationId", async c => {
    const id = installationId.safeParse(c.req.param("installationId")), command = importantNotificationCommandSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !command.success) throw invalid();
    return c.json(database(sqlite => applyCommand(sqlite, { userId: c.get("auth").userId, installationId: id.data, channel: command.data.channel }, c.get("auth").sessionId, command.data, config, now().getTime())));
  });
  app.get("/v1/notifications/operations/:operationId", c => {
    const id = z.uuid().safeParse(c.req.param("operationId"));
    if (!id.success || Object.keys(c.req.query()).length) throw invalid();
    return c.json(database(sqlite => sqlite.transaction(() => reconcileOperation(sqlite, c.get("auth").userId, id.data, c.get("auth").sessionId, config, now().getTime())).deferred()));
  });
  app.post("/v1/notifications/installations/:installationId/claim", async c => {
    const id = installationId.safeParse(c.req.param("installationId")), input = importantNotificationClaimSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) throw invalid();
    return c.json(database(sqlite => claimBrowser(sqlite, { userId: c.get("auth").userId, installationId: id.data, channel: "open_app" }, c.get("auth").sessionId, input.data, now().getTime())));
  });
  app.post("/v1/notifications/installations/:installationId/report", async c => {
    const id = installationId.safeParse(c.req.param("installationId")), input = importantNotificationReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !input.success) throw invalid();
    return c.json(database(sqlite => reportBrowser(sqlite, { userId: c.get("auth").userId, installationId: id.data, channel: "open_app" }, c.get("auth").sessionId, input.data, now().getTime())));
  });
  return app;
}
