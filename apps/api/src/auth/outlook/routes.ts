import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";

import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import { createSession } from "../session-store.ts";
import { DatabaseOAuthAccountStore, type OAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { loadOutlookOAuthConfig, validateOutlookOAuthConfig, type OutlookOAuthConfig } from "./config.ts";
import { createOutlookOAuthService, type OutlookFetch } from "./oauth.ts";

type Options = { authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>; config?: OutlookOAuthConfig; store?: OAuthAccountStore; fetch?: OutlookFetch; dbFactory?: typeof createDatabaseClient };

export function createOutlookAuthApp(options: Options = {}): Hono<{ Variables: AuthVariables }> {
  const config = options.config ?? loadOutlookOAuthConfig();
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const store = options.store ?? new DatabaseOAuthAccountStore(dbFactory, "outlook");
  const service = createOutlookOAuthService({ config, store, fetch: options.fetch });
  const auth = options.authMiddleware ?? requireAuth({ dbFactory });
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/status", (c) => {
    const available = validateOutlookOAuthConfig(config).length === 0;
    return c.json({
      provider: "outlook" as const,
      available,
      reason: available ? null : "configuration_required" as const,
    });
  });

  const start = (initialLogin: boolean): Handler<{ Variables: AuthVariables }> => async (c) => {
    const missing = validateOutlookOAuthConfig(config);
    if (missing.length) {
      console.error("Outlook authorization is unavailable because its server configuration is incomplete", {
        operation: "connect",
        configurationIssues: missing,
      });
      return c.json({ error: { code: "provider_unavailable", message: "Outlook sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.", retryable: true } }, 503);
    }
    const result = service.getAuthorizationUrl(c.req.query("returnTo"), initialLogin);
    return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  };

  app.get("/connect", auth, start(false));
  app.get("/login", async (c) => {
    const missing = validateOutlookOAuthConfig(config);
    if (missing.length) {
      console.error("Outlook authorization is unavailable because its server configuration is incomplete", {
        operation: "login",
        configurationIssues: missing,
      });
      return c.json({ error: { code: "provider_unavailable", message: "Outlook sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.", retryable: true } }, 503);
    }
    const { db, sqlite } = dbFactory();
    try {
      const userId = `user_${crypto.randomUUID()}`;
      db.insert(users).values({ id: userId, email: `pending-${crypto.randomUUID()}@orca.invalid` }).run();
      const session = await createSession(db, userId);
      c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));
      const result = service.getAuthorizationUrl(c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`, true);
      return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
    } finally { sqlite.close(); }
  });
  app.get("/callback", auth, async (c) => {
    const current = c.get("auth");
    let result;
    try {
      result = await service.handleCallback(new URLSearchParams(c.req.query()), current.userId);
    } catch (error) {
      console.error("Outlook authorization callback failed", { error });
      return c.json({ ok: false, error: "authorization_failed", message: "Outlook sign-in could not be completed. Nothing in your account was changed. Try again from Orca." }, 502);
    }
    if (result.ok && result.initialLogin) {
      const { db, sqlite } = dbFactory();
      try {
        const existingUser = db.select({ id: users.id }).from(users)
          .where(eq(users.email, result.account.providerEmail)).get();

        if (existingUser && existingUser.id !== current.userId) {
          const existingAccount = db.select().from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, existingUser.id),
              eq(oauthAccounts.provider, "outlook"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();
          const pendingAccount = db.select().from(oauthAccounts)
            .where(and(
              eq(oauthAccounts.userId, current.userId),
              eq(oauthAccounts.provider, "outlook"),
              eq(oauthAccounts.providerId, result.account.providerAccountId),
            )).get();

          if (pendingAccount && existingAccount) {
            db.update(oauthAccounts)
              .set({
                providerEmail: pendingAccount.providerEmail,
                providerId: pendingAccount.providerId,
                profileImageUrl: pendingAccount.profileImageUrl ?? existingAccount.profileImageUrl,
                accessTokenEncrypted: pendingAccount.accessTokenEncrypted,
                refreshTokenEncrypted: pendingAccount.refreshTokenEncrypted ?? existingAccount.refreshTokenEncrypted,
                tokenExpiry: pendingAccount.tokenExpiry,
                scope: pendingAccount.scope,
                updatedAt: new Date(),
              })
              .where(eq(oauthAccounts.id, existingAccount.id))
              .run();
            db.delete(oauthAccounts).where(eq(oauthAccounts.id, pendingAccount.id)).run();
          } else if (pendingAccount) {
            db.update(oauthAccounts)
              .set({ userId: existingUser.id })
              .where(eq(oauthAccounts.id, pendingAccount.id))
              .run();
          }

          db.update(users)
            .set({ authenticatedAt: new Date(), onboardingCompletedAt: new Date() })
            .where(eq(users.id, existingUser.id))
            .run();
          db.delete(users).where(eq(users.id, current.userId)).run();
          const session = await createSession(db, existingUser.id);
          c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));

          if (result.redirectUrl) return c.redirect(redirectReturningUserToWorkspace(result.redirectUrl), 302);
        } else {
          db.update(users)
            .set({ email: result.account.providerEmail, authenticatedAt: new Date(), onboardingCompletedAt: new Date() })
            .where(eq(users.id, current.userId))
            .run();
        }
      } finally { sqlite.close(); }
    }
    if (result.redirectUrl) {
      if (!result.ok) console.error("Outlook authorization was not completed", { code: result.code, diagnostic: result.message });
      return c.redirect(result.redirectUrl, 302);
    }
    if (result.ok) return c.json({ ok: true, provider: "outlook", account: result.account });
    console.error("Outlook authorization was not completed", { code: result.code, diagnostic: result.message });
    return c.json({ ok: false, error: result.code, message: "Outlook sign-in could not be completed. Nothing in your account was changed. Try again from Orca." }, 400);
  });
  return app;
}

export function redirectReturningUserToWorkspace(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  url.pathname = "/";
  return url.toString();
}
