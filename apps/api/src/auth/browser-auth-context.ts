import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { browserAuthContextCookieName } from "@orca/shared";
import { getAuthConfig, sessionCookieName } from "./config.ts";
import { buildClearedSessionCookie, buildSessionCookie, getSessionCookieOptions, type SessionCookieOptions, type SessionTokenPayload } from "./jwt.ts";

/** A noncredential witness. Input must come from a verified server session. */
export function createBrowserAuthContext(session: Pick<SessionTokenPayload, "userId" | "sessionId">): string {
  return `v1.${createHmac("sha256", getAuthConfig().sessionSecret)
    .update(JSON.stringify(["orca/browser-auth-context/v1", session.userId, session.sessionId]))
    .digest("base64url")}`;
}

function witnessCookie(value: string, expiresAt: Date, options: SessionCookieOptions): string {
  return buildSessionCookie(value, expiresAt, options)
    .replace(`${sessionCookieName}=`, `${browserAuthContextCookieName}=`)
    .replace("; HttpOnly", "");
}

/** Build a verified browser authentication transition; never use pending identities. */
export function buildBrowserSessionCookiePair(
  session: SessionTokenPayload & { token: string },
  options: SessionCookieOptions = getSessionCookieOptions(),
): [string, string] {
  return [buildSessionCookie(session.token, session.expiresAt, options), witnessCookie(createBrowserAuthContext(session), session.expiresAt, options)];
}

export function buildClearedBrowserSessionCookiePair(options: SessionCookieOptions = getSessionCookieOptions()): [string, string] {
  return [buildClearedSessionCookie(options), witnessCookie("", new Date(0), options)];
}

/** Preserve unrelated Set-Cookie fields and replace both members of any older pair. */
function writePair(c: Context, pair: [string, string]): void {
  const unrelated = c.res.headers.getSetCookie().filter(cookie => ![sessionCookieName, browserAuthContextCookieName].some(name => cookie.startsWith(`${name}=`)));
  c.header("Set-Cookie", undefined);
  for (const cookie of [...unrelated, ...pair]) c.header("Set-Cookie", cookie, { append: true });
  c.header("Cache-Control", "private, no-store");
}

export function setBrowserSessionCookies(c: Context, session: SessionTokenPayload & { token: string }): void {
  writePair(c, buildBrowserSessionCookiePair(session));
}

export function clearBrowserSessionCookies(c: Context): void {
  writePair(c, buildClearedBrowserSessionCookiePair());
}

/** Pending OAuth credentials invalidate the witness without asserting an owner. */
export function setPendingBrowserSessionCookies(c: Context, session: { token: string; expiresAt: Date }): void {
  const options = getSessionCookieOptions();
  writePair(c, [buildSessionCookie(session.token, session.expiresAt, options), witnessCookie("", new Date(0), options)]);
}
