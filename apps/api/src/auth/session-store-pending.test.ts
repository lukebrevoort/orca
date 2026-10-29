import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs } from "./config.ts";
import { createSession, renewSession } from "./session-store.ts";

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
      "current", "fresh", "real", "authenticated", "onboarded", ...lookalikes.map((_, i) => `lookalike-${i}`),
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
