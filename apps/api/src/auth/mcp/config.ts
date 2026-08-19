import type { McpOAuthScope } from "@orca/shared";

export const mcpOAuthScopes = ["mail:read", "agent_events:read"] as const;
export type { McpOAuthScope };

export type McpOAuthConfig = {
  enabled: boolean;
  issuer: string;
  resource: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  authorizationCodeTtlMs: number;
};

function canonicalUrl(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.search || url.hash) throw new Error(`${name} must not include a query or fragment`);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function positiveSeconds(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback * 1000;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error(`${name} must be a positive integer`);
  return seconds * 1000;
}

export function getMcpOAuthConfig(env: NodeJS.ProcessEnv = process.env): McpOAuthConfig {
  const issuer = canonicalUrl(env.ORCA_M6_MCP_ISSUER ?? "http://localhost:3000", "ORCA_M6_MCP_ISSUER");
  const resource = canonicalUrl(env.ORCA_M6_MCP_RESOURCE ?? `${issuer}/mcp`, "ORCA_M6_MCP_RESOURCE");
  if (new URL(issuer).pathname !== "/") throw new Error("ORCA_M6_MCP_ISSUER must be an origin without a path");
  if (env.NODE_ENV === "production" && (new URL(issuer).protocol !== "https:" || new URL(resource).protocol !== "https:")) {
    throw new Error("ORCA_M6_MCP_ISSUER and ORCA_M6_MCP_RESOURCE must use HTTPS in production");
  }
  return {
    enabled: env.ORCA_M6_MCP_ENABLED === "true",
    issuer,
    resource,
    accessTokenTtlMs: Math.min(600_000, positiveSeconds(env.ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS, 600, "ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS")),
    refreshTokenTtlMs: Math.min(2_592_000_000, positiveSeconds(env.ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS, 60 * 60 * 24 * 30, "ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS")),
    authorizationCodeTtlMs: positiveSeconds(env.ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS, 300, "ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS"),
  };
}

export function isAllowedMcpRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

export function getMcpProtectedResourceMetadataUrl(resource: string) {
  const url = new URL(resource);
  url.pathname = "/.well-known/oauth-protected-resource";
  url.search = "";
  url.hash = "";
  return url.toString();
}
