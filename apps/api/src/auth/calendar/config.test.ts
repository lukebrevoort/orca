import { describe, expect, test } from "bun:test";

import { googleCalendarReadScopes, loadGoogleCalendarOAuthConfig } from "./config.ts";

describe("Calendar OAuth configuration", () => {
  test("keeps the fixed scope allowlist separate from Gmail and event writes", () => {
    const config = loadGoogleCalendarOAuthConfig({
      GOOGLE_CALENDAR_CLIENT_ID: "client",
      GOOGLE_CALENDAR_CLIENT_SECRET: "secret",
      TOKEN_ENCRYPTION_KEY: "key",
      SESSION_SECRET: "state",
      GOOGLE_OAUTH_SCOPES: "https://mail.google.com/ https://www.googleapis.com/auth/calendar",
    });
    expect(config.scopes).toEqual(googleCalendarReadScopes);
    expect(config.scopes.some((scope) => scope.includes("gmail"))).toBe(false);
    expect(config.scopes.some((scope) => scope.endsWith("/calendar"))).toBe(false);
  });
});

