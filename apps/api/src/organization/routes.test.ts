import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { createApp } from "../index.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("Organization REST read adapter", () => {
  test("describes and queries only the session Workspace Accounts", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 18).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-routes-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values([
        { id: "workspace_owner", email: "owner@example.com" },
        { id: "workspace_other", email: "other@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider-a" },
        { id: "account_b", userId: "workspace_owner", provider: "outlook", providerEmail: "owner@outlook.example", providerId: "provider-b" },
        { id: "account_private", userId: "workspace_other", provider: "gmail", providerEmail: "private@example.com", providerId: "provider-private" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "source-a", subject: "A", latestReceivedAt: new Date("2026-08-23T12:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_b", accountId: "account_b", providerThreadId: "source-b", subject: "B", latestReceivedAt: new Date("2026-08-23T11:00:00.000Z"), messageCount: 1, isRead: true },
        { id: "thread_private", accountId: "account_private", providerThreadId: "source-private", subject: "Private", latestReceivedAt: new Date("2026-08-23T13:00:00.000Z"), messageCount: 1, isRead: false },
      ]).run();
      db.insert(emails).values([
        { id: "message_a", accountId: "account_a", threadId: "thread_a", providerMessageId: "message-source-a", subject: "A", receivedAt: new Date("2026-08-23T12:00:00.000Z") },
        { id: "message_b", accountId: "account_b", threadId: "thread_b", providerMessageId: "message-source-b", subject: "B", receivedAt: new Date("2026-08-23T11:00:00.000Z"), isRead: true },
        { id: "message_private", accountId: "account_private", threadId: "thread_private", providerMessageId: "message-source-private", subject: "Private", receivedAt: new Date("2026-08-23T13:00:00.000Z") },
      ]).run();
      const session = await createSession(db, "workspace_owner");
      const headers = { cookie: `orca_session=${session.token}` };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });

      const describeResponse = await app.request("/v1/organization/describe", { headers });
      assert.equal(describeResponse.status, 200);
      const description = await describeResponse.json();
      assert.deepEqual(description.accountIds, ["account_a", "account_b"]);
      assert.equal(description.workspaceSchema.aggregate, "thread");
      assert.equal(description.capabilities.operations.simulate, false);
      assert.deepEqual(description.facetSupport.valueTypes, ["text", "number", "boolean", "datetime", "duration", "email", "domain", "enum"]);
      assert.deepEqual(description.facetSupport.workflowStateIndependentOf, ["lane", "subject_matter"]);
      assert.equal(JSON.stringify(description).includes("gmail"), false);

      const workspaceResponse = await app.request("/v1/organization/query?attention=all", { headers });
      assert.equal(workspaceResponse.status, 200);
      const workspace = await workspaceResponse.json();
      assert.deepEqual(workspace.threads.map((thread: { id: string }) => thread.id), ["thread_a", "thread_b"]);
      assert.equal(JSON.stringify(workspace).includes("Private"), false);

      const accountResponse = await app.request("/v1/organization/query?accountId=account_b&attention=all", { headers });
      assert.equal(accountResponse.status, 200);
      assert.deepEqual((await accountResponse.json()).threads.map((thread: { id: string }) => thread.id), ["thread_b"]);

      const denied = await app.request("/v1/organization/query?accountId=account_private&attention=all", { headers });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: { code: "account_denied", message: "The requested Account scope is not authorized" } });
    } finally {
      sqlite.close();
    }
  });

  test("requires authentication and keeps simulate/revert routes disabled", async () => {
    assert.equal((await createApp().request("/v1/organization/describe")).status, 401);

    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-disabled-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values({ id: "workspace_owner", email: "owner@example.com" }).run();
      const session = await createSession(db, "workspace_owner");
      const headers = { cookie: `orca_session=${session.token}` };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });
      for (const operation of ["simulate", "revert"]) {
        const response = await app.request(`/v1/organization/${operation}`, { method: "POST", headers });
        assert.equal(response.status, 405);
        assert.deepEqual(await response.json(), { error: { code: "operation_disabled", message: `Organization ${operation} is disabled in this read-only slice` } });
      }
    } finally {
      sqlite.close();
    }
  });
});
