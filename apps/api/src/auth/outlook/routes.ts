import { Hono } from "hono";
import type { Handler, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";

import { buildSessionCookie, getSessionCookieOptions } from "../jwt.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import { createSession } from "../session-store.ts";
import { DatabaseOAuthAccountStore, type OAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
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

  const start = (initialLogin: boolean): Handler<{ Variables: AuthVariables }> => async (c) => {
    const missing = validateOutlookOAuthConfig(config);
    if (missing.length) return c.json({ error: "outlook_oauth_not_configured", message: `Missing Outlook OAuth configuration: ${missing.join(", ")}` }, 503);
    const result = service.getAuthorizationUrl(c.req.query("returnTo"), initialLogin);
    return c.json({ provider: "outlook", authUrl: result.url, state: result.state, redirectUri: config.redirectUri, scopes: result.scopes });
  };

  app.get("/connect", auth, start(false));
  app.get("/login", async (c) => {
    const missing = validateOutlookOAuthConfig(config);
    if (missing.length) return c.json({ error: "outlook_oauth_not_configured", message: `Missing Outlook OAuth configuration: ${missing.join(", ")}` }, 503);
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
    const result = await service.handleCallback(new URLSearchParams(c.req.query()), current.userId);
    if (result.ok && result.initialLogin) {
      const { db, sqlite } = dbFactory();
      try { db.update(users).set({ email: result.account.providerEmail, authenticatedAt: new Date(), onboardingCompletedAt: new Date() }).where(eq(users.id, current.userId)).run(); } finally { sqlite.close(); }
    }
    if (result.redirectUrl) return c.redirect(result.redirectUrl, 302);
    return result.ok ? c.json({ ok: true, provider: "outlook", account: result.account }) : c.json({ ok: false, error: result.code, message: result.message }, 400);
  });
  return app;
}
