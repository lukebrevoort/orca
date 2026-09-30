import type { MailOAuthTransaction, MailOAuthTransactionStore, OAuthOwner } from "../mail-oauth-transactions.ts";

import type { GmailOAuthConfig } from "./config.ts";
import { encryptSecret } from "./crypto.ts";
import type { OAuthAccountStore } from "./oauth-accounts.ts";

const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const googleUserInfoUrl = "https://www.googleapis.com/oauth2/v2/userinfo";

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
  | "account_mismatch"
  | "compose_not_granted"
  | "connect_account_missing"
  | "upgrade_account_missing"
  | "account_persistence_failed";

export type GmailOAuthIntent = "connect" | "upgrade";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

type UserInfoResponse = {
  id?: string;
  email?: string;
  picture?: string;
};

export type GmailOAuthService = {
  getAuthorizationUrl(owner: OAuthOwner, returnTo?: string | null, intent?: GmailOAuthIntent, accountId?: string | null, pendingEmail?: string | null): { url: string; state: string; scopes: string[] };
  handleCallback(params: URLSearchParams, owner: OAuthOwner): Promise<GmailOAuthCallbackResult>;
};

export type GmailOAuthCallbackResult =
  | {
      ok: true;
      redirectUrl: string | null;
      pendingEmail: string | null;
      scopeReturned: boolean;
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
  transactions: MailOAuthTransactionStore;
  fetch?: FetchLike;
}): GmailOAuthService {
  const fetchImpl = options.fetch ?? fetch;

  return {
    getAuthorizationUrl(owner, returnTo, intent = "connect", accountId = null, pendingEmail = null) {
      const scopes = intent === "upgrade" ? options.config.composeScopes : options.config.scopes;
      const { state, codeChallenge } = options.transactions.create({
        ...owner, provider: "gmail", returnTo: normalizeReturnTo(returnTo, options.config.webOrigin),
        intent, accountId, pendingEmail,
      });
      const url = new URL(googleAuthUrl);
      url.searchParams.set("client_id", options.config.clientId);
      url.searchParams.set("redirect_uri", options.config.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");

      return {
        url: url.toString(),
        state,
        scopes,
      };
    },

    async handleCallback(params, owner) {
      const { userId } = owner;
      const state = params.get("state");
      if (!state) {
        return buildError(options.config.errorRedirectUrl, "missing_state", "Missing OAuth state.");
      }

      const decodedState = options.transactions.consume(state, owner, "gmail");
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
          decodedState.intent,
        );
      }

      const code = params.get("code");
      if (!code) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "missing_code",
          "Missing OAuth authorization code.",
          decodedState.intent,
        );
      }

      const tokenResponse = await exchangeCode({
        code,
        codeVerifier: decodedState.codeVerifier,
        config: options.config,
        fetchImpl,
        requestedScopes: decodedState.intent === "upgrade" ? options.config.composeScopes : options.config.scopes,
      });

      if (!tokenResponse.ok) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          tokenResponse.code,
          tokenResponse.message,
          decodedState.intent,
        );
      }

      const userInfoResponse = await fetchUserInfo(tokenResponse.accessToken, fetchImpl);
      if (!userInfoResponse.ok) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          userInfoResponse.code,
          userInfoResponse.message,
          decodedState.intent,
        );
      }

      if (!userInfoResponse.providerAccountId || !userInfoResponse.providerEmail) {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "account_identity_missing",
          "Google did not return an account id and email for this grant.",
          decodedState.intent,
        );
      }

      let existingTargetAccount: Awaited<ReturnType<OAuthAccountStore["findById"]>> = null;
      if (decodedState.accountId) {
        existingTargetAccount = await options.store.findById(userId, decodedState.accountId);
        if (!existingTargetAccount) {
          return buildError(
            resolveReturnTo(decodedState, options.config.errorRedirectUrl),
            decodedState.intent === "upgrade" ? "upgrade_account_missing" : "connect_account_missing",
            decodedState.intent === "upgrade"
              ? "The existing Gmail connection could not be found. Reading access was not changed."
              : "The Gmail connection to reconnect could not be found. Reading access was not changed.",
            decodedState.intent,
          );
        }
        if (existingTargetAccount.providerAccountId !== userInfoResponse.providerAccountId) {
          return buildError(
            resolveReturnTo(decodedState, options.config.errorRedirectUrl),
            "account_mismatch",
            "Choose the same Google account that is already connected to Orca. Reading access was not changed.",
            decodedState.intent,
          );
        }
      }

      let existingUpgradeAccount = existingTargetAccount;
      if (decodedState.intent === "upgrade") {
        if (!decodedState.accountId) {
          return buildError(
            resolveReturnTo(decodedState, options.config.errorRedirectUrl),
            "upgrade_account_missing",
            "The Gmail account to upgrade could not be identified. Reading access was not changed.",
            decodedState.intent,
          );
        }
        // The account was loaded and identity-checked above so this upgrade
        // cannot accidentally mutate another stacked Gmail connection.
        const missingScopes = options.config.composeScopes.filter((scope) => !tokenResponse.grantedScopes.includes(scope));
        if (tokenResponse.scopeReturned && missingScopes.length > 0) {
          return buildError(
            resolveReturnTo(decodedState, options.config.errorRedirectUrl),
            "compose_not_granted",
            "Google did not grant Gmail compose access. Reading access was not changed.",
            decodedState.intent,
          );
        }
      }

      if (!options.transactions.isActive(owner) || (decodedState.pendingEmail && !options.transactions.isPending(owner, decodedState.pendingEmail))) {
        return buildError(options.config.errorRedirectUrl, "invalid_state", "The pending login is no longer available.");
      }

      try {
        await options.store.upsert({ authorization: { sessionId: owner.sessionId, pendingEmail: decodedState.pendingEmail ?? null },
          userId,
          provider: "gmail",
          providerAccountId: userInfoResponse.providerAccountId,
          providerEmail: userInfoResponse.providerEmail,
          profileImageUrl: userInfoResponse.profileImageUrl,
          grantedScopes: tokenResponse.scopeReturned
            ? tokenResponse.grantedScopes
            : [...new Set([...(existingUpgradeAccount?.grantedScopes ?? []), ...tokenResponse.grantedScopes])],
          encryptedAccessToken: encryptSecret(
            tokenResponse.accessToken,
            options.config.tokenEncryptionKey,
          ),
          encryptedRefreshToken: tokenResponse.refreshToken
            ? encryptSecret(tokenResponse.refreshToken, options.config.tokenEncryptionKey)
            : null,
          expiresAt: tokenResponse.expiresAt,
        });
      } catch {
        return buildError(
          resolveReturnTo(decodedState, options.config.errorRedirectUrl),
          "account_persistence_failed",
          "Could not safely update the Gmail connection. Reading access was not changed.",
          decodedState.intent,
        );
      }

      return {
        ok: true,
        redirectUrl: appendStatus(resolveReturnTo(decodedState, options.config.successRedirectUrl), {
          provider: "gmail",
          status: "success",
          intent: decodedState.intent,
        }),
        pendingEmail: decodedState.pendingEmail ?? null,
        scopeReturned: tokenResponse.scopeReturned,
        account: {
          providerEmail: userInfoResponse.providerEmail,
          providerAccountId: userInfoResponse.providerAccountId,
          grantedScopes: tokenResponse.grantedScopes,
        },
      };
    },
  };
}

