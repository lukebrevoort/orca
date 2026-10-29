import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs } from "./config.ts";
import { createSession, renewSession } from "./session-store.ts";
import * as sessionStore from "./session-store.ts";
import { verifySessionToken } from "./jwt.ts";

const shortTtl = 1000 * 60 * 15;
const hour = 1000 * 60 * 60;
let client: ReturnType<typeof createDatabaseClient>;
let previousSecret: string | undefined;
let previousKey: string | undefined;
beforeEach(() => {
  previousSecret = process.env.SESSION_SECRET;
  previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "pending-login-session-test-secret-long-enough";
  client = createDatabaseClient(":memory:");
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
});
afterEach(() => {
  setSystemTime();
  client.sqlite.close();
  if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});
function seed(id: string, email = `pending-${id}@orca.invalid`, extra: Partial<typeof users.$inferInsert> = {}) {
  client.db.insert(users).values({ id, email, ...extra }).run();
}
async function expectTtl(action: () => Promise<{ expiresAt: Date } | null>, ttl: number) {
  const before = Date.now();
  const result = await action();
  const after = Date.now();
  expect(result).not.toBeNull();
  expect(result!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttl);
  expect(result!.expiresAt.getTime()).toBeLessThanOrEqual(after + ttl);
}

describe("pending login sessions", () => {
  test("purge is bounded", async () => {
    const batch = sessionStore.stalePendingPurgeBatchSize;
    const old = new Date(Date.now() - 2 * hour);
    // Keep the baseline runnable before the exported limit exists.
    const count = (batch ?? 100) + 25;
    for (let i = 0; i < count; i++) seed(`stale-${i}`, undefined, { createdAt: old });
    seed("current", undefined, { createdAt: old });
    seed("owner", undefined, { createdAt: old });
    seed("authenticated", undefined, { createdAt: old, authenticatedAt: old });
    seed("onboarded", undefined, { createdAt: old, onboardingCompletedAt: old });
    seed("young", undefined, { createdAt: new Date(Date.now() - hour / 2) });
    seed("real", "real@example.test", { createdAt: old });
    client.db.insert(oauthAccounts).values({ id: "oauth", userId: "owner", provider: "gmail", providerId: "owner", providerEmail: "owner@example.test" }).run();
    const protectedRows = client.db.select().from(users).all().filter(row => !row.id.startsWith("stale-"));
    await createSession(client.db, "current");
    expect(client.db.select().from(users).all().filter(row => row.id.startsWith("stale-"))).toHaveLength(25);
    expect(batch).toBe(100);
    expect(client.db.select().from(users).all().filter(row => !row.id.startsWith("stale-"))).toEqual(protectedRows);
    await createSession(client.db, "current");
    expect(client.db.select().from(users).all()).toEqual(protectedRows.filter(row => row.id !== "onboarded"));
  });
  test("onboarded junk is purged while protected users are kept", async () => {
    const now = Date.now();
    const old = new Date(now - 2 * hour);
    seed("current");
    seed("onboarded", undefined, { createdAt: old, onboardingCompletedAt: old });
    seed("owner", undefined, { createdAt: old, onboardingCompletedAt: old });
    seed("authenticated", undefined, { createdAt: old, authenticatedAt: old });
    seed("authenticated-onboarded", undefined, { createdAt: old, authenticatedAt: old, onboardingCompletedAt: old });
    seed("young-onboarded", undefined, { createdAt: new Date(now - hour / 2), onboardingCompletedAt: old });
    seed("real", "real@example.test", { createdAt: old, onboardingCompletedAt: old });
    client.db.insert(oauthAccounts).values({ id: "oauth", userId: "owner", provider: "gmail", providerId: "owner", providerEmail: "owner@example.test" }).run();
    const protectedRows = client.db.select().from(users).all().filter(row => row.id !== "onboarded");
    await createSession(client.db, "current");
    expect(client.db.select().from(users).where(eq(users.id, "onboarded")).get()).toBeUndefined();
    expect(client.db.select().from(users).all()).toEqual(protectedRows);
    expect(client.db.select().from(oauthAccounts).all()).toHaveLength(1);
  });
  test("cap boundary rejects equality and renews one millisecond before the cap", async () => {
    const now = Date.now();
    setSystemTime(now);
    seed("pending");
    const session = await createSession(client.db, "pending", hour);
    client.db.update(sessions).set({ createdAt: new Date(now - sessionStore.pendingSessionMaxAgeMs) }).where(eq(sessions.id, session.sessionId)).run();
    const before = client.db.select().from(sessions).all();
    expect(await renewSession(client.db, session)).toBeNull();
    expect(client.db.select().from(sessions).all()).toEqual(before);
    client.db.update(sessions).set({ createdAt: new Date(now - sessionStore.pendingSessionMaxAgeMs + 1) }).where(eq(sessions.id, session.sessionId)).run();
    const renewed = await renewSession(client.db, session);
    expect(renewed).not.toBeNull();
    expect(renewed!.expiresAt.getTime()).toBe(now + 1);
    expect(client.db.select().from(sessions).where(eq(sessions.id, session.sessionId)).get()?.expiresAt).toEqual(new Date(now + 1));
  });
  test("purge age boundary keeps equality and purges one millisecond older", async () => {
    const now = Date.now();
    setSystemTime(now);
    seed("current");
    seed("boundary", undefined, { createdAt: new Date(now - hour) });
    seed("older", undefined, { createdAt: new Date(now - hour - 1) });
    const boundary = client.db.select().from(users).where(eq(users.id, "boundary")).get();
    await createSession(client.db, "current");
    expect(client.db.select().from(users).where(eq(users.id, "boundary")).get()).toEqual(boundary);
    expect(client.db.select().from(users).where(eq(users.id, "older")).get()).toBeUndefined();
  });
  test("missing session record returns null and creates no row", async () => {
    seed("pending");
    expect(await renewSession(client.db, { sessionId: "missing", userId: "pending" })).toBeNull();
    expect(client.db.select().from(sessions).all()).toEqual([]);
  });
  test("purge failure never fails login", async () => {
    seed("current");
    const db = new Proxy(client.db, {
      get(target, property, receiver) {
        if (property === "delete") return () => { throw new Error("synthetic purge failure"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const output: unknown[][] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map(method =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => { output.push(args); }));
    try {
      const before = Date.now();
      const session = await createSession(db, "current");
      expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(before + shortTtl);
      expect(session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + shortTtl);
      expect(client.db.select().from(sessions).where(eq(sessions.id, session.sessionId)).get()?.expiresAt).toEqual(session.expiresAt);
      expect((await verifySessionToken(session.token)).sessionId).toBe(session.sessionId);
      expect(output).toEqual([]);
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });
  test("pending session cannot renew past cap", async () => {
    seed("pending");
    const session = await createSession(client.db, "pending", hour);
    const createdAt = new Date(Date.now() - 50 * 60 * 1000);
    client.db.update(sessions).set({ createdAt }).where(eq(sessions.id, session.sessionId)).run();
    const renewed = await renewSession(client.db, session);
    expect(renewed?.expiresAt.getTime()).toBe(createdAt.getTime() + hour);
    expect(sessionStore.pendingSessionMaxAgeMs).toBe(hour);
    expect(client.db.select().from(sessions).where(eq(sessions.id, session.sessionId)).get()?.expiresAt).toEqual(renewed!.expiresAt);
    client.db.update(sessions).set({ createdAt: new Date(Date.now() - 61 * 60 * 1000) }).where(eq(sessions.id, session.sessionId)).run();
    const before = client.db.select().from(sessions).where(eq(sessions.id, session.sessionId)).get();
    expect(await renewSession(client.db, session)).toBeNull();
    expect(client.db.select().from(sessions).where(eq(sessions.id, session.sessionId)).get()).toEqual(before);
  });
  test("pending renewal cap preserves fresh, authenticated and explicit TTL sessions", async () => {
    seed("pending");
    const fresh = await createSession(client.db, "pending");
    await expectTtl(() => renewSession(client.db, fresh), shortTtl);
    seed("authenticated", undefined, { authenticatedAt: new Date() });
    const real = await createSession(client.db, "authenticated");
    client.db.update(sessions).set({ createdAt: new Date(Date.now() - 2 * hour) }).where(eq(sessions.id, real.sessionId)).run();
    await expectTtl(() => renewSession(client.db, real), defaultSessionTtlMs);
    await expectTtl(() => createSession(client.db, "pending", 1234567), 1234567);
    client.db.update(sessions).set({ createdAt: new Date(Date.now() - 2 * hour) }).where(eq(sessions.id, fresh.sessionId)).run();
    await expectTtl(() => renewSession(client.db, fresh, 2345678), 2345678);
  });
  test("pending TTL is 15 minutes", async () => {
    seed("pending");
    await expectTtl(() => createSession(client.db, "pending"), shortTtl);
  });
  test("non-pending TTL is 30 days", async () => {
    seed("real", "real@example.test");
    await expectTtl(() => createSession(client.db, "real"), defaultSessionTtlMs);
  });
  for (const email of [
    "pending-real@orca.invalid",
    "pending-%@orca.invalid",
    "pending-_@orca.invalid",
    "pending-%_雪@orca.invalid",
  ]) {
    test(`authenticated user is never short-lived on creation (${email})`, async () => {
      seed("real", email, { authenticatedAt: new Date() });
      await expectTtl(() => createSession(client.db, "real"), defaultSessionTtlMs);
    });
    test(`authenticated user is never short-lived on renewal (${email})`, async () => {
      seed("real", email, { authenticatedAt: new Date() });
      const session = await createSession(client.db, "real", hour);
      await expectTtl(() => renewSession(client.db, session), defaultSessionTtlMs);
    });
    test(`authenticated placeholder-shaped user does not trigger stale purge (${email})`, async () => {
      seed("stale", undefined, { createdAt: new Date(Date.now() - 2 * hour) });
      seed("real", email, { authenticatedAt: new Date() });
      const stale = client.db.select().from(users).where(eq(users.id, "stale")).get();
      await createSession(client.db, "real");
      expect(client.db.select().from(users).where(eq(users.id, "stale")).get()).toEqual(stale);
    });
    test(`unauthenticated placeholder stays short-lived even after onboarding (${email})`, async () => {
      seed("pending", email, { authenticatedAt: null, onboardingCompletedAt: new Date() });
      await expectTtl(() => createSession(client.db, "pending"), shortTtl);
      const session = await createSession(client.db, "pending", hour);
      await expectTtl(() => renewSession(client.db, session), shortTtl);
    });
  }
  test("explicit TTL is honored for creation and renewal", async () => {
    seed("pending");
    await expectTtl(() => createSession(client.db, "pending", 1234567), 1234567);
    const session = await createSession(client.db, "pending", hour);
    await expectTtl(() => renewSession(client.db, session, 2345678), 2345678);
  });
  test("renewal keeps pending sessions short and gives real users 30 days", async () => {
    seed("pending");
    seed("real", "real@example.test");
    const pending = await createSession(client.db, "pending", hour);
    const real = await createSession(client.db, "real", hour);
    await expectTtl(() => renewSession(client.db, pending), shortTtl);
    await expectTtl(() => renewSession(client.db, real), defaultSessionTtlMs);
  });
  test("promoted ex-pending user renewal gives 30 days", async () => {
    seed("promoted");
    const session = await createSession(client.db, "promoted");
    client.db.update(users).set({ email: "promoted@example.test" }).where(eq(users.id, "promoted")).run();
    await expectTtl(() => renewSession(client.db, session), defaultSessionTtlMs);
  });
  test("purge is anchored and bounded and cascades stale placeholder rows", async () => {
    const old = new Date(Date.now() - 2 * hour);
    seed("stale", undefined, { createdAt: old });
    seed("current", undefined, { createdAt: old });
    seed("fresh", undefined, { createdAt: new Date(Date.now() - hour / 2) });
    seed("real", "real@example.test", { createdAt: old });
    const lookalikes = ["pending@orca.invalid", "pendingx@orca.invalid", "xpending-x@orca.invalid", "pending-x@orca.invalid.example.test"];
    lookalikes.forEach((email, i) => seed(`lookalike-${i}`, email, { createdAt: old }));
    seed("authenticated", undefined, { createdAt: old, authenticatedAt: old });
    seed("onboarded", undefined, { createdAt: old, onboardingCompletedAt: old });
    client.db.insert(sessions).values({ id: "stale-session", userId: "stale", expiresAt: new Date(Date.now() + hour) }).run();
    await createSession(client.db, "current");
    expect(client.db.select().from(users).all().map(row => row.id).sort()).toEqual([
      "current", "fresh", "real", "authenticated", ...lookalikes.map((_, i) => `lookalike-${i}`),
    ].sort());
    expect(client.db.select().from(sessions).where(eq(sessions.id, "stale-session")).all()).toHaveLength(0);
    expect(client.db.select().from(oauthAccounts).all()).toHaveLength(0);
  });
  for (const providerId of ["p1", "%_\"'雪"]) {
    test(`never deletes an account with a provider row (${providerId})`, async () => {
      const old = new Date(Date.now() - 2 * hour);
      seed("owner", undefined, { createdAt: old });
      seed("unconnected", undefined, { createdAt: old });
      seed("current");
      for (const userId of ["owner", "unconnected"]) {
        client.db.insert(sessions).values({ id: `${userId}-session`, userId, expiresAt: new Date(Date.now() + hour) }).run();
      }
      client.db.insert(oauthAccounts).values({ id: "owned-oauth", userId: "owner", provider: "gmail", providerId, providerEmail: "owner@example.test" }).run();
      const owner = client.db.select().from(users).where(eq(users.id, "owner")).get();
      const session = client.db.select().from(sessions).where(eq(sessions.id, "owner-session")).get();
      const account = client.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "owned-oauth")).get();

      await createSession(client.db, "current");

      expect(client.db.select().from(users).where(eq(users.id, "owner")).get()).toEqual(owner);
      expect(client.db.select().from(sessions).where(eq(sessions.id, "owner-session")).get()).toEqual(session);
      expect(client.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "owned-oauth")).get()).toEqual(account);
      expect(client.db.select().from(users).where(eq(users.id, "unconnected")).all()).toHaveLength(0);
      expect(client.db.select().from(sessions).where(eq(sessions.id, "unconnected-session")).all()).toHaveLength(0);
    });
    test(`a provider row belonging to a different user does not protect a stale placeholder (${providerId})`, async () => {
      seed("stale", undefined, { createdAt: new Date(Date.now() - 2 * hour) });
      seed("other", "other@example.test");
      seed("current");
      client.db.insert(sessions).values({ id: "stale-session", userId: "stale", expiresAt: new Date(Date.now() + hour) }).run();
      client.db.insert(oauthAccounts).values({ id: "other-oauth", userId: "other", provider: "gmail", providerId, providerEmail: "other@example.test" }).run();
      const account = client.db.select().from(oauthAccounts).all();

      await createSession(client.db, "current");

      expect(client.db.select().from(users).where(eq(users.id, "stale")).all()).toHaveLength(0);
      expect(client.db.select().from(sessions).where(eq(sessions.id, "stale-session")).all()).toHaveLength(0);
      expect(client.db.select().from(users).where(eq(users.id, "other")).all()).toHaveLength(1);
      expect(client.db.select().from(oauthAccounts).all()).toEqual(account);
    });
  }
  test("hostile input with %, _, quotes and unicode does not widen purge", async () => {
    const old = new Date(Date.now() - 2 * hour);
    const hostile = "%_\"'雪";
    seed(hostile, `pending-${hostile}@orca.invalid`, { createdAt: old });
    seed("stale", `pending-other${hostile}@orca.invalid`, { createdAt: old });
    seed("safe", `${hostile}@example.test`, { createdAt: old });
    seed("lookalike", `pending${hostile}@orca.invalid`, { createdAt: old });
    await expectTtl(() => createSession(client.db, hostile), shortTtl);
    expect(client.db.select().from(users).all().map(row => row.id).sort()).toEqual([hostile, "safe", "lookalike"].sort());
  });
  test("creating a real user session does not trigger purge", async () => {
    seed("stale", undefined, { createdAt: new Date(Date.now() - 2 * hour) });
    seed("real", "real@example.test");
    await createSession(client.db, "real");
    expect(client.db.select().from(users).all()).toHaveLength(2);
  });
});
