// Target repo path: apps/api/src/auth/mail-oauth-login.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
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

});