export type GmailTokenRefreshResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    }
  | {
      ok: false;
      code: "oauth_not_configured" | "refresh_token_rejected" | "provider_error";
      message: string;
    };

/** Exchange a stored Gmail refresh grant for a current access token. */
export async function refreshGmailAccessToken(options: {
  refreshToken: string;
  config: GmailOAuthConfig;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<GmailTokenRefreshResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();

  if (!options.config.clientId || !options.config.clientSecret) {
    return {
      ok: false,
      code: "oauth_not_configured",
      message: "Gmail OAuth is not configured for token refresh.",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(googleTokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: options.config.clientId,
        client_secret: options.config.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch {
    return {
      ok: false,
      code: "provider_error",
      message: "Google could not refresh the Gmail access token.",
    };
  }

  if (!response.ok) {
    const providerError = await readTokenErrorCode(response);
    return {
      ok: false,
      code: providerError === "invalid_grant" ? "refresh_token_rejected" : "provider_error",
      message: providerError === "invalid_grant"
        ? "Google rejected the Gmail refresh token."
        : "Google could not refresh the Gmail access token.",
    };
  }

  let rawTokens: unknown;
  try {
    rawTokens = await response.json();
  } catch {
    return {
      ok: false,
      code: "provider_error",
      message: "Google returned an invalid Gmail token response.",
    };
  }

  const tokens = parseRefreshTokenResponse(rawTokens, now);
  if (!tokens) {
    return {
      ok: false,
      code: "provider_error",
      message: "Google returned an invalid Gmail token response.",
    };
  }

  return {
    ok: true,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

function parseRefreshTokenResponse(
  value: unknown,
  now: Date,
): { accessToken: string; refreshToken: string | null; expiresAt: Date } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const response = value as Record<string, unknown>;
  const accessToken = typeof response.access_token === "string"
    ? response.access_token.trim()
    : "";
  const refreshTokenValue = response.refresh_token;
  const refreshToken = refreshTokenValue === undefined
    ? null
    : typeof refreshTokenValue === "string"
      ? refreshTokenValue.trim() || null
      : null;
  const expiresIn = response.expires_in;

  if (
    !accessToken
    || (refreshTokenValue !== undefined && typeof refreshTokenValue !== "string")
    || typeof expiresIn !== "number"
    || !Number.isFinite(expiresIn)
    || expiresIn < 0
  ) {
    return null;
  }

  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    return null;
  }

  return { accessToken, refreshToken, expiresAt };
}

async function readTokenErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as TokenResponse;
    return typeof body.error === "string" ? body.error : null;
  } catch {
    await response.body?.cancel();
    return null;
  }
}

async function exchangeCode(options: {
  code: string;
  codeVerifier: string;
  config: GmailOAuthConfig;
  fetchImpl: FetchLike;
  requestedScopes: string[];
}): Promise<
  | {
      ok: true;
      accessToken: string;
      refreshToken: string | null;
      grantedScopes: string[];
      scopeReturned: boolean;
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
      message: "Gmail OAuth is not configured for an authorization exchange.",
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
        code_verifier: options.codeVerifier,
        client_id: options.config.clientId,
        client_secret: options.config.clientSecret,
        redirect_uri: options.config.redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch (error) {
    console.error("Gmail authorization code exchange failed", { error });
    return {
      ok: false,
      code: "token_exchange_failed",
      message: "Google could not complete the Gmail authorization exchange.",
    };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      code: "token_exchange_failed",
      message: "Google did not accept the authorization response. Try the permission flow again.",
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
    grantedScopes: (tokens.scope ?? options.requestedScopes.join(" "))
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    scopeReturned: typeof tokens.scope === "string",
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
      profileImageUrl: string | null;
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
    console.error("Gmail account identity request failed", { error });
    return {
      ok: false,
      code: "userinfo_failed",
      message: "Google could not confirm the Gmail account identity.",
    };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      code: "userinfo_failed",
      message: "Google could not confirm which account granted access. Try again with the connected account.",
    };
  }

  const data = (await response.json()) as UserInfoResponse;
  return {
    ok: true,
    providerAccountId: data.id ?? null,
    providerEmail: data.email ?? null,
    profileImageUrl: normalizeProviderImageUrl(data.picture),
  };
}

function normalizeProviderImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildError(
  redirectBaseUrl: string | null,
  code: GmailOAuthErrorCode,
  message: string,
  intent: GmailOAuthIntent = "connect",
): GmailOAuthCallbackResult {
  return {
    ok: false,
    code,
    message,
    redirectUrl: appendStatus(redirectBaseUrl, {
      provider: "gmail",
      status: "error",
      reason: code,
      intent,
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

function resolveReturnTo(state: MailOAuthTransaction | null, fallback: string | null): string | null {
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
