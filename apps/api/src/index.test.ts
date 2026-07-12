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

  test("persists account-scoped sender rules, resolves precedence, and resets to the next rule", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-attention-test-"));
    const dbPath = join(tempDir, "attention.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const domainResponse = await testApp.request("/v1/attention/rules", {
        method: "POST", headers,
        body: JSON.stringify({ scope: "domain", value: "Example.COM", behavior: "quiet", source: "user_choice" }),
      });
      assert.equal(domainResponse.status, 200);
      assert.equal((await domainResponse.json()).value, "example.com");

      const addressResponse = await testApp.request("/v1/attention/rules", {
        method: "POST", headers,
        body: JSON.stringify({ scope: "address", value: "Maya@Example.com", behavior: "focus", source: "suggestion_accepted" }),
      });
      const addressRule = await addressResponse.json();
      assert.equal(addressResponse.status, 200);

      const exact = await testApp.request("/v1/attention/resolve?address=maya%40example.com", { headers });
      assert.deepEqual(await exact.json(), {
        behavior: "focus",
        rule: { ...addressRule, value: "maya@example.com" },
      });
      const domain = await testApp.request("/v1/attention/resolve?address=other%40example.com", { headers });
      assert.equal((await domain.json()).behavior, "quiet");

      const reset = await testApp.request(`/v1/attention/rules/${addressRule.id}`, { method: "DELETE", headers });
      assert.equal(reset.status, 204);
      const afterReset = await testApp.request("/v1/attention/resolve?address=maya%40example.com", { headers });
      assert.equal((await afterReset.json()).behavior, "quiet");
      const defaultRule = await testApp.request("/v1/attention/resolve?address=elsewhere%40other.example", { headers });
      assert.deepEqual(await defaultRule.json(), { behavior: "normal", rule: null });
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  test("persists presentation independently of attention behavior", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const tempDir = mkdtempSync(join(tmpdir(), "orca-attention-views-test-"));
    const dbPath = join(tempDir, "views.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });

    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "acct_1", userId: "user_1", provider: "gmail", providerEmail: "luke@example.com", providerId: "gmail-user-1",
      }).run();
      const session = await createSession(db, "user_1");
      const testApp = createApp({ dbFactory: () => createDatabaseClient(dbPath) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };

      const listed = await testApp.request("/v1/attention/view-settings", { headers });
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).length, 5);
      const updated = await testApp.request("/v1/attention/view-settings/normal", {
        method: "PATCH", headers,
        body: JSON.stringify({ displayName: "Everyday", icon: "mail", color: "#123456", position: 0 }),
      });
      assert.deepEqual(await updated.json(), {
        behavior: "normal", displayName: "Everyday", icon: "mail", color: "#123456", position: 0,
      });
      const settings = await testApp.request("/v1/attention/view-settings", { headers });
      const values = await settings.json();
      assert.deepEqual(values.map((value: { behavior: string; position: number }) => [value.behavior, value.position]), [
        ["normal", 0], ["notify", 1], ["focus", 2], ["quiet", 3], ["hidden", 4],
      ]);
    } finally {
      sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
      delete process.env.SESSION_SECRET;
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });
});
