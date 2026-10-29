import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { createDatabaseClient } from "../db/client.ts";
import { sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs, sessionCookieName } from "./config.ts";
import { isPendingSessionUser, requireAuth, type AuthVariables } from "./middleware.ts";
import * as sessionStore from "./session-store.ts";
import { createMobileSession } from "./mobile/store.ts";
import { createGmailAuthApp } from "./gmail/routes.ts";
import { createOutlookAuthApp } from "./outlook/routes.ts";

let dir: string;
let previousSecret: string | undefined;
let previousKey: string | undefined;
const dbFactory = () => createDatabaseClient(join(dir, "test.sqlite"));
beforeEach(() => {
  previousSecret = process.env.SESSION_SECRET;
  previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "synthetic-pending-session-secret-0123456789";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "orca-pending-gate-"));
  const client = dbFactory();
  try { migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") }); }
  finally { client.sqlite.close(); }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
  if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
});
async function seed(email = "pending-synthetic@orca.invalid", authenticatedAt: Date | null = null, ttl = 3600_000) {
  const client = dbFactory();
  try {
    const userId = crypto.randomUUID();
    client.db.insert(users).values({ id: userId, email, authenticatedAt }).run();
    return await sessionStore.createSession(client.db, userId, ttl);
  } finally { client.sqlite.close(); }
}
function app(allowPending = false) {
  const app = new Hono<{ Variables: AuthVariables }>();
  // Structural assignment keeps the tests runnable on the pre-option baseline.
  const options = { dbFactory, allowPending };
  app.get("/protected", requireAuth(options), (c) => c.json({ userId: c.get("auth").userId }));
  return app;
}
function headers(token: string) { return { cookie: `${sessionCookieName}=${token}` }; }
function expiry(sessionId: string) {
  const client = dbFactory();
  try { return client.db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!.expiresAt.getTime(); }
  finally { client.sqlite.close(); }
}

test("pending session cannot use ordinary routes: identical invalid-session response without renewal", async () => {
  const session = await seed();
  const before = expiry(session.sessionId);
  const server = app();
  const invalid = await server.request("/protected", { headers: headers("forged") });
  const pending = await server.request("/protected", { headers: headers(session.token) });
  expect(pending.status).toBe(401);
  expect(pending.status).toBe(invalid.status);
  expect(await pending.json()).toEqual(await invalid.json());
  expect([...pending.headers]).toEqual([...invalid.headers]);
  expect(pending.headers.get("set-cookie")).toBeNull();
  expect(expiry(session.sessionId)).toBe(before);
});

test("callback opt-out accepts the same pending cookie", async () => {
  const session = await seed();
  const response = await app(true).request("/protected", { headers: headers(session.token) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: session.userId });
});

for (const email of ["pending-real@orca.invalid", "pending-%@orca.invalid", "pending-_@orca.invalid", "pending-人@orca.invalid", "ｐending-x@orca.invalid", "owner@example.test"]) {
  test(`real users with lookalike emails are not blocked: ${email}`, async () => {
    const session = await seed(email, new Date());
    expect((await app().request("/protected", { headers: headers(session.token) })).status).toBe(200);
  });
}

for (const { email, onboardingCompletedAt } of [
  { email: "legacy@example.test", onboardingCompletedAt: null },
  { email: "legacy@example.test", onboardingCompletedAt: new Date("2026-01-01T00:00:00Z") },
  { email: "pending-x@orca.invalid.example.test", onboardingCompletedAt: null },
  { email: "xpending-x@orca.invalid", onboardingCompletedAt: null },
  { email: "pending@orca.invalid", onboardingCompletedAt: null },
  { email: "pendingx@orca.invalid", onboardingCompletedAt: null },
]) {
  test(`marker-less real user is not pending: ${email}, onboarding ${onboardingCompletedAt ? "complete" : "incomplete"}`, async () => {
    const session = await seed(email, null);
    const client = dbFactory();
    try {
      client.db.update(users).set({ onboardingCompletedAt }).where(eq(users.id, session.userId)).run();
      expect(isPendingSessionUser(client.db, session.userId)).toBe(false);
    } finally { client.sqlite.close(); }
    const server = new Hono<{ Variables: AuthVariables }>();
    server.get("/protected", requireAuth({ dbFactory }), (c) => c.json({ userId: c.get("auth").userId }));
    const response = await server.request("/protected", { headers: headers(session.token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: session.userId });
  });
}

test("uppercase placeholder follows the shared isPendingUser predicate", async () => {
  const session = await seed("PENDING-x@ORCA.INVALID");
  expect(typeof isPendingSessionUser).toBe("function");
  const client = dbFactory();
  let pending: boolean;
  try { pending = isPendingSessionUser(client.db, session.userId); }
  finally { client.sqlite.close(); }
  expect((await app().request("/protected", { headers: headers(session.token) })).status).toBe(pending ? 401 : 200);
});

test("promotion accepts the pre-existing session and renews it for thirty days", async () => {
  const session = await seed();
  expect((await app().request("/protected", { headers: headers(session.token) })).status).toBe(401);
  const client = dbFactory();
  try { client.db.update(users).set({ authenticatedAt: new Date() }).where(eq(users.id, session.userId)).run(); }
  finally { client.sqlite.close(); }
  const before = Date.now();
  const response = await app().request("/protected", { headers: headers(session.token) });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain(sessionCookieName + "=");
  expect(expiry(session.sessionId)).toBeGreaterThanOrEqual(before + defaultSessionTtlMs - 1000);
  expect(expiry(session.sessionId)).toBeLessThanOrEqual(Date.now() + defaultSessionTtlMs);
});

test("mobile bearer remains accepted for a pending-shaped unauthenticated user", async () => {
  const session = await seed();
  const client = dbFactory();
  let token: string;
  try { token = createMobileSession(client.db, session.userId).accessToken; }
  finally { client.sqlite.close(); }
  const response = await app().request("/protected", { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId: session.userId });
  expect(response.headers.get("set-cookie")).toBeNull();
});

for (const provider of ["gmail", "outlook"] as const) {
  test(`${provider} real wiring: callback opt-out while pending connect is rejected`, async () => {
    const common = {
      clientId: "synthetic-client", clientSecret: "synthetic-secret",
      redirectUri: `http://localhost:3000/v1/auth/${provider}/callback`,
      scopes: ["openid", "email"], tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      stateSecret: "synthetic-state-secret", successRedirectUrl: null, errorRedirectUrl: null,
      webOrigin: "http://localhost:5173",
    };
    const fetch = async () => { throw new Error("no network expected"); };
    const server = provider === "gmail"
      ? createGmailAuthApp({ dbFactory, fetch, config: { ...common, composeScopes: ["https://www.googleapis.com/auth/gmail.compose"] } })
      : createOutlookAuthApp({ dbFactory, fetch, config: { ...common, tenant: "common" } });
    const login = await server.request("/login");
    expect(login.status).toBe(200);
    const { state } = await login.json() as { state: string };
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const callback = await server.request(`/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("reason=provider_error");
    expect((await server.request("/connect", { headers: { cookie } })).status).toBe(401);
    if (provider === "gmail") expect((await server.request("/upgrade", { headers: { cookie } })).status).toBe(401);
  });
}
