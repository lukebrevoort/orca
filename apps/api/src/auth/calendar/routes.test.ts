import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MiddlewareHandler } from "hono";

import { createDatabaseClient } from "../../db/client.ts";
import { availabilityCalendars, calendarConnections, oauthAccounts, users } from "../../db/schema.ts";
import type { AuthVariables } from "../middleware.ts";
import { googleCalendarReadScopes, type GoogleCalendarOAuthConfig } from "./config.ts";
import { createCalendarApp } from "./routes.ts";

const key = Buffer.alloc(32, 19).toString("base64");
const config: GoogleCalendarOAuthConfig = {
  clientId: "calendar-client",
  clientSecret: "calendar-secret",
  redirectUri: "http://localhost:3000/v1/auth/calendar/google/callback",
  tokenEncryptionKey: key,
  stateSecret: "calendar-state-secret",
  webOrigin: "http://localhost:5173",
  scopes: googleCalendarReadScopes,
};
const now = new Date("2026-11-03T19:55:00.000Z");
const auth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("auth", { sessionId: "session", userId: "user-1", expiresAt: new Date("2027-01-01T00:00:00.000Z") });
  await next();
};

describe("read-only Calendar routes", () => {
  let directory = "";
  let dbPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "orca-calendar-routes-"));
    dbPath = join(directory, "calendar.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(users).values([
      { id: "user-1", email: "owner@example.com" },
      { id: "user-2", email: "other@example.com" },
    ]).run();
    sqlite.close();
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test("uses separate least-privilege consent, explicit selection, free/busy only, and revocation", async () => {
    const requests: Array<{ url: string; body: string | null }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, body: init?.body ? String(init.body) : null });
      if (url === "https://oauth2.googleapis.com/token") return Response.json({
        access_token: "calendar-access-token",
        refresh_token: "calendar-refresh-token",
        expires_in: 3600,
        scope: config.scopes.join(" "),
      });
      if (url.includes("oauth2/v2/userinfo")) return Response.json({ id: "google-calendar-user", email: "calendar@example.com" });
      if (url.includes("users/me/calendarList")) return Response.json({ items: [
        { id: "primary@example.com", summary: "Work", timeZone: "America/Denver", primary: true, selected: true, accessRole: "owner", description: "private" },
        { id: "focus@example.com", summary: "Focus", timeZone: "America/Denver", selected: true, accessRole: "reader", location: "private" },
      ] });
      if (url.endsWith("/freeBusy")) return Response.json({ calendars: {
        "primary@example.com": { busy: [] },
        "focus@example.com": { busy: [{ start: "2026-11-03T20:15:00.000Z", end: "2026-11-03T20:45:00.000Z" }] },
      } });
      if (url === "https://oauth2.googleapis.com/revoke") return new Response(null, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    };
    const app = createCalendarApp({ authMiddleware: auth, config, dbFactory: () => createDatabaseClient(dbPath), fetch: fetchImpl, now: () => now });

    const savedPreferences = await app.request("/v1/calendar/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userTimeZone: "America/Denver",
        staleAfterMinutes: 15,
        workingHours: { timeZone: "America/Denver", days: [{ day: 2, startLocal: "09:00", endLocal: "17:00" }] },
      }),
    });
    expect(savedPreferences.status).toBe(200);
    expect(await (await app.request("/v1/calendar/preferences")).json()).toEqual({
      userTimeZone: "America/Denver",
      staleAfterMinutes: 15,
      workingHours: { timeZone: "America/Denver", days: [{ day: 2, startLocal: "09:00", endLocal: "17:00" }] },
    });
    expect((await app.request("/v1/calendar/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userTimeZone: "Mars/Olympus" }),
    })).status).toBe(400);

    const connect = await app.request("/v1/auth/calendar/google/connect?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fcalendar");
    expect(connect.status).toBe(200);
    const connectBody = await connect.json() as { authUrl: string; scopes: string[] };
    const authorizationUrl = new URL(connectBody.authUrl);
    expect(connectBody.scopes).toEqual([...googleCalendarReadScopes]);
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBe("false");
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("gmail");
    expect(authorizationUrl.searchParams.get("scope")).not.toContain("calendar.events");

    const callback = await app.request(`/v1/auth/calendar/google/callback?code=calendar-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`, { redirect: "manual" });
    expect(callback.status).toBe(302);
    const verification = createDatabaseClient(dbPath);
    const connection = verification.db.select().from(calendarConnections).where(eq(calendarConnections.userId, "user-1")).get()!;
    expect(connection.accessTokenEncrypted).not.toContain("calendar-access-token");
    expect(connection.refreshTokenEncrypted).not.toContain("calendar-refresh-token");
    expect(verification.db.select().from(oauthAccounts).all()).toEqual([]);
    verification.sqlite.close();

    const discovery = await app.request(`/v1/calendar/calendars?connectionId=${encodeURIComponent(connection.id)}`);
    expect(discovery.status).toBe(200);
    const discoveryBody = await discovery.json() as { calendars: Array<{ id: string; displayName: string; selected: boolean }> };
    expect(discoveryBody.calendars.map((calendar) => ({ displayName: calendar.displayName, selected: calendar.selected }))).toEqual([
      { displayName: "Work", selected: true },
      { displayName: "Focus", selected: false },
    ]);
    expect(JSON.stringify(discoveryBody)).not.toContain("private");

    const selectedIds = discoveryBody.calendars.map((calendar) => calendar.id);
    const selection = await app.request("/v1/calendar/calendars/selection", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: connection.id, selectedCalendarIds: selectedIds }),
    });
    expect(selection.status).toBe(200);

    const availability = await app.request("/v1/calendar/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: connection.id,
        userTimeZone: "America/Denver",
        workingHours: null,
        requestedWindows: [{
          id: "window-1",
          messageId: "message-1",
          sourceText: "Tuesday 1–2 PM Mountain",
          sourceUrl: "http://localhost:5173/?thread=thread-1&message=message-1",
          originalTimeZone: "America/Denver",
          userTimeZone: "America/Denver",
          start: "2026-11-03T20:00:00.000Z",
          end: "2026-11-03T21:00:00.000Z",
          durationMinutes: 60,
          interpretation: "exact",
          ambiguities: [],
        }],
      }),
    });
    expect(availability.status).toBe(200);
    const availabilityBody = await availability.json() as { results: Array<{ status: string }>; humanConfirmationRequired: boolean; limitations: string[] };
    expect(availabilityBody.results[0]?.status).toBe("busy");
    expect(availabilityBody.humanConfirmationRequired).toBe(true);
    expect(availabilityBody.limitations.join(" ")).toContain("does not schedule");
    const freeBusyBody = JSON.parse(requests.find((request) => request.url.endsWith("/freeBusy"))!.body!);
    expect(Object.keys(freeBusyBody).sort()).toEqual(["calendarExpansionMax", "items", "timeMax", "timeMin", "timeZone"]);

    const revoked = await app.request(`/v1/calendar/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    expect(revoked.status).toBe(204);
    const after = createDatabaseClient(dbPath);
    expect(after.db.select().from(calendarConnections).where(eq(calendarConnections.id, connection.id)).get()).toMatchObject({ state: "revoked", accessTokenEncrypted: null, refreshTokenEncrypted: null });
    expect(after.db.select().from(availabilityCalendars).where(eq(availabilityCalendars.connectionId, connection.id)).all()).toHaveLength(2);
    after.sqlite.close();
    expect(requests.some((request) => request.url === "https://oauth2.googleapis.com/revoke")).toBe(true);
  });

  test("turns an expired refresh grant into Unknown instead of guessed availability", async () => {
    const { db, sqlite } = createDatabaseClient(dbPath);
    const { encryptSecret } = await import("../gmail/crypto.ts");
    db.insert(calendarConnections).values({
      id: "expired-connection",
      userId: "user-1",
      provider: "google",
      providerAccountId: "google-expired",
      accountLabel: "expired@example.com",
      accessTokenEncrypted: encryptSecret("old-access", key),
      refreshTokenEncrypted: encryptSecret("expired-refresh", key),
      tokenExpiry: new Date("2026-11-03T18:00:00.000Z"),
      scope: config.scopes.join(" "),
      state: "connected",
    }).run();
    db.insert(availabilityCalendars).values({
      id: "calendar-primary",
      connectionId: "expired-connection",
      providerCalendarId: "primary@example.com",
      displayName: "Work",
      timeZone: "America/Denver",
      selected: true,
      isPrimary: true,
      accessRole: "owner",
      lastDiscoveredAt: now,
    }).run();
    sqlite.close();
    const app = createCalendarApp({
      authMiddleware: auth,
      config,
      dbFactory: () => createDatabaseClient(dbPath),
      fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      now: () => now,
    });
    const response = await app.request("/v1/calendar/availability", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId: "expired-connection",
        userTimeZone: "America/Denver",
        workingHours: null,
        requestedWindows: [{ id: "window-1", messageId: "message-1", sourceText: "Tuesday at one", sourceUrl: "http://localhost:5173/?thread=one", originalTimeZone: "America/Denver", userTimeZone: "America/Denver", start: "2026-11-03T20:00:00.000Z", end: "2026-11-03T21:00:00.000Z", durationMinutes: 60, interpretation: "exact", ambiguities: [] }],
      }),
    });
    const body = await response.json() as { connection: { state: string }; results: Array<{ status: string; unknownReason: string }> };
    expect(body.connection.state).toBe("expired");
    expect(body.results[0]).toMatchObject({ status: "unknown", unknownReason: "grant_expired" });
  });
});
