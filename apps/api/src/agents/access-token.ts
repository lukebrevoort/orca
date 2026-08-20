import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  orcaMcpAuthorizationContextSchema,
  type OrcaMcpAuthorizationContext,
} from "@orca/shared";
import { jwtVerify } from "jose";

import type { OrcaAgentBoundaryPolicy } from "./boundary.ts";

const minimumSigningSecretLength = 32;
const authorizationExtraKey = "orcaAuthorization";

export type OrcaMcpTokenVerifier = OAuthTokenVerifier;

function invalidToken(message = "The access token is invalid or expired"): never {
  throw new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

function readScopes(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return readStringArray(value);
}

/**
 * Validates Orca-issued short-lived JWT access tokens. BRE-267 owns issuance,
 * consent, refresh, and revocation; this verifier is the narrow resource-side
 * seam used by BRE-265 and can be replaced in tests or by a future verifier.
 */
export function createOrcaMcpAccessTokenVerifier(
  policy: Extract<OrcaAgentBoundaryPolicy, { enabled: true }>,
  env: NodeJS.ProcessEnv = process.env,
): OrcaMcpTokenVerifier {
  const secret = env.ORCA_M6_MCP_SIGNING_SECRET;
  if (!secret || secret.length < minimumSigningSecretLength) {
    throw new Error(`ORCA_M6_MCP_SIGNING_SECRET must be at least ${minimumSigningSecretLength} characters when MCP is enabled`);
  }
  const key = new TextEncoder().encode(secret);

  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
          audience: policy.resource,
          issuer: policy.issuer,
        });
        const accountIds = readStringArray(payload.account_ids);
        const scopes = readScopes(payload.scope);
        const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
        if (!payload.sub || !payload.iat || !payload.exp || !accountIds?.length || !scopes?.length || !clientId) {
          return invalidToken();
        }

        const authorization = orcaMcpAuthorizationContextSchema.safeParse({
          userId: payload.sub,
          accountIds,
          issuer: payload.iss,
          resource: policy.resource,
          scopes,
          issuedAt: new Date(payload.iat * 1_000).toISOString(),
          expiresAt: new Date(payload.exp * 1_000).toISOString(),
        });
        if (!authorization.success) return invalidToken();

        return {
          token,
          clientId,
          scopes,
          expiresAt: payload.exp,
          resource: new URL(policy.resource),
          extra: {
            [authorizationExtraKey]: authorization.data,
            grantRevokedAt: null,
          },
        };
      } catch (error) {
        if (OAuthError.isInstance(error)) throw error;
        return invalidToken();
      }
    },
  };
}

export function getOrcaAuthorization(authInfo: AuthInfo): {
  authorization: OrcaMcpAuthorizationContext;
  grantRevokedAt: string | null;
} {
  const authorization = orcaMcpAuthorizationContextSchema.safeParse(authInfo.extra?.[authorizationExtraKey]);
  if (!authorization.success) return invalidToken();
  const grantRevokedAt = authInfo.extra?.grantRevokedAt;
  if (grantRevokedAt !== null && grantRevokedAt !== undefined && typeof grantRevokedAt !== "string") {
    return invalidToken();
  }
  return { authorization: authorization.data, grantRevokedAt: grantRevokedAt ?? null };
}
