import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";

import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { buildSessionCookie } from "../jwt.ts";
import { requireAuth, type AuthVariables } from "../middleware.ts";
import { createSession } from "../session-store.ts";
import { createMobileAuthApp } from "./routes.ts";
import { admitMobileAuthRequest, createMobileAuthRequest } from "./store.ts";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "s".repeat(43);
const webOrigin = "https://orca.example";

type Fixture = ReturnType<typeof createFixture> extends Promise<infer T> ? T : never;
let fixture: Fixture;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(() => {
  fixture.sqlite.close();
  rmSync(fixture.tempDir, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("mobile native authentication", () => {
  test("requires explicit consent, exchanges PKCE once, and authenticates a user-scoped bearer", async () => {
    const started = await start(fixture.app);
    const requestToken = new URL(started.authorizationUrl).searchParams.get("request")!;

    const consentResponse = await fixture.app.request(`/v1/mobile/auth/authorize?request=${requestToken}`, {
      headers: { cookie: fixture.user1Cookie },
    });
    expect(consentResponse.status).toBe(200);
    const consent = await consentResponse.json() as { accountEmail: string; csrfToken: string };
    expect(consent.accountEmail).toBe("one@example.com");
    expect(fixture.sqlite.query("select authorization_code_hash from mobile_auth_requests").get()).toEqual({ authorization_code_hash: null });

    const bindingCookie = consentResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
    expect(consentResponse.headers.get("set-cookie")).toContain("HttpOnly");
    expect(consentResponse.headers.get("set-cookie")).toContain("SameSite=Lax");
    const grantResponse = await fixture.app.request("/v1/mobile/auth/grant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${fixture.user1Cookie}; ${bindingCookie}`,
        origin: webOrigin,
      },
      body: JSON.stringify({ csrfToken: consent.csrfToken }),
    });
    expect(grantResponse.status).toBe(200);
    const redirectUrl = new URL((await grantResponse.json() as { redirectUrl: string }).redirectUrl);
    expect(`${redirectUrl.protocol}//${redirectUrl.host}`).toBe("orca://auth");
    expect(redirectUrl.searchParams.get("state")).toBe(state);
    const code = redirectUrl.searchParams.get("code")!;
    expect(redirectUrl.searchParams.has("accessToken")).toBe(false);

    const badVerifier = await exchange(fixture.app, code, "b".repeat(43));
    expect(badVerifier.status).toBe(400);

    const exchanged = await exchange(fixture.app, code, verifier);
    expect(exchanged.status).toBe(200);
    const credential = await exchanged.json() as { accessToken: string; expiresAt: string };
    const raw = fixture.sqlite.query("select token_hash from mobile_sessions").get() as { token_hash: string };
    expect(raw.token_hash).not.toBe(credential.accessToken);

    const protectedResponse = await fixture.app.request("/protected", {
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });
    expect(protectedResponse.status).toBe(200);
    expect((await protectedResponse.json() as { userId: string }).userId).toBe("user_1");

    expect((await exchange(fixture.app, code, verifier)).status).toBe(400);
  });

  test("rejects a grant from a different web user and rejects cross-site confirmation", async () => {
    const started = await start(fixture.app);
    const requestToken = new URL(started.authorizationUrl).searchParams.get("request")!;
    const consentResponse = await fixture.app.request(`/v1/mobile/auth/authorize?request=${requestToken}`, {
      headers: { cookie: fixture.user1Cookie },
    });
    const consent = await consentResponse.json() as { csrfToken: string };
    const bindingCookie = consentResponse.headers.get("set-cookie")!.split(";", 1)[0]!;

    const crossSite = await fixture.app.request("/v1/mobile/auth/grant", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${fixture.user1Cookie}; ${bindingCookie}`, origin: "https://evil.example" },
      body: JSON.stringify({ csrfToken: consent.csrfToken }),
    });
    expect(crossSite.status).toBe(403);

    const wrongUser = await fixture.app.request("/v1/mobile/auth/grant", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${fixture.user2Cookie}; ${bindingCookie}`, origin: webOrigin },
      body: JSON.stringify({ csrfToken: consent.csrfToken }),
    });
    expect(wrongUser.status).toBe(400);
  });

  test("rejects expired authorization codes", async () => {
    const { code } = await authorize(fixture, fixture.user1Cookie);
    fixture.clock = new Date(fixture.clock.getTime() + 5 * 60 * 1000 + 1);
    expect((await exchange(fixture.app, code, verifier)).status).toBe(400);
  });

  test("does not grant pending login identities", async () => {
    const started = await start(fixture.app);
    const requestToken = new URL(started.authorizationUrl).searchParams.get("request")!;
    const response = await fixture.app.request(`/v1/mobile/auth/authorize?request=${requestToken}`, {
      headers: { cookie: fixture.pendingCookie },
    });
    expect(response.status).toBe(403);
  });

  test("revokes only the presented mobile session and leaves the desktop cookie valid", async () => {
    const { code } = await authorize(fixture, fixture.user1Cookie);
    const exchanged = await exchange(fixture.app, code, verifier);
    const { accessToken } = await exchanged.json() as { accessToken: string };

    const revoked = await fixture.app.request("/v1/mobile/auth/session", {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(revoked.status).toBe(204);
    expect((await fixture.app.request("/protected", { headers: { authorization: `Bearer ${accessToken}` } })).status).toBe(401);

    const cookieResponse = await fixture.app.request("/protected", { headers: { cookie: fixture.user1Cookie } });
    expect(cookieResponse.status).toBe(200);
    expect((await cookieResponse.json() as { userId: string }).userId).toBe("user_1");
  });

  test("rejects weak inputs and a silently changed browser request binding", async () => {
    const weak = await fixture.app.request("/v1/mobile/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codeChallenge: "weak", state: "weak" }),
    });
    expect(weak.status).toBe(400);

    const first = await start(fixture.app);
    const second = await start(fixture.app);
    const firstToken = new URL(first.authorizationUrl).searchParams.get("request")!;
    const secondToken = new URL(second.authorizationUrl).searchParams.get("request")!;
    const firstConsent = await fixture.app.request(`/v1/mobile/auth/authorize?request=${firstToken}`, { headers: { cookie: fixture.user1Cookie } });
    const bindingCookie = firstConsent.headers.get("set-cookie")!.split(";", 1)[0]!;
    const conflict = await fixture.app.request(`/v1/mobile/auth/authorize?request=${secondToken}`, {
      headers: { cookie: `${fixture.user1Cookie}; ${bindingCookie}` },
    });
    expect(conflict.status).toBe(409);
  });

  test("bounds start payloads, pending capacity, and prunes expired requests", async () => {
    const oversized = await fixture.app.request("/v1/mobile/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000" },
      body: "x".repeat(5000),
    });
    expect(oversized.status).toBe(413);

    const { db, sqlite } = createDatabaseClient(fixture.dbPath);
    try {
      createMobileAuthRequest(db, { codeChallenge: challenge, state }, new Date(fixture.clock.getTime() - 11 * 60 * 1000));
      const admitted = admitMobileAuthRequest(db, { codeChallenge: challenge, state }, fixture.clock, 1);
      expect(admitted).not.toBeNull();
      const atCapacity = admitMobileAuthRequest(db, { codeChallenge: challenge, state }, fixture.clock, 1);
      expect(atCapacity).toBeNull();
      expect((fixture.sqlite.query("select count(*) as count from mobile_auth_requests").get() as { count: number }).count).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

async function createFixture() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const tempDir = mkdtempSync(join(tmpdir(), "orca-mobile-auth-"));
  const dbPath = join(tempDir, "auth.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  sqlite.exec(await Bun.file(resolve(import.meta.dir, "../../../drizzle/0046_mobile_auth.sql")).text());

  const clockStart = new Date("2026-09-22T18:00:00.000Z");
  db.insert(users).values([
    { id: "user_1", email: "one@example.com", authenticatedAt: clockStart },
    { id: "user_2", email: "two@example.com", authenticatedAt: clockStart },
    { id: "pending", email: "pending@example.com" },
  ]).run();
  const user1 = await createSession(db, "user_1");
  const user2 = await createSession(db, "user_2");
  const pending = await createSession(db, "pending");
  const result = {
    app: new Hono<{ Variables: AuthVariables }>(),
    clock: clockStart,
    dbPath,
    sqlite,
    tempDir,
    user1Cookie: cookie(user1.token, user1.expiresAt),
    user2Cookie: cookie(user2.token, user2.expiresAt),
    pendingCookie: cookie(pending.token, pending.expiresAt),
  };
  result.app.route("/v1/mobile/auth", createMobileAuthApp({
    dbFactory: () => createDatabaseClient(dbPath),
    webOrigin,
    cookieSecure: true,
    now: () => result.clock,
  }));
  result.app.get("/protected", requireAuth({ dbFactory: () => createDatabaseClient(dbPath) }), (c) => c.json(c.get("auth")));
  return result;
}

function cookie(token: string, expiresAt: Date) {
  return buildSessionCookie(token, expiresAt, { secure: true }).split(";", 1)[0]!;
}

async function start(app: Fixture["app"]) {
  const response = await app.request("/v1/mobile/auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ codeChallenge: challenge, state }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ authorizationUrl: string; expiresAt: string }>;
}

async function authorize(current: Fixture, sessionCookie: string) {
  const started = await start(current.app);
  const requestToken = new URL(started.authorizationUrl).searchParams.get("request")!;
  const consentResponse = await current.app.request(`/v1/mobile/auth/authorize?request=${requestToken}`, { headers: { cookie: sessionCookie } });
  const consent = await consentResponse.json() as { csrfToken: string };
  const bindingCookie = consentResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
  const grantResponse = await current.app.request("/v1/mobile/auth/grant", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${sessionCookie}; ${bindingCookie}`, origin: webOrigin },
    body: JSON.stringify({ csrfToken: consent.csrfToken }),
  });
  expect(grantResponse.status).toBe(200);
  const redirectUrl = new URL((await grantResponse.json() as { redirectUrl: string }).redirectUrl);
  return { code: redirectUrl.searchParams.get("code")! };
}

function exchange(app: Fixture["app"], code: string, codeVerifier: string) {
  return app.request("/v1/mobile/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, codeVerifier }),
  });
}
