import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";

import { createDatabaseClient } from "../../db/client.ts";
import {
  mcpAccessTokens,
  mcpAuthorizationCodes,
  mcpConnectionAccounts,
  mcpConnections,
  mcpOAuthClients,
  mcpRefreshTokens,
  oauthAccounts,
} from "../../db/schema.ts";
import type { McpOAuthConfig, McpOAuthScope } from "./config.ts";
import { mcpOAuthRetention } from "./config.ts";
import { orcaMcpAuthorizationContextSchema } from "./context.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export class McpTokenError extends Error {
  constructor(
    public readonly code: "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
    this.name = "McpTokenError";
  }
}

class RefreshReplayError extends Error {}

export function deriveMcpSigningKey(config: McpOAuthConfig, purpose: "access" | "consent") {
  if (!config.signingKey) throw new Error("MCP OAuth signing key is unavailable while the feature is disabled");
  return new Uint8Array(hkdfSync("sha256", config.signingKey, new Uint8Array(), `orca-mcp:${purpose}:v1`, 32));
}

export function hashMcpSecret(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function createOpaqueMcpToken(prefix: "mcp_code" | "mcp_rt") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function parseScopes(value: string) {
  return value.split(/\s+/).filter(Boolean) as McpOAuthScope[];
}

function serializeScopes(scopes: readonly McpOAuthScope[]) {
  return [...new Set(scopes)].sort().join(" ");
}

function getConnectionAccounts(db: Database, connectionId: string, userId: string) {
  return db
    .select({ id: oauthAccounts.id })
    .from(mcpConnectionAccounts)
    .innerJoin(oauthAccounts, eq(mcpConnectionAccounts.accountId, oauthAccounts.id))
    .where(and(
      eq(mcpConnectionAccounts.connectionId, connectionId),
      eq(oauthAccounts.userId, userId),
    ))
    .all()
    .map((row) => row.id)
    .sort();
}

export function revokeMcpConnection(db: Database, connectionId: string, now = new Date()) {
  return db.transaction((tx) => {
    const revoked = tx.update(mcpConnections)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(mcpConnections.id, connectionId), isNull(mcpConnections.revokedAt)))
      .returning({ id: mcpConnections.id })
      .get();
    if (!revoked) return false;
    tx.update(mcpAccessTokens).set({ revokedAt: now }).where(and(eq(mcpAccessTokens.connectionId, connectionId), isNull(mcpAccessTokens.revokedAt))).run();
    tx.update(mcpRefreshTokens).set({ revokedAt: now }).where(and(eq(mcpRefreshTokens.connectionId, connectionId), isNull(mcpRefreshTokens.revokedAt))).run();
    return true;
  });
}

export function revokeAllMcpConnections(db: Database, userId: string, now = new Date()) {
  const connections = db.select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), isNull(mcpConnections.revokedAt)))
    .all();
  for (const connection of connections) revokeMcpConnection(db, connection.id, now);
  return connections.length;
}

export async function prepareMcpTokenPair(
  input: {
    connectionId: string;
    userId: string;
    clientId: string;
    resource: string;
    scopes: McpOAuthScope[];
    accountIds: string[];
  },
  config: McpOAuthConfig,
  now = new Date(),
) {
  const scopes = [...new Set(input.scopes)].sort();
  const accountIds = [...new Set(input.accountIds)].sort();
  const accessTokenId = crypto.randomUUID();
  const accessExpiresAt = new Date(now.getTime() + config.accessTokenTtlMs);
  const accessToken = await new SignJWT({
    client_id: input.clientId,
    resource: input.resource,
    scope: serializeScopes(scopes),
    account_ids: accountIds,
  })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: config.signingKeyId })
    .setIssuer(config.issuer)
    .setAudience(input.resource)
    .setSubject(input.userId)
    .setJti(accessTokenId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(accessExpiresAt.getTime() / 1000))
    .sign(deriveMcpSigningKey(config, "access"));

  const refreshToken = createOpaqueMcpToken("mcp_rt");
  const refreshExpiresAt = new Date(now.getTime() + config.refreshTokenTtlMs);
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(config.accessTokenTtlMs / 1000),
    scope: serializeScopes(scopes),
    accessRecord: {
      id: accessTokenId,
      tokenHash: hashMcpSecret(accessToken),
      connectionId: input.connectionId,
      expiresAt: accessExpiresAt,
      createdAt: now,
    },
    refreshRecord: {
      id: crypto.randomUUID(),
      tokenHash: hashMcpSecret(refreshToken),
      connectionId: input.connectionId,
      expiresAt: refreshExpiresAt,
      createdAt: now,
    },
  };
}

