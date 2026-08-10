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
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const store = options.store ?? new DatabaseOAuthAccountStore(dbFactory);
  const service = createGmailOAuthService({
    config,
    store,
    fetch: options.fetch,
  });
  const authMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });
  const pendingAuthMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });

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
    const accountId = c.req.query("accountId") ?? null;
    const result = service.getAuthorizationUrl(returnTo, "connect", accountId);

    return c.json({
      provider: "gmail",
      authUrl: result.url,
      state: result.state,
      redirectUri: config.redirectUri,
      scopes: result.scopes,
    });
  });

  app.get("/upgrade", authMiddleware, async (c) => {
    const configErrors = validateGmailOAuthConfig(config);
    if (configErrors.length > 0) {
      return c.json({ error: "gmail_oauth_not_configured", message: `Missing Gmail OAuth configuration: ${configErrors.join(", ")}` }, 503);
    }

    const auth = c.get("auth");
    const requestedAccountId = c.req.query("accountId");
    const account = requestedAccountId
      ? await store.findById(auth.userId, requestedAccountId)
      : await store.findForUser(auth.userId);
    if (!account) {
      return c.json({ error: "gmail_account_not_found", message: "Connect Gmail read-only before enabling compose and send." }, 404);
    }
    const result = service.getAuthorizationUrl(c.req.query("returnTo"), "upgrade", account.id);
    return c.json({
      provider: "gmail",
      intent: "upgrade",
      accountId: account.id,
      authUrl: result.url,
      state: result.state,
      redirectUri: config.redirectUri,
      scopes: result.scopes,
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
      const result = service.getAuthorizationUrl(returnTo, "connect", null, true);
      return c.json({ provider: "gmail", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
    } finally {
      sqlite.close();
    }
  });

  app.get("/callback", pendingAuthMiddleware, async (c) => {
    const auth = c.get("auth");
    const result = await service.handleCallback(new URLSearchParams(c.req.query()), auth.userId);

    const isInitialLogin = result.ok && result.initialLogin;

    if (result.ok && isInitialLogin) {
      const { db, sqlite } = dbFactory();
      try {
        const existingUser = db.select({ id: users.id }).from(users)
          .where(eq(users.email, result.account.providerEmail)).get();

        if (existingUser && existingUser.id !== auth.userId) {
          const existingAccount = db.select().from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, existingUser.id),
              eq(oauthAccounts.provider, "gmail"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();
          const pendingAccount = db.select().from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, auth.userId),
              eq(oauthAccounts.provider, "gmail"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();

          if (pendingAccount && existingAccount) {
            // The callback stores the newly exchanged Google credentials under
            // the temporary login user. Keep the existing account id so its
            // cached mail remains attached, but move the fresh credentials
            // onto that account before removing the temporary record.
            db.update(oauthAccounts)
              .set({
                providerEmail: pendingAccount.providerEmail,
                providerId: pendingAccount.providerId,
                accessTokenEncrypted: pendingAccount.accessTokenEncrypted,
                refreshTokenEncrypted: pendingAccount.refreshTokenEncrypted ?? existingAccount.refreshTokenEncrypted,
                tokenExpiry: pendingAccount.tokenExpiry,
                updatedAt: new Date(),
              })
              .where(eq(oauthAccounts.id, existingAccount.id))
              .run();
            db.delete(oauthAccounts).where(eq(oauthAccounts.id, pendingAccount.id)).run();
          } else if (pendingAccount) {
            db.update(oauthAccounts).set({ userId: existingUser.id }).where(eq(oauthAccounts.id, pendingAccount.id)).run();
          }
          db.update(users)
            .set({ onboardingCompletedAt: new Date() })
            .where(eq(users.id, existingUser.id))
            .run();
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
