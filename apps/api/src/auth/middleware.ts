import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { createDatabaseClient } from "../db/client.ts";
import { sessionCookieName, sessionRenewalWindowMs } from "./config.ts";
import { buildSessionCookie, getSessionCookieOptions } from "./jwt.ts";
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
    const sessionToken = getCookie(c, sessionCookieName);

    if (!sessionToken) {
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

    const dbFactory = options.dbFactory ?? createDatabaseClient;
    const { db, sqlite } = dbFactory();

    try {
      let auth: AuthContext | null;

      try {
        auth = await getSessionFromToken(db, sessionToken);
      } catch {
        auth = null;
      }

      if (!auth) {
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

      if (shouldRenewSession(auth.expiresAt)) {
        const renew = options.renewSession ?? renewSession;
        const renewed = await renew(db, auth).catch(() => null);

        if (!renewed) {
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
