import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { createDatabaseClient } from "../db/client.ts";
import { sessionCookieName } from "./config.ts";
import { getSessionFromToken } from "./session-store.ts";

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
};

export function requireAuth(
  options: RequireAuthOptions = {},
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
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

      c.set("auth", auth);

      await next();
    } finally {
      sqlite.close();
    }
  };
}
