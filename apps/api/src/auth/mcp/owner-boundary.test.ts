import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { expectedUserIdHeaderName } from "@orca/shared";
import { createDatabaseClient } from "../../db/client.ts";
import { mcpAccessTokens, mcpConnections, mcpOAuthClients, mcpRefreshTokens, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { createSession } from "../session-store.ts";
import type { McpOAuthConfig } from "./config.ts";

const config: McpOAuthConfig = {
  enabled: true, issuer: "https://auth.orca.test", resource: "https://mcp.orca.test/mcp",
  accessTokenTtlMs: 600_000, refreshTokenTtlMs: 2_592_000_000, authorizationCodeTtlMs: 300_000,
  signingKey: new Uint8Array(32).fill(17), signingKeyId: "synthetic-owner-boundary",
  allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], registrationLimitPerMinute: 30,
};

async function fixture(run: (f: {
  app: ReturnType<typeof createApp>;
  u: Awaited<ReturnType<typeof createSession>>;
  v: Awaited<ReturnType<typeof createSession>>;
  snapshot: () => unknown;
}) => Promise<void>) {
  const previous = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "synthetic-mcp-original-owner-boundary-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-mcp-owner-"));
  const path = join(directory, "owner.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(users).values([{ id: "u", email: "u@example.test" }, { id: "v", email: "v@example.test" }]).run();
    db.insert(mcpOAuthClients).values({ id: "client", name: "Synthetic client", redirectUris: JSON.stringify(config.allowedRedirectUris) }).run();
    db.insert(mcpConnections).values(["u", "v"].map(userId => ({ id: `${userId}-connection`, userId, clientId: "client", resource: config.resource, scopes: "mail:read" }))).run();
    const expiresAt = new Date(Date.now() + 3_600_000);
    db.insert(mcpAccessTokens).values(["u", "v"].map(id => ({ id: `${id}-access`, tokenHash: `${id}-synthetic-access-hash`, connectionId: `${id}-connection`, expiresAt }))).run();
    db.insert(mcpRefreshTokens).values(["u", "v"].map(id => ({ id: `${id}-refresh`, tokenHash: `${id}-synthetic-refresh-hash`, connectionId: `${id}-connection`, expiresAt }))).run();
    const u = await createSession(db, "u"), v = await createSession(db, "v");
    const app = createApp({ dbFactory: () => createDatabaseClient(path), mcpOAuthConfig: config });
    const snapshot = () => ({
      connections: sqlite.query("SELECT id,user_id,revoked_at,updated_at FROM mcp_connections ORDER BY id").all(),
      access: sqlite.query("SELECT id,connection_id,revoked_at FROM mcp_access_tokens ORDER BY id").all(),
      refresh: sqlite.query("SELECT id,connection_id,revoked_at FROM mcp_refresh_tokens ORDER BY id").all(),
    });
    await run({ app, u, v, snapshot });
  } finally {
    sqlite.close(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const commands = [
  { name: "list", path: "/v1/mcp/connections", method: "GET" },
  { name: "revoke one", path: "/v1/mcp/connections/v-connection", method: "DELETE" },
  { name: "revoke all", path: "/v1/mcp/connections/revoke-all", method: "POST" },
];

for (const command of commands) {
  test(`BRE-469 MCP ${command.name} rejects original U with replacement V session before domain effects`, async () => fixture(async ({ app, u, v, snapshot }) => {
    // The original editor accepted this real U response before its next request uses V.
    const held = await app.request("/v1/auth/session", { headers: { cookie: `orca_session=${u.token}` } });
    expect(held.status).toBe(200);
    expect(((await held.json()) as { user: { id: string } }).user.id).toBe("u");
    const before = snapshot();
    const response = await app.request(command.path, { method: command.method, headers: { cookie: `orca_session=${v.token}`, [expectedUserIdHeaderName]: "u" } });
    const after = snapshot();
    expect({ status: response.status, domain: after }).toEqual({ status: 409, domain: before });
    expect(await response.json()).toMatchObject({ error: { code: "session_owner_changed" } });
  }));

  test(`BRE-469 MCP ${command.name} rejects malformed original owner`, async () => fixture(async ({ app, u, snapshot }) => {
    const before = snapshot();
    const response = await app.request(command.path, { method: command.method, headers: { cookie: `orca_session=${u.token}`, [expectedUserIdHeaderName]: "u v" } });
    expect({ status: response.status, domain: snapshot() }).toEqual({ status: 400, domain: before });
  }));
}

test("BRE-469 MCP same-owner revoke-all revokes only that owner's connection and credentials", async () => fixture(async ({ app, u }) => {
  const response = await app.request("/v1/mcp/connections/revoke-all", { method: "POST", headers: { cookie: `orca_session=${u.token}`, [expectedUserIdHeaderName]: "u" } });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ revoked: 1 });
  const own = await app.request("/v1/mcp/connections", { headers: { cookie: `orca_session=${u.token}`, [expectedUserIdHeaderName]: "u" } });
  const items = (await own.json() as { items: { id: string; revokedAt: string | null }[] }).items;
  expect(items.map(item => item.id)).toEqual(["u-connection"]); expect(items[0]!.revokedAt).not.toBeNull();
}));

test("BRE-469 MCP legacy no-header client retains exact revoke-all response", async () => fixture(async ({ app, v }) => {
  const response = await app.request("/v1/mcp/connections/revoke-all", { method: "POST", headers: { cookie: `orca_session=${v.token}` } });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ revoked: 1 });
}));

test("BRE-469 MCP foreign resource ID remains 404 for legacy DELETE", async () => fixture(async ({ app, u, snapshot }) => {
  const before = snapshot();
  const response = await app.request("/v1/mcp/connections/v-connection", { method: "DELETE", headers: { cookie: `orca_session=${u.token}` } });
  expect(response.status).toBe(404); expect(snapshot()).toEqual(before);
}));
