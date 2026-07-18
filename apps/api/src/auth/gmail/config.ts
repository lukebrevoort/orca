const defaultWebOrigin = "http://localhost:5173";
const defaultRedirectUri = "http://localhost:3000/v1/auth/gmail/callback";
export const gmailReadScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

// gmail.compose is the narrowest single grant that covers creating and updating
// drafts as well as sending new messages, replies, and forwards. gmail.modify
// and the full mailbox scope are intentionally not requested.
export const gmailComposeScopes = [
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export type GmailOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  composeScopes: string[];
  tokenEncryptionKey: string;
  stateSecret: string;
  successRedirectUrl: string | null;
  errorRedirectUrl: string | null;
  webOrigin: string;
};

export function loadGmailOAuthConfig(
  env: Record<string, string | undefined> = process.env,
): GmailOAuthConfig {
  return {
    clientId: env.GMAIL_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GMAIL_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: normalizeAbsoluteUrl(
      env.GMAIL_REDIRECT_URI ?? env.GOOGLE_REDIRECT_URI ?? defaultRedirectUri,
      "GMAIL_REDIRECT_URI",
    ),
    scopes: parseScopes(env.GMAIL_OAUTH_SCOPES ?? env.GOOGLE_OAUTH_SCOPES),
    composeScopes: [...gmailComposeScopes],
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? env.OAUTH_TOKEN_ENCRYPTION_KEY ?? "",
    stateSecret: env.GMAIL_OAUTH_STATE_SECRET ?? env.GOOGLE_OAUTH_STATE_SECRET ?? env.SESSION_SECRET ?? "",
    successRedirectUrl: normalizeOptionalAbsoluteUrl(
      env.ORCA_GMAIL_OAUTH_SUCCESS_URL,
      "ORCA_GMAIL_OAUTH_SUCCESS_URL",
    ),
    errorRedirectUrl: normalizeOptionalAbsoluteUrl(
      env.ORCA_GMAIL_OAUTH_ERROR_URL,
      "ORCA_GMAIL_OAUTH_ERROR_URL",
    ),
    webOrigin: normalizeOrigin(env.WEB_ORIGIN ?? defaultWebOrigin, "WEB_ORIGIN"),
  };
}

export function validateGmailOAuthConfig(config: GmailOAuthConfig): string[] {
  const missing: string[] = [];

  if (!config.clientId) {
    missing.push("GMAIL_CLIENT_ID");
  }

  if (!config.clientSecret) {
    missing.push("GMAIL_CLIENT_SECRET");
  }

  if (!config.redirectUri) {
    missing.push("GMAIL_REDIRECT_URI");
  }

  if (!config.tokenEncryptionKey) {
    missing.push("TOKEN_ENCRYPTION_KEY");
  }

  if (!config.stateSecret) {
    missing.push("SESSION_SECRET");
  }

  return missing;
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw) {
    return [...gmailReadScopes];
  }

  return raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function normalizeOrigin(value: string, envName: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
}

function normalizeAbsoluteUrl(value: string, envName: string): string {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
}

function normalizeOptionalAbsoluteUrl(value: string | undefined, envName: string): string | null {
  if (!value) {
    return null;
  }

  return normalizeAbsoluteUrl(value, envName);
}
