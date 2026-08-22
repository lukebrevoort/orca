import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import {
  calendarAvailabilityRequestSchema,
  calendarPreferencesSchema,
  updateCalendarPreferencesSchema,
  updateCalendarSelectionSchema,
} from "@orca/shared";

import { createGoogleCalendarClient, GoogleCalendarError, type CalendarFetch } from "../../calendar/google-client.ts";
import { createCalendarAvailabilityResolver, getOwnedCalendarConnection, getUsableGoogleCalendarToken, listAvailabilityCalendars, markCalendarConnection, toPublicCalendarConnection } from "../../calendar/resolver.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { availabilityCalendars, calendarPreferences } from "../../db/schema.ts";
import { decryptSecret } from "../gmail/crypto.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import { loadGoogleCalendarOAuthConfig, validateGoogleCalendarOAuthConfig, type GoogleCalendarOAuthConfig } from "./config.ts";
import { createGoogleCalendarOAuthService, revokeGoogleCalendarToken } from "./oauth.ts";
import { DatabaseCalendarConnectionStore } from "./store.ts";

type Options = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: GoogleCalendarOAuthConfig;
  dbFactory?: typeof createDatabaseClient;
  fetch?: CalendarFetch;
  now?: () => Date;
};

export function createCalendarApp(options: Options = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const config = options.config ?? loadGoogleCalendarOAuthConfig();
  const auth = options.authMiddleware ?? requireAuth({ dbFactory });
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const store = new DatabaseCalendarConnectionStore(dbFactory);
  const oauth = createGoogleCalendarOAuthService({ config, store, fetch: fetchImpl, now });
  const google = createGoogleCalendarClient(fetchImpl);
  const resolver = createCalendarAvailabilityResolver({ dbFactory, config, fetch: fetchImpl, now });
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/v1/auth/calendar/google/connect", auth, (c) => {
    const missing = validateGoogleCalendarOAuthConfig(config);
    if (missing.length) return c.json({ error: {
      code: "calendar_oauth_not_configured",
      message: `Calendar consent needs server setup. Missing: ${missing.join(", ")}.`,
    } }, 503);
    const result = oauth.getAuthorizationUrl(c.get("auth").userId, c.req.query("returnTo"));
    return c.json({ provider: "google", authUrl: result.url, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  app.get("/v1/auth/calendar/google/callback", auth, async (c) => {
    const result = await oauth.handleCallback(new URLSearchParams(c.req.query()), c.get("auth").userId);
    if (result.redirectUrl) return c.redirect(result.redirectUrl, 302);
    return result.ok
      ? c.json({ ok: true, connectionId: result.connectionId })
      : c.json({ error: { code: result.code, message: result.message } }, 400);
  });

  app.get("/v1/calendar/connections", auth, async (c) => {
    const rows = await store.listForUser(c.get("auth").userId);
    return c.json({ items: rows.map((row) => ({ id: row.id, provider: row.provider, accountLabel: row.accountLabel, state: row.state, grantedScopes: row.grantedScopes, connectedAt: row.createdAt.toISOString(), error: row.error })) });
  });

  app.get("/v1/calendar/preferences", auth, (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const row = db.select().from(calendarPreferences).where(eq(calendarPreferences.userId, c.get("auth").userId)).get();
      return c.json(calendarPreferencesSchema.parse({
        userTimeZone: row?.timeZone ?? "UTC",
        workingHours: row?.workingHours ? JSON.parse(row.workingHours) : null,
        staleAfterMinutes: row?.staleAfterMinutes ?? 15,
      }));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/calendar/preferences", validator("json", (value, c) => {
    const parsed = updateCalendarPreferencesSchema.safeParse(value);
    return parsed.success ? parsed.data : c.json({ error: { code: "invalid_request", message: "Invalid calendar preferences" } }, 400);
  }), auth, (c) => {
    const input = c.req.valid("json");
    const { db, sqlite } = dbFactory();
    try {
      const userId = c.get("auth").userId;
      const current = db.select().from(calendarPreferences).where(eq(calendarPreferences.userId, userId)).get();
      const next = calendarPreferencesSchema.parse({
        userTimeZone: input.userTimeZone ?? current?.timeZone ?? "UTC",
        workingHours: input.workingHours === undefined ? (current?.workingHours ? JSON.parse(current.workingHours) : null) : input.workingHours,
        staleAfterMinutes: input.staleAfterMinutes ?? current?.staleAfterMinutes ?? 15,
      });
      // Intl rejects unknown IANA timezone identifiers; fail at the edge.
      try { new Intl.DateTimeFormat("en-US", { timeZone: next.userTimeZone }).format(now()); }
      catch { return c.json({ error: { code: "invalid_timezone", message: "Use a valid IANA timezone" } }, 400); }
      db.insert(calendarPreferences).values({ userId, timeZone: next.userTimeZone, workingHours: next.workingHours ? JSON.stringify(next.workingHours) : null, staleAfterMinutes: next.staleAfterMinutes, updatedAt: now() })
        .onConflictDoUpdate({ target: calendarPreferences.userId, set: { timeZone: next.userTimeZone, workingHours: next.workingHours ? JSON.stringify(next.workingHours) : null, staleAfterMinutes: next.staleAfterMinutes, updatedAt: now() } }).run();
      return c.json(next);
    } finally { sqlite.close(); }
  });

  app.get("/v1/calendar/calendars", auth, async (c) => {
    const connectionId = c.req.query("connectionId");
    if (!connectionId) return c.json({ error: { code: "invalid_request", message: "connectionId is required" } }, 400);
    const { db, sqlite } = dbFactory();
    try {
      let connection = getOwnedCalendarConnection(db, c.get("auth").userId, connectionId);
      if (!connection) return c.json({ error: { code: "not_found", message: "Calendar connection not found" } }, 404);
      const token = await getUsableGoogleCalendarToken(db, connection, config, fetchImpl, now());
      connection = getOwnedCalendarConnection(db, c.get("auth").userId, connectionId)!;
      if (!token) return c.json({ connection: toPublicCalendarConnection(connection), calendars: listAvailabilityCalendars(db, connectionId), error: { code: "calendar_auth_required", message: "Reconnect Calendar before checking availability." } }, 401);
      try {
        const discovered = await google.listCalendars(token);
        const discoveredAt = now();
        for (const calendar of discovered) {
          const existing = db.select().from(availabilityCalendars).where(and(
            eq(availabilityCalendars.connectionId, connectionId),
            eq(availabilityCalendars.providerCalendarId, calendar.providerCalendarId),
          )).get();
          const values = {
            displayName: calendar.displayName,
            timeZone: calendar.timeZone,
            isPrimary: calendar.primary,
            accessRole: calendar.accessRole,
            lastDiscoveredAt: discoveredAt,
            updatedAt: discoveredAt,
          };
          if (existing) {
            db.update(availabilityCalendars).set(values).where(eq(availabilityCalendars.id, existing.id)).run();
          } else {
            db.insert(availabilityCalendars).values({
              id: `availability-calendar:${crypto.randomUUID()}`,
              connectionId,
              providerCalendarId: calendar.providerCalendarId,
              selected: calendar.primary,
              ...values,
            }).run();
          }
        }
        return c.json({ connection: toPublicCalendarConnection(connection), calendars: listAvailabilityCalendars(db, connectionId) });
      } catch (error) {
        if (error instanceof GoogleCalendarError && error.kind === "auth") {
          markCalendarConnection(db, connectionId, "expired", "Calendar authorization expired or was revoked.", now());
          return c.json({ connection: toPublicCalendarConnection(getOwnedCalendarConnection(db, c.get("auth").userId, connectionId)!), calendars: listAvailabilityCalendars(db, connectionId), error: { code: "calendar_auth_required", message: "Reconnect Calendar before checking availability." } }, 401);
        }
        return c.json({ connection: toPublicCalendarConnection(connection), calendars: listAvailabilityCalendars(db, connectionId), error: { code: "calendar_provider_error", message: "Google could not list calendars." } }, 502);
      }
    } finally { sqlite.close(); }
  });

  app.patch("/v1/calendar/calendars/selection", validator("json", (value, c) => {
    const parsed = updateCalendarSelectionSchema.safeParse(value);
    return parsed.success ? parsed.data : c.json({ error: { code: "invalid_request", message: "Invalid calendar selection" } }, 400);
  }), auth, (c) => {
    const input = c.req.valid("json");
    const { db, sqlite } = dbFactory();
    try {
      const connection = getOwnedCalendarConnection(db, c.get("auth").userId, input.connectionId);
      if (!connection) return c.json({ error: { code: "not_found", message: "Calendar connection not found" } }, 404);
      const calendars = db.select().from(availabilityCalendars).where(eq(availabilityCalendars.connectionId, input.connectionId)).all();
      const knownIds = new Set(calendars.map((calendar) => calendar.id));
      if (input.selectedCalendarIds.some((id) => !knownIds.has(id))) return c.json({ error: { code: "invalid_selection", message: "Select only calendars from this connection" } }, 400);
      db.transaction((tx) => {
        tx.update(availabilityCalendars).set({ selected: false, updatedAt: now() }).where(eq(availabilityCalendars.connectionId, input.connectionId)).run();
        if (input.selectedCalendarIds.length) tx.update(availabilityCalendars).set({ selected: true, updatedAt: now() }).where(inArray(availabilityCalendars.id, input.selectedCalendarIds)).run();
      });
      return c.json({ connection: toPublicCalendarConnection(connection), calendars: listAvailabilityCalendars(db, input.connectionId) });
    } finally { sqlite.close(); }
  });

  app.post("/v1/calendar/availability", validator("json", (value, c) => {
    const parsed = calendarAvailabilityRequestSchema.safeParse(value);
    return parsed.success ? parsed.data : c.json({ error: { code: "invalid_request", message: "Invalid availability request" } }, 400);
  }), auth, async (c) => {
    return c.json(await resolver.resolve({ userId: c.get("auth").userId, request: c.req.valid("json") }));
  });

  app.delete("/v1/calendar/connections/:id", auth, async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const row = getOwnedCalendarConnection(db, c.get("auth").userId, c.req.param("id"));
      if (!row) return c.json({ error: { code: "not_found", message: "Calendar connection not found" } }, 404);
      const encryptedToken = row.refreshTokenEncrypted ?? row.accessTokenEncrypted;
      const token = encryptedToken ? decryptSecret(encryptedToken, config.tokenEncryptionKey) : null;
      markCalendarConnection(db, row.id, "revoked", null, now(), true);
      if (token) await revokeGoogleCalendarToken(token, fetchImpl);
      return c.body(null, 204);
    } finally { sqlite.close(); }
  });

  return app;
}
