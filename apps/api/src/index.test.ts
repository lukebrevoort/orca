import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, users } from "./db/schema.ts";
import { app, createApp } from "./index.ts";
import { GmailSyncError } from "./providers/gmail/sync.ts";

describe("Orca API", () => {
  test("requires a session before returning auth state", async () => {
    const response = await app.request("/v1/auth/session");

    assert.equal(response.status, 401);
  });

  test("requires a session before returning an account", async () => {
    const response = await app.request("/v1/me");

    assert.equal(response.status, 401);
  });

  test("requires a session before returning inbox data", async () => {
    const response = await app.request("/v1/inbox");

    assert.equal(response.status, 401);
  });

  test("rejects blank inbox cursors", async () => {
    const response = await app.request("/v1/inbox?cursor=");
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "validation_error");
    assert.equal(body.error.message, "Invalid inbox query parameters");
    assert.equal(body.error.issues.length, 1);
    assert.equal(body.error.issues[0].path, "cursor");
    assert.match(body.error.issues[0].message, /1 character/);
  });

  test("runs the manual Gmail sync endpoint for an authenticated user", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "../drizzle"),
    });

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
        providerId: "gmail-user-1",
      }).run();

      const session = await createSession(db, "user_1");
      const syncCalls: string[] = [];
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        syncPage: async (_db, input) => {
          syncCalls.push(input.accountId);
          return {
            accountId: input.accountId,
            emailCount: 1,
            threadCount: 1,
            labelCount: 2,
            contactCount: 2,
            nextCursor: null,
            lastSyncedAt: "2026-07-08T12:00:00.000Z",
          };
        },
      });

      const response = await testApp.request("/v1/sync/gmail", {
        method: "POST",
        headers: {
          cookie: `orca_session=${session.token}`,
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accountId: "acct_1",
        emailCount: 1,
        threadCount: 1,
        labelCount: 2,
        contactCount: 2,
        nextCursor: null,
        lastSyncedAt: "2026-07-08T12:00:00.000Z",
        pages: 1,
      });
      assert.deepEqual(syncCalls, ["acct_1"]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("reports per-account sync status and last successful sync time", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com", displayName: "Luke" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
        accessTokenEncrypted: "access", refreshTokenEncrypted: "refresh", lastSyncedAt: new Date("2026-07-08T12:00:00.000Z"),
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });

      const response = await testApp.request("/api/sync/status", { headers: { cookie: `orca_session=${session.token}` } });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accounts: [{
          id: "acct_1", provider: "gmail", email: "luke@example.com", displayName: "Luke",
          state: "idle", lastSyncedAt: "2026-07-08T12:00:00.000Z", error: null,
        }],
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("maps provider sync failures to a bounded public error response", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

    const tempDir = mkdtempSync(join(tmpdir(), "orca-index-test-"));
    const dbPath = join(tempDir, "index.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "../drizzle"),
    });

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
        providerId: "gmail-user-1",
      }).run();

      const session = await createSession(db, "user_1");
      const testApp = createApp({
        dbFactory: () => createDatabaseClient(dbPath),
        syncPage: async () => {
          throw new GmailSyncError("raw upstream detail acct_1", "provider_error");
        },
      });

      const response = await testApp.request("/v1/sync/gmail", {
        method: "POST",
        headers: {
          cookie: `orca_session=${session.token}`,
        },
      });

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: {
          code: "provider_error",
          message: "Gmail sync is temporarily unavailable",
        },
      });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });
});
