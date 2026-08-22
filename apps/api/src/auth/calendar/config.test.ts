import { describe, expect, test } from "bun:test";

import { googleCalendarReadScopes, loadGoogleCalendarOAuthConfig, validateGoogleCalendarOAuthConfig } from "./config.ts";

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

  test("reuses Orca's existing Google OAuth client without sharing the Gmail grant", () => {
    const config = loadGoogleCalendarOAuthConfig({
      GMAIL_CLIENT_ID: "existing-google-client",
      GMAIL_CLIENT_SECRET: "existing-google-secret",
      GMAIL_REDIRECT_URI: "https://api.orca.example/v1/auth/gmail/callback",
      GMAIL_OAUTH_STATE_SECRET: "gmail-state-secret",
      TOKEN_ENCRYPTION_KEY: "token-key",
    });

    expect(config.clientId).toBe("existing-google-client");
    expect(config.clientSecret).toBe("existing-google-secret");
    expect(config.redirectUri).toBe("https://api.orca.example/v1/auth/calendar/google/callback");
    expect(config.stateSecret).toBe("gmail-state-secret");
    expect(config.scopes).toEqual(googleCalendarReadScopes);
    expect(validateGoogleCalendarOAuthConfig(config)).toEqual([]);
  });

  test("prefers dedicated Calendar OAuth overrides when they are configured", () => {
    const config = loadGoogleCalendarOAuthConfig({
      GOOGLE_CALENDAR_CLIENT_ID: "calendar-client",
      GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-secret",
      GOOGLE_CALENDAR_REDIRECT_URI: "https://api.orca.example/custom-calendar-callback",
      GOOGLE_CALENDAR_OAUTH_STATE_SECRET: "calendar-state",
      GMAIL_CLIENT_ID: "gmail-client",
      GMAIL_CLIENT_SECRET: "gmail-secret",
      GMAIL_REDIRECT_URI: "https://api.orca.example/v1/auth/gmail/callback",
      TOKEN_ENCRYPTION_KEY: "token-key",
    });

    expect(config).toMatchObject({
      clientId: "calendar-client",
      clientSecret: "calendar-secret",
      redirectUri: "https://api.orca.example/custom-calendar-callback",
      stateSecret: "calendar-state",
    });
  });
});
