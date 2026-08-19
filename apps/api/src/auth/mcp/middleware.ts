import type { MiddlewareHandler } from "hono";
import { createDatabaseClient } from "../../db/client.ts";
import { getMcpProtectedResourceMetadataUrl, type McpOAuthConfig, type McpOAuthScope } from "./config.ts";
import type { OrcaMcpAuthorizationContext } from "./context.ts";
import { McpTokenError, verifyMcpAccessToken } from "./tokens.ts";

export type McpAuthVariables = {
  mcpAuth: OrcaMcpAuthorizationContext;
};

export function buildMcpWwwAuthenticate(
  config: McpOAuthConfig,
  options: { scopes?: McpOAuthScope[]; error?: McpTokenError["code"] } = {},
) {
  const metadata = getMcpProtectedResourceMetadataUrl(config.resource);
  const error = options.error ? `, error="${options.error}"` : "";
  const scope = options.scopes?.length ? `, scope="${options.scopes.join(" ")}"` : "";
  return `Bearer resource_metadata="${metadata}"${error}${scope}`;
}

export function requireMcpAuthorization(options: {
  config: McpOAuthConfig;
  requiredScopes?: McpOAuthScope[];
  dbFactory?: typeof createDatabaseClient;
}): MiddlewareHandler<{ Variables: McpAuthVariables }> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) {
      c.header("WWW-Authenticate", buildMcpWwwAuthenticate(options.config, { scopes: options.requiredScopes }));
      return c.json({ error: { code: "invalid_token", message: "A bearer access token is required" } }, 401);
    }
    const { db, sqlite } = (options.dbFactory ?? createDatabaseClient)();
    try {
      const context = await verifyMcpAccessToken(db, token, { config: options.config, requiredScopes: options.requiredScopes });
      c.set("mcpAuth", context);
      await next();
    } catch (error) {
      const tokenError = error instanceof McpTokenError ? error : new McpTokenError("invalid_token", "The bearer access token could not be verified");
      c.header("WWW-Authenticate", buildMcpWwwAuthenticate(options.config, { scopes: options.requiredScopes, error: tokenError.code }));
      return c.json({ error: { code: tokenError.code, message: tokenError.message } }, 401);
    } finally { sqlite.close(); }
  };
}
