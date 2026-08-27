import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { decodeJwt, decodeProtectedHeader } from "jose";

import { createSession } from "../session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { mcpAccessTokens, mcpAuthorizationCodes, mcpConnections, mcpOAuthClients, mcpRefreshTokens, oauthAccounts, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import type { McpOAuthConfig } from "./config.ts";
import { collectMcpOAuthGarbage, hashMcpSecret, McpTokenError, verifyMcpAccessToken } from "./tokens.ts";
import { requireMcpAuthorization } from "./middleware.ts";

const config: McpOAuthConfig = {
  enabled: true,
  issuer: "https://auth.orca.test",
  resource: "https://mcp.orca.test/mcp",
  accessTokenTtlMs: 10 * 60 * 1000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  authorizationCodeTtlMs: 5 * 60 * 1000,
  signingKey: new Uint8Array(32).fill(17),
  signingKeyId: "test-mcp-v1",
  allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  registrationLimitPerMinute: 30,
};

const chatGptRedirect = "https://chatgpt.com/connector_platform_oauth_redirect";

function pkce(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

describe("Orca MCP OAuth 2.1", () => {
  let tempDir = "";
  let dbPath = "";

  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
    tempDir = mkdtempSync(join(tmpdir(), "orca-mcp-oauth-test-"));
    dbPath = join(tempDir, "oauth.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(users).values([
      { id: "user_a", email: "a@example.com", displayName: "User A" },
      { id: "user_b", email: "b@example.com", displayName: "User B" },
    ]).run();
    db.insert(oauthAccounts).values([
      { id: "account_a", userId: "user_a", provider: "gmail", providerEmail: "a@gmail.com", providerId: "provider-a" },
      { id: "account_b", userId: "user_b", provider: "gmail", providerEmail: "b@gmail.com", providerId: "provider-b" },
    ]).run();
    sqlite.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.SESSION_SECRET;
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  async function registerClient(app: ReturnType<typeof createApp>) {
    const response = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT development connection",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(response.status, 201);
    return (await response.json()) as { client_id: string; client_name: string };
  }

  async function authorize(app: ReturnType<typeof createApp>, clientId: string, scope = "mail:read") {
    const { db, sqlite } = createDatabaseClient(dbPath);
    const session = await createSession(db, "user_a");
    sqlite.close();
    const verifier = "orca-pkce-verifier-with-at-least-forty-three-characters-123";
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: config.resource,
      scope,
      state: "client-state-123",
      code_challenge: pkce(verifier),
      code_challenge_method: "S256",
    });
    const headers = { cookie: `orca_session=${session.token}` };
    const consent = await app.request(`/oauth/authorize?${query}`, { headers });
    assert.equal(consent.status, 200);
    const html = await consent.text();
    if (scope.split(/\s+/).includes("organization:control")) {
      assert.match(html, /revocable, account-scoped Organization-control connection/);
      assert.match(html, /cannot send, reply, forward, delete provider mail/);
      assert.match(html, /Describe, query, simulate, apply, and revert bounded Orca Organization changes/);
      assert.match(html, /Allow scoped access/);
    } else {
      assert.match(html, /revocable, read-only connection/);
    }
    assert.doesNotMatch(html, /account_b/);
    const consentRequest = /name="consent_request" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(consentRequest);
    const approval = await app.request("/oauth/authorize", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_request: consentRequest, decision: "approve", account_id: "account_a" }).toString(),
    });
    assert.equal(approval.status, 302);
    const redirect = new URL(approval.headers.get("location")!);
    assert.equal(redirect.searchParams.get("state"), "client-state-123");
    assert.equal(redirect.searchParams.get("iss"), config.issuer);
    assert.ok(redirect.searchParams.get("code"));
    return { code: redirect.searchParams.get("code")!, verifier };
  }

  async function exchange(app: ReturnType<typeof createApp>, clientId: string, code: string, verifier: string) {
    return app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
        resource: config.resource,
      }).toString(),
    });
  }

  function refresh(app: ReturnType<typeof createApp>, clientId: string, refreshToken: string) {
    return app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: config.resource }).toString(),
    });
  }

  function callMcp(app: ReturnType<typeof createApp>, accessToken: string, toolName: string, args: Record<string, unknown> = {}) {
    return app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        host: new URL(config.resource).host,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
    });
  }

  test("publishes discovery and completes stateful authorization code + S256 PKCE", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const resourceMetadata = await app.request("/.well-known/oauth-protected-resource/mcp");
    assert.equal(resourceMetadata.status, 200);
    assert.deepEqual((await resourceMetadata.json()).scopes_supported, ["mail:read", "agent_events:read", "organization:control"]);
    const authorizationMetadata = await app.request("/.well-known/oauth-authorization-server");
    const metadata = await authorizationMetadata.json();
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);

    const client = await registerClient(app);
    const { code, verifier } = await authorize(app, client.client_id);
    const wrongPkce = await exchange(app, client.client_id, code, `${verifier}-wrong`);
    assert.equal(wrongPkce.status, 400);
    assert.equal((await wrongPkce.json()).error, "invalid_grant");

    const wrongResource = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", resource: "https://other.orca.test/mcp" }).toString(),
    });
    assert.equal(wrongResource.status, 400);
    assert.equal((await wrongResource.json()).error, "invalid_target");

    const tokenResponse = await exchange(app, client.client_id, code, verifier);
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
    const tokens = await tokenResponse.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 600);
    assert.equal(tokens.scope, "mail:read");
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.deepEqual(decodeProtectedHeader(tokens.access_token), { alg: "HS256", typ: "at+jwt", kid: "test-mcp-v1" });
    const claims = decodeJwt(tokens.access_token);
    assert.equal(claims.iss, config.issuer);
    assert.equal(claims.aud, config.resource);
    assert.equal(claims.resource, config.resource);
    assert.equal(claims.sub, "user_a");
    assert.equal(claims.scope, "mail:read");
    assert.deepEqual(claims.account_ids, ["account_a"]);
    assert.ok(typeof claims.jti === "string");
    assert.ok(typeof claims.iat === "number" && typeof claims.exp === "number" && claims.exp - claims.iat <= 600);

    const replay = await exchange(app, client.client_id, code, verifier);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");

    const { db, sqlite } = createDatabaseClient(dbPath);
    try {
      assert.notEqual(db.select().from(mcpAccessTokens).get()?.tokenHash, tokens.access_token);
      assert.notEqual(db.select().from(mcpRefreshTokens).get()?.tokenHash, tokens.refresh_token);
      const context = await verifyMcpAccessToken(db, tokens.access_token, { config, requiredScopes: ["mail:read"] });
      assert.equal(context.userId, "user_a");
      assert.deepEqual(context.accountIds, ["account_a"]);
      process.env.SESSION_SECRET = "rotated-browser-session-secret-that-is-long-enough";
      assert.equal((await verifyMcpAccessToken(db, tokens.access_token, { config })).userId, "user_a");
      await assert.rejects(
        verifyMcpAccessToken(db, tokens.access_token, { config: { ...config, signingKey: new Uint8Array(32).fill(99) } }),
        (error: unknown) => error instanceof McpTokenError && error.code === "invalid_token",
      );
      await assert.rejects(
        verifyMcpAccessToken(db, tokens.access_token, { config, requiredScopes: ["agent_events:read"] }),
        (error: unknown) => error instanceof McpTokenError && error.code === "insufficient_scope",
      );
      await assert.rejects(
        verifyMcpAccessToken(db, tokens.access_token, { config: { ...config, resource: "https://other.orca.test/mcp" } }),
        (error: unknown) => error instanceof McpTokenError && error.code === "invalid_token",
      );
    } finally { sqlite.close(); }
  });

  test("issues an explicit account-scoped Organization-control grant with truthful consent", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id, "organization:control");
    const response = await exchange(app, client.client_id, grant.code, grant.verifier);
    assert.equal(response.status, 200);
    const tokens = await response.json();
    assert.equal(tokens.scope, "organization:control");
    assert.deepEqual(decodeJwt(tokens.access_token).account_ids, ["account_a"]);
  });

  test("registers protected-resource metadata at the full configured resource path", async () => {
    const nestedConfig = { ...config, resource: "https://mcp.orca.test/orca/mcp" };
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: nestedConfig });
    const metadataResponse = await app.request("/.well-known/oauth-protected-resource/orca/mcp");
    assert.equal(metadataResponse.status, 200);
    assert.equal((await metadataResponse.json()).resource, nestedConfig.resource);
    assert.equal((await app.request("/.well-known/oauth-protected-resource")).status, 404);
  });

  test("carries issued OAuth grants through /mcp and enforces live revocation and disconnect", async () => {
    const app = createApp({
      dbFactory: () => createDatabaseClient(dbPath),
      mcpOAuthConfig: config,
      mcpBoundaryPolicy: { enabled: true, issuer: config.issuer, resource: config.resource },
    });
    const client = await registerClient(app);
    const mailGrant = await authorize(app, client.client_id, "mail:read");
    const mailTokens = await (await exchange(app, client.client_id, mailGrant.code, mailGrant.verifier)).json();

    assert.equal((await callMcp(app, mailTokens.access_token, "search_mail", { classification: "all", attention: "all" })).status, 200);
    const missingEventScope = await callMcp(app, mailTokens.access_token, "list_agent_events");
    assert.equal(missingEventScope.status, 403);
    assert.match(missingEventScope.headers.get("www-authenticate") ?? "", /scope="agent_events:read"/);

    const revokeDb = createDatabaseClient(dbPath);
    const session = await createSession(revokeDb.db, "user_a");
    const connection = revokeDb.db.select().from(mcpConnections).where(eq(mcpConnections.userId, "user_a")).get();
    revokeDb.sqlite.close();
    assert.ok(connection);
    assert.equal((await app.request(`/v1/mcp/connections/${connection.id}`, {
      method: "DELETE",
      headers: { cookie: `orca_session=${session.token}` },
    })).status, 204);
    assert.equal((await callMcp(app, mailTokens.access_token, "search_mail", { classification: "all", attention: "all" })).status, 401);

    const replacementGrant = await authorize(app, client.client_id, "mail:read agent_events:read");
    const replacementTokens = await (await exchange(app, client.client_id, replacementGrant.code, replacementGrant.verifier)).json();
    assert.equal((await callMcp(app, replacementTokens.access_token, "list_agent_events")).status, 200);
    const disconnectDb = createDatabaseClient(dbPath);
    disconnectDb.db.delete(oauthAccounts).where(eq(oauthAccounts.id, "account_a")).run();
    disconnectDb.sqlite.close();
    assert.equal((await callMcp(app, replacementTokens.access_token, "search_mail", { classification: "all", attention: "all" })).status, 401);
  });

  test("rotates refresh tokens, detects replay, and immediately revokes the connection", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id, "mail:read agent_events:read");
    const initial = await (await exchange(app, client.client_id, grant.code, grant.verifier)).json();
    const refreshedResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: initial.refresh_token, resource: config.resource, scope: "mail:read" }).toString(),
    });
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await refreshedResponse.json();
    assert.notEqual(refreshed.refresh_token, initial.refresh_token);
    assert.equal(refreshed.scope, "mail:read");

    const replay = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: initial.refresh_token, resource: config.resource }).toString(),
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error_description, /replay detected/);
    const { db, sqlite } = createDatabaseClient(dbPath);
    try {
      await assert.rejects(verifyMcpAccessToken(db, refreshed.access_token, { config }), McpTokenError);
      assert.ok(db.select().from(mcpConnections).where(eq(mcpConnections.userId, "user_a")).get()?.revokedAt);
    } finally { sqlite.close(); }
  });

  test("rolls back authorization-code consumption when credential persistence fails", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id);
    const failureDb = createDatabaseClient(dbPath);
    failureDb.sqlite.exec("CREATE TRIGGER fail_access_insert BEFORE INSERT ON mcp_access_tokens BEGIN SELECT RAISE(ABORT, 'injected access insert failure'); END");
    failureDb.sqlite.close();

    assert.equal((await exchange(app, client.client_id, grant.code, grant.verifier)).status, 500);
    const check = createDatabaseClient(dbPath);
    try {
      assert.equal(check.db.select().from(mcpAuthorizationCodes).where(eq(mcpAuthorizationCodes.codeHash, hashMcpSecret(grant.code))).get()?.consumedAt, null);
      assert.equal(check.db.select().from(mcpConnections).all().length, 0);
      check.sqlite.exec("DROP TRIGGER fail_access_insert");
    } finally { check.sqlite.close(); }
    assert.equal((await exchange(app, client.client_id, grant.code, grant.verifier)).status, 200);
  });

  test("rolls back refresh consumption when replacement credential persistence fails", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id);
    const initial = await (await exchange(app, client.client_id, grant.code, grant.verifier)).json();
    const failureDb = createDatabaseClient(dbPath);
    failureDb.sqlite.exec("CREATE TRIGGER fail_refresh_insert BEFORE INSERT ON mcp_refresh_tokens BEGIN SELECT RAISE(ABORT, 'injected refresh insert failure'); END");
    failureDb.sqlite.close();

    assert.equal((await refresh(app, client.client_id, initial.refresh_token)).status, 500);
    const check = createDatabaseClient(dbPath);
    try {
      assert.equal(check.db.select().from(mcpRefreshTokens).where(eq(mcpRefreshTokens.tokenHash, hashMcpSecret(initial.refresh_token))).get()?.consumedAt, null);
      assert.equal(check.db.select().from(mcpRefreshTokens).all().length, 1);
      check.sqlite.exec("DROP TRIGGER fail_refresh_insert");
    } finally { check.sqlite.close(); }
    assert.equal((await refresh(app, client.client_id, initial.refresh_token)).status, 200);
  });

  test("bounds dynamic registration and rejects untrusted callback origins", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: { ...config, registrationLimitPerMinute: 1 } });
    const attacker = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://attacker.example/callback"] }),
    });
    assert.equal(attacker.status, 400);
    assert.equal((await attacker.json()).error, "invalid_redirect_uri");
    const inspection = createDatabaseClient(dbPath);
    assert.equal(inspection.db.select().from(mcpOAuthClients).all().length, 0);
    inspection.sqlite.close();
    const registered = await registerClient(app);
    assert.equal(registered.client_id.length > 0, true);
    assert.equal(registered.client_name, "ChatGPT or Codex");
    const limited = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [chatGptRedirect] }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    const oversized = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x".repeat(17_000), redirect_uris: [chatGptRedirect] }),
    });
    assert.equal(oversized.status, 413);
  });

  test("retains consumed refresh tokens for replay detection, then garbage-collects them", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id);
    const initial = await (await exchange(app, client.client_id, grant.code, grant.verifier)).json();
    assert.equal((await refresh(app, client.client_id, initial.refresh_token)).status, 200);
    const { db, sqlite } = createDatabaseClient(dbPath);
    try {
      const initialHash = hashMcpSecret(initial.refresh_token);
      assert.ok(db.select().from(mcpRefreshTokens).where(eq(mcpRefreshTokens.tokenHash, initialHash)).get()?.consumedAt);
      collectMcpOAuthGarbage(db, new Date(Date.now() + 23 * 60 * 60 * 1000));
      assert.ok(db.select().from(mcpRefreshTokens).where(eq(mcpRefreshTokens.tokenHash, initialHash)).get());
      collectMcpOAuthGarbage(db, new Date(Date.now() + 25 * 60 * 60 * 1000));
      assert.equal(db.select().from(mcpRefreshTokens).where(eq(mcpRefreshTokens.tokenHash, initialHash)).get(), undefined);
    } finally { sqlite.close(); }
  });

  test("keeps grants account-scoped and supports per-connection and all-connection revocation", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id);
    const tokens = await (await exchange(app, client.client_id, grant.code, grant.verifier)).json();
    const { db, sqlite } = createDatabaseClient(dbPath);
    const session = await createSession(db, "user_a");
    sqlite.close();
    const headers = { cookie: `orca_session=${session.token}` };
    const list = await app.request("/v1/mcp/connections", { headers });
    assert.equal(list.status, 200);
    const page = await list.json();
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0].accounts.map((account: { id: string }) => account.id), ["account_a"]);
    assert.equal(page.items[0].revokedAt, null);

    const otherSessionDb = createDatabaseClient(dbPath);
    const otherSession = await createSession(otherSessionDb.db, "user_b");
    otherSessionDb.sqlite.close();
    assert.equal((await app.request(`/v1/mcp/connections/${page.items[0].id}`, { method: "DELETE", headers: { cookie: `orca_session=${otherSession.token}` } })).status, 404);
    assert.equal((await app.request(`/v1/mcp/connections/${page.items[0].id}`, { method: "DELETE", headers })).status, 204);

    const check = createDatabaseClient(dbPath);
    try { await assert.rejects(verifyMcpAccessToken(check.db, tokens.access_token, { config }), McpTokenError); }
    finally { check.sqlite.close(); }
    const revokedPage = await (await app.request("/v1/mcp/connections", { headers })).json();
    assert.ok(revokedPage.items[0].revokedAt);
    assert.deepEqual(await (await app.request("/v1/mcp/connections/revoke-all", { method: "POST", headers })).json(), { revoked: 0 });
  });

  test("removes disconnected accounts from live authorization and cascades connections on user deletion", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const grant = await authorize(app, client.client_id);
    const tokens = await (await exchange(app, client.client_id, grant.code, grant.verifier)).json();
    const { db, sqlite } = createDatabaseClient(dbPath);
    try {
      db.delete(oauthAccounts).where(eq(oauthAccounts.id, "account_a")).run();
      const context = await verifyMcpAccessToken(db, tokens.access_token, { config, requiredScopes: ["mail:read"] });
      assert.deepEqual(context.accountIds, []);
      db.delete(users).where(eq(users.id, "user_a")).run();
      assert.equal(db.select().from(mcpConnections).where(eq(mcpConnections.userId, "user_a")).all().length, 0);
      await assert.rejects(verifyMcpAccessToken(db, tokens.access_token, { config }), McpTokenError);
    } finally { sqlite.close(); }
  });

  test("keeps the entire OAuth surface off until explicitly enabled", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: { ...config, enabled: false } });
    assert.equal((await app.request("/.well-known/oauth-authorization-server")).status, 404);
    assert.equal((await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    assert.equal((await app.request("/oauth/authorize")).status, 404);
    assert.equal((await app.request("/oauth/authorize", { method: "POST" })).status, 404);
    assert.equal((await app.request("/oauth/token", { method: "POST" })).status, 404);
    assert.equal((await app.request("/oauth/revoke", { method: "POST" })).status, 404);
    assert.equal((await app.request("/v1/mcp/connections")).status, 404);
    assert.equal((await app.request("/v1/mcp/connections/example", { method: "DELETE" })).status, 404);
    assert.equal((await app.request("/v1/mcp/connections/revoke-all", { method: "POST" })).status, 404);
  });

  test("provides a standards-discoverable 401 hook for the MCP resource", async () => {
    const resource = new Hono();
    resource.get("/mcp", requireMcpAuthorization({ config, requiredScopes: ["mail:read"] }), (c) => c.json({ ok: true }));
    const response = await resource.request("/mcp");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer resource_metadata=\"https://mcp.orca.test/.well-known/oauth-protected-resource/mcp\", scope=\"mail:read\"");
    assert.equal((await response.json()).error.code, "invalid_token");
  });

  test("refuses write scopes before consent", async () => {
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), mcpOAuthConfig: config });
    const client = await registerClient(app);
    const { db, sqlite } = createDatabaseClient(dbPath);
    const session = await createSession(db, "user_a");
    sqlite.close();
    const query = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: config.resource, scope: "mail:write", state: "write-state",
      code_challenge: pkce("write-scope-verifier-with-at-least-forty-three-characters"), code_challenge_method: "S256",
    });
    const response = await app.request(`/oauth/authorize?${query}`, { headers: { cookie: `orca_session=${session.token}` } });
    assert.equal(response.status, 302);
    const redirect = new URL(response.headers.get("location")!);
    assert.equal(redirect.searchParams.get("error"), "invalid_scope");
    assert.equal(redirect.searchParams.get("state"), "write-state");
    assert.equal(redirect.searchParams.get("iss"), config.issuer);
  });
});
