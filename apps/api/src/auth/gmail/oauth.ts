import { createHmac, randomUUID } from "node:crypto";
import type { GmailOAuthConfig } from "./config";
import { encryptSecret } from "./crypto";
import type { OAuthAccountStore } from "./oauth-accounts";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GmailOAuthErrorCode =
  | "oauth_not_configured"
  | "missing_code"
  | "missing_state"
  | "invalid_state"
  | "provider_error"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "account_identity_missing";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

type UserInfoResponse = {
  id?: string;
  email?: string;
};

type SignedStatePayload = {
  nonce: string;
  returnTo: string | null;
  issuedAt: string;
};

export type GmailOAuthService = {
  getAuthorizationUrl(returnTo?: string | null): { url: string; state: string };
  handleCallback(params: URLSearchParams): Promise<GmailOAuthCallbackResult>;
};

export type GmailOAuthCallbackResult =
  | {
      ok: true;
      redirectUrl: string | null;
      account: {
        providerEmail: string;
        providerAccountId: string;
        grantedScopes: string[];
      };
    }
  | {
      ok: false;
      redirectUrl: string | null;
      code: GmailOAuthErrorCode;
      message: string;
    };

export function createGmailOAuthService(options: {
  config: GmailOAuthConfig;
  store: OAuthAccountStore;
  fetch?: FetchLike;
}): GmailOAuthService {
  const fetchImpl = options.fetch ?? fetch;

  return {
    getAuthorizationUrl(returnTo) {
      const state = signState(
        {
          nonce: randomUUID(),
          returnTo: normalizeReturnTo(returnTo),
          issuedAt: new Date().toISOString(),
        },
        options.config.stateSecret,
      );
      const url = new URL(GOOGLE_AUTH_URL);
      url.searchParams.set("client_id", options.config.clientId);
      url.searchParams.set("redirect_uri", options.config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", options.config.scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);

      return {
        url: url.toString(),
        state,
      };
    },

    async handleCallback(params) {
      const state = params.get("state");
      if (!state) {
        return buildError(options.config.errorRedirectUrl, "missing_state", "Missing OAuth state.");
      }

      const decodedState = verifyState(state, options.config.stateSecret);
      if (!decodedState) {
        return buildError(resolveReturnTo(decodedState, options.config.errorRedirectUrl), "invalid_state", "Could not verify OAuth state.");
      }

      const providerError = params.get("error");
      if (providerError) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "provider_error",
          `Google returned an OAuth error: ${providerError}.`,
        );
      }

      const code = params.get("code");
      if (!code) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "missing_code",
          "Missing OAuth authorization code.",
        );
      }

      const tokenResponse = await exchangeCode({
        code,
        config: options.config,
        fetchImpl,
      });

      if (!tokenResponse.ok) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          tokenResponse.code,
          tokenResponse.message,
        );
      }

      const userInfoResponse = await fetchUserInfo(tokenResponse.accessToken, fetchImpl);
      if (!userInfoResponse.ok) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          userInfoResponse.code,
          userInfoResponse.message,
        );
      }

      if (!userInfoResponse.providerAccountId || !userInfoResponse.providerEmail) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "account_identity_missing",
          "Google did not return an account id and email for this grant.",
        );
      }

      await options.store.upsert({
        provider: "gmail",
        providerAccountId: userInfoResponse.providerAccountId,
        providerEmail: userInfoResponse.providerEmail,
        grantedScopes: tokenResponse.grantedScopes,
        encryptedAccessToken: encryptSecret(tokenResponse.accessToken, options.config.encryptionKey),
        encryptedRefreshToken: tokenResponse.refreshToken
          ? encryptSecret(tokenResponse.refreshToken, options.config.encryptionKey)
          : null,
        tokenType: tokenResponse.tokenType,
        expiresAt: tokenResponse.expiresAt,
      });

      return {
        ok: true,
        redirectUrl: appendStatus(resolveReturnTo(decodedState, options.config.successRedirectUrl), {
          provider: "gmail",
          status: "success",
          email: userInfoResponse.providerEmail,
        }),
        account: {
          providerEmail: userInfoResponse.providerEmail,
          providerAccountId: userInfoResponse.providerAccountId,
          grantedScopes: tokenResponse.grantedScopes,
        },
      };
    },
  };
}

async function exchangeCode(options: {
  code: string;
  config: GmailOAuthConfig;
  fetchImpl: FetchLike;
}): Promise<
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      grantedScopes: string[];
      tokenType: string;
      expiresAt: string | null;
    }
  | {
      ok: false;
      code: "oauth_not_configured" | "token_exchange_failed";
      message: string;
    }
> {
  if (!options.config.clientId || !options.config.clientSecret || !options.config.redirectUri) {
    return {
      ok: false,
      code: "oauth_not_configured",
      message: "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
    };
  }

  const response = await options.fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      redirect_uri: options.config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      ok: false,
      code: "token_exchange_failed",
      message: `Failed to exchange Gmail OAuth code (${response.status}): ${detail}`,
    };
  }

  const tokens = (await response.json()) as TokenResponse;

  return {
    ok: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    grantedScopes: (tokens.scope ?? options.config.scopes.join(" "))
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    tokenType: tokens.token_type ?? "Bearer",
    expiresAt:
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null,
  };
}

async function fetchUserInfo(
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<
  | {
      ok: true;
      providerAccountId: string | null;
      providerEmail: string | null;
    }
  | {
      ok: false;
      code: "userinfo_failed";
      message: string;
    }
> {
  const response = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      ok: false,
      code: "userinfo_failed",
      message: `Failed to fetch Gmail account identity (${response.status}): ${detail}`,
    };
  }

  const data = (await response.json()) as UserInfoResponse;
  return {
    ok: true,
    providerAccountId: data.id ?? null,
    providerEmail: data.email ?? null,
  };
}

function signState(payload: SignedStatePayload, secret: string): string {
  const encodedPayload = encodeJson(payload);
  const signature = signValue(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

function verifyState(value: string, secret: string): SignedStatePayload | null {
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = signValue(encodedPayload, secret);
  if (signature !== expected) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SignedStatePayload;
  } catch {
    return null;
  }
}

function signValue(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function encodeJson(value: SignedStatePayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function buildError(
  redirectBaseUrl: string | null,
  code: GmailOAuthErrorCode,
  message: string,
): GmailOAuthCallbackResult {
  return {
    ok: false,
    code,
    message,
    redirectUrl: appendStatus(redirectBaseUrl, {
      provider: "gmail",
      status: "error",
      reason: code,
      message,
    }),
  };
}

function appendStatus(baseUrl: string | null, params: Record<string, string>): string | null {
  if (!baseUrl) {
    return null;
  }

  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function resolveReturnTo(state: SignedStatePayload | null, fallback: string | null): string | null {
  return state?.returnTo ?? fallback;
}

function normalizeReturnTo(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value;
}
