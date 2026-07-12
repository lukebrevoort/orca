import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";

import { requireAuth, type AuthVariables } from "../middleware.ts";
import {
  loadGmailOAuthConfig,
  validateGmailOAuthConfig,
  type GmailOAuthConfig,
} from "./config.ts";
import {
  DatabaseOAuthAccountStore,
  type OAuthAccountStore,
} from "./oauth-accounts.ts";
import { createGmailOAuthService, type FetchLike } from "./oauth.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { createSession } from "../session-store.ts";

type GmailAuthAppOptions = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: GmailOAuthConfig;
  store?: OAuthAccountStore;
  fetch?: FetchLike;
  dbFactory?: typeof createDatabaseClient;
};

export function createGmailAuthApp(options: GmailAuthAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const config = options.config ?? loadGmailOAuthConfig();
  const store = options.store ?? new DatabaseOAuthAccountStore();
  const service = createGmailOAuthService({
    config,
    store,
    fetch: options.fetch,
  });
  const authMiddleware = options.authMiddleware ?? requireAuth();
  const pendingAuthMiddleware = options.authMiddleware ?? requireAuth();
  const dbFactory = options.dbFactory ?? createDatabaseClient;

  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/connect", authMiddleware, (c) => {
    const configErrors = validateGmailOAuthConfig(config);
    if (configErrors.length > 0) {
      return c.json(
        {
          error: "gmail_oauth_not_configured",
          message: `Missing Gmail OAuth configuration: ${configErrors.join(", ")}`,
        },
        503,
      );
    }

    const returnTo = c.req.query("returnTo");
    const result = service.getAuthorizationUrl(returnTo);

    return c.json({
      provider: "gmail",
      authUrl: result.url,
      state: result.state,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
    });
  });

  app.get("/login", async (c) => {
    const configErrors = validateGmailOAuthConfig(config);
    if (configErrors.length > 0) {
      return c.json({ error: "gmail_oauth_not_configured", message: `Missing Gmail OAuth configuration: ${configErrors.join(", ")}` }, 503);
    }

    const { db, sqlite } = dbFactory();
    try {
      const userId = `user_${crypto.randomUUID()}`;
      db.insert(users).values({
        id: userId,
        email: `pending-${crypto.randomUUID()}@orca.invalid`,
      }).run();
      const session = await createSession(db, userId);
      c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));
      const returnTo = c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`;
      const result = service.getAuthorizationUrl(returnTo);
      return c.json({ provider: "gmail", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: config.scopes });
    } finally {
      sqlite.close();
    }
  });

  app.get("/callback", pendingAuthMiddleware, async (c) => {
    const auth = c.get("auth");
    const result = await service.handleCallback(new URLSearchParams(c.req.query()), auth.userId);

    const isInitialLogin = result.ok && result.redirectUrl
      ? new URL(result.redirectUrl).pathname === "/onboarding"
      : false;

    if (result.ok && isInitialLogin) {
      const { db, sqlite } = dbFactory();
      try {
        const existingUser = db.select({ id: users.id }).from(users)
          .where(eq(users.email, result.account.providerEmail)).get();

        if (existingUser && existingUser.id !== auth.userId) {
          const existingAccount = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, existingUser.id),
              eq(oauthAccounts.provider, "gmail"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();
          const pendingAccount = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, auth.userId),
              eq(oauthAccounts.provider, "gmail"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();

          if (pendingAccount && existingAccount) {
            db.delete(oauthAccounts).where(eq(oauthAccounts.id, pendingAccount.id)).run();
          } else if (pendingAccount) {
            db.update(oauthAccounts).set({ userId: existingUser.id }).where(eq(oauthAccounts.id, pendingAccount.id)).run();
          }
          db.delete(users).where(eq(users.id, auth.userId)).run();
          const session = await createSession(db, existingUser.id);
          c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));

          // A returning user should land in their workspace, not the first-time
          // onboarding screen that initiated the OAuth flow.
          if (result.redirectUrl) {
            return c.redirect(redirectReturningUserToWorkspace(result.redirectUrl), 302);
          }
        } else {
          db.update(users)
            .set({ email: result.account.providerEmail, authenticatedAt: new Date() })
            .where(eq(users.id, auth.userId))
            .run();
        }
      } finally {
        sqlite.close();
      }
      if (result.redirectUrl) {
        return c.redirect(result.redirectUrl, 302);
      }
      return c.json({
        ok: true,
        provider: "gmail",
        account: result.account,
      });
    }

    if (result.ok) {
      if (result.redirectUrl) {
        return c.redirect(result.redirectUrl, 302);
      }
      return c.json({ ok: true, provider: "gmail", account: result.account });
    }

    if (result.redirectUrl) {
      return c.redirect(result.redirectUrl, 302);
    }

    return c.json(
      {
        ok: false,
        error: result.code,
        message: result.message,
      },
      result.code === "oauth_not_configured" ? 503 : 400,
    );
  });

  return app;
}

export function redirectReturningUserToWorkspace(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  url.pathname = "/";
  return url.toString();
}
