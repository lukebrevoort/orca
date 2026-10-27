/**
 * Mount with app.route("/api/auth", createLogoutApp({ dbFactory })).
 * The caller must guard POST /api/auth/logout against untrusted origins before
 * mounting; CORS alone does not prevent cross-origin cookie-authenticated writes.
 */
import { Hono } from "hono";

import { createDatabaseClient } from "../db/client.ts";
import { sessionCookieName } from "./config.ts";
import { buildSessionCookie, getSessionCookieOptions } from "./jwt.ts";
import { getSessionFromToken, invalidateSession } from "./session-store.ts";

export function createLogoutApp(
  { dbFactory = createDatabaseClient }: { dbFactory?: typeof createDatabaseClient } = {},
) {
  const app = new Hono();

  app.post("/logout", async (c) => {
    const token = readSessionCookie(c.req.header("cookie"));
    if (token) {
      const { db, sqlite } = dbFactory();
      try {
        // Invalid and expired tokens have the same public result as missing cookies.
        const session = await getSessionFromToken(db, token).catch(() => null);
        if (session) invalidateSession(db, session.sessionId);
      } finally {
        sqlite.close();
      }
    }
    c.header("Set-Cookie", buildSessionCookie("", new Date(0), getSessionCookieOptions()));
    return c.json({ ok: true });
  });

  return app;
}

function readSessionCookie(header: string | undefined): string | null {
  // Bound work on untrusted input and reject ambiguous cookies rather than
  // choosing a session based on cookie order or decoding attacker-controlled bytes.
  if (!header || header.length > 16_384 || /[^\x20-\x7e]/.test(header)) return null;
  const matches = header.split(";").filter((part) => {
    const separator = part.indexOf("=");
    return part.slice(0, separator < 0 ? part.length : separator).trim() === sessionCookieName;
  });
  if (matches.length !== 1) return null;
  const cookie = matches[0]!;
  const separator = cookie.indexOf("=");
  if (separator < 0) return null;
  const token = cookie.slice(separator + 1).trim();
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  return token;
}
