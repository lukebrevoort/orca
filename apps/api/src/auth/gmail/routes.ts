import { DatabaseMailOAuthTransactionStore, type MailOAuthTransactionStore } from "../mail-oauth-transactions.ts";
import { completeMailOAuthLogin } from "../mail-oauth-login.ts";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

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
import { users } from "../../db/schema.ts";
import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { createSession } from "../session-store.ts";

type GmailAuthAppOptions = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: GmailOAuthConfig;
  store?: OAuthAccountStore;
  transactions?: MailOAuthTransactionStore;
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
    transactions: options.transactions ?? new DatabaseMailOAuthTransactionStore(dbFactory),
    fetch: options.fetch,
  });
  const authMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });
  const pendingAuthMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });

  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/status", (c) => {
    const available = validateGmailOAuthConfig(config).length === 0;
    return c.json({
      provider: "gmail" as const,
      available,
      reason: available ? null : "configuration_required" as const,
    });
  });

  app.get("/connect", authMiddleware, (c) => {
    const configErrors = validateGmailOAuthConfig(config);
    if (configErrors.length > 0) {
      console.error("Gmail authorization is unavailable because its server configuration is incomplete", {
        operation: "connect",
        configurationIssues: configErrors,
      });
      return c.json(
        {
          error: {
            code: "provider_unavailable",
            message: "Gmail sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.",
            retryable: true,
          },
        },
        503,
      );
    }

    const returnTo = c.req.query("returnTo");
    const accountId = c.req.query("accountId") ?? null;
    const result = service.getAuthorizationUrl(c.get("auth"), returnTo, "connect", accountId);

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
      console.error("Gmail authorization is unavailable because its server configuration is incomplete", {
        operation: "upgrade",
        configurationIssues: configErrors,
      });
      return c.json({ error: { code: "provider_unavailable", message: "Gmail draft and send access is unavailable in this Orca environment. Your existing mail access was not changed. Try again later.", retryable: true } }, 503);
    }

    const auth = c.get("auth");
    const requestedAccountId = c.req.query("accountId");
    const account = requestedAccountId
      ? await store.findById(auth.userId, requestedAccountId)
      : await store.findForUser(auth.userId);
    if (!account) {
      return c.json({ error: "gmail_account_not_found", message: "Connect Gmail read-only before enabling compose and send." }, 404);
    }
    const result = service.getAuthorizationUrl(auth, c.req.query("returnTo"), "upgrade", account.id);
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
      console.error("Gmail authorization is unavailable because its server configuration is incomplete", {
        operation: "login",
        configurationIssues: configErrors,
      });
      return c.json({ error: { code: "provider_unavailable", message: "Gmail sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.", retryable: true } }, 503);
    }

    const { db, sqlite } = dbFactory();
    try {
      const userId = `user_${crypto.randomUUID()}`;
      const pendingEmail = `pending-${crypto.randomUUID()}@orca.invalid`;
      db.insert(users).values({
        id: userId,
        email: pendingEmail,
      }).run();
      const session = await createSession(db, userId);
      c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt, getSessionCookieOptions()));
      const returnTo = c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`;
      const result = service.getAuthorizationUrl(session, returnTo, "connect", null, pendingEmail);
      return c.json({ provider: "gmail", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
    } finally {
      sqlite.close();
    }
  });

  app.get("/callback", pendingAuthMiddleware, async (c) => {
    const auth = c.get("auth");
    let result;
    try {
      result = await service.handleCallback(new URLSearchParams(c.req.query()), auth);
    } catch (error) {
      console.error("Gmail authorization callback failed", { error });
      return c.json({
        ok: false,
        error: "authorization_failed",
        message: "Gmail sign-in could not be completed. Nothing in your account was changed. Try again from Orca.",
      }, 502);
    }

    if (result.ok && result.pendingEmail) {
      const { db, sqlite } = dbFactory();
      try {
        const completion = completeMailOAuthLogin(db, {
          userId: auth.userId, sessionId: auth.sessionId, pendingEmail: result.pendingEmail, provider: "gmail", scopeReturned: result.scopeReturned,
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

    if (result.ok) {
      if (result.redirectUrl) {
        return c.redirect(result.redirectUrl, 302);
      }
      return c.json({ ok: true, provider: "gmail", account: result.account });
    }

    if (result.redirectUrl) {
      console.error("Gmail authorization was not completed", {
        code: result.code,
        diagnostic: result.message,
      });
      return c.redirect(result.redirectUrl, 302);
    }

    console.error("Gmail authorization was not completed", {
      code: result.code,
      diagnostic: result.message,
    });
    return c.json(
      {
        ok: false,
        error: result.code,
        message: result.code === "oauth_not_configured"
          ? "Gmail sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later."
          : "Gmail sign-in could not be completed. Nothing in your account was changed. Try again from Orca.",
      },
      result.code === "oauth_not_configured" ? 503 : 400,
    );
  });

  return app;
}

export function redirectReturningUserToWorkspace(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  if (url.pathname === "/onboarding") url.pathname = "/";
  return url.toString();
}
