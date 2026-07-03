import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { GmailOAuthConfig } from "./config.ts";
import { encryptSecret } from "./crypto.ts";
import type { OAuthAccountStore } from "./oauth-accounts.ts";

const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleUserInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo";
const maxStateAgeMs = 1000 * 60 * 10;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GmailOAuthErrorCode =
  | "oauth_not_configured"
  | "missing_code"
  | "missing_state"
  | "invalid_state"
  | "provider_error"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "account_identity_missing"
  | "account_persistence_failed";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
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
  handleCallback(params: URLSearchParams, userId: string): Promise<GmailOAuthCallbackResult>;
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
          returnTo: normalizeReturnTo(returnTo, options.config.webOrigin),
          issuedAt: new Date().toISOString(),
        },
        options.config.stateSecret,
      );
      const url = new URL(googleAuthUrl);
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

    async handleCallback(params, userId) {
      const state = params.get("state");
      if (!state) {
        return buildError(options.config.errorRedirectUrl, "missing_state", "Missing OAuth state.");
      }

      const decodedState = verifyState(state, options.config.stateSecret);
      if (!decodedState) {
        return buildError(
          options.config.errorRedirectUrl,
          "invalid_state",
          "Could not verify OAuth state.",
        );
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

      try {
        await options.store.upsert({
          userId,
          provider: "gmail",
          providerAccountId: userInfoResponse.providerAccountId,
          providerEmail: userInfoResponse.providerEmail,
          grantedScopes: tokenResponse.grantedScopes,
          encryptedAccessToken: encryptSecret(
            tokenResponse.accessToken,
            options.config.tokenEncryptionKey,
          ),
          encryptedRefreshToken: tokenResponse.refreshToken
            ? encryptSecret(tokenResponse.refreshToken, options.config.tokenEncryptionKey)
            : null,
          expiresAt: tokenResponse.expiresAt,
        });
      } catch (error) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "account_persistence_failed",
          error instanceof Error ? error.message : "Could not persist OAuth account data.",
        );
      }

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
      expiresAt: Date | null;
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
      message: "Gmail OAuth is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI.",
    };
  }

  let response: Response;

  try {
    response = await options.fetchImpl(googleTokenUrl, {
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
  } catch (error) {
    return {
      ok: false,
      code: "token_exchange_failed",
      message: error instanceof Error ? error.message : "Failed to exchange Gmail OAuth code.",
    };
  }

  if (!response.ok) {
    const detail = await response.text();
    return {
      ok: false,
      code: "token_exchange_failed",
      message: `Failed to exchange Gmail OAuth code (${response.status}): ${detail}`,
    };
  }

  const tokens = (await response.json()) as TokenResponse;

  if (!tokens.access_token) {
    return {
      ok: false,
      code: "token_exchange_failed",
      message: "Gmail token exchange did not return an access token.",
    };
  }

  return {
    ok: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    grantedScopes: (tokens.scope ?? options.config.scopes.join(" "))
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    expiresAt:
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000)
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
  let response: Response;

  try {
    response = await fetchImpl(googleUserInfoUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    return {
      ok: false,
      code: "userinfo_failed",
      message: error instanceof Error ? error.message : "Failed to fetch Gmail account identity.",
    };
  }

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

  if (!safeEquals(signature, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SignedStatePayload;

    const issuedAt = Date.parse(payload.issuedAt);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > maxStateAgeMs) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
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

function normalizeReturnTo(value: string | null | undefined, webOrigin: string): string | null {
  if (!value) {
    return null;
  }

  try {
    const origin = new URL(webOrigin);
    const url = value.startsWith("/")
      ? new URL(value, origin)
      : new URL(value);

    if (url.origin !== origin.origin) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
