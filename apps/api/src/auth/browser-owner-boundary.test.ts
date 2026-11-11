import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { createBrowserAuthContext, setBrowserSessionCookies, buildBrowserSessionCookiePair } from "./browser-auth-context.ts";
import { requireAuth, type AuthVariables } from "./middleware.ts";
import { createMobileSession } from "./mobile/store.ts";
import { randomUUID } from "node:crypto";
import { authSessionSchema } from "@orca/shared";
import { createApp } from "../index.ts";
import { createDatabaseClient } from "../db/client.ts";
import { clearMobilePushTestEnv, createMobilePushTestDb, seedAccount, setMobilePushTestEnv } from "../mobile-push/test-helpers.ts";
import { createSession } from "./session-store.ts";
import { sessionRenewalWindowMs } from "./config.ts";

let fixture: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const f = createMobilePushTestDb();
  seedAccount(f.sqlite, "u", "a"); seedAccount(f.sqlite, "v", "b");
  const u = await createSession(f.db, "u"), v = await createSession(f.db, "v");
  const app = createApp({ dbFactory: () => createDatabaseClient(f.path) });
  return { ...f, u, v, app };
}
beforeEach(async () => { setMobilePushTestEnv(); fixture = await setup(); });
afterEach(() => { fixture.sqlite.close(); clearMobilePushTestEnv(); });
const contextCookie = "orca_browser_auth_context";
const contextHeader = "x-orca-browser-auth-context";
function request(path: string, method = "GET", body?: unknown, token = fixture.v.token, expected = "u") {
  return fixture.app.request(path, { method, headers: { cookie: `orca_session=${token}`, "content-type": "application/json", "x-orca-expected-user-id": expected }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function snapshot() {
  return Object.fromEntries(["important_notification_installations", "important_notification_accounts", "important_notification_operations", "important_notification_web_claims", "important_notification_web_deliveries"].map(table => [table, fixture.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
const installation = "/v1/notifications/installations/unadopted-original-u";
for (const operation of ["read", "pause", "reconcile", "claim", "report"] as const) {
  test(`BRE-455 expected U/current V rejects ${operation} before domain access`, async () => {
    const before = snapshot();
    const response = operation === "read" ? await request(`${installation}?channel=open_app`)
      : operation === "pause" ? await request(installation, "PUT", { channel: "open_app", policyVersion: 1, enabled: false, accountIds: [], permission: "default", expectedRevision: 0, operationId: randomUUID() })
      : operation === "reconcile" ? await request(`/v1/notifications/operations/${randomUUID()}`)
      : await request(`${installation}/${operation}`, "POST", {});
    const after = snapshot();
    expect({ status: response.status, domainBefore: before, domainAfter: after }).toEqual({ status: 409, domainBefore: before, domainAfter: before });
    expect(await response.json()).toMatchObject({ error: { code: "session_owner_changed" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
}
test("BRE-455 account initialization rejects replacement owner", async () => {
  const response = await request("/v1/accounts");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "session_owner_changed" } });
});
test("BRE-455 fresh cookie session has computed context header and no marker repair", async () => {
  const response = await request("/v1/auth/session", "GET", undefined, fixture.u.token);
  expect(response.status).toBe(200);
  expect(authSessionSchema.safeParse(await response.json()).success).toBe(true);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get(contextHeader)).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test("BRE-455 real renewal reissues an authentication/witness pair", async () => {
  const expiring = await createSession(fixture.db, "u", sessionRenewalWindowMs - 1_000);
  const response = await request("/v1/auth/session", "GET", undefined, expiring.token);
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toMatch(/^orca_session=.+; HttpOnly; Path=\//);
  expect(cookies[1]).toMatch(new RegExp(`^${contextCookie}=v1\\.[A-Za-z0-9_-]{43}; Path=/`));
  expect(cookies[1]).not.toContain("HttpOnly");
});
test("BRE-455 missing cookie logout clears authentication/witness pair", async () => {
  const response = await fixture.app.request("/v1/auth/logout", { method: "POST", headers: { origin: "http://localhost:5173" } });
  expect(response.status).toBe(200);
  expect(response.headers.getSetCookie()).toHaveLength(2);
  expect(response.headers.getSetCookie()[1]).toContain(`${contextCookie}=; Path=/; SameSite=Lax;`);
});

for (const path of [`${installation}?channel=open_app`, "/v1/accounts", "/v1/auth/session"]) {
  test(`owner guard handles malformed, unauthenticated, same-owner and legacy ${path}`, async () => {
    for (const expected of ["", "two owners", "x".repeat(257), "u,v"]) {
      const response = await request(path, "GET", undefined, fixture.u.token, expected);
      // Comma-joined duplicate headers cannot accidentally select a matching owner.
      expect(response.status).toBe(expected === "u,v" ? 409 : 400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const missing = await fixture.app.request(path, { headers: { "x-orca-expected-user-id": "u" } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect((await request(path, "GET", undefined, fixture.u.token)).status).toBe(200);
    expect((await fixture.app.request(path, { headers: { cookie: `orca_session=${fixture.v.token}` } })).status).toBe(200);
  });
}
test("owner guard admits legitimate revisioned adoption/reconcile/claim/report and preserves foreign-ID 404", async () => {
  const operationId = randomUUID();
  const pause = { channel: "open_app", policyVersion: 1, enabled: true, accountIds: ["a"], permission: "granted", expectedRevision: 0, operationId };
  const response = await request(installation, "PUT", pause, fixture.u.token);
  expect(response.status).toBe(200);
  expect((await request(`/v1/notifications/operations/${operationId}`, "GET", undefined, fixture.u.token)).status).toBe(200);
  const claimId = randomUUID();
  expect((await request(`${installation}/claim`, "POST", { channel: "open_app", expectedRevision: 1, operationId: claimId, permission: "granted" }, fixture.u.token)).status).toBe(200);
  expect((await request(`${installation}/report`, "POST", { operationId: claimId, notificationIds: [], outcome: "constructed" }, fixture.u.token)).status).toBe(200);
  const foreign = await request(`${installation}?channel=open_app`, "GET", undefined, fixture.v.token, "v");
  expect(foreign.status).toBe(404);
  expect(fixture.sqlite.query("SELECT user_id FROM important_notification_installations").all()).toEqual([{ user_id: "u" }]);
});
test("owner mismatch wins over oversized or malformed request body before any domain connection", async () => {
  let connections = 0;
  const app = createApp({ dbFactory: () => { connections++; return createDatabaseClient(fixture.path); } });
  const response = await app.request(installation, { method: "PUT", headers: { cookie: `orca_session=${fixture.v.token}`, "x-orca-expected-user-id": "u" }, body: "x".repeat(40_000) });
  expect(response.status).toBe(409);
  expect(connections).toBe(1); // Authentication only; no body/domain DB admission.
  expect(snapshot().important_notification_installations).toEqual([]);
});
test("context is stable per verified session, changes across users/sessions, and ignores forged markers", async () => {
  const second = await createSession(fixture.db, "u");
  const expected = createBrowserAuthContext(fixture.u);
  expect(expected).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
  expect(expected).not.toContain(fixture.u.sessionId);
  expect(expected).not.toBe(createBrowserAuthContext(second));
  expect(expected).not.toBe(createBrowserAuthContext(fixture.v));
  for (const marker of ["malformed", createBrowserAuthContext(fixture.v), `${expected}; ${contextCookie}=other`]) {
    const response = await fixture.app.request("/v1/auth/session", { headers: { cookie: `orca_session=${fixture.u.token}; ${contextCookie}=${marker}`, [contextHeader]: "foreign" } });
    expect(response.status).toBe(200);
    expect(response.headers.get(contextHeader)).toBe(expected);
    expect(response.headers.getSetCookie()).toEqual([]);
  }
});
test("marker alone and marker as bearer grant nothing; real bearer wins over ambient cookie without browser output", async () => {
  const marker = createBrowserAuthContext(fixture.u);
  for (const headers of [{ cookie: `${contextCookie}=${marker}` }, { authorization: `Bearer ${marker}` }]) {
    const response = await fixture.app.request("/v1/auth/session", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get(contextHeader)).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  const mobile = createMobileSession(fixture.db, "v");
  const response = await fixture.app.request("/v1/auth/session", { headers: { authorization: `Bearer ${mobile.accessToken}`, cookie: `orca_session=${fixture.u.token}; ${contextCookie}=${marker}` } });
  expect(response.status).toBe(200);
  expect(authSessionSchema.parse(await response.json()).user!.id).toBe("v");
  expect(response.headers.get(contextHeader)).toBeNull();
  expect(response.headers.getSetCookie()).toEqual([]);
  const logout = await fixture.app.request("/v1/auth/logout", { method: "POST", headers: { origin: "http://localhost:5173", authorization: `Bearer ${mobile.accessToken}`, cookie: `${contextCookie}=${marker}` } });
  expect(logout.status).toBe(200);
  expect(logout.headers.getSetCookie()).toEqual([]);
});
test("real renewal tag remains stable and final pair replaces middleware pair without losing other cookies", async () => {
  const expiring = await createSession(fixture.db, "u", sessionRenewalWindowMs - 1_000);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.get("/switch", requireAuth({ dbFactory: () => createDatabaseClient(fixture.path) }), c => {
    c.header("Set-Cookie", "unrelated=preserved; HttpOnly; Path=/", { append: true });
    setBrowserSessionCookies(c, fixture.v);
    return c.json({ ok: true });
  });
  const renewed = await request("/v1/auth/session", "GET", undefined, expiring.token);
  expect(renewed.headers.get(contextHeader)).toBe(createBrowserAuthContext(expiring));
  expect(renewed.headers.getSetCookie()[1]).toStartWith(`${contextCookie}=${createBrowserAuthContext(expiring)};`);
  const response = await app.request("/switch", { headers: { cookie: `orca_session=${expiring.token}` } });
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(3);
  expect(cookies[0]).toBe("unrelated=preserved; HttpOnly; Path=/");
  expect(cookies[1]).toStartWith(`orca_session=${fixture.v.token};`);
  expect(cookies[2]).toStartWith(`${contextCookie}=${createBrowserAuthContext(fixture.v)};`);
});
test("production pair is host-only with shared attributes and readable witness only", () => {
  const cookies = buildBrowserSessionCookiePair(fixture.u, { secure: true });
  for (const cookie of cookies) {
    expect(cookie).toContain("; Path=/; SameSite=Lax; Secure;");
    expect(cookie).toContain(`Expires=${fixture.u.expiresAt.toUTCString()}`);
    expect(cookie).not.toContain("Domain=");
  }
  expect(cookies[0]).toContain("; HttpOnly;");
  expect(cookies[1]).not.toContain("HttpOnly");
});
test("held fresh U session response cannot replace V witness after real paired transition", async () => {
  // Hold the real response after server authentication; later client consumption
  // cannot mutate a browser jar because it contains no Set-Cookie at all.
  const held = await request("/v1/auth/session", "GET", undefined, fixture.u.token);
  const app = new Hono();
  app.get("/fixture-login-other", c => { setBrowserSessionCookies(c, fixture.v); return c.json({ ok: true }); });
  const transition = await app.request("/fixture-login-other");
  const jar = new Map<string, string>();
  for (const response of [transition, held]) for (const cookie of response.headers.getSetCookie()) {
    const [name, value] = cookie.split(";", 1)[0]!.split("="); jar.set(name!, value!);
  }
  expect(jar.get(contextCookie)).toBe(createBrowserAuthContext(fixture.v));
  expect(held.headers.get(contextHeader)).toBe(createBrowserAuthContext(fixture.u));
  expect(jar.get(contextCookie)).not.toBe(held.headers.get(contextHeader)!);
  expect(authSessionSchema.parse(await held.json()).user!.id).toBe("u");
});
