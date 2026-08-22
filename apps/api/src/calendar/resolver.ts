import { and, asc, desc, eq } from "drizzle-orm";
import type {
  CalendarAvailabilityRequest,
  CalendarAvailabilityResponse,
  CalendarConnection,
} from "@orca/shared";

import { decryptSecret, encryptSecret } from "../auth/gmail/crypto.ts";
import { loadGoogleCalendarOAuthConfig, type GoogleCalendarOAuthConfig } from "../auth/calendar/config.ts";
import { refreshGoogleCalendarToken } from "../auth/calendar/oauth.ts";
import { createDatabaseClient } from "../db/client.ts";
import { availabilityCalendars, calendarConnections } from "../db/schema.ts";
import { compareCalendarAvailability } from "./availability.ts";
import { createGoogleCalendarClient, GoogleCalendarError, type CalendarFetch } from "./google-client.ts";

export type CalendarAvailabilityResolver = {
  resolve(input: { userId: string; request: CalendarAvailabilityRequest }): Promise<CalendarAvailabilityResponse>;
};

export function createCalendarAvailabilityResolver(options: {
  dbFactory?: typeof createDatabaseClient;
  config?: GoogleCalendarOAuthConfig;
  fetch?: CalendarFetch;
  now?: () => Date;
} = {}): CalendarAvailabilityResolver {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const config = options.config ?? loadGoogleCalendarOAuthConfig();
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const google = createGoogleCalendarClient(fetchImpl);

  return {
    async resolve({ userId, request }) {
      const { db, sqlite } = dbFactory();
      try {
        let row = getOwnedCalendarConnection(db, userId, request.connectionId);
        if (!row) return compareCalendarAvailability({ request, connection: null, calendars: [] });
        let connection = toPublicCalendarConnection(row);
        const calendars = listAvailabilityCalendars(db, row.id);
        const exactWindows = request.requestedWindows.filter((window) => window.interpretation === "exact" && window.start && window.end);
        if (connection.state !== "connected" || exactWindows.length === 0 || calendars.every((calendar) => !calendar.selected)) {
          return compareCalendarAvailability({ request, connection, calendars });
        }
        const token = await getUsableGoogleCalendarToken(db, row, config, fetchImpl, now());
        row = getOwnedCalendarConnection(db, userId, request.connectionId)!;
        connection = toPublicCalendarConnection(row);
        if (!token) return compareCalendarAvailability({ request, connection, calendars });
        const selectedRows = db.select().from(availabilityCalendars).where(and(eq(availabilityCalendars.connectionId, row.id), eq(availabilityCalendars.selected, true))).all();
        const start = new Date(Math.min(...exactWindows.map((window) => Date.parse(window.start!)))).toISOString();
        const end = new Date(Math.max(...exactWindows.map((window) => Date.parse(window.end!)))).toISOString();
        try {
          const providerResults = await google.queryFreeBusy({ accessToken: token, providerCalendarIds: selectedRows.map((calendar) => calendar.providerCalendarId), start, end, timeZone: request.userTimeZone });
          const localByProvider = new Map(selectedRows.map((calendar) => [calendar.providerCalendarId, calendar.id]));
          const checkedAt = now();
          return compareCalendarAvailability({
            request,
            connection,
            calendars,
            providerResults: providerResults.map((result) => ({ calendarId: localByProvider.get(result.providerCalendarId)!, busy: result.busy, error: result.error })),
            checkedAt,
            now: checkedAt,
          });
        } catch (error) {
          if (error instanceof GoogleCalendarError && error.kind === "auth") {
            markCalendarConnection(db, row.id, "expired", "Calendar authorization expired or was revoked.", now());
          } else {
            markCalendarConnection(db, row.id, "error", "Calendar availability could not be checked.", now());
          }
          connection = toPublicCalendarConnection(getOwnedCalendarConnection(db, userId, row.id)!);
          return compareCalendarAvailability({ request, connection, calendars });
        }
      } finally { sqlite.close(); }
    },
  };
}

export type CalendarDb = ReturnType<typeof createDatabaseClient>["db"];

export function getOwnedCalendarConnection(db: CalendarDb, userId: string, id: string) {
  return db.select().from(calendarConnections).where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, userId))).get();
}

export function listAvailabilityCalendars(db: CalendarDb, connectionId: string) {
  return db.select().from(availabilityCalendars)
    .where(eq(availabilityCalendars.connectionId, connectionId))
    .orderBy(desc(availabilityCalendars.isPrimary), asc(availabilityCalendars.displayName), asc(availabilityCalendars.id))
    .all().map((calendar) => ({
      id: calendar.id,
      connectionId,
      provider: "google" as const,
      displayName: calendar.displayName,
      timeZone: calendar.timeZone,
      selected: calendar.selected,
      primary: calendar.isPrimary,
    }));
}

export function toPublicCalendarConnection(row: typeof calendarConnections.$inferSelect): CalendarConnection {
  return {
    id: row.id,
    provider: "google",
    accountLabel: row.accountLabel,
    state: row.state as CalendarConnection["state"],
    grantedScopes: row.scope.split(/\s+/).filter(Boolean),
    connectedAt: row.createdAt.toISOString(),
    error: row.error,
  };
}

export async function getUsableGoogleCalendarToken(db: CalendarDb, row: typeof calendarConnections.$inferSelect, config: GoogleCalendarOAuthConfig, fetchImpl: CalendarFetch, now: Date) {
  if (row.state !== "connected" || !row.accessTokenEncrypted) return null;
  if (!row.tokenExpiry || row.tokenExpiry.getTime() > now.getTime() + 60_000) return decryptSecret(row.accessTokenEncrypted, config.tokenEncryptionKey);
  if (!row.refreshTokenEncrypted) {
    markCalendarConnection(db, row.id, "expired", "Calendar authorization expired.", now);
    return null;
  }
  const refresh = await refreshGoogleCalendarToken({ refreshToken: decryptSecret(row.refreshTokenEncrypted, config.tokenEncryptionKey), config, fetch: fetchImpl, now });
  if (!refresh.ok) {
    markCalendarConnection(db, row.id, refresh.expired ? "expired" : "error", refresh.expired ? "Calendar authorization expired or was revoked." : "Calendar authorization could not be refreshed.", now);
    return null;
  }
  db.update(calendarConnections).set({ accessTokenEncrypted: encryptSecret(refresh.accessToken, config.tokenEncryptionKey), tokenExpiry: refresh.expiresAt, state: "connected", error: null, updatedAt: now }).where(eq(calendarConnections.id, row.id)).run();
  return refresh.accessToken;
}

export function markCalendarConnection(db: CalendarDb, id: string, state: "expired" | "revoked" | "error", error: string | null, updatedAt: Date, clearTokens = false) {
  db.update(calendarConnections).set({ state, error, updatedAt, ...(clearTokens ? { accessTokenEncrypted: null, refreshTokenEncrypted: null, tokenExpiry: null } : {}) }).where(eq(calendarConnections.id, id)).run();
}

