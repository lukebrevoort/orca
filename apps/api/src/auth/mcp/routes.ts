import { createHash } from "node:crypto";
import { and, count, desc, eq, gt, gte, isNull } from "drizzle-orm";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { mcpConnectionPageSchema, mcpOAuthScopeSchema } from "@orca/shared";

import { requireAuth, type AuthVariables } from "../middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  mcpAuthorizationCodes,
  mcpAccessTokens,
  mcpConnectionAccounts,
  mcpConnections,
  mcpOAuthClients,
  mcpRefreshTokens,
  oauthAccounts,
} from "../../db/schema.ts";
import {
  getMcpProtectedResourceMetadataUrl,
  isAllowedMcpRedirectUri,
  mcpOAuthLimits,
  mcpOAuthScopes,
  type McpOAuthConfig,
  type McpOAuthScope,
} from "./config.ts";
import {
  collectMcpOAuthGarbage,
  createOpaqueMcpToken,
  deriveMcpSigningKey,
  hashMcpSecret,
  McpTokenError,
  parseScopes,
  prepareMcpTokenPair,
  revokeAllMcpConnections,
  revokeMcpConnection,
  revokeMcpToken,
  rotateMcpRefreshToken,
} from "./tokens.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type McpApp = Hono<{ Variables: AuthVariables }>;
type McpContext = Context<{ Variables: AuthVariables }>;

type AuthorizationRequest = {
  userId: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: McpOAuthScope[];
  state: string | null;
  codeChallenge: string;
};

function parseJsonList(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseRequestedScopes(value: string | null): McpOAuthScope[] | null {
  const raw = value?.split(/\s+/).filter(Boolean) ?? [];
  if (raw.length === 0) return null;
  const parsed = raw.map((scope) => mcpOAuthScopeSchema.safeParse(scope));
  if (parsed.some((result) => !result.success)) return null;
  return [...new Set(parsed.map((result) => result.data!))];
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function appendAuthorizationResult(request: Pick<AuthorizationRequest, "redirectUri" | "state">, config: McpOAuthConfig, values: Record<string, string>) {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (request.state) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", config.issuer);
  return url.toString();
}

async function createConsentToken(request: AuthorizationRequest, config: McpOAuthConfig, now: Date) {
  return new SignJWT({ ...request, state: request.state ?? undefined })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: config.signingKeyId })
    .setIssuer(config.issuer)
    .setAudience("orca:mcp:consent")
    .setSubject(request.userId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor((now.getTime() + config.authorizationCodeTtlMs) / 1000))
    .sign(deriveMcpSigningKey(config, "consent"));
}

async function verifyConsentToken(token: string, config: McpOAuthConfig, now: Date): Promise<AuthorizationRequest> {
  const { payload, protectedHeader } = await jwtVerify(token, deriveMcpSigningKey(config, "consent"), {
    algorithms: ["HS256"],
    issuer: config.issuer,
    audience: "orca:mcp:consent",
    currentDate: now,
  });
  if (protectedHeader.kid !== config.signingKeyId || protectedHeader.typ !== "JWT") throw new Error("Consent signing key is invalid");
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.map((scope) => mcpOAuthScopeSchema.parse(scope)) : [];
  if (
    typeof payload.sub !== "string" ||
    typeof payload.clientId !== "string" ||
    typeof payload.redirectUri !== "string" ||
    typeof payload.resource !== "string" ||
    typeof payload.codeChallenge !== "string" ||
    scopes.length === 0
  ) throw new Error("Consent request is invalid");
  return {
    userId: payload.sub,
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    resource: payload.resource,
    scopes,
    state: typeof payload.state === "string" ? payload.state : null,
    codeChallenge: payload.codeChallenge,
  };
}

function oauthError(c: McpContext, status: 400 | 401 | 413 | 429 | 500, error: string, description: string) {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({ error, error_description: description }, status);
}

async function readBoundedBody(c: McpContext, maximumBytes: number) {
  const contentLength = Number(c.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) return null;
  const text = await c.req.text();
  return new TextEncoder().encode(text).byteLength <= maximumBytes ? text : null;
}

async function readBoundedForm(c: McpContext, maximumBytes: number) {
  const text = await readBoundedBody(c, maximumBytes);
  if (text === null) return null;
  const entries: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const existing = entries[key];
    entries[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return entries;
}

function featureDisabled(c: McpContext, config: McpOAuthConfig) {
  return config.enabled ? null : c.notFound();
}

function protectedResourceMetadata(config: McpOAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: mcpOAuthScopes,
    bearer_methods_supported: ["header"],
  };
}

