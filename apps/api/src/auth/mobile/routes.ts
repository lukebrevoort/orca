import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";

import { getServerConfig } from "../../config/server.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import {
  bindMobileAuthRequest,
  admitMobileAuthRequest,
  exchangeMobileAuthorizationCode,
  grantMobileAuthRequest,
  revokeMobileSession,
} from "./store.ts";

const requestBindingCookie = "orca_mobile_auth_request";
const pkceValuePattern = /^[A-Za-z0-9_-]{43,128}$/;
const statePattern = /^[A-Za-z0-9_-]{32,128}$/;
const startAdmissionWindowMs = 60_000;
const startAdmissionMaximum = 120;
let startAdmissionWindow = { startedAt: 0, count: 0 };

type MobileAuthAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  webOrigin?: string;
  now?: () => Date;
  cookieSecure?: boolean;
  cookieAuthMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
};

export function createMobileAuthApp(options: MobileAuthAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const webOrigin = new URL(options.webOrigin ?? getServerConfig().webOrigin).origin;
  const now = options.now ?? (() => new Date());
  const cookieSecure = options.cookieSecure ?? process.env.NODE_ENV === "production";
  const cookieAuth = options.cookieAuthMiddleware ?? requireAuth({ dbFactory, allowMobileBearer: false });
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("/start", bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => error(c, 413, "payload_too_large", "The mobile authorization request is too large"),
  }));

  app.post("/start", async (c) => {
    if (!admitStartAt(Date.now())) {
      c.header("Retry-After", "60");
      return error(c, 429, "rate_limited", "Too many mobile authorization requests are starting; try again shortly");
    }
    const body = await readJson(c.req.raw);
    const codeChallenge = stringField(body, "codeChallenge");
    const state = stringField(body, "state");
    if (!codeChallenge || !pkceValuePattern.test(codeChallenge) || !state || !statePattern.test(state)) {
      return error(c, 400, "invalid_request", "codeChallenge and state must be base64url values with sufficient entropy");
    }
    const { db, sqlite } = dbFactory();
    try {
      const request = admitMobileAuthRequest(db, { codeChallenge, state }, now());
      if (!request) {
        c.header("Retry-After", "60");
        return error(c, 503, "authorization_capacity", "Mobile authorization is temporarily at capacity; try again shortly");
      }
      const authorizationUrl = new URL("/mobile-auth", webOrigin);
      authorizationUrl.searchParams.set("request", request.requestToken);
      return c.json({ authorizationUrl: authorizationUrl.toString(), expiresAt: request.expiresAt.toISOString() });
    } finally {
      sqlite.close();
    }
  });

  app.get("/authorize", cookieAuth, (c) => {
    const requestToken = c.req.query("request");
    if (!requestToken || !pkceValuePattern.test(requestToken)) {
      return error(c, 400, "invalid_request", "The mobile authorization request is invalid");
    }
    const existingBinding = getCookie(c, requestBindingCookie);
    if (existingBinding && existingBinding !== requestToken) {
      return error(c, 409, "request_binding_conflict", "A different mobile authorization request is already active in this browser");
    }
    const auth = c.get("auth");
    const { db, sqlite } = dbFactory();
    try {
      const user = db.select({ email: users.email, authenticatedAt: users.authenticatedAt })
        .from(users).where(eq(users.id, auth.userId)).get();
      if (!user?.authenticatedAt) {
        return error(c, 403, "authenticated_user_required", "Finish signing in before connecting this device");
      }
      const bound = bindMobileAuthRequest(db, {
        requestToken,
        userId: auth.userId,
        browserSessionId: auth.sessionId,
      }, now());
      if (!bound) {
        return error(c, 400, "invalid_request", "The mobile authorization request is expired, used, or belongs to another session");
      }
      setCookie(c, requestBindingCookie, requestToken, {
        httpOnly: true,
        sameSite: "Lax",
        secure: cookieSecure,
        path: "/v1/mobile/auth",
        maxAge: 10 * 60,
      });
      return c.json({
        accountEmail: user.email,
        csrfToken: bound.csrfToken,
        expiresAt: bound.expiresAt.toISOString(),
      });
    } finally {
      sqlite.close();
    }
  });

  app.post("/grant", cookieAuth, async (c) => {
    if (c.req.header("origin") !== webOrigin) {
      return error(c, 403, "invalid_origin", "The authorization confirmation must come from Orca");
    }
    const requestToken = getCookie(c, requestBindingCookie);
    const body = await readJson(c.req.raw);
    const csrfToken = stringField(body, "csrfToken");
    if (!requestToken || !csrfToken || !pkceValuePattern.test(csrfToken)) {
      return error(c, 400, "invalid_request", "The authorization confirmation is invalid");
    }
    const auth = c.get("auth");
    const { db, sqlite } = dbFactory();
    try {
      const granted = grantMobileAuthRequest(db, {
        requestToken,
        csrfToken,
        userId: auth.userId,
        browserSessionId: auth.sessionId,
      }, now());
      if (!granted) {
        return error(c, 400, "invalid_request", "The authorization confirmation is expired, used, or belongs to another session");
      }
      deleteCookie(c, requestBindingCookie, {
        secure: cookieSecure,
        path: "/v1/mobile/auth",
      });
      const redirectUrl = new URL("orca://auth");
      redirectUrl.searchParams.set("code", granted.authorizationCode);
      redirectUrl.searchParams.set("state", granted.state);
      return c.json({ redirectUrl: redirectUrl.toString() });
    } finally {
      sqlite.close();
    }
  });

  app.post("/exchange", async (c) => {
    const body = await readJson(c.req.raw);
    const code = stringField(body, "code");
    const codeVerifier = stringField(body, "codeVerifier");
    if (!code || !pkceValuePattern.test(code) || !codeVerifier || !pkceValuePattern.test(codeVerifier)) {
      return error(c, 400, "invalid_grant", "The authorization code or PKCE verifier is invalid");
    }
    const { db, sqlite } = dbFactory();
    try {
      const session = exchangeMobileAuthorizationCode(db, { code, codeVerifier }, now());
      if (!session) return error(c, 400, "invalid_grant", "The authorization code is invalid, expired, or already used");
      return c.json({ accessToken: session.accessToken, expiresAt: session.expiresAt.toISOString() });
    } finally {
      sqlite.close();
    }
  });

  app.delete("/session", requireAuth({ dbFactory }), (c) => {
    if (!c.req.header("authorization")?.match(/^Bearer [A-Za-z0-9_-]+$/i)) {
      return error(c, 401, "unauthorized", "A mobile bearer session is required");
    }
    const auth = c.get("auth");
    const { db, sqlite } = dbFactory();
    try {
      revokeMobileSession(db, auth.sessionId, auth.userId, now());
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  return app;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function error(c: Context, status: 400 | 401 | 403 | 409 | 413 | 429 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function admitStartAt(timestamp: number) {
  if (timestamp - startAdmissionWindow.startedAt >= startAdmissionWindowMs) {
    startAdmissionWindow = { startedAt: timestamp, count: 0 };
  }
  if (startAdmissionWindow.count >= startAdmissionMaximum) return false;
  startAdmissionWindow.count += 1;
  return true;
}
