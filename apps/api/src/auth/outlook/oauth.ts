import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { encryptSecret } from "../gmail/crypto.ts";
import type { OAuthAccountStore } from "../gmail/oauth-accounts.ts";
import type { OutlookOAuthConfig } from "./config.ts";

export type OutlookFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createOutlookOAuthService(options: { config: OutlookOAuthConfig; store: OAuthAccountStore; fetch?: OutlookFetch }) {
  const fetchImpl = options.fetch ?? fetch;
  return {
    getAuthorizationUrl(returnTo?: string | null, initialLogin = false) {
      const state = sign({ nonce: randomUUID(), issuedAt: Date.now(), returnTo: safeReturnTo(returnTo, options.config.webOrigin), initialLogin }, options.config.stateSecret);
      const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(options.config.tenant)}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({ client_id: options.config.clientId, response_type: "code", redirect_uri: options.config.redirectUri, response_mode: "query", scope: options.config.scopes.join(" "), state }).toString();
      return { url: url.toString(), state, scopes: options.config.scopes };
    },
    async handleCallback(params: URLSearchParams, userId: string) {
      const state = verify(params.get("state"), options.config.stateSecret);
      const redirect = state?.returnTo ?? options.config.errorRedirectUrl;
      if (!state) return failure("invalid_state", "Could not verify OAuth state.", redirect);
      if (params.get("error")) return failure("provider_error", `Microsoft returned an OAuth error: ${params.get("error")}.`, redirect);
      const code = params.get("code");
      if (!code) return failure("missing_code", "Missing OAuth authorization code.", redirect);
      const tokenResponse = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(options.config.tenant)}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: options.config.clientId, client_secret: options.config.clientSecret, code, redirect_uri: options.config.redirectUri, grant_type: "authorization_code", scope: options.config.scopes.join(" ") }) });
      if (!tokenResponse.ok) return failure("token_exchange_failed", "Microsoft did not accept the authorization response.", redirect);
      const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
      if (!tokens.access_token) return failure("token_exchange_failed", "Outlook token exchange did not return an access token.", redirect);
      const profileResponse = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (!profileResponse.ok) return failure("userinfo_failed", "Microsoft Graph could not confirm the connected account.", redirect);
      const profile = await profileResponse.json() as { id?: string; mail?: string; userPrincipalName?: string };
      const email = profile.mail ?? profile.userPrincipalName;
      if (!profile.id || !email) return failure("account_identity_missing", "Microsoft did not return an account id and email.", redirect);
      await options.store.upsert({ userId, provider: "outlook", providerAccountId: profile.id, providerEmail: email, grantedScopes: (tokens.scope ?? options.config.scopes.join(" ")).split(/\s+/), encryptedAccessToken: encryptSecret(tokens.access_token, options.config.tokenEncryptionKey), encryptedRefreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token, options.config.tokenEncryptionKey) : null, expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null });
      return { ok: true as const, initialLogin: state.initialLogin, redirectUrl: statusUrl(state.returnTo ?? options.config.successRedirectUrl, "success"), account: { providerEmail: email, providerAccountId: profile.id } };
    },
  };
}

function sign(value: object, secret: string) { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`; }
function verify(value: string | null, secret: string): { issuedAt: number; returnTo: string | null; initialLogin: boolean } | null { if (!value) return null; const [payload, signature] = value.split("."); if (!payload || !signature) return null; const expected = createHmac("sha256", secret).update(payload).digest("base64url"); if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { issuedAt: number; returnTo: string | null; initialLogin: boolean }; return Date.now() - data.issuedAt <= 600_000 ? data : null; } catch { return null; } }
function safeReturnTo(value: string | null | undefined, origin: string) { if (!value) return null; try { const url = new URL(value, origin); return url.origin === origin ? url.toString() : null; } catch { return null; } }
function statusUrl(value: string | null, status: string) { if (!value) return null; const url = new URL(value); url.searchParams.set("provider", "outlook"); url.searchParams.set("status", status); return url.toString(); }
function failure(code: string, message: string, redirect: string | null) { return { ok: false as const, code, message, redirectUrl: statusUrl(redirect, "error") }; }
