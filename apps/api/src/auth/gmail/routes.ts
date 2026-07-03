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

type GmailAuthAppOptions = {
  authMiddleware?: MiddlewareHandler<{ Variables: AuthVariables }>;
  config?: GmailOAuthConfig;
  store?: OAuthAccountStore;
  fetch?: FetchLike;
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

  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", authMiddleware);

  app.get("/connect", (c) => {
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

  app.get("/callback", async (c) => {
    const auth = c.get("auth");
    const result = await service.handleCallback(new URLSearchParams(c.req.query()), auth.userId);

    if (result.redirectUrl) {
      return c.redirect(result.redirectUrl, 302);
    }

    if (result.ok) {
      return c.json({
        ok: true,
        provider: "gmail",
        account: result.account,
      });
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
