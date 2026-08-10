const defaultWebOrigin = "http://localhost:5173";
const defaultRedirectUri = "http://localhost:3000/v1/auth/outlook/callback";

export const outlookReadScopes = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read"] as const;

export type OutlookOAuthConfig = {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
  scopes: string[];
  tokenEncryptionKey: string;
  stateSecret: string;
  successRedirectUrl: string | null;
  errorRedirectUrl: string | null;
  webOrigin: string;
};

export function loadOutlookOAuthConfig(env: Record<string, string | undefined> = process.env): OutlookOAuthConfig {
  return {
    clientId: env.OUTLOOK_CLIENT_ID ?? "",
    clientSecret: env.OUTLOOK_CLIENT_SECRET ?? "",
    tenant: env.OUTLOOK_TENANT_ID ?? "common",
    redirectUri: absolute(env.OUTLOOK_REDIRECT_URI ?? defaultRedirectUri, "OUTLOOK_REDIRECT_URI"),
    scopes: env.OUTLOOK_OAUTH_SCOPES?.split(/[\s,]+/).filter(Boolean) ?? [...outlookReadScopes],
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY ?? "",
    stateSecret: env.OUTLOOK_OAUTH_STATE_SECRET ?? env.SESSION_SECRET ?? "",
    successRedirectUrl: optional(env.ORCA_OUTLOOK_OAUTH_SUCCESS_URL),
    errorRedirectUrl: optional(env.ORCA_OUTLOOK_OAUTH_ERROR_URL),
    webOrigin: new URL(env.WEB_ORIGIN ?? defaultWebOrigin).origin,
  };
}

export function validateOutlookOAuthConfig(config: OutlookOAuthConfig): string[] {
  return [
    !config.clientId && "OUTLOOK_CLIENT_ID",
    !config.clientSecret && "OUTLOOK_CLIENT_SECRET",
    !config.redirectUri && "OUTLOOK_REDIRECT_URI",
    !config.tokenEncryptionKey && "TOKEN_ENCRYPTION_KEY",
    !config.stateSecret && "SESSION_SECRET",
  ].filter((value): value is string => Boolean(value));
}

function absolute(value: string, name: string) {
  try { return new URL(value).toString(); } catch { throw new Error(`${name} must be a valid URL`); }
}
function optional(value: string | undefined) { return value ? absolute(value, "Outlook redirect URL") : null; }
