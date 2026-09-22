import type { Hono } from "hono";
import { z } from "zod";

import { requireAuth, type AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { loadMobilePushConfig, type MobilePushConfig } from "./config.ts";
import { listDevices, registerDevice, unregisterDevice } from "./store.ts";

const installationIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const registrationSchema = z.object({
  // APNs says token size can change; validate its encoded nature, not a fixed byte count.
  token: z.string().trim().min(32).max(512).regex(/^(?:[0-9a-fA-F]{2})+$/),
  environment: z.enum(["sandbox", "production"]),
  notificationMode: z.enum(["human", "all", "off"]),
}).strict();

type MobilePushApp = Hono<{ Variables: AuthVariables }>;

function publicDevice(device: ReturnType<typeof listDevices>[number]) {
  const { userId: _userId, ...safe } = device;
  return {
    ...safe,
    registeredAt: new Date(safe.registeredAt).toISOString(),
    lastSeenAt: new Date(safe.lastSeenAt).toISOString(),
    updatedAt: new Date(safe.updatedAt).toISOString(),
    disabledAt: safe.disabledAt === null ? null : new Date(safe.disabledAt).toISOString(),
  };
}

export function registerMobilePushRoutes(app: MobilePushApp, options: {
  dbFactory?: typeof createDatabaseClient;
  config?: MobilePushConfig;
  now?: () => Date;
} = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const config = options.config ?? loadMobilePushConfig();
  const now = options.now ?? (() => new Date());

  app.put("/v1/mobile/devices/:installationId", requireAuth({ dbFactory }), async (c) => {
    const installation = installationIdSchema.safeParse(c.req.param("installationId"));
    let body: unknown;
    try { body = await c.req.json(); } catch { body = null; }
    const registration = registrationSchema.safeParse(body);
    if (!installation.success || !registration.success) {
      return c.json({ error: { code: "validation_error", message: "Provide a valid installation ID, APNs token, environment, and notification mode" } }, 400);
    }
    const client = dbFactory();
    try {
      await registerDevice(client.sqlite, { userId: c.get("auth").userId, sessionId: c.get("auth").sessionId, installationId: installation.data, ...registration.data, now: now() });
      const device = listDevices(client.sqlite, c.get("auth").userId, installation.data)[0];
      return c.json({ device: publicDevice(device!), push: { configured: config.configured, disabledReason: config.disabledReason } });
    } finally { client.sqlite.close(); }
  });

  app.delete("/v1/mobile/devices/:installationId", requireAuth({ dbFactory }), (c) => {
    const installation = installationIdSchema.safeParse(c.req.param("installationId"));
    if (!installation.success) return c.json({ error: { code: "validation_error", message: "Installation ID is invalid" } }, 400);
    const client = dbFactory();
    try {
      const removed = unregisterDevice(client.sqlite, c.get("auth").userId, installation.data);
      return removed ? c.body(null, 204) : c.json({ error: { code: "not_found", message: "Device registration was not found" } }, 404);
    } finally { client.sqlite.close(); }
  });

  app.get("/v1/mobile/push/status", requireAuth({ dbFactory }), (c) => {
    const installationValue = c.req.query("installationId");
    const installation = installationValue === undefined ? null : installationIdSchema.safeParse(installationValue);
    if (installation && !installation.success) return c.json({ error: { code: "validation_error", message: "Installation ID is invalid" } }, 400);
    const client = dbFactory();
    try {
      const devices = listDevices(client.sqlite, c.get("auth").userId, installation?.data).map(publicDevice);
      return c.json({
        configured: config.configured,
        deliveryEnabled: config.configured && devices.some((device) => device.notificationMode !== "off" && device.disabledAt === null),
        disabledReason: config.disabledReason,
        devices,
      });
    } finally { client.sqlite.close(); }
  });
}
