import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { encryptSecret } from "../gmail/crypto.ts";
import type { CalendarFetch } from "../../calendar/google-client.ts";
import type { GoogleCalendarOAuthConfig } from "./config.ts";
import type { CalendarConnectionStore } from "./store.ts";

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenUrl = "https://oauth2.googleapis.com/token";
const userInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo";
const revokeUrl = "https://oauth2.googleapis.com/revoke";
const stateTtlMs = 10 * 60_000;

export type GoogleCalendarOAuthResult =
  | { ok: true; connectionId: string; redirectUrl: string }
  | { ok: false; code: string; message: string; redirectUrl: string | null };

export function createGoogleCalendarOAuthService(options: {
  config: GoogleCalendarOAuthConfig;
  store: CalendarConnectionStore;
  fetch?: CalendarFetch;
  now?: () => Date;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    getAuthorizationUrl(userId: string, returnTo?: string | null) {
      const state = signState({
        userId,
        nonce: randomUUID(),
        issuedAt: now().toISOString(),
        returnTo: normalizeReturnTo(returnTo, options.config.webOrigin),
      }, options.config.stateSecret);
      const url = new URL(authUrl);
      url.searchParams.set("client_id", options.config.clientId);
      url.searchParams.set("redirect_uri", options.config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", options.config.scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return { url: url.toString(), state, scopes: [...options.config.scopes] };
    },

    async handleCallback(params: URLSearchParams, userId: string): Promise<GoogleCalendarOAuthResult> {
      const state = params.get("state");
      const decoded = state ? verifyState(state, options.config.stateSecret, now()) : null;
      if (!decoded || decoded.userId !== userId) return error("invalid_state", "Could not verify Calendar OAuth state.", null);
      if (params.get("error")) return error("provider_error", "Google did not grant calendar access.", decoded.returnTo);
      const code = params.get("code");
      if (!code) return error("missing_code", "Missing Calendar OAuth authorization code.", decoded.returnTo);
      let tokenResponse: Response;
      try {
        tokenResponse = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: options.config.clientId,
            client_secret: options.config.clientSecret,
            redirect_uri: options.config.redirectUri,
            grant_type: "authorization_code",
          }),
        });
      } catch {
        return error("token_exchange_failed", "Google Calendar authorization could not be completed.", decoded.returnTo);
      }
      if (!tokenResponse.ok) {
        await tokenResponse.body?.cancel();
        return error("token_exchange_failed", "Google Calendar authorization could not be completed.", decoded.returnTo);
      }
      const tokenBody = await safeObject(tokenResponse);
      const accessToken = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
      const refreshToken = typeof tokenBody?.refresh_token === "string" ? tokenBody.refresh_token : null;
      const grantedScopes = typeof tokenBody?.scope === "string" ? tokenBody.scope.split(/\s+/).filter(Boolean) : [];
      if (!accessToken || options.config.scopes.some((scope) => !grantedScopes.includes(scope))) {
        return error("scope_not_granted", "Google did not grant the dedicated free/busy permissions.", decoded.returnTo);
      }
      let identityResponse: Response;
      try {
        identityResponse = await fetchImpl(userInfoUrl, { headers: { authorization: `Bearer ${accessToken}` } });
      } catch {
        return error("identity_failed", "Google could not confirm the calendar account.", decoded.returnTo);
      }
      if (!identityResponse.ok) {
        await identityResponse.body?.cancel();
        return error("identity_failed", "Google could not confirm the calendar account.", decoded.returnTo);
      }
      const identity = await safeObject(identityResponse);
      const providerAccountId = typeof identity?.id === "string" ? identity.id : "";
      const accountLabel = typeof identity?.email === "string" ? identity.email : "";
      if (!providerAccountId || !accountLabel) return error("identity_failed", "Google did not identify the calendar account.", decoded.returnTo);
      const expiresIn = typeof tokenBody?.expires_in === "number" && Number.isFinite(tokenBody.expires_in) ? tokenBody.expires_in : null;
      try {
        const connection = await options.store.upsert({
          userId,
          providerAccountId,
          accountLabel,
          accessTokenEncrypted: encryptSecret(accessToken, options.config.tokenEncryptionKey),
          refreshTokenEncrypted: refreshToken ? encryptSecret(refreshToken, options.config.tokenEncryptionKey) : null,
          tokenExpiry: expiresIn === null ? null : new Date(now().getTime() + expiresIn * 1000),
          grantedScopes,
        });
        return { ok: true, connectionId: connection.id, redirectUrl: appendStatus(decoded.returnTo, "success") };
      } catch {
        return error("persistence_failed", "Orca could not safely store the Calendar grant.", decoded.returnTo);
      }
    },
  };
}

export async function refreshGoogleCalendarToken(input: {
  refreshToken: string;
  config: GoogleCalendarOAuthConfig;
  fetch?: CalendarFetch;
  now?: Date;
}) {
  const response = await (input.fetch ?? fetch)(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = await safeObject(response);
    return { ok: false as const, expired: body?.error === "invalid_grant" };
  }
  const body = await safeObject(response);
  if (!body || typeof body.access_token !== "string") return { ok: false as const, expired: false };
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { ok: true as const, accessToken: body.access_token, expiresAt: new Date((input.now ?? new Date()).getTime() + expiresIn * 1000) };
}

export async function revokeGoogleCalendarToken(token: string, fetchImpl: CalendarFetch = fetch) {
  try {
    const response = await fetchImpl(revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type State = { userId: string; nonce: string; issuedAt: string; returnTo: string };

function signState(value: State, secret: string) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(value: string, secret: string, now: Date): State | null {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as State;
    const issuedAt = Date.parse(decoded.issuedAt);
    if (!decoded.userId || !decoded.nonce || !decoded.returnTo || !Number.isFinite(issuedAt) || issuedAt > now.getTime() + 60_000 || now.getTime() - issuedAt > stateTtlMs) return null;
    return decoded;
  } catch { return null; }
}

function normalizeReturnTo(value: string | null | undefined, webOrigin: string) {
  const fallback = new URL("/settings/integrations/calendar", webOrigin).toString();
  if (!value) return fallback;
  try {
    const url = new URL(value, webOrigin);
    return url.origin === new URL(webOrigin).origin ? url.toString() : fallback;
  } catch { return fallback; }
}

function appendStatus(returnTo: string, status: string) {
  const url = new URL(returnTo);
  url.searchParams.set("calendar", status);
  return url.toString();
}

function error(code: string, message: string, returnTo: string | null): GoogleCalendarOAuthResult {
  return { ok: false, code, message, redirectUrl: returnTo ? appendStatus(returnTo, code) : null };
}

async function safeObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}

