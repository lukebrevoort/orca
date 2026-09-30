import { DatabaseMailOAuthTransactionStore, type MailOAuthTransactionStore } from "../mail-oauth-transactions.ts";
import { completeMailOAuthLogin } from "../mail-oauth-login.ts";
import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";

import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import { createSession } from "../session-store.ts";
import { DatabaseOAuthAccountStore, type OAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { loadOutlookOAuthConfig, validateOutlookOAuthConfig, type OutlookOAuthConfig } from "./config.ts";
import { createOutlookOAuthService, type OutlookFetch } from "./oauth.ts";

type Options = { authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>; config?: OutlookOAuthConfig; store?: OAuthAccountStore; transactions?: MailOAuthTransactionStore; fetch?: OutlookFetch; dbFactory?: typeof createDatabaseClient };

export function createOutlookAuthApp(options: Options = {}): Hono<{ Variables: AuthVariables }> {
  const config = options.config ?? loadOutlookOAuthConfig();
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const store = options.store ?? new DatabaseOAuthAccountStore(dbFactory, "outlook");
  const service = createOutlookOAuthService({ config, store, transactions: options.transactions ?? new DatabaseMailOAuthTransactionStore(dbFactory), fetch: options.fetch });
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

  const start: Handler<{ Variables: AuthVariables }> = async (c) => {
    const missing = validateOutlookOAuthConfig(config);
    if (missing.length) {
      console.error("Outlook authorization is unavailable because its server configuration is incomplete", {
        operation: "connect",
        configurationIssues: missing,
      });
      return c.json({ error: { code: "provider_unavailable", message: "Outlook sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.", retryable: true } }, 503);
    }
    const result = service.getAuthorizationUrl(c.get("auth"), c.req.query("returnTo"));
    return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  };

  app.get("/connect", auth, start);
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
      const pendingEmail = `pending-${crypto.randomUUID()}@orca.invalid`;
      db.insert(users).values({ id: userId, email: pendingEmail }).run();
      const session = await createSession(db, userId);
      c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));
      const result = service.getAuthorizationUrl(session, c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`, pendingEmail);
      return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
    } finally { sqlite.close(); }
  });
  app.get("/callback", auth, async (c) => {
    const current = c.get("auth");
    let result;
    try {
      result = await service.handleCallback(new URLSearchParams(c.req.query()), current);
    } catch (error) {
      console.error("Outlook authorization callback failed", { error });
      return c.json({ ok: false, error: "authorization_failed", message: "Outlook sign-in could not be completed. Nothing in your account was changed. Try again from Orca." }, 502);
    }
    if (result.ok && result.pendingEmail) {
      const { db, sqlite } = dbFactory();
      try {
        const completion = completeMailOAuthLogin(db, {
          userId: current.userId, sessionId: current.sessionId, pendingEmail: result.pendingEmail, provider: "outlook",
          ...result.account,
        });
        if (!completion.ok) return c.json({ ok: false, error: "invalid_state", message: "The pending login is no longer available. Try again from Orca." }, 400);
        if (completion.returningUserId) {
          const session = await createSession(db, completion.returningUserId);
          c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));
          if (result.redirectUrl) return c.redirect(redirectReturningUserToWorkspace(result.redirectUrl), 302);
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
  if (url.pathname === "/onboarding") url.pathname = "/";
  return url.toString();
}
