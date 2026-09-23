import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { createDatabaseClient } from "../db/client.ts";
import { sessionCookieName, sessionRenewalWindowMs } from "./config.ts";
import { buildSessionCookie, getSessionCookieOptions } from "./jwt.ts";
import { getMobileSessionFromToken } from "./mobile/store.ts";
import { getSessionFromToken, renewSession } from "./session-store.ts";

export type AuthContext = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
};

export type AuthVariables = {
  auth: AuthContext;
};

type RequireAuthOptions = {
  dbFactory?: typeof createDatabaseClient;
  renewSession?: typeof renewSession;
  allowMobileBearer?: boolean;
};

export function shouldRenewSession(expiresAt: Date, now = Date.now()) {
  return expiresAt.getTime() - now <= sessionRenewalWindowMs;
}

export function requireAuth(
  options: RequireAuthOptions = {},
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    // Shared route groups may authenticate once before bounded body admission.
    // Route-local guards remain safe and free of duplicate database work.
    if (c.get("auth")) return next();
    const authorization = c.req.header("authorization");
    const bearerMatch = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
    const bearerToken = bearerMatch?.[1] ?? null;
    const sessionToken = getCookie(c, sessionCookieName);

    if (authorization && !bearerToken) {
      return unauthorized(c);
    }

    if (!bearerToken && !sessionToken) {
      return unauthorized(c);
    }

    if (bearerToken && options.allowMobileBearer === false) {
      return unauthorized(c);
    }

    const dbFactory = options.dbFactory ?? createDatabaseClient;
    const { db, sqlite } = dbFactory();

    try {
      if (bearerToken) {
        const mobileAuth = getMobileSessionFromToken(db, bearerToken);
        if (!mobileAuth) return unauthorized(c);
        c.set("auth", mobileAuth);
        await next();
        return;
      }

      if (!sessionToken) {
        return unauthorized(c);
      }

      let auth: AuthContext | null;

      try {
        auth = await getSessionFromToken(db, sessionToken);
      } catch {
        auth = null;
      }

      if (!auth) {
        return unauthorized(c);
      }

      if (shouldRenewSession(auth.expiresAt)) {
        const renew = options.renewSession ?? renewSession;
        const renewed = await renew(db, auth).catch(() => null);

        if (!renewed) {
          return unauthorized(c);
        }

        c.header("Set-Cookie", buildSessionCookie(renewed.token, renewed.expiresAt, getSessionCookieOptions()));
        c.set("auth", {
          sessionId: renewed.sessionId,
          userId: renewed.userId,
          expiresAt: renewed.expiresAt,
        });
      } else {
        c.set("auth", auth);
      }

      await next();
    } finally {
      sqlite.close();
    }
  };
}

function unauthorized(c: Parameters<MiddlewareHandler>[0]) {
  return c.json(
    {
      error: {
        code: "unauthorized",
        message: "Authentication required",
      },
    },
    401,
  );
}
