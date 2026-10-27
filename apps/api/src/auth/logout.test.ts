import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";

import { createDatabaseClient } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";
import { buildSessionCookie, getSessionCookieOptions } from "./jwt.ts";
import { createLogoutApp } from "./logout.ts";
import { createSession, getSessionFromToken, invalidateSession } from "./session-store.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;
let savedSecret: string | undefined;
let savedKey: string | undefined;

beforeEach(async () => {
  savedSecret = process.env.SESSION_SECRET;
  savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "logout-test-session-secret-long-enough";
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

async function createFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-logout-"));
  const dbPath = join(tempDir, "auth.sqlite");
  const client = createDatabaseClient(dbPath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values([
    { id: "one", email: "one@example.test" },
    { id: "two", email: "two@example.test" },
  ]).run();
  const own = await createSession(client.db, "one");
  const sameUser = await createSession(client.db, "one");
  const otherUser = await createSession(client.db, "two");
  const handles: ReturnType<typeof createDatabaseClient>[] = [];
  const app = new Hono().route("/api/auth", createLogoutApp({
    dbFactory: () => {
      const handle = createDatabaseClient(dbPath);
      handles.push(handle);
      return handle;
    },
  }));
  return { ...client, tempDir, own, sameUser, otherUser, app, handles };
}

async function expectOk(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toBe(
    buildSessionCookie("", new Date(0), getSessionCookieOptions()),
  );
  for (const handle of fixture.handles) {
    expect(() => handle.sqlite.query("SELECT 1").get()).toThrow();
  }
}

async function expectLive(...tokens: string[]) {
  for (const token of tokens) expect(await getSessionFromToken(fixture.db, token)).not.toBeNull();
}

function post(cookie?: string, path = "/api/auth/logout", init: RequestInit = {}) {
  return fixture.app.request(path, {
    ...init,
    method: "POST",
    headers: { ...init.headers, ...(cookie === undefined ? {} : { cookie }) },
  });
}

test("only own session: invalidates the cookie session and preserves same-user and other-user sessions", async () => {
  await expectOk(await post(`orca_session=${fixture.own.token}`));
  const row = fixture.db.select().from(sessions).where(eq(sessions.id, fixture.own.sessionId)).get()!;
  expect(row.invalidatedAt).toBeInstanceOf(Date);
  expect(await getSessionFromToken(fixture.db, fixture.own.token)).toBeNull();
  await expectLive(fixture.sameUser.token, fixture.otherUser.token);
  const invalidatedAt = row.invalidatedAt;
  await expectOk(await post(`orca_session=${fixture.own.token}`));
  expect(fixture.db.select().from(sessions).where(eq(sessions.id, fixture.own.sessionId)).get()!.invalidatedAt).toEqual(invalidatedAt);
});

for (const kind of ["missing", "empty", "malformed", "forged signature", "expired token", "expired row", "already invalidated"] as const) {
  test(`idempotent/no oracle: ${kind} cookie returns success and clears the cookie`, async () => {
    let token: string | undefined;
    if (kind === "empty") token = "";
    if (kind === "malformed") token = "not-a-token";
    if (kind === "forged signature") {
      const parts = fixture.own.token.split(".");
      parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
      token = parts.join(".");
    }
    if (kind === "expired token") token = (await createSession(fixture.db, "one", -60_000)).token;
    if (kind === "expired row") {
      const expired = await createSession(fixture.db, "one");
      fixture.db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, expired.sessionId)).run();
      token = expired.token;
    }
    if (kind === "already invalidated") {
      const invalidated = await createSession(fixture.db, "one");
      invalidateSession(fixture.db, invalidated.sessionId);
      token = invalidated.token;
    }
    const before = fixture.db.select().from(sessions).all();
    await expectOk(await post(token === undefined ? undefined : `orca_session=${token}`));
    expect(fixture.db.select().from(sessions).all()).toEqual(before);
    await expectLive(fixture.own.token, fixture.sameUser.token, fixture.otherUser.token);
  });
}

test("only own session: ignores body, query, session headers and Authorization bearer", async () => {
  const init = {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${fixture.otherUser.token}`,
      "x-session-id": fixture.otherUser.sessionId,
      "session-id": fixture.otherUser.sessionId,
    },
    body: JSON.stringify({ sessionId: fixture.otherUser.sessionId, token: fixture.otherUser.token }),
  };
  const path = `/api/auth/logout?sessionId=${fixture.otherUser.sessionId}&token=${fixture.otherUser.token}`;
  await expectOk(await post(undefined, path, init));
  await expectLive(fixture.own.token, fixture.sameUser.token, fixture.otherUser.token);
  await expectOk(await post(`orca_session=${fixture.own.token}`, path, init));
  expect(await getSessionFromToken(fixture.db, fixture.own.token)).toBeNull();
  await expectLive(fixture.sameUser.token, fixture.otherUser.token);
});

for (const kind of ["duplicates", "reverse duplicates", "oversized", "control chars", "unicode", "markup", "bad escape"] as const) {
  test(`idempotent/no oracle: hostile cookie ${kind} never invalidates a session`, async () => {
    const token = fixture.own.token;
    const values = {
      duplicates: `orca_session=${token}; orca_session=${fixture.otherUser.token}`,
      "reverse duplicates": `orca_session=bad; orca_session=${token}`,
      oversized: `orca_session=${"a".repeat(100_000)}`,
      "control chars": `orca_session=${token}\u0001`,
      unicode: `orca_session=${token}☃`,
      markup: "orca_session=<script>alert(1)</script>",
      "bad escape": "orca_session=%E0%A4%A",
    };
    // Bypass Fetch's transport header validation to exercise the handler with hostile bytes.
    const request = new Request("http://localhost/api/auth/logout", { method: "POST" });
    const originalGet = request.headers.get.bind(request.headers);
    request.headers.get = (name) => name.toLowerCase() === "cookie" ? values[kind] : originalGet(name);
    await expectOk(await fixture.app.fetch(request));
    await expectLive(fixture.own.token, fixture.sameUser.token, fixture.otherUser.token);
  });
}

test("GET and other methods do not perform logout", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const response = await fixture.app.request("/api/auth/logout", {
      method, headers: { cookie: `orca_session=${fixture.own.token}` },
    });
    expect([404, 405]).toContain(response.status);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expectLive(fixture.own.token, fixture.sameUser.token, fixture.otherUser.token);
  }
});
