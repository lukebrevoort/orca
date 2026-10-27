// Target repo path: apps/api/src/auth/mail-oauth-login.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createApp } from "../index.ts";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { createSession } from "./session-store.ts";
import { completeMailOAuthLogin } from "./mail-oauth-login.ts";

import { createMobileSession } from "./mobile/store.ts";
import { mobileSessions } from "./mobile/schema.ts";

const clients: ReturnType<typeof createDatabaseClient>[] = [];
afterEach(() => { while (clients.length) clients.pop()!.sqlite.close(); });

const env = { ...process.env };
let dir = "";
beforeAll(() => {
  process.env.SESSION_SECRET ??= "synthetic-session-secret-0123456789abcdef";
  process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "orca-mail-login-"));
});
afterAll(() => { process.env = env; rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function freshDb() {
  const client = createDatabaseClient(join(dir, `db-${++n}.sqlite`));
  clients.push(client);
  const { db } = client;
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  db.insert(users).values({ id: "existing", email: "a@example.test", authenticatedAt: new Date() }).run();
  db.insert(oauthAccounts).values({ id: "existing_gmail", userId: "existing", provider: "gmail", providerEmail: "a@example.test", providerId: "google-A", scope: "", accessTokenEncrypted: "enc" }).run();
  return db;
}
async function startLogin(db: ReturnType<typeof freshDb>, provider: "gmail" | "outlook", providerId: string, email: string) {
  const userId = `pend_${n}_${providerId}`; const pendingEmail = `pending-${userId}@orca.invalid`;
  db.insert(users).values({ id: userId, email: pendingEmail }).run();
  const s = await createSession(db, userId);
  db.insert(oauthAccounts).values({ id: `acct_${userId}`, userId, provider, providerEmail: email, providerId, scope: "", accessTokenEncrypted: "enc" }).run();
  return { userId, sessionId: s.sessionId, pendingEmail, provider, providerEmail: email, providerAccountId: providerId };
}

describe("completeMailOAuthLogin identity binding", () => {
  test("different provider identity with a colliding email is refused", async () => {
    const db = freshDb();
    const input = await startLogin(db, "outlook", "ms-B", "a@example.test");
    const r = completeMailOAuthLogin(db, input);
    expect(r).toEqual({ ok: false, reason: "account_exists" });
    expect(db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, "existing")).all().map((a) => a.providerId)).toEqual(["google-A"]);
    expect(db.select().from(users).where(eq(users.id, input.userId)).get()).toBeUndefined();
    expect(db.select().from(sessions).where(eq(sessions.userId, input.userId)).all()).toEqual([]);
    expect(db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, input.userId)).all()).toEqual([]);
  });

  test("same provider, different account id, colliding email is refused", async () => {
    const db = freshDb();
    const r = completeMailOAuthLogin(db, await startLogin(db, "gmail", "google-RECYCLED", "a@example.test"));
    expect(r).toEqual({ ok: false, reason: "account_exists" });
  });

  test("control: same provider + account id returns the same user", async () => {
    const db = freshDb();
    const r = completeMailOAuthLogin(db, await startLogin(db, "gmail", "google-A", "a@example.test"));
    expect(r).toEqual({ ok: true, returningUserId: "existing" });
  });

  test("control: same provider + account id with a changed email still returns the same user", async () => {
    const db = freshDb();
    const r = completeMailOAuthLogin(db, await startLogin(db, "gmail", "google-A", "renamed@example.test"));
    expect(r).toEqual({ ok: true, returningUserId: "existing" });
  });

  test("control: new identity with a new email becomes a new user", async () => {
    const db = freshDb();
    const input = await startLogin(db, "outlook", "ms-C", "c@example.test");
    expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: null });
    expect(db.select().from(users).where(eq(users.id, input.userId)).get()?.email).toBe("c@example.test");
  });
  for (const email of ["A@example.test", " a@example.test ", "", "x".repeat(10_000)]) {
    test(`email comparison remains exact for boundary input of length ${email.length}`, async () => {
      const db = freshDb();
      const input = await startLogin(db, "outlook", "ms-boundary", email);
      expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: null });
      expect(db.select().from(users).where(eq(users.id, input.userId)).get()?.email).toBe(email);
    });
  }

  test("identity match ignores an email belonging to another user", async () => {
    const db = freshDb();
    db.insert(users).values({ id: "other", email: "other@example.test" }).run();
    const input = await startLogin(db, "gmail", "google-A", "other@example.test");
    expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: "existing" });
    expect(db.select().from(users).where(eq(users.id, "existing")).get()?.email).toBe("a@example.test");
    expect(db.select().from(users).where(eq(users.id, "other")).get()?.email).toBe("other@example.test");
  });

  test("mobile pending login refusal removes both mobile and browser sessions", async () => {
    const db = freshDb();
    const input = await startLogin(db, "outlook", "ms-mobile", "a@example.test");
    const mobile = createMobileSession(db, input.userId);
    expect(completeMailOAuthLogin(db, { ...input, sessionId: mobile.sessionId })).toEqual({ ok: false, reason: "account_exists" });
    expect(db.select().from(users).where(eq(users.id, input.userId)).get()).toBeUndefined();
    expect(db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, input.userId)).all()).toEqual([]);
    expect(db.select().from(sessions).where(eq(sessions.userId, input.userId)).all()).toEqual([]);
    expect(db.select().from(mobileSessions).where(eq(mobileSessions.userId, input.userId)).all()).toEqual([]);
  });

  test("stale session retains its reasonless failure", async () => {
    const db = freshDb();
    const input = await startLogin(db, "outlook", "ms-stale", "a@example.test");
    db.delete(sessions).where(eq(sessions.id, input.sessionId)).run();
    expect(completeMailOAuthLogin(db, input)).toEqual({ ok: false });
    expect(db.select().from(users).where(eq(users.id, input.userId)).get()).toBeTruthy();
  });

  test("pending users never count as owner after a stale login", async () => {
    const db = freshDb();
    db.delete(oauthAccounts).where(eq(oauthAccounts.userId, "existing")).run();
    const stale = await startLogin(db, "gmail", "google-A", "a@example.test");
    db.delete(sessions).where(eq(sessions.id, stale.sessionId)).run();
    expect(completeMailOAuthLogin(db, stale)).toEqual({ ok: false });
    expect(db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, stale.userId)).all()).toHaveLength(1);
    db.insert(oauthAccounts).values({ id: "existing_gmail", userId: "existing", provider: "gmail", providerId: "google-A", providerEmail: "a@example.test", scope: "" }).run();
    const next = await startLogin(db, "gmail", "next-tab", "a@example.test");
    db.update(oauthAccounts).set({ providerId: "google-A" }).where(eq(oauthAccounts.userId, next.userId)).run();
    expect(completeMailOAuthLogin(db, { ...next, providerAccountId: "google-A" })).toEqual({ ok: true, returningUserId: "existing" });
  });

  test("pending users never count as owner during overlapping logins", async () => {
    const db = freshDb();
    const first = await startLogin(db, "gmail", "google-new", "new@example.test");
    const second = await startLogin(db, "gmail", "second-tab", "new@example.test");
    db.update(oauthAccounts).set({ providerId: "google-new" }).where(eq(oauthAccounts.userId, second.userId)).run();
    expect(completeMailOAuthLogin(db, first)).toEqual({ ok: true, returningUserId: null });
    expect(db.select().from(users).where(eq(users.id, first.userId)).get()?.authenticatedAt).toBeInstanceOf(Date);
    expect(completeMailOAuthLogin(db, { ...second, providerAccountId: "google-new" })).toEqual({ ok: true, returningUserId: first.userId });
    expect(db.select().from(users).where(eq(users.id, second.userId)).get()).toBeUndefined();
  });

  for (const equalDates of [false, true]) {
    test(`deterministic owner choice uses ${equalDates ? "id for equal dates" : "earliest createdAt"}`, async () => {
      const db = freshDb();
      db.update(oauthAccounts).set({ createdAt: new Date(2000) }).where(eq(oauthAccounts.id, "existing_gmail")).run();
      db.insert(users).values({ id: "other", email: "other@example.test", onboardingCompletedAt: new Date() }).run();
      db.insert(oauthAccounts).values({ id: equalDates ? "a_other" : "z_other", userId: "other", provider: "gmail", providerId: "google-A", providerEmail: "other@example.test", scope: "", createdAt: new Date(equalDates ? 2000 : 1000) }).run();
      expect(completeMailOAuthLogin(db, await startLogin(db, "gmail", "google-A", "a@example.test"))).toEqual({ ok: true, returningUserId: "other" });
    });
  }

  test("provider must match even when provider account ids are equal", async () => {
    const db = freshDb();
    const input = await startLogin(db, "outlook", "google-A", "new@example.test");
    expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: null });
    expect(db.select().from(users).where(eq(users.id, input.userId)).get()?.email).toBe("new@example.test");
  });

  for (const providerId of ["", "' OR 1=1 --", "<script>", "x".repeat(10_000)]) {
    test(`unmatched provider account boundary input of length ${providerId.length} becomes a first signup`, async () => {
      const db = freshDb();
      const input = await startLogin(db, "gmail", providerId, "new@example.test");
      expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: null });
      expect(db.select().from(users).where(eq(users.id, "existing")).get()?.email).toBe("a@example.test");
    });
  }

});