export async function rotateMcpRefreshToken(
  db: Database,
  input: {
    refreshToken: string;
    clientId: string;
    resource: string;
    scopes?: McpOAuthScope[];
  },
  config: McpOAuthConfig,
  now = new Date(),
) {
  const tokenHash = hashMcpSecret(input.refreshToken);
  const existing = db.select({
    id: mcpRefreshTokens.id,
    connectionId: mcpRefreshTokens.connectionId,
    consumedAt: mcpRefreshTokens.consumedAt,
    revokedAt: mcpRefreshTokens.revokedAt,
    expiresAt: mcpRefreshTokens.expiresAt,
    userId: mcpConnections.userId,
    clientId: mcpConnections.clientId,
    resource: mcpConnections.resource,
    scopes: mcpConnections.scopes,
    connectionRevokedAt: mcpConnections.revokedAt,
  }).from(mcpRefreshTokens)
    .innerJoin(mcpConnections, eq(mcpRefreshTokens.connectionId, mcpConnections.id))
    .where(eq(mcpRefreshTokens.tokenHash, tokenHash))
    .get();

  if (!existing || existing.revokedAt || existing.connectionRevokedAt || existing.expiresAt <= now) {
    throw new McpTokenError("invalid_token", "The refresh token is invalid or expired");
  }
  if (existing.clientId !== input.clientId || existing.resource !== input.resource) {
    throw new McpTokenError("invalid_token", "The refresh token was issued to a different client or resource");
  }
  const grantedScopes = parseScopes(existing.scopes);
  const scopes = input.scopes?.length ? input.scopes : grantedScopes;
  if (scopes.some((scope) => !grantedScopes.includes(scope))) {
    throw new McpTokenError("insufficient_scope", "The requested scope was not granted to this connection");
  }
  if (existing.consumedAt) {
    revokeMcpConnection(db, existing.connectionId, now);
    throw new McpTokenError("invalid_token", "Refresh token replay detected; the connection was revoked");
  }

  const pair = await prepareMcpTokenPair({
    connectionId: existing.connectionId,
    userId: existing.userId,
    clientId: existing.clientId,
    resource: existing.resource,
    scopes,
    accountIds: getConnectionAccounts(db, existing.connectionId, existing.userId),
  }, config, now);

  try {
    db.transaction((tx) => {
      const consumed = tx.update(mcpRefreshTokens)
        .set({ consumedAt: now })
        .where(and(eq(mcpRefreshTokens.id, existing.id), isNull(mcpRefreshTokens.consumedAt), isNull(mcpRefreshTokens.revokedAt)))
        .returning({ id: mcpRefreshTokens.id })
        .get();
      if (!consumed) throw new RefreshReplayError();
      tx.insert(mcpAccessTokens).values(pair.accessRecord).run();
      tx.insert(mcpRefreshTokens).values(pair.refreshRecord).run();
    });
  } catch (error) {
    if (!(error instanceof RefreshReplayError)) throw error;
    revokeMcpConnection(db, existing.connectionId, now);
    throw new McpTokenError("invalid_token", "Refresh token replay detected; the connection was revoked");
  }

  return pair;
}

