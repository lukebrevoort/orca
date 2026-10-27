import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { buildClearedSessionCookie, getSessionCookieOptions } from "./auth/jwt.ts";
import { createSession, getSessionFromToken } from "./auth/session-store.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { createApp } from "./index.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;
let savedSecret: string | undefined;
let savedKey: string | undefined;
const origin = getServerConfig().webOrigin;

async function createFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-logout-route-"));
  const dbPath = join(tempDir, "auth.sqlite");
  const client = createDatabaseClient(dbPath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  client.db.insert(users).values({ id: "owner", email: "owner@example.test" }).run();
  const session = await createSession(client.db, "owner");
  let opens = 0;
  const app = createApp({ dbFactory: () => {
    opens++;
    return createDatabaseClient(dbPath);
  } });
  return { ...client, tempDir, session, app, opens: () => opens };
}

beforeEach(async () => {
  savedSecret = process.env.SESSION_SECRET;
  savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "logout-route-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  fixture = await createFixture();
});

afterEach(() => {
  fixture.sqlite.close();
  rmSync(fixture.tempDir, { recursive: true, force: true });
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

for (const rejected of ["https://evil.example", undefined, "null", origin + ".evil.example", origin + "/"] as const) {
  test(`origin guard: rejects ${rejected ?? "missing Origin"} before opening the handler database`, async () => {
    const headers: Record<string, string> = { cookie: `orca_session=${fixture.session.token}` };
    if (rejected !== undefined) headers.origin = rejected;
    const response = await fixture.app.request("/v1/auth/logout", { method: "POST", headers });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("invalid_origin");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fixture.opens()).toBe(0);
    expect(await getSessionFromToken(fixture.db, fixture.session.token)).not.toBeNull();
    expect((await fixture.app.request("/v1/auth/session", { headers: { cookie: headers.cookie! } })).status).toBe(200);
  });
}

test("revocation through real wiring: matching Origin clears cookie and old token receives 401", async () => {
  const cookie = `orca_session=${fixture.session.token}`;
  const response = await fixture.app.request("/v1/auth/logout", { method: "POST", headers: { origin, cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toBe(buildClearedSessionCookie(getSessionCookieOptions()));
  expect(await getSessionFromToken(fixture.db, fixture.session.token)).toBeNull();
  expect((await fixture.app.request("/v1/auth/session", { headers: { cookie } })).status).toBe(401);
});

test("matching Origin with no cookie succeeds and clears the cookie", async () => {
  const response = await fixture.app.request("/v1/auth/logout", { method: "POST", headers: { origin } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toBe(buildClearedSessionCookie(getSessionCookieOptions()));
  expect(fixture.opens()).toBe(0);
});

test("other methods cannot revoke through real wiring", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
    const response = await fixture.app.request("/v1/auth/logout", {
      method, headers: { origin, cookie: `orca_session=${fixture.session.token}` },
    });
    expect([404, 405]).toContain(response.status);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  // Global CORS handles OPTIONS as a preflight without invoking logout.
  const preflight = await fixture.app.request("/v1/auth/logout", { method: "OPTIONS", headers: { origin } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("set-cookie")).toBeNull();
  expect(fixture.opens()).toBe(0);
  expect(await getSessionFromToken(fixture.db, fixture.session.token)).not.toBeNull();
});
