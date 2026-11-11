/** Synthetic HTTP/SQLite proof. No provider, network, real mail or credentials. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { browserAuthContextCookieName, browserAuthContextHeaderName } from "@orca/shared";
import { createDatabaseClient } from "../src/db/client.ts";
import { createApp } from "../src/index.ts";
import { createSession } from "../src/auth/session-store.ts";
import { createBrowserAuthContext, setBrowserSessionCookies } from "../src/auth/browser-auth-context.ts";

const output = process.argv[2];
if (!output) throw new Error("Provide a new output JSON path");
const previous = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
process.env.SESSION_SECRET = "bre455-owner-proof-synthetic-secret-0001";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
const directory = mkdtempSync(join(tmpdir(), "orca-owner-proof-"));
const path = join(directory, "proof.sqlite");
const { db, sqlite } = createDatabaseClient(path);
try {
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.test'),('v','v@example.test'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','u@example.test'),('b','v','gmail','b','v@example.test')");
  const u = await createSession(db, "u"), v = await createSession(db, "v");
  const app = createApp({ dbFactory: () => createDatabaseClient(path) });
  // This is the production pair helper used by the separately owned web fixture.
  const transitions = new Hono();
  transitions.get("/login-other", c => { setBrowserSessionCookies(c, v); return c.json({ ok: true }); });
  const headers = { cookie: `orca_session=${v.token}`, "x-orca-expected-user-id": "u", "content-type": "application/json" };
  const snapshot = () => ({
    installations: sqlite.query("SELECT user_id,installation_id,enabled,revision FROM important_notification_installations ORDER BY user_id,installation_id").all(),
    operations: sqlite.query("SELECT user_id,operation_id,installation_id FROM important_notification_operations ORDER BY user_id,operation_id").all(),
  });
  const before = snapshot();
  const pause = await app.request("/v1/notifications/installations/original-u", { method: "PUT", headers, body: JSON.stringify({ channel: "open_app", policyVersion: 1, enabled: false, accountIds: [], permission: "default", expectedRevision: 0, operationId: crypto.randomUUID() }) });
  const accounts = await app.request("/v1/accounts", { headers });
  const afterMismatch = snapshot();
  assert.equal(pause.status, 409); assert.equal(accounts.status, 409); assert.deepEqual(afterMismatch, before);
  const positive = await app.request("/v1/notifications/installations/original-u", { method: "PUT", headers: { ...headers, cookie: `orca_session=${u.token}` }, body: JSON.stringify({ channel: "open_app", policyVersion: 1, enabled: false, accountIds: [], permission: "default", expectedRevision: 0, operationId: crypto.randomUUID() }) });
  assert.equal(positive.status, 200);
  const held = await app.request("/v1/auth/session", { headers: { cookie: `orca_session=${u.token}` } });
  const transition = await transitions.request("/login-other");
  const marker = transition.headers.getSetCookie().find(cookie => cookie.startsWith(`${browserAuthContextCookieName}=`))!;
  assert.equal(transition.headers.getSetCookie().length, 2);
  assert.equal(held.headers.getSetCookie().length, 0);
  assert.equal(held.headers.get(browserAuthContextHeaderName), createBrowserAuthContext(u));
  assert.ok(marker.startsWith(`${browserAuthContextCookieName}=${createBrowserAuthContext(v)};`));
  const logout = await app.request("/v1/auth/logout", { method: "POST", headers: { origin: "http://localhost:5173", cookie: `orca_session=${v.token}` } });
  assert.equal(logout.status, 200); assert.equal(logout.headers.getSetCookie().length, 2);
  // Never serialize tokens, raw session IDs, secrets or witness values.
  const result = { synthetic: true, pauseStatus: pause.status, accountsStatus: accounts.status, before, afterMismatch, sameOwnerStatus: positive.status, afterPositive: snapshot(), heldSession: { status: held.status, computedHeader: !!held.headers.get(browserAuthContextHeaderName), cookieWrites: held.headers.getSetCookie().length, differsFromReplacement: held.headers.get(browserAuthContextHeaderName) !== createBrowserAuthContext(v) }, realPairedTransition: { status: transition.status, cookieNames: transition.headers.getSetCookie().map(cookie => cookie.slice(0, cookie.indexOf("="))), markerReadable: !marker.includes("HttpOnly") }, logout: { status: logout.status, clearedCookies: logout.headers.getSetCookie().map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), expired: cookie.includes("Max-Age=0") })) }, osDisplayVerified: false };
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, pauseStatus: pause.status, accountsStatus: accounts.status, sameOwnerStatus: positive.status, heldReadCookieWrites: 0, realTransitionCookieCount: 2, logoutCookieCount: 2 }));
} finally {
  sqlite.close(); rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
