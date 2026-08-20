import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { McpOAuthScope, OrcaMcpScope } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import type { McpOAuthConfig } from "../auth/mcp/config.ts";
import { verifyMcpAccessToken } from "../auth/mcp/tokens.ts";
import {
  orcaAgentAuthorizationContextSchema,
  type OrcaAgentAuthorizationContext,
} from "./authorization.ts";

const authorizationExtraKey = "orcaAuthorization";
type DatabaseFactory = typeof createDatabaseClient;

export type OrcaMcpTokenVerifier = OAuthTokenVerifier;

const resourceScopesByOAuthScope = {
  "mail:read": [
    "orca:mail.metadata:read",
    "orca:mail.content:read",
    "orca:connection-status:read",
  ],
  "agent_events:read": ["orca:agent-events:read"],
} as const satisfies Record<McpOAuthScope, readonly OrcaMcpScope[]>;

function invalidToken(message = "The access token is invalid or expired"): never {
  throw new OAuthError(OAuthErrorCode.InvalidToken, message);
}

export function mapOAuthScopesToResourceScopes(scopes: readonly McpOAuthScope[]): OrcaMcpScope[] {
  return [...new Set(scopes.flatMap((scope) => resourceScopesByOAuthScope[scope]))];
}

export function getOAuthScopeForResourceScope(scope: OrcaMcpScope): McpOAuthScope {
  const match = (Object.entries(resourceScopesByOAuthScope) as Array<[McpOAuthScope, readonly OrcaMcpScope[]]>)
    .find(([, resourceScopes]) => resourceScopes.includes(scope));
  if (!match) throw new Error(`No OAuth scope maps to the resource capability ${scope}`);
  return match[0];
}

/**
 * Adapts the live OAuth grant verifier to the MCP SDK. Signature validation is
 * only the first gate: every request also checks the token hash, connection
 * revocation, granted scopes, and current account ownership in SQLite.
 */
export function createOrcaMcpAccessTokenVerifier(
  config: McpOAuthConfig,
  dbFactory: DatabaseFactory = createDatabaseClient,
): OrcaMcpTokenVerifier {
  if (!config.enabled || !config.signingKey) {
    throw new Error("MCP OAuth must be enabled with ORCA_M6_MCP_SIGNING_KEY before the /mcp resource is enabled");
  }

  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      const { db, sqlite } = dbFactory();
      try {
        const oauthAuthorization = await verifyMcpAccessToken(db, token, { config });
        const scopes = mapOAuthScopesToResourceScopes(oauthAuthorization.scopes);
        const authorization = orcaAgentAuthorizationContextSchema.parse({
          userId: oauthAuthorization.userId,
          accountIds: oauthAuthorization.accountIds,
          issuer: oauthAuthorization.issuer,
          resource: oauthAuthorization.resource,
          scopes,
          issuedAt: oauthAuthorization.issuedAt,
          expiresAt: oauthAuthorization.expiresAt,
        });
        return {
          token,
          clientId: oauthAuthorization.clientId,
          scopes: oauthAuthorization.scopes,
          expiresAt: Math.floor(oauthAuthorization.expiresAt.getTime() / 1_000),
          resource: new URL(oauthAuthorization.resource),
          extra: {
            [authorizationExtraKey]: authorization,
            grantRevokedAt: null,
          },
        };
      } catch {
        return invalidToken();
      } finally {
        sqlite.close();
      }
    },
  };
}

export function getOrcaAuthorization(authInfo: AuthInfo): {
  authorization: OrcaAgentAuthorizationContext;
  grantRevokedAt: string | null;
} {
  const authorization = orcaAgentAuthorizationContextSchema.safeParse(authInfo.extra?.[authorizationExtraKey]);
  if (!authorization.success) return invalidToken();
  const grantRevokedAt = authInfo.extra?.grantRevokedAt;
  if (grantRevokedAt !== null && grantRevokedAt !== undefined && typeof grantRevokedAt !== "string") {
    return invalidToken();
  }
  return { authorization: authorization.data, grantRevokedAt: grantRevokedAt ?? null };
}
