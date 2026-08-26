import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";

import { completeOAuthLogin } from "../complete-oauth-login.ts";
import type { OAuthAccountStore, OAuthAccountUpsert } from "../gmail/oauth-accounts.ts";
import { DatabaseOAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import {
  buildClearedOAuthAttemptCookie,
  buildOAuthAttemptCookie,
  consumeOAuthTransactionForBindings,
  createOAuthAttemptBinding,
  DatabaseOAuthTransactionStore,
  normalizeOAuthReturnTo,
  oauthLoginRateLimitKey,
  resolveOAuthCallbackBindings,
  type OAuthTransactionStore,
} from "../oauth-transactions.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { loadOutlookOAuthConfig, validateOutlookOAuthConfig, type OutlookOAuthConfig } from "./config.ts";
import { buildOutlookOAuthError, createOutlookOAuthService, type OutlookFetch } from "./oauth.ts";

type Options = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: OutlookOAuthConfig;
  store?: OAuthAccountStore;
  transactionStore?: OAuthTransactionStore;
  fetch?: OutlookFetch;
  dbFactory?: typeof createDatabaseClient;
};

export function createOutlookAuthApp(options: Options = {}): Hono<{ Variables: AuthVariables }> {
  const config = options.config ?? loadOutlookOAuthConfig();
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const store = options.store ?? new DatabaseOAuthAccountStore(dbFactory, "outlook");
  const transactionStore = options.transactionStore ?? new DatabaseOAuthTransactionStore(dbFactory);
  const service = createOutlookOAuthService({ config, store, fetch: options.fetch });
  const authMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/connect", authMiddleware, async (c) => {
    const configurationError = outlookConfigurationError(c, config);
    if (configurationError) return configurationError;
    const auth = c.get("auth");
    const started = await transactionStore.begin({
      provider: "outlook",
      intent: "connect",
      sessionId: auth.sessionId,
      userId: auth.userId,
      returnTo: normalizeOAuthReturnTo(c.req.query("returnTo"), config.webOrigin),
      usePkce: true,
    });
    if (!started.ok) return rateLimited(c);
    if (!started.codeVerifier) return c.json({ error: "outlook_oauth_start_failed", message: "Could not create a secure Outlook OAuth transaction." }, 500);
    const result = service.getAuthorizationUrl(started.state, started.codeVerifier);
    return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  app.get("/login", async (c) => {
    const configurationError = outlookConfigurationError(c, config);
    if (configurationError) return configurationError;
    const attempt = await createOAuthAttemptBinding();
    const started = await transactionStore.begin({
      provider: "outlook",
      intent: "login",
      ...attempt.binding,
      returnTo: normalizeOAuthReturnTo(c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`, config.webOrigin),
      usePkce: true,
      rateLimitKey: oauthLoginRateLimitKey(c.req.raw),
    });
    if (!started.ok) return rateLimited(c);
    if (!started.codeVerifier) return c.json({ error: "outlook_oauth_start_failed", message: "Could not create a secure Outlook OAuth transaction." }, 500);
    const result = service.getAuthorizationUrl(started.state, started.codeVerifier);
    c.header("Set-Cookie", buildOAuthAttemptCookie(attempt.token, attempt.expiresAt));
    return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  const callback: Handler<{ Variables: AuthVariables }> = async (c) => {
    const bindings = options.authMiddleware
      ? [c.get("auth")]
      : await resolveOAuthCallbackBindings(c.req.header("cookie") ?? null, dbFactory);
    const transaction = await consumeOAuthTransactionForBindings(
      transactionStore,
      c.req.query("state") ?? null,
      "outlook",
      bindings,
    );
    if (!transaction) {
      return respond(c, buildOutlookOAuthError("invalid_state", "Could not verify OAuth state.", config.errorRedirectUrl));
    }

    let result = await service.handleCallback(new URLSearchParams(c.req.query()), transaction);
    if (!result.ok) return respond(c, result);

    if (result.initialLogin) {
      const completed = await completeOAuthLogin({
        dbFactory,
        attemptedUserId: transaction.userId,
        grant: withoutUserId(result.grant),
        completeOnboardingForNewUser: true,
      });
      if (!completed.ok) {
        result = buildOutlookOAuthError(
          "account_identity_conflict",
          "This Microsoft identity does not match the existing Orca account.",
          transaction.returnTo ?? config.errorRedirectUrl,
        );
        return respond(c, result);
      }
      c.header("Set-Cookie", buildSessionCookie(completed.session.token, completed.session.expiresAt, getSessionCookieOptions()));
      c.header("Set-Cookie", buildClearedOAuthAttemptCookie(), { append: true });
      if (completed.returningUser && result.redirectUrl) {
        return c.redirect(redirectReturningUserToWorkspace(result.redirectUrl), 302);
      }
      return respond(c, result);
    }

    try {
      await store.upsert(result.grant);
    } catch {
      result = buildOutlookOAuthError(
        "account_persistence_failed",
        "Could not safely update the Outlook connection.",
        transaction.returnTo ?? config.errorRedirectUrl,
      );
    }
    return respond(c, result);
  };

  if (options.authMiddleware) app.get("/callback", options.authMiddleware, callback);
  else app.get("/callback", callback);
  return app;
}

export function redirectReturningUserToWorkspace(redirectUrl: string): string {
  const url = new URL(redirectUrl);
  url.pathname = "/";
  return url.toString();
}

function outlookConfigurationError(c: Parameters<Handler>[0], config: OutlookOAuthConfig) {
  const missing = validateOutlookOAuthConfig(config);
  return missing.length
    ? c.json({ error: "outlook_oauth_not_configured", message: `Missing Outlook OAuth configuration: ${missing.join(", ")}` }, 503)
    : null;
}

function rateLimited(c: Parameters<Handler>[0]) {
  c.header("Retry-After", "60");
  return c.json({ error: "oauth_start_rate_limited", message: "Too many OAuth login attempts. Try again shortly." }, 429);
}

function respond(c: Parameters<Handler>[0], result: { ok: boolean; redirectUrl: string | null; code?: string; message?: string; account?: unknown }) {
  if (result.redirectUrl) return c.redirect(result.redirectUrl, 302);
  if (result.ok) return c.json({ ok: true, provider: "outlook", account: result.account });
  return c.json({ ok: false, error: result.code, message: result.message }, 400);
}

function withoutUserId(input: OAuthAccountUpsert): Omit<OAuthAccountUpsert, "userId"> {
  const { userId: _userId, ...grant } = input;
  return grant;
}
