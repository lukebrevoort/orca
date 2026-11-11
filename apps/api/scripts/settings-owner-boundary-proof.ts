/** In-process HTTP/SQLite demonstration; no provider calls or user credentials. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../src/db/client.ts";
import { mcpAccessTokens, mcpConnections, mcpOAuthClients, mcpRefreshTokens, users } from "../src/db/schema.ts";
import { createApp } from "../src/index.ts";
import { createSession } from "../src/auth/session-store.ts";
import { createOutlookAuthApp } from "../src/auth/outlook/routes.ts";

const output = process.argv[2];
if (!output) throw new Error("Provide a new output JSON path");
const previous = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
const key = Buffer.alloc(32, 21).toString("base64");
process.env.SESSION_SECRET = "synthetic-settings-owner-demo-secret";
process.env.TOKEN_ENCRYPTION_KEY = key;
const directory = mkdtempSync(join(tmpdir(), "orca-settings-owner-demo-")), path = join(directory, "demo.sqlite");
const { db, sqlite } = createDatabaseClient(path);
let providerCalls = 0;
try {
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  db.insert(users).values([{ id: "u", email: "u@example.test" }, { id: "v", email: "v@example.test" }]).run();
  db.insert(mcpOAuthClients).values({ id: "client", name: "Synthetic demo", redirectUris: "[]" }).run();
  db.insert(mcpConnections).values(["u", "v"].map(userId => ({ id: `${userId}-connection`, userId, clientId: "client", scopes: "mail:read", resource: "https://mcp.orca.test/mcp" }))).run();
  const expiresAt = new Date(Date.now() + 3_600_000);
  db.insert(mcpAccessTokens).values(["u", "v"].map(id => ({ id: `${id}-access`, tokenHash: `${id}-synthetic-access`, connectionId: `${id}-connection`, expiresAt }))).run();
  db.insert(mcpRefreshTokens).values(["u", "v"].map(id => ({ id: `${id}-refresh`, tokenHash: `${id}-synthetic-refresh`, connectionId: `${id}-connection`, expiresAt }))).run();
  const u = await createSession(db, "u"), v = await createSession(db, "v"), dbFactory = () => createDatabaseClient(path);
  const app = createApp({ dbFactory, mcpOAuthConfig: { enabled: true, issuer: "https://auth.orca.test", resource: "https://mcp.orca.test/mcp", accessTokenTtlMs: 600_000, refreshTokenTtlMs: 2_592_000_000, authorizationCodeTtlMs: 300_000, signingKey: new Uint8Array(32).fill(17), signingKeyId: "synthetic-demo", allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], registrationLimitPerMinute: 30 } });
  const outlook = createOutlookAuthApp({ dbFactory, config: { clientId: "synthetic-client", clientSecret: "synthetic-not-used", tenant: "common", redirectUri: "http://localhost:3000/v1/auth/outlook/callback", scopes: ["openid", "Mail.Read"], tokenEncryptionKey: key, stateSecret: "synthetic-state-secret", successRedirectUrl: "http://localhost:5173/onboarding", errorRedirectUrl: "http://localhost:5173/login", webOrigin: "http://localhost:5173" }, fetch: async () => { providerCalls++; throw new Error("No external provider permitted"); } });
  const snapshot = () => ({ connections: sqlite.query("SELECT id,user_id,revoked_at FROM mcp_connections ORDER BY id").all(), access: sqlite.query("SELECT id,connection_id,revoked_at FROM mcp_access_tokens ORDER BY id").all(), refresh: sqlite.query("SELECT id,connection_id,revoked_at FROM mcp_refresh_tokens ORDER BY id").all(), transactions: sqlite.query("SELECT user_id,provider FROM mail_oauth_transactions ORDER BY user_id").all() });
  const before = snapshot(), stale = { cookie: `orca_session=${v.token}`, "x-orca-expected-user-id": "u" };
  const revoke = await app.request("/v1/mcp/connections/revoke-all", { method: "POST", headers: stale });
  const start = await outlook.request("/connect", { headers: stale });
  const afterMismatch = snapshot();
  assert.equal(revoke.status, 409); assert.equal(start.status, 409); assert.deepEqual(afterMismatch, before);
  const own = { cookie: `orca_session=${u.token}`, "x-orca-expected-user-id": "u" };
  const positive = await app.request("/v1/mcp/connections/revoke-all", { method: "POST", headers: own });
  assert.equal(positive.status, 200); assert.deepEqual(await positive.json(), { revoked: 1 });
  const afterOwn = snapshot();
  for (const rows of [afterOwn.connections, afterOwn.access, afterOwn.refresh]) {
    const typed = rows as { id: string; revoked_at: number | null }[];
    assert.notEqual(typed.find(row => row.id.startsWith("u-"))?.revoked_at, null);
    assert.equal(typed.find(row => row.id.startsWith("v-"))?.revoked_at, null);
  }
  const positiveStart = await outlook.request("/connect", { headers: own });
  assert.equal(positiveStart.status, 200); assert.deepEqual(snapshot().transactions, [{ user_id: "u", provider: "outlook" }]);
  const legacy = await app.request("/v1/mcp/connections", { headers: { cookie: `orca_session=${v.token}` } });
  assert.equal(legacy.status, 200); assert.equal(providerCalls, 0);
  const proof = { synthetic: true, httpRequests: 5, mismatch: { revokeStatus: revoke.status, outlookStartStatus: start.status, before, after: afterMismatch, domainUnchanged: true }, positive: { revokeStatus: positive.status, outlookStartStatus: positiveStart.status, after: snapshot() }, legacyReadStatus: legacy.status, providerCalls, callbackOrConsentExecuted: false, browserAcceptance: false };
  writeFileSync(output, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, httpRequests: 5, mismatchStatus: [409, 409], positiveStatus: [200, 200], legacyStatus: 200, providerCalls }));
} finally {
  sqlite.close(); rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}
