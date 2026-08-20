const defaultRedirectUri = "http://localhost:3000/v1/auth/calendar/google/callback";
const defaultWebOrigin = "http://localhost:5173";

/** Fixed allowlist: do not make this user-configurable with an env var. */
export const googleCalendarReadScopes = [
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export type GoogleCalendarOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenEncryptionKey: string;
  stateSecret: string;
  webOrigin: string;
  scopes: readonly string[];
};

export function loadGoogleCalendarOAuthConfig(env: Record<string, string | undefined> = process.env): GoogleCalendarOAuthConfig {
  return {
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: absoluteUrl(env.GOOGLE_CALENDAR_REDIRECT_URI ?? defaultRedirectUri, "GOOGLE_CALENDAR_REDIRECT_URI"),
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? env.OAUTH_TOKEN_ENCRYPTION_KEY ?? "",
    stateSecret: env.GOOGLE_CALENDAR_OAUTH_STATE_SECRET ?? env.SESSION_SECRET ?? "",
    webOrigin: new URL(env.WEB_ORIGIN ?? defaultWebOrigin).origin,
    scopes: googleCalendarReadScopes,
  };
}

export function validateGoogleCalendarOAuthConfig(config: GoogleCalendarOAuthConfig) {
  const missing: string[] = [];
  if (!config.clientId) missing.push("GOOGLE_CALENDAR_CLIENT_ID");
  if (!config.clientSecret) missing.push("GOOGLE_CALENDAR_CLIENT_SECRET");
  if (!config.tokenEncryptionKey) missing.push("TOKEN_ENCRYPTION_KEY");
  if (!config.stateSecret) missing.push("SESSION_SECRET");
  return missing;
}

function absoluteUrl(value: string, name: string) {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

