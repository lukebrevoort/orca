import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { Hono } from "hono";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs, getAuthConfig, sessionCookieName, sessionRenewalWindowMs } from "./config.ts";
import { requireAuth, shouldRenewSession, type AuthVariables } from "./middleware.ts";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
} from "./jwt.ts";
import {
  createSession,
  getSessionFromToken,
  invalidateSession,
  readProviderTokens,
  renewSession,
  storeProviderTokens,
} from "./session-store.ts";
import { decryptToken, encryptToken } from "./token-crypto.ts";

function setAuthEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
}

function clearAuthEnv() {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
}

function createMigratedDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "orca-auth-"));
  const dbPath = join(tempDir, "auth.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);

  migrate(db, {
    migrationsFolder: resolve(import.meta.dir, "../../drizzle"),
  });

  return {
    db,
    dbPath,
    sqlite,
    tempDir,
  };
}

afterEach(() => {
  clearAuthEnv();
});

describe("auth foundation", () => {
  test("keeps sessions for 30 days and renews them during active use", async () => {
    setAuthEnv();

    const { db, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
      }).run();

      const session = await createSession(db, "user_1");
      assert.ok(session.expiresAt.getTime() - Date.now() > defaultSessionTtlMs - 5_000);

      const expiring = await createSession(db, "user_1", sessionRenewalWindowMs - 1_000);
      const renewed = await renewSession(db, expiring);

      assert.ok(renewed);
      assert.ok(renewed.expiresAt.getTime() > expiring.expiresAt.getTime());
      assert.deepEqual(await getSessionFromToken(db, renewed.token), {
        sessionId: expiring.sessionId,
        userId: "user_1",
        expiresAt: renewed.expiresAt,
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("does not renew invalidated or expired sessions", async () => {
    setAuthEnv();

    const { db, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
      }).run();

      const invalidated = await createSession(db, "user_1", sessionRenewalWindowMs - 1_000);
      invalidateSession(db, invalidated.sessionId);
      assert.equal(await renewSession(db, invalidated), null);

      const expired = await createSession(db, "user_1", sessionRenewalWindowMs - 1_000);
      db.update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.id, expired.sessionId))
        .run();
      assert.equal(await renewSession(db, expired), null);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("renews through auth middleware and keeps the token out of auth context", async () => {
    setAuthEnv();

    const { db, dbPath, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      const expiring = await createSession(db, "user_1", sessionRenewalWindowMs - 1_000);
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use(
        "*",
        requireAuth({
          dbFactory: () => createDatabaseClient(dbPath),
        }),
      );
      app.get("/protected", (c) => c.json(c.get("auth")));

      const response = await app.request("http://orca.test/protected", {
        headers: {
          cookie: `${sessionCookieName}=${expiring.token}`,
        },
      });

      assert.equal(response.status, 200);
      const cookie = response.headers.get("set-cookie");
      assert.ok(cookie);
      assert.match(cookie, new RegExp(`^${sessionCookieName}=[^;]+; HttpOnly; Path=/; SameSite=Lax;`));
      assert.match(cookie, /Max-Age=\d+/);
      assert.match(cookie, /Expires=/);
      const refreshedToken = cookie.match(new RegExp(`^${sessionCookieName}=([^;]+)`))?.[1];
      assert.ok(refreshedToken);
      assert.notEqual(refreshedToken, expiring.token);

      const auth = await response.json();
      assert.deepEqual(auth, {
        sessionId: expiring.sessionId,
        userId: "user_1",
        expiresAt: (await getSessionFromToken(db, refreshedToken))?.expiresAt.toISOString(),
      });
      assert.equal("token" in auth, false);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects a renewal that did not update a live session and honors the exact renewal boundary", async () => {
    setAuthEnv();

    const { db, dbPath, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
      }).run();

      const now = Date.parse("2026-08-06T00:00:00.000Z");
      assert.equal(shouldRenewSession(new Date(now + sessionRenewalWindowMs), now), true);
      assert.equal(shouldRenewSession(new Date(now + sessionRenewalWindowMs + 1), now), false);

      const expiring = await createSession(db, "user_1", sessionRenewalWindowMs - 1_000);
      invalidateSession(db, expiring.sessionId);

      const app = new Hono<{ Variables: AuthVariables }>();
      app.use(
        "*",
        requireAuth({
          dbFactory: () => createDatabaseClient(dbPath),
          renewSession: async () => null,
        }),
      );
      app.get("/protected", (c) => c.json(c.get("auth")));

      const response = await app.request("http://orca.test/protected", {
        headers: {
          cookie: `${sessionCookieName}=${expiring.token}`,
        },
      });

      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("encrypts and decrypts provider tokens", async () => {
    setAuthEnv();

    const encrypted = await encryptToken("token-value");

    assert.notEqual(encrypted, "token-value");
    assert.equal(await decryptToken(encrypted), "token-value");
  });

  test("persists encrypted provider tokens instead of plaintext", async () => {
    setAuthEnv();

    const { db, dbPath, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      db.insert(oauthAccounts).values({
        id: "acct_1",
        userId: "user_1",
        provider: "gmail",
        providerEmail: "luke@example.com",
        providerId: "gmail-123",
      }).run();

      await storeProviderTokens(db, {
        oauthAccountId: "acct_1",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenExpiry: new Date("2026-07-01T00:00:00.000Z"),
      });

      const raw = sqlite
        .query(
          "select access_token_encrypted, refresh_token_encrypted from oauth_accounts where id = ?1",
        )
        .get("acct_1") as {
        access_token_encrypted: string;
        refresh_token_encrypted: string;
      };

      assert.ok(raw.access_token_encrypted);
      assert.ok(raw.refresh_token_encrypted);
      assert.notEqual(raw.access_token_encrypted, "access-secret");
      assert.notEqual(raw.refresh_token_encrypted, "refresh-secret");

      const decrypted = await readProviderTokens(db, "acct_1");

      assert.deepEqual(decrypted, {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        tokenExpiry: new Date("2026-07-01T00:00:00.000Z"),
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates, resolves, and invalidates sessions", async () => {
    setAuthEnv();

    const { db, dbPath, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      const session = await createSession(db, "user_1", 1000 * 60 * 30);
      const resolved = await getSessionFromToken(db, session.token);

      assert.equal(resolved?.sessionId, session.sessionId);
      assert.equal(resolved?.userId, "user_1");

      invalidateSession(db, session.sessionId);

      const afterInvalidation = await getSessionFromToken(db, session.token);

      assert.equal(afterInvalidation, null);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("auth middleware resolves the current user from the session cookie", async () => {
    setAuthEnv();

    const { db, dbPath, sqlite, tempDir } = createMigratedDb();

    try {
      db.insert(users).values({
        id: "user_1",
        email: "luke@example.com",
        displayName: "Luke",
      }).run();

      const session = await createSession(db, "user_1");

      const app = new Hono<{ Variables: AuthVariables }>();
      app.use(
        "*",
        requireAuth({
          dbFactory: () => createDatabaseClient(dbPath),
        }),
      );
      app.get("/protected", (c) => c.json(c.get("auth")));

      const response = await app.request("http://orca.test/protected", {
        headers: {
          cookie: `${sessionCookieName}=${session.token}`,
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        sessionId: session.sessionId,
        userId: "user_1",
        expiresAt: session.expiresAt.toISOString(),
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("auth middleware returns unauthorized when the cookie is missing", async () => {
    setAuthEnv();

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", requireAuth());
    app.get("/protected", (c) => c.json(c.get("auth")));

    const response = await app.request("http://orca.test/protected");

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: {
        code: "unauthorized",
        message: "Authentication required",
      },
    });
  });

  test("adds secure session cookie attributes by default", () => {
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");

    const sessionCookie = buildSessionCookie("token-value", expiresAt);
    const clearedCookie = buildClearedSessionCookie();

    assert.match(sessionCookie, /; Secure(?:;|$)/);
    assert.match(clearedCookie, /; Secure(?:;|$)/);
  });

  test("allows opting out of secure cookies for local HTTP development", () => {
    const expiresAt = new Date("2026-07-01T00:00:00.000Z");

    const sessionCookie = buildSessionCookie("token-value", expiresAt, { secure: false });
    const clearedCookie = buildClearedSessionCookie({ secure: false });

    assert.doesNotMatch(sessionCookie, /; Secure(?:;|$)/);
    assert.doesNotMatch(clearedCookie, /; Secure(?:;|$)/);
  });

  test("validates missing auth configuration clearly", () => {
    clearAuthEnv();

    assert.throws(() => getAuthConfig(), /SESSION_SECRET/);

    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";

    assert.throws(() => getAuthConfig(), /TOKEN_ENCRYPTION_KEY/);
  });
});