export async function verifyMcpAccessToken(
  db: Database,
  token: string,
  input: { config: McpOAuthConfig; requiredScopes?: McpOAuthScope[]; now?: Date },
) {
  const now = input.now ?? new Date();
  let payload;
  try {
    const verified = await jwtVerify(token, deriveMcpSigningKey(input.config, "access"), {
      algorithms: ["HS256"],
      issuer: input.config.issuer,
      audience: input.config.resource,
      currentDate: now,
    });
    if (verified.protectedHeader.kid !== input.config.signingKeyId || verified.protectedHeader.typ !== "at+jwt") {
      throw new Error("Unexpected MCP signing key or token type");
    }
    payload = verified.payload;
  } catch {
    throw new McpTokenError("invalid_token", "The access token is invalid, expired, or intended for another resource");
  }

  const tokenId = payload.jti;
  const userId = payload.sub;
  const clientId = payload.client_id;
  const resource = payload.resource;
  const scopeValue = payload.scope;
  if ([tokenId, userId, clientId, resource, scopeValue].some((value) => typeof value !== "string")) {
    throw new McpTokenError("invalid_token", "The access token claims are incomplete");
  }

  const record = db.select({
    connectionId: mcpConnections.id,
    userId: mcpConnections.userId,
    clientId: mcpConnections.clientId,
    resource: mcpConnections.resource,
    connectionScopes: mcpConnections.scopes,
    clientName: mcpOAuthClients.name,
  }).from(mcpAccessTokens)
    .innerJoin(mcpConnections, eq(mcpAccessTokens.connectionId, mcpConnections.id))
    .innerJoin(mcpOAuthClients, eq(mcpConnections.clientId, mcpOAuthClients.id))
    .where(and(
      eq(mcpAccessTokens.id, tokenId as string),
      eq(mcpAccessTokens.tokenHash, hashMcpSecret(token)),
      isNull(mcpAccessTokens.revokedAt),
      gt(mcpAccessTokens.expiresAt, now),
      isNull(mcpConnections.revokedAt),
    ))
    .get();
  if (!record || record.userId !== userId || record.clientId !== clientId || record.resource !== resource || resource !== input.config.resource) {
    throw new McpTokenError("invalid_token", "The access token is no longer active");
  }

  const scopes = parseScopes(scopeValue as string);
  const connectionScopes = parseScopes(record.connectionScopes);
  const requiredScopes = input.requiredScopes ?? [];
  if (scopes.some((scope) => !connectionScopes.includes(scope)) || requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw new McpTokenError("insufficient_scope", "The access token does not grant the required scope");
  }

  const accountIds = getConnectionAccounts(db, record.connectionId, record.userId);
  db.update(mcpAccessTokens).set({ lastUsedAt: now }).where(eq(mcpAccessTokens.id, tokenId as string)).run();
  db.update(mcpConnections).set({ lastUsedAt: now, updatedAt: now }).where(eq(mcpConnections.id, record.connectionId)).run();
  return orcaMcpAuthorizationContextSchema.parse({
    connectionId: record.connectionId,
    userId: record.userId,
    clientId: record.clientId,
    clientName: record.clientName,
    resource: record.resource,
    scopes,
    accountIds,
    expiresAt: new Date((payload.exp as number) * 1000),
  });
}

export function revokeMcpToken(db: Database, token: string, now = new Date()) {
  const tokenHash = hashMcpSecret(token);
  const access = db.update(mcpAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(mcpAccessTokens.tokenHash, tokenHash), isNull(mcpAccessTokens.revokedAt)))
    .returning({ connectionId: mcpAccessTokens.connectionId })
    .get();
  if (access) return true;
  const refresh = db.select({ connectionId: mcpRefreshTokens.connectionId })
    .from(mcpRefreshTokens)
    .where(eq(mcpRefreshTokens.tokenHash, tokenHash))
    .get();
  if (!refresh) return false;
  return revokeMcpConnection(db, refresh.connectionId, now);
}

export function collectMcpOAuthGarbage(db: Database, now = new Date()) {
  const credentialCutoff = new Date(now.getTime() - mcpOAuthRetention.expiredCredentialMs);
  const replayCutoff = new Date(now.getTime() - mcpOAuthRetention.refreshReplayMs);
  const connectionCutoff = new Date(now.getTime() - mcpOAuthRetention.revokedConnectionMs);
  const clientCutoff = new Date(now.getTime() - mcpOAuthRetention.unusedClientMs);
  return db.transaction((tx) => {
    const authorizationCodes = tx.delete(mcpAuthorizationCodes).where(lt(mcpAuthorizationCodes.expiresAt, credentialCutoff)).returning({ id: mcpAuthorizationCodes.id }).all().length;
    const accessTokens = tx.delete(mcpAccessTokens).where(or(
      lt(mcpAccessTokens.expiresAt, credentialCutoff),
      lt(mcpAccessTokens.revokedAt, credentialCutoff),
    )).returning({ id: mcpAccessTokens.id }).all().length;
    const refreshTokens = tx.delete(mcpRefreshTokens).where(or(
      lt(mcpRefreshTokens.expiresAt, credentialCutoff),
      lt(mcpRefreshTokens.consumedAt, replayCutoff),
      lt(mcpRefreshTokens.revokedAt, replayCutoff),
    )).returning({ id: mcpRefreshTokens.id }).all().length;
    const connections = tx.delete(mcpConnections).where(lt(mcpConnections.revokedAt, connectionCutoff)).returning({ id: mcpConnections.id }).all().length;
    const clients = tx.delete(mcpOAuthClients).where(and(
      lt(mcpOAuthClients.createdAt, clientCutoff),
      notExists(tx.select({ value: sql<number>`1` }).from(mcpConnections).where(eq(mcpConnections.clientId, mcpOAuthClients.id))),
      notExists(tx.select({ value: sql<number>`1` }).from(mcpAuthorizationCodes).where(eq(mcpAuthorizationCodes.clientId, mcpOAuthClients.id))),
    )).returning({ id: mcpOAuthClients.id }).all().length;
    return { authorizationCodes, accessTokens, refreshTokens, connections, clients };
  });
}
