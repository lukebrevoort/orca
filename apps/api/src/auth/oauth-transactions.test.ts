import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { oauthTransactions, sessions, users } from "../db/schema.ts";
import {
  DatabaseOAuthTransactionStore,
  hashOAuthState,
  oauthTransactionRetentionMs,
} from "./oauth-transactions.ts";

describe("provider OAuth transactions", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  test("stores only a minimal pre-authentication transaction and atomically binds consumption", async () => {
    const { dbFactory, cleanup } = migratedDatabase();
    cleanups.push(cleanup);
    const store = new DatabaseOAuthTransactionStore(dbFactory);
    const binding = { sessionId: "oauth_attempt_session_one", userId: "oauth_attempt_user_one" };
    const started = await store.begin({
      provider: "outlook",
      intent: "login",
      ...binding,
      returnTo: "http://localhost:5173/onboarding",
      usePkce: true,
      rateLimitKey: "client-one",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const inspection = dbFactory();
    try {
      expect(inspection.db.select().from(users).all()).toEqual([]);
      expect(inspection.db.select().from(sessions).all()).toEqual([]);
      const row = inspection.db.select().from(oauthTransactions).get();
      expect(row).toMatchObject({ sessionId: binding.sessionId, userId: binding.userId, intent: "login" });
      expect(row?.stateHash).toBe(hashOAuthState(started.state));
      expect(row?.stateHash).not.toBe(started.state);
      expect(row?.codeVerifier).toBe(started.codeVerifier);
    } finally {
      inspection.sqlite.close();
    }

    expect(await store.consume(started.state, "outlook", { sessionId: "other", userId: binding.userId })).toBeNull();
    const consumed = await store.consume(started.state, "outlook", binding);
    expect(consumed?.codeVerifier).toBe(started.codeVerifier);
    expect(await store.consume(started.state, "outlook", binding)).toBeNull();

    const after = dbFactory();
    try {
      expect(after.db.select().from(oauthTransactions).where(eq(oauthTransactions.id, consumed!.id)).get()?.codeVerifier).toBeNull();
    } finally {
      after.sqlite.close();
    }
  });

  test("bounds burst, sustained, and active login starts and cleans retained attempts", async () => {
    const { dbFactory, cleanup } = migratedDatabase();
    cleanups.push(cleanup);
    let now = new Date("2026-08-26T12:00:00.000Z");
    const store = new DatabaseOAuthTransactionStore(dbFactory, () => now, {
      perKeyPerMinute: 2,
      perKeyPerHour: 3,
      globalActive: 3,
      globalPerHour: 4,
    });
    const begin = (rateLimitKey: string) => store.begin({
      provider: "gmail",
      intent: "login",
      sessionId: `session-${crypto.randomUUID()}`,
      userId: `user-${crypto.randomUUID()}`,
      returnTo: null,
      rateLimitKey,
    });

    expect((await begin("client-a")).ok).toBe(true);
    expect((await begin("client-a")).ok).toBe(true);
    expect(await begin("client-a")).toEqual({ ok: false, reason: "rate_limited" });

    now = new Date(now.getTime() + 61_000);
    expect((await begin("client-a")).ok).toBe(true);
    expect(await begin("client-b")).toEqual({ ok: false, reason: "rate_limited" });

    now = new Date(now.getTime() + oauthTransactionRetentionMs + 1);
    expect((await begin("client-a")).ok).toBe(true);
    const inspection = dbFactory();
    try {
      expect(inspection.db.select().from(oauthTransactions).all()).toHaveLength(1);
    } finally {
      inspection.sqlite.close();
    }
  });

  test("consumes connect state only while the exact durable session remains live", async () => {
    const { dbFactory, cleanup } = migratedDatabase();
    cleanups.push(cleanup);
    const store = new DatabaseOAuthTransactionStore(dbFactory);
    const binding = { sessionId: "session-connect", userId: "user-connect" };
    const setup = dbFactory();
    try {
      setup.db.insert(users).values({ id: binding.userId, email: "connect@example.com" }).run();
      setup.db.insert(sessions).values({
        id: binding.sessionId,
        userId: binding.userId,
        expiresAt: new Date(Date.now() + 60_000),
      }).run();
    } finally {
      setup.sqlite.close();
    }

    const started = await store.begin({
      provider: "gmail",
      intent: "connect",
      ...binding,
      returnTo: null,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const invalidated = dbFactory();
    try {
      invalidated.db.update(sessions)
        .set({ invalidatedAt: new Date() })
        .where(eq(sessions.id, binding.sessionId))
        .run();
    } finally {
      invalidated.sqlite.close();
    }

    expect(await store.consume(started.state, "gmail", binding)).toBeNull();
    const inspection = dbFactory();
    try {
      expect(inspection.db.select().from(oauthTransactions).get()?.consumedAt).toBeNull();
    } finally {
      inspection.sqlite.close();
    }
  });
});

function migratedDatabase() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-oauth-transactions-"));
  const dbPath = join(tempDir, "oauth.sqlite");
  const initial = createDatabaseClient(dbPath);
  migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  initial.sqlite.close();
  return {
    dbFactory: () => createDatabaseClient(dbPath),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}