export function registerMcpOAuthRoutes(
  app: McpApp,
  options: {
    dbFactory?: typeof createDatabaseClient;
    config: McpOAuthConfig;
    now?: () => Date;
  },
) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const config = options.config;
  const now = options.now ?? (() => new Date());
  const resourceMetadataPath = new URL(getMcpProtectedResourceMetadataUrl(config.resource)).pathname;
  const requireMcpFeature: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    const disabled = featureDisabled(c, config);
    if (disabled) return disabled;
    await next();
  };

  const metadataHandler = (c: McpContext) => featureDisabled(c, config) ?? c.json(protectedResourceMetadata(config));
  app.get(resourceMetadataPath, metadataHandler);

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const disabled = featureDisabled(c, config); if (disabled) return disabled;
    return c.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.issuer}/oauth/token`,
      registration_endpoint: `${config.issuer}/oauth/register`,
      revocation_endpoint: `${config.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: mcpOAuthScopes,
      authorization_response_iss_parameter_supported: true,
    });
  });

  app.post("/oauth/register", async (c) => {
    const disabled = featureDisabled(c, config); if (disabled) return disabled;
    const rawBody = await readBoundedBody(c, mcpOAuthLimits.registrationBodyBytes);
    if (rawBody === null) return oauthError(c, 413, "invalid_client_metadata", "Client registration document is too large");
    let body: any;
    try { body = JSON.parse(rawBody); } catch { return oauthError(c, 400, "invalid_client_metadata", "Expected a JSON client registration document"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return oauthError(c, 400, "invalid_client_metadata", "Expected a JSON client registration object");
    const redirects = Array.isArray(body.redirect_uris) ? [...new Set(body.redirect_uris)] : [];
    if (redirects.length === 0 || redirects.length > mcpOAuthLimits.redirectsPerClient || redirects.some((uri) => typeof uri !== "string" || !isAllowedMcpRedirectUri(uri, config))) {
      return oauthError(c, 400, "invalid_redirect_uri", "Redirect URIs must exactly match a configured OpenAI callback");
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return oauthError(c, 400, "invalid_client_metadata", "Only public clients using token_endpoint_auth_method=none are supported");
    }
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some((grant: unknown) => !["authorization_code", "refresh_token"].includes(String(grant))))) {
      return oauthError(c, 400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
    }
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.some((type: unknown) => type !== "code"))) {
      return oauthError(c, 400, "invalid_client_metadata", "Only the code response type is supported");
    }
    const clientId = crypto.randomUUID();
    if (typeof body.client_name === "string" && body.client_name.length > mcpOAuthLimits.clientNameCharacters) {
      return oauthError(c, 400, "invalid_client_metadata", `client_name must not exceed ${mcpOAuthLimits.clientNameCharacters} characters`);
    }
    // This surface is deliberately OpenAI-only; never turn caller-supplied branding into trusted consent copy.
    const clientName = "ChatGPT or Codex";
    const { db, sqlite } = dbFactory();
    try {
      const registrationAt = now();
      collectMcpOAuthGarbage(db, registrationAt);
      const registered = db.transaction((tx) => {
        const since = new Date(registrationAt.getTime() - 60_000);
        const recent = tx.select({ value: count() }).from(mcpOAuthClients).where(gte(mcpOAuthClients.createdAt, since)).get()?.value ?? 0;
        if (recent >= config.registrationLimitPerMinute) return false;
        tx.insert(mcpOAuthClients).values({ id: clientId, name: clientName, redirectUris: JSON.stringify(redirects), createdAt: registrationAt }).run();
        return true;
      });
      if (!registered) {
        c.header("Retry-After", "60");
        return oauthError(c, 429, "temporarily_unavailable", "Client registration rate limit exceeded");
      }
      return c.json({
        client_id: clientId,
        client_name: clientName,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }, 201);
    } finally { sqlite.close(); }
  });

  app.get("/oauth/authorize", requireMcpFeature, requireAuth({ dbFactory }), async (c) => {
    const query = c.req.query();
    const { db, sqlite } = dbFactory();
    try {
      const client = typeof query.client_id === "string" ? db.select().from(mcpOAuthClients).where(eq(mcpOAuthClients.id, query.client_id)).get() : null;
      if (!client) return oauthError(c, 400, "invalid_request", "Unknown OAuth client");
      const redirects = parseJsonList(client.redirectUris);
      if (!query.redirect_uri || !redirects.includes(query.redirect_uri)) return oauthError(c, 400, "invalid_request", "The redirect URI is not registered for this client");
      const partial = { redirectUri: query.redirect_uri, state: query.state ?? null };
      const redirectError = (error: string, description: string) => c.redirect(appendAuthorizationResult(partial, config, { error, error_description: description }), 302);
      if (query.response_type !== "code") return redirectError("unsupported_response_type", "Only the authorization code response type is supported");
      if (query.resource !== config.resource) return redirectError("invalid_target", "The resource parameter must exactly match the Orca MCP resource");
      if (query.code_challenge_method !== "S256" || !query.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge)) return redirectError("invalid_request", "A valid S256 PKCE code challenge is required");
      const scopes = parseRequestedScopes(query.scope ?? null);
      if (!scopes) return redirectError("invalid_scope", "Request one or more supported Orca MCP scopes");
      const userId = c.get("auth").userId;
      const accounts = db.select({ id: oauthAccounts.id, email: oauthAccounts.providerEmail, provider: oauthAccounts.provider })
        .from(oauthAccounts).where(eq(oauthAccounts.userId, userId)).all();
      if (accounts.length === 0) return redirectError("access_denied", "Connect at least one mail account in Orca before authorizing an agent");
      const consentToken = await createConsentToken({ userId, clientId: client.id, redirectUri: query.redirect_uri, resource: config.resource, scopes, state: query.state ?? null, codeChallenge: query.code_challenge }, config, now());
      const hasOrganizationControl = scopes.includes("organization:control");
      const scopeItems = scopes.map((scope) => `<li><strong>${escapeHtml(scope)}</strong><span>${scope === "mail:read"
        ? "Read bounded Orca mail and thread data."
        : scope === "agent_events:read"
          ? "Read propagated agent event status."
          : "Describe, query, simulate, apply, and revert bounded Orca Organization changes. This cannot send, reply, forward, or delete provider mail."}</span></li>`).join("");
      const accountItems = accounts.map((account) => `<label><input checked name="account_id" type="checkbox" value="${escapeHtml(account.id)}"><span><strong>${escapeHtml(account.email)}</strong><small>${escapeHtml(account.provider)}</small></span></label>`).join("");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      const heading = hasOrganizationControl ? `Let ${escapeHtml(client.name)} organize Orca?` : `Let ${escapeHtml(client.name)} read from Orca?`;
      const connectionDescription = hasOrganizationControl
        ? "This creates a revocable, account-scoped Organization-control connection. It can change Orca Organization state only; it cannot send, reply, forward, delete provider mail, or access provider tokens and credentials."
        : "This creates a revocable, read-only connection. It never shares provider tokens, a ChatGPT credential, or an OpenAI API key.";
      const allowLabel = hasOrganizationControl ? "Allow scoped access" : "Allow read-only access";
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${escapeHtml(client.name)} · Orca</title><style>:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui;background:#f4f1e8;color:#18302d}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{background:#fff;border:1px solid #d8d4ca;border-radius:24px;box-shadow:0 18px 60px #17302d18;max-width:620px;padding:36px;width:100%}p,small{color:#65726f;line-height:1.55}h1{font-family:Georgia,serif;font-size:36px;margin:8px 0 12px}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase}ul{display:grid;gap:10px;list-style:none;padding:0}li,label{align-items:center;background:#f7f6f1;border:1px solid #dedbd2;border-radius:14px;display:flex;gap:12px;padding:13px 15px}li span,label span{display:grid;gap:3px}section{margin-top:24px}section h2{font-size:15px}.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:28px}button{border:1px solid #c9c5bb;border-radius:999px;cursor:pointer;font-weight:700;padding:11px 18px}button[value=approve]{background:#18302d;color:#fff}@media(prefers-color-scheme:dark){:root{background:#121817;color:#edf1ef}main{background:#1b2422;border-color:#35423f}p,small{color:#aab5b2}li,label{background:#222d2a;border-color:#3b4945}button{background:#26322f;color:#edf1ef;border-color:#475650}button[value=approve]{background:#dbe8e4;color:#13201e}}</style></head><body><main><p class="eyebrow">Orca agent access</p><h1>${heading}</h1><p>${connectionDescription}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent_request" value="${escapeHtml(consentToken)}"><section><h2>Permissions</h2><ul>${scopeItems}</ul></section><section><h2>Accounts this connection may access</h2>${accountItems}</section><div class="actions"><button name="decision" value="deny">Cancel</button><button name="decision" value="approve">${allowLabel}</button></div></form></main></body></html>`);
    } finally { sqlite.close(); }
  });

  app.post("/oauth/authorize", requireMcpFeature, requireAuth({ dbFactory }), async (c) => {
    const body = await readBoundedForm(c, mcpOAuthLimits.tokenRequestBodyBytes);
    if (!body) return oauthError(c, 413, "invalid_request", "Consent response is too large");
    const token = typeof body.consent_request === "string" ? body.consent_request : "";
    let request: AuthorizationRequest;
    try { request = await verifyConsentToken(token, config, now()); } catch { return oauthError(c, 400, "invalid_request", "The consent request expired or is invalid"); }
    if (request.userId !== c.get("auth").userId) return oauthError(c, 400, "invalid_request", "The consent request belongs to another user");
    if (body.decision !== "approve") return c.redirect(appendAuthorizationResult(request, config, { error: "access_denied", error_description: "The user declined access" }), 302);
    const selected = (Array.isArray(body.account_id) ? body.account_id : [body.account_id]).filter((value): value is string => typeof value === "string");
    const { db, sqlite } = dbFactory();
    try {
      const owned = db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, request.userId)).all().map((account) => account.id);
      const accountIds = [...new Set(selected)].filter((id) => owned.includes(id));
      if (accountIds.length === 0 || accountIds.length !== new Set(selected).size) return c.redirect(appendAuthorizationResult(request, config, { error: "access_denied", error_description: "Choose one or more of your connected accounts" }), 302);
      const code = createOpaqueMcpToken("mcp_code");
      const issuedAt = now();
      db.insert(mcpAuthorizationCodes).values({
        id: crypto.randomUUID(), codeHash: hashMcpSecret(code), userId: request.userId, clientId: request.clientId,
        redirectUri: request.redirectUri, resource: request.resource, scopes: request.scopes.join(" "), accountIds: JSON.stringify(accountIds),
        codeChallenge: request.codeChallenge, expiresAt: new Date(issuedAt.getTime() + config.authorizationCodeTtlMs), createdAt: issuedAt,
      }).run();
      return c.redirect(appendAuthorizationResult(request, config, { code }), 302);
    } finally { sqlite.close(); }
  });

  app.post("/oauth/token", async (c) => {
    const disabled = featureDisabled(c, config); if (disabled) return disabled;
    const body = await readBoundedForm(c, mcpOAuthLimits.tokenRequestBodyBytes);
    if (!body) return oauthError(c, 413, "invalid_request", "Token request is too large");
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const resource = typeof body.resource === "string" ? body.resource : "";
    if (!clientId) return oauthError(c, 401, "invalid_client", "client_id is required for this public client");
    if (resource !== config.resource) return oauthError(c, 400, "invalid_target", "The resource parameter must exactly match the Orca MCP resource");
    const { db, sqlite } = dbFactory();
    try {
      collectMcpOAuthGarbage(db, now());
      let pair: Awaited<ReturnType<typeof prepareMcpTokenPair>>;
      if (grantType === "authorization_code") {
        const code = typeof body.code === "string" ? body.code : "";
        const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
        const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(c, 400, "invalid_grant", "A valid PKCE code_verifier is required");
        const record = db.select().from(mcpAuthorizationCodes).where(eq(mcpAuthorizationCodes.codeHash, hashMcpSecret(code))).get();
        const exchangeAt = now();
        if (!record || record.consumedAt || record.expiresAt <= exchangeAt || record.clientId !== clientId || record.redirectUri !== redirectUri || record.resource !== resource) return oauthError(c, 400, "invalid_grant", "The authorization code is invalid, expired, or already used");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== record.codeChallenge) return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
        const accountIds = parseJsonList(record.accountIds);
        const ownedIds = db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, record.userId)).all().map((account) => account.id);
        const activeAccountIds = accountIds.filter((id) => ownedIds.includes(id));
        if (activeAccountIds.length === 0) return oauthError(c, 400, "invalid_grant", "The authorized Orca accounts are no longer connected");
        const connectionId = crypto.randomUUID();
        pair = await prepareMcpTokenPair({
          connectionId,
          userId: record.userId,
          clientId,
          resource,
          scopes: parseScopes(record.scopes),
          accountIds: activeAccountIds,
        }, config, exchangeAt);
        const committed = db.transaction((tx) => {
          const consumed = tx.update(mcpAuthorizationCodes).set({ consumedAt: exchangeAt }).where(and(eq(mcpAuthorizationCodes.id, record.id), isNull(mcpAuthorizationCodes.consumedAt), gt(mcpAuthorizationCodes.expiresAt, exchangeAt))).returning({ id: mcpAuthorizationCodes.id }).get();
          if (!consumed) return false;
          tx.insert(mcpConnections).values({ id: connectionId, userId: record.userId, clientId, resource, scopes: record.scopes, createdAt: exchangeAt, updatedAt: exchangeAt }).run();
          tx.insert(mcpConnectionAccounts).values(activeAccountIds.map((accountId) => ({ id: crypto.randomUUID(), connectionId, accountId, createdAt: exchangeAt }))).run();
          tx.insert(mcpAccessTokens).values(pair.accessRecord).run();
          tx.insert(mcpRefreshTokens).values(pair.refreshRecord).run();
          return true;
        });
        if (!committed) return oauthError(c, 400, "invalid_grant", "The authorization code is invalid, expired, or already used");
      } else if (grantType === "refresh_token") {
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const scopes = body.scope === undefined ? undefined : parseRequestedScopes(typeof body.scope === "string" ? body.scope : "");
        if (body.scope !== undefined && !scopes) return oauthError(c, 400, "invalid_scope", "Refresh scope must be a subset of the original scoped grant");
        try { pair = await rotateMcpRefreshToken(db, { refreshToken, clientId, resource, scopes: scopes ?? undefined }, config, now()); }
        catch (error) {
          if (!(error instanceof McpTokenError)) throw error;
          return oauthError(c, 400, error.code === "insufficient_scope" ? "invalid_scope" : "invalid_grant", error.message);
        }
      } else {
        return oauthError(c, 400, "unsupported_grant_type", "Only authorization_code and refresh_token grants are supported");
      }
      c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache");
      return c.json({ access_token: pair.accessToken, token_type: "Bearer", expires_in: pair.expiresIn, refresh_token: pair.refreshToken, scope: pair.scope, resource: config.resource });
    } finally { sqlite.close(); }
  });

  app.post("/oauth/revoke", async (c) => {
    const disabled = featureDisabled(c, config); if (disabled) return disabled;
    const body = await readBoundedForm(c, mcpOAuthLimits.tokenRequestBodyBytes);
    if (!body) return oauthError(c, 413, "invalid_request", "Revocation request is too large");
    const token = typeof body.token === "string" ? body.token : "";
    const { db, sqlite } = dbFactory();
    try { if (token) revokeMcpToken(db, token, now()); return c.body(null, 200); }
    finally { sqlite.close(); }
  });

  app.get("/v1/mcp/connections", requireMcpFeature, requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const rows = db.select({
        id: mcpConnections.id, clientName: mcpOAuthClients.name, scopes: mcpConnections.scopes,
        createdAt: mcpConnections.createdAt, lastUsedAt: mcpConnections.lastUsedAt, revokedAt: mcpConnections.revokedAt,
      }).from(mcpConnections).innerJoin(mcpOAuthClients, eq(mcpConnections.clientId, mcpOAuthClients.id))
        .where(eq(mcpConnections.userId, c.get("auth").userId)).orderBy(desc(mcpConnections.createdAt)).all();
      const items = rows.map((row) => ({
        id: row.id, clientName: row.clientName, scopes: parseScopes(row.scopes),
        accounts: db.select({ id: oauthAccounts.id, email: oauthAccounts.providerEmail, provider: oauthAccounts.provider })
          .from(mcpConnectionAccounts).innerJoin(oauthAccounts, eq(mcpConnectionAccounts.accountId, oauthAccounts.id))
          .where(and(eq(mcpConnectionAccounts.connectionId, row.id), eq(oauthAccounts.userId, c.get("auth").userId))).all(),
        createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
      }));
      return c.json(mcpConnectionPageSchema.parse({ items }));
    } finally { sqlite.close(); }
  });

  app.delete("/v1/mcp/connections/:id", requireMcpFeature, requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const connection = db.select({ id: mcpConnections.id }).from(mcpConnections).where(and(eq(mcpConnections.id, c.req.param("id")), eq(mcpConnections.userId, c.get("auth").userId))).get();
      if (!connection) return c.json({ error: { code: "not_found", message: "Agent connection not found" } }, 404);
      revokeMcpConnection(db, connection.id, now());
      return c.body(null, 204);
    } finally { sqlite.close(); }
  });

  app.post("/v1/mcp/connections/revoke-all", requireMcpFeature, requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try { return c.json({ revoked: revokeAllMcpConnections(db, c.get("auth").userId, now()) }); }
    finally { sqlite.close(); }
  });
}
