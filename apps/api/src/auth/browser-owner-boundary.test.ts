import { afterEach, beforeEach, expect, test } from "bun:test";
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
