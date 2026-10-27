/**
 * Mount with app.route("/v1/auth", createLogoutApp({ dbFactory })).
 * The caller must guard POST /v1/auth/logout against untrusted origins before
 * mounting; CORS alone does not prevent cross-origin cookie-authenticated writes.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { createDatabaseClient } from "../db/client.ts";
import { sessionCookieName } from "./config.ts";
import { buildClearedSessionCookie, getSessionCookieOptions } from "./jwt.ts";
import { getSessionFromToken, invalidateSession } from "./session-store.ts";

export function createLogoutApp(
  { dbFactory = createDatabaseClient }: { dbFactory?: typeof createDatabaseClient } = {},
) {
  const app = new Hono();

  app.post("/logout", async (c) => {
    const values = readSessionCookies(c.req.header("cookie"));
    const tokens = new Set(values.filter(isSessionToken));
    // Use the authentication parser itself for its selected cookie, including
    // percent decoding. Do not let it decode oversized values or scan past the
    // candidate limit; the bounded raw candidates still work in those cases.
    if (values.length > 0 && values.length <= 8 && values.every((value) => value.length <= 4096)) {
      const token = getCookie(c, sessionCookieName);
      if (token && isSessionToken(token)) tokens.add(token);
    }
    if (tokens.size > 0) {
      const { db, sqlite } = dbFactory();
      try {
        // Invalid and expired tokens have the same public result as missing cookies.
        for (const token of tokens) {
          const session = await getSessionFromToken(db, token).catch(() => null);
          if (session) invalidateSession(db, session.sessionId);
        }
      } finally {
        sqlite.close();
      }
    }
    c.header("Set-Cookie", buildClearedSessionCookie(getSessionCookieOptions()));
    return c.json({ ok: true });
  });

  return app;
}

function isSessionToken(token: string): boolean {
  return token.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function readSessionCookies(header: string | undefined): string[] {
  if (!header || header.length > 16_384) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== sessionCookieName) continue;
    // A ninth sentinel disables getCookie above, without processing its value.
    if (values.length === 8) return [...values, ""];
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values.push(value);
  }
  return values;
}
