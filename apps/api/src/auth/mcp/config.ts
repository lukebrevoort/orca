import { mcpOAuthScopes, type McpOAuthScope } from "@orca/shared";

export { mcpOAuthScopes };
export type { McpOAuthScope };

export const mcpOAuthLimits = {
  registrationBodyBytes: 16_384,
  redirectUriCharacters: 2_048,
  clientNameCharacters: 120,
  redirectsPerClient: 10,
  tokenRequestBodyBytes: 16_384,
} as const;

export const mcpOAuthRetention = {
  expiredCredentialMs: 24 * 60 * 60 * 1000,
  refreshReplayMs: 24 * 60 * 60 * 1000,
  revokedConnectionMs: 30 * 24 * 60 * 60 * 1000,
  unusedClientMs: 24 * 60 * 60 * 1000,
} as const;

export type McpOAuthConfig = {
  enabled: boolean;
  issuer: string;
  resource: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  authorizationCodeTtlMs: number;
  signingKey: Uint8Array | null;
  signingKeyId: string;
  allowedRedirectUris: readonly string[];
  registrationLimitPerMinute: number;
};

function canonicalUrl(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not include credentials`);
  if (url.search || url.hash) throw new Error(`${name} must not include a query or fragment`);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function positiveSeconds(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback * 1000;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`${name} must be a positive integer`);
  return seconds * 1000;
}

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function parseSigningKey(value: string | undefined, enabled: boolean) {
  if (!value) {
    if (enabled) throw new Error("ORCA_M6_MCP_SIGNING_KEY must be set when MCP OAuth is enabled");
    return null;
  }
  const encoded = value.trim();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) {
    throw new Error("ORCA_M6_MCP_SIGNING_KEY must be canonical base64 that decodes to 32 bytes");
  }
  return new Uint8Array(bytes);
}

function parseAllowedRedirectUris(value: string | undefined) {
  const values = (value ?? "https://chatgpt.com/connector_platform_oauth_redirect")
    .split(/[\s,]+/)
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.length > mcpOAuthLimits.redirectsPerClient) {
    throw new Error(`ORCA_M6_MCP_REDIRECT_URIS must contain 1-${mcpOAuthLimits.redirectsPerClient} exact redirect URIs`);
  }
  if (unique.some((uri) => !isSyntacticallySafeRedirectUri(uri))) {
    throw new Error("ORCA_M6_MCP_REDIRECT_URIS contains an invalid redirect URI");
  }
  return unique;
}

export function getMcpOAuthConfig(env: NodeJS.ProcessEnv = process.env): McpOAuthConfig {
  const enabled = env.ORCA_M6_MCP_ENABLED === "true";
  const issuer = canonicalUrl(env.ORCA_M6_MCP_ISSUER ?? "http://localhost:3000", "ORCA_M6_MCP_ISSUER");
  const resource = canonicalUrl(env.ORCA_M6_MCP_RESOURCE ?? `${issuer}/mcp`, "ORCA_M6_MCP_RESOURCE");
  if (new URL(issuer).pathname !== "/") throw new Error("ORCA_M6_MCP_ISSUER must be an origin without a path");
  if (env.NODE_ENV === "production" && (new URL(issuer).protocol !== "https:" || new URL(resource).protocol !== "https:")) {
    throw new Error("ORCA_M6_MCP_ISSUER and ORCA_M6_MCP_RESOURCE must use HTTPS in production");
  }
  const signingKeyId = env.ORCA_M6_MCP_SIGNING_KEY_ID ?? "mcp-v1";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(signingKeyId)) throw new Error("ORCA_M6_MCP_SIGNING_KEY_ID is invalid");
  return {
    enabled,
    issuer,
    resource,
    accessTokenTtlMs: Math.min(600_000, positiveSeconds(env.ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS, 600, "ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS")),
    refreshTokenTtlMs: Math.min(2_592_000_000, positiveSeconds(env.ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS, 60 * 60 * 24 * 30, "ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS")),
    authorizationCodeTtlMs: positiveSeconds(env.ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS, 300, "ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS"),
    signingKey: parseSigningKey(env.ORCA_M6_MCP_SIGNING_KEY, enabled),
    signingKeyId,
    allowedRedirectUris: parseAllowedRedirectUris(env.ORCA_M6_MCP_REDIRECT_URIS),
    registrationLimitPerMinute: boundedPositiveInteger(env.ORCA_M6_MCP_DCR_PER_MINUTE, 30, 60, "ORCA_M6_MCP_DCR_PER_MINUTE"),
  };
}

function isSyntacticallySafeRedirectUri(value: string) {
  if (value.length > mcpOAuthLimits.redirectUriCharacters) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

export function isAllowedMcpRedirectUri(value: string, config: Pick<McpOAuthConfig, "allowedRedirectUris">) {
  return isSyntacticallySafeRedirectUri(value) && config.allowedRedirectUris.includes(value);
}

export function getMcpProtectedResourceMetadataUrl(resource: string) {
  const url = new URL(resource);
  const resourcePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `/.well-known/oauth-protected-resource${resourcePath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
