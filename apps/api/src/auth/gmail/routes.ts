import { Hono } from "hono";
import { loadGmailOAuthConfig, validateGmailOAuthConfig, type GmailOAuthConfig } from "./config";
import { FileOAuthAccountStore, type OAuthAccountStore } from "./oauth-accounts";
import { createGmailOAuthService, type FetchLike } from "./oauth";

type GmailAuthAppOptions = {
  config?: GmailOAuthConfig;
  store?: OAuthAccountStore;
  fetch?: FetchLike;
};

export function createGmailAuthApp(options: GmailAuthAppOptions = {}): Hono {
  const config = options.config ?? loadGmailOAuthConfig();
  const store = options.store ?? new FileOAuthAccountStore(config.oauthAccountsPath);
  const service = createGmailOAuthService({
    config,
    store,
    fetch: options.fetch,
  });

  const app = new Hono();

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
    const result = await service.handleCallback(new URLSearchParams(c.req.query()));

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
