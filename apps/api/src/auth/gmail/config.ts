import { resolve } from "node:path";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export type GmailOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  encryptionKey: string;
  stateSecret: string;
  successRedirectUrl: string | null;
  errorRedirectUrl: string | null;
  oauthAccountsPath: string;
};

export function loadGmailOAuthConfig(env: Record<string, string | undefined> = process.env): GmailOAuthConfig {
  const encryptionKey = env.OAUTH_TOKEN_ENCRYPTION_KEY ?? "dev-orca-oauth-token-key";

  return {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/v1/auth/gmail/callback",
    scopes: parseScopes(env.GOOGLE_OAUTH_SCOPES),
    encryptionKey,
    stateSecret: env.GOOGLE_OAUTH_STATE_SECRET ?? encryptionKey,
    successRedirectUrl: env.ORCA_GMAIL_OAUTH_SUCCESS_URL ?? null,
    errorRedirectUrl: env.ORCA_GMAIL_OAUTH_ERROR_URL ?? null,
    oauthAccountsPath: resolve(
      env.ORCA_OAUTH_ACCOUNTS_PATH ?? "./.local/oauth-accounts.json",
    ),
  };
}

export function validateGmailOAuthConfig(config: GmailOAuthConfig): string[] {
  const missing: string[] = [];

  if (!config.clientId) {
    missing.push("GOOGLE_CLIENT_ID");
  }

  if (!config.clientSecret) {
    missing.push("GOOGLE_CLIENT_SECRET");
  }

  if (!config.redirectUri) {
    missing.push("GOOGLE_REDIRECT_URI");
  }

  if (!config.encryptionKey) {
    missing.push("OAUTH_TOKEN_ENCRYPTION_KEY");
  }

  return missing;
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) {
    return DEFAULT_SCOPES;
  }

  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}
