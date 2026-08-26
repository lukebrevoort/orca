import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";

import { completeOAuthLogin } from "../complete-oauth-login.ts";
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
import {
  loadGmailOAuthConfig,
  validateGmailOAuthConfig,
  type GmailOAuthConfig,
} from "./config.ts";
import {
  DatabaseOAuthAccountStore,
  type OAuthAccountStore,
  type OAuthAccountUpsert,
} from "./oauth-accounts.ts";
import {
  buildGmailOAuthError,
  createGmailOAuthService,
  type FetchLike,
  type GmailOAuthCallbackResult,
  type GmailOAuthIntent,
} from "./oauth.ts";

type GmailAuthAppOptions = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: GmailOAuthConfig;
  store?: OAuthAccountStore;
  transactionStore?: OAuthTransactionStore;
  fetch?: FetchLike;
  dbFactory?: typeof createDatabaseClient;
};

export function createGmailAuthApp(options: GmailAuthAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const config = options.config ?? loadGmailOAuthConfig();
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const store = options.store ?? new DatabaseOAuthAccountStore(dbFactory);
  const transactionStore = options.transactionStore ?? new DatabaseOAuthTransactionStore(dbFactory);
  const service = createGmailOAuthService({ config, store, fetch: options.fetch });
  const authMiddleware = options.authMiddleware ?? requireAuth({ dbFactory });
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/connect", authMiddleware, async (c) => {
    const configurationError = gmailConfigurationError(c, config);
    if (configurationError) return configurationError;

    const auth = c.get("auth");
    const intent: GmailOAuthIntent = "connect";
    const started = await transactionStore.begin({
      provider: "gmail",
      intent,
      sessionId: auth.sessionId,
      userId: auth.userId,
      accountId: c.req.query("accountId") ?? null,
      returnTo: normalizeOAuthReturnTo(c.req.query("returnTo"), config.webOrigin),
    });
    if (!started.ok) return rateLimited(c);
    const result = service.getAuthorizationUrl(started.state, intent);
    return c.json({ provider: "gmail", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  app.get("/upgrade", authMiddleware, async (c) => {
    const configurationError = gmailConfigurationError(c, config);
    if (configurationError) return configurationError;

    const auth = c.get("auth");
    const requestedAccountId = c.req.query("accountId");
    const account = requestedAccountId
      ? await store.findById(auth.userId, requestedAccountId)
      : await store.findForUser(auth.userId);
    if (!account) {
      return c.json({ error: "gmail_account_not_found", message: "Connect Gmail read-only before enabling compose and send." }, 404);
    }
    const started = await transactionStore.begin({
      provider: "gmail",
      intent: "upgrade",
      sessionId: auth.sessionId,
      userId: auth.userId,
      accountId: account.id,
      returnTo: normalizeOAuthReturnTo(c.req.query("returnTo"), config.webOrigin),
    });
    if (!started.ok) return rateLimited(c);
    const result = service.getAuthorizationUrl(started.state, "upgrade");
    return c.json({ provider: "gmail", intent: "upgrade", accountId: account.id, authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  app.get("/login", async (c) => {
    const configurationError = gmailConfigurationError(c, config);
    if (configurationError) return configurationError;

    const attempt = await createOAuthAttemptBinding();
    const returnTo = normalizeOAuthReturnTo(c.req.query("returnTo") ?? `${config.webOrigin}/onboarding`, config.webOrigin);
    const started = await transactionStore.begin({
      provider: "gmail",
      intent: "login",
      ...attempt.binding,
      returnTo,
      rateLimitKey: oauthLoginRateLimitKey(c.req.raw),
    });
    if (!started.ok) return rateLimited(c);

    const result = service.getAuthorizationUrl(started.state, "connect");
    c.header("Set-Cookie", buildOAuthAttemptCookie(attempt.token, attempt.expiresAt));
    return c.json({ provider: "gmail", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  });

  const callback: Handler<{ Variables: AuthVariables }> = async (c) => {
    const bindings = options.authMiddleware
      ? [c.get("auth")]
      : await resolveOAuthCallbackBindings(c.req.header("cookie") ?? null, dbFactory);
    const transaction = await consumeOAuthTransactionForBindings(
      transactionStore,
      c.req.query("state") ?? null,
      "gmail",
      bindings,
    );
    if (!transaction) {
      return respond(c, buildGmailOAuthError(config.errorRedirectUrl, "invalid_state", "Could not verify OAuth state."));
    }

    let result = await service.handleCallback(new URLSearchParams(c.req.query()), transaction);
    if (!result.ok) return respond(c, result);

    if (result.initialLogin) {
      const completed = await completeOAuthLogin({
        dbFactory,
        attemptedUserId: transaction.userId,
        grant: withoutUserId(result.grant),
        completeOnboardingForNewUser: false,
      });
      if (!completed.ok) {
        result = buildGmailOAuthError(
          transaction.returnTo ?? config.errorRedirectUrl,
          "account_identity_conflict",
          "This Google identity does not match the existing Orca account.",
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
      result = buildGmailOAuthError(
        transaction.returnTo ?? config.errorRedirectUrl,
        "account_persistence_failed",
        "Could not safely update the Gmail connection. Reading access was not changed.",
        transaction.intent === "upgrade" ? "upgrade" : "connect",
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

function gmailConfigurationError(c: Parameters<Handler>[0], config: GmailOAuthConfig) {
  const errors = validateGmailOAuthConfig(config);
  return errors.length > 0
    ? c.json({ error: "gmail_oauth_not_configured", message: `Missing Gmail OAuth configuration: ${errors.join(", ")}` }, 503)
    : null;
}

function rateLimited(c: Parameters<Handler>[0]) {
  c.header("Retry-After", "60");
  return c.json({ error: "oauth_start_rate_limited", message: "Too many OAuth login attempts. Try again shortly." }, 429);
}

function respond(c: Parameters<Handler>[0], result: GmailOAuthCallbackResult) {
  if (result.redirectUrl) return c.redirect(result.redirectUrl, 302);
  if (result.ok) return c.json({ ok: true, provider: "gmail", account: result.account });
  return c.json({ ok: false, error: result.code, message: result.message }, result.code === "oauth_not_configured" ? 503 : 400);
}

function withoutUserId(input: OAuthAccountUpsert): Omit<OAuthAccountUpsert, "userId"> {
  const { userId: _userId, ...grant } = input;
  return grant;
}
