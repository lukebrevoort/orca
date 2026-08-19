import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { encryptSecret } from "../gmail/crypto.ts";
import type { OAuthAccountStore } from "../gmail/oauth-accounts.ts";
import type { OutlookOAuthConfig } from "./config.ts";

export type OutlookFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OutlookOAuthState = {
  nonce: string;
  issuedAt: number;
  returnTo: string | null;
  initialLogin: boolean;
  codeVerifier: string;
};

const maxStateAgeMs = 1000 * 60 * 10;
const maxProviderProfileImageBytes = 2_000_000;
const providerProfileImageTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function createOutlookOAuthService(options: { config: OutlookOAuthConfig; store: OAuthAccountStore; fetch?: OutlookFetch }) {
  const fetchImpl = options.fetch ?? fetch;
  return {
    getAuthorizationUrl(returnTo?: string | null, initialLogin = false) {
      const codeVerifier = randomBytes(32).toString("base64url");
      const state = sign(
        {
          nonce: randomUUID(),
          issuedAt: Date.now(),
          returnTo: safeReturnTo(returnTo, options.config.webOrigin),
          initialLogin,
          codeVerifier,
        },
        options.config.stateSecret,
      );
      const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(options.config.tenant)}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({
        client_id: options.config.clientId,
        response_type: "code",
        redirect_uri: options.config.redirectUri,
        response_mode: "query",
        scope: options.config.scopes.join(" "),
        state,
        code_challenge: createCodeChallenge(codeVerifier),
        code_challenge_method: "S256",
      }).toString();
      return { url: url.toString(), state, scopes: options.config.scopes };
    },
    async handleCallback(params: URLSearchParams, userId: string) {
      const state = verify(params.get("state"), options.config.stateSecret);
      const redirect = state?.returnTo ?? options.config.errorRedirectUrl;
      if (!state) return failure("invalid_state", "Could not verify OAuth state.", redirect);
      if (params.get("error")) return failure("provider_error", `Microsoft returned an OAuth error: ${params.get("error")}.`, redirect);
      const code = params.get("code");
      if (!code) return failure("missing_code", "Missing OAuth authorization code.", redirect);
      const tokenResponse = await fetchImpl(
        `https://login.microsoftonline.com/${encodeURIComponent(options.config.tenant)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.config.clientId,
            client_secret: options.config.clientSecret,
            code,
            code_verifier: state.codeVerifier,
            redirect_uri: options.config.redirectUri,
            grant_type: "authorization_code",
            scope: options.config.scopes.join(" "),
          }),
        },
      );
      if (!tokenResponse.ok) return failure("token_exchange_failed", "Microsoft did not accept the authorization response.", redirect);
      const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
      if (!tokens.access_token) return failure("token_exchange_failed", "Outlook token exchange did not return an access token.", redirect);
      const profileResponse = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", { headers: { authorization: `Bearer ${tokens.access_token}` } });
      if (!profileResponse.ok) return failure("userinfo_failed", "Microsoft Graph could not confirm the connected account.", redirect);
      const profile = await profileResponse.json() as { id?: string; mail?: string; userPrincipalName?: string };
      const email = profile.mail ?? profile.userPrincipalName;
      if (!profile.id || !email) return failure("account_identity_missing", "Microsoft did not return an account id and email.", redirect);
      const profileImageUrl = await fetchOutlookProfileImage(tokens.access_token, fetchImpl);
      await options.store.upsert({ userId, provider: "outlook", providerAccountId: profile.id, providerEmail: email, profileImageUrl, grantedScopes: (tokens.scope ?? options.config.scopes.join(" ")).split(/\s+/), encryptedAccessToken: encryptSecret(tokens.access_token, options.config.tokenEncryptionKey), encryptedRefreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token, options.config.tokenEncryptionKey) : null, expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null });
      return { ok: true as const, initialLogin: state.initialLogin, redirectUrl: statusUrl(state.returnTo ?? options.config.successRedirectUrl, "success"), account: { providerEmail: email, providerAccountId: profile.id } };
    },
  };
}

async function fetchOutlookProfileImage(accessToken: string, fetchImpl: OutlookFetch): Promise<string | null> {
  try {
    const response = await fetchImpl("https://graph.microsoft.com/v1.0/me/photo/$value", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (!providerProfileImageTypes.has(contentType) || contentLength > maxProviderProfileImageBytes) {
      await response.body?.cancel();
      return null;
    }
    const image = Buffer.from(await response.arrayBuffer());
    if (!image.length || image.byteLength > maxProviderProfileImageBytes) return null;
    return `data:${contentType};base64,${image.toString("base64")}`;
  } catch {
    // A missing provider photo should never block account connection.
    return null;
  }
}

function sign(value: object, secret: string) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function verify(value: string | null, secret: string): OutlookOAuthState | null {
  if (!value) return null;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<OutlookOAuthState>;
    if (
      typeof data.nonce !== "string"
      || typeof data.issuedAt !== "number"
      || (typeof data.returnTo !== "string" && data.returnTo !== null)
      || typeof data.initialLogin !== "boolean"
      || typeof data.codeVerifier !== "string"
    ) {
      return null;
    }

    return Date.now() - data.issuedAt <= maxStateAgeMs ? data as OutlookOAuthState : null;
  } catch {
    return null;
  }
}

function createCodeChallenge(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function safeReturnTo(value: string | null | undefined, origin: string) {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function statusUrl(value: string | null, status: string) {
  if (!value) return null;
  const url = new URL(value);
  url.searchParams.set("provider", "outlook");
  url.searchParams.set("status", status);
  return url.toString();
}

function failure(code: string, message: string, redirect: string | null) {
  return { ok: false as const, code, message, redirectUrl: statusUrl(redirect, "error") };
}