describe("structural mail login owners", () => {
  test("pending users never count as owner even after onboarding/complete", async () => {
    const path = join(dir, `onboarded-pending-${++n}.sqlite`);
    const dbFactory = () => createDatabaseClient(path);
    const client = dbFactory(); clients.push(client);
    const db = client.db;
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    db.insert(users).values({ id: "existing", email: "a@example.test", authenticatedAt: new Date() }).run();
    const stale = await startLogin(db, "gmail", "google-A", "a@example.test");
    db.update(oauthAccounts).set({ createdAt: new Date(1000) }).where(eq(oauthAccounts.userId, stale.userId)).run();
    const session = await createSession(db, stale.userId);
    const response = await createApp({ dbFactory }).request("/v1/auth/onboarding/complete", {
      method: "POST", headers: { cookie: `orca_session=${session.token}`, origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(200);
    expect(db.select().from(users).where(eq(users.id, stale.userId)).get()?.onboardingCompletedAt).toBeInstanceOf(Date);
    db.insert(oauthAccounts).values({ id: "existing_gmail", userId: "existing", provider: "gmail", providerId: "google-A", providerEmail: "a@example.test", scope: "", createdAt: new Date(2000) }).run();
    const next = await startLogin(db, "gmail", "next-tab", "a@example.test");
    db.update(oauthAccounts).set({ providerId: "google-A" }).where(eq(oauthAccounts.userId, next.userId)).run();
    expect(completeMailOAuthLogin(db, { ...next, providerAccountId: "google-A" })).toEqual({ ok: true, returningUserId: "existing" });
  });
  for (const email of ["a@example.test", "renamed@example.test"]) {
    test(`legacy marker-less real user returns by identity with ${email}`, async () => {
      const db = freshDb();
      db.update(users).set({ authenticatedAt: null, onboardingCompletedAt: null }).where(eq(users.id, "existing")).run();
      const input = await startLogin(db, "gmail", "google-A", email);
      expect(completeMailOAuthLogin(db, input)).toEqual({ ok: true, returningUserId: "existing" });
      expect(db.select().from(users).where(eq(users.id, input.userId)).get()).toBeUndefined();
    });
  }
  test("legacy marker-less real user refuses a different identity with the same email", async () => {
    const db = freshDb();
    db.update(users).set({ authenticatedAt: null, onboardingCompletedAt: null }).where(eq(users.id, "existing")).run();
    expect(completeMailOAuthLogin(db, await startLogin(db, "gmail", "different-id", "a@example.test"))).toEqual({ ok: false, reason: "account_exists" });
  });
  for (const email of ["pending-x@orca.invalid", "xpending-x@orca.invalid", "pending-x@orca.invalid.example.test"]) {
    test(`placeholder pattern is anchored for ${email}`, async () => {
      const db = freshDb();
      db.update(users).set({ email }).where(eq(users.id, "existing")).run();
      expect(completeMailOAuthLogin(db, await startLogin(db, "gmail", "google-A", "new@example.test"))).toEqual({
        ok: true, returningUserId: email === "pending-x@orca.invalid" ? null : "existing",
      });
    });
  }
  test("provider placeholder-shaped email is stored but not recognized as an owner later", async () => {
    const db = freshDb();
    const first = await startLogin(db, "gmail", "new-id", "pending-provider@orca.invalid");
    expect(completeMailOAuthLogin(db, first)).toEqual({ ok: true, returningUserId: null });
    const promoted = db.select().from(users).where(eq(users.id, first.userId)).get();
    expect(promoted?.email).toBe("pending-provider@orca.invalid");
    expect(promoted?.authenticatedAt).toBeInstanceOf(Date);
    const next = await startLogin(db, "gmail", "next-tab", "pending-provider@orca.invalid");
    db.update(oauthAccounts).set({ providerId: "new-id" }).where(eq(oauthAccounts.userId, next.userId)).run();
    expect(completeMailOAuthLogin(db, { ...next, providerAccountId: "new-id" })).toEqual({ ok: false, reason: "account_exists" });
    expect(db.select().from(users).where(eq(users.id, first.userId)).get()).toEqual(promoted);
  });
});
