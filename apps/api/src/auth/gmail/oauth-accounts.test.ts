import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { DatabaseOAuthAccountStore } from "./oauth-accounts.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DatabaseOAuthAccountStore", () => {
  test("upgrades in place while preserving sync state and the latest refresh token", async () => {
    const { dbPath, store } = createStore();
    const { db, sqlite } = createDatabaseClient(dbPath);
    const lastSyncedAt = new Date("2026-07-18T20:00:00.000Z");
    try {
      db.insert(users).values([
        { id: "user_1", email: "luke@example.com" },
        { id: "user_2", email: "other@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        {
          id: "account_1", userId: "user_1", provider: "gmail", providerEmail: "luke@gmail.com", providerId: "google-1",
          accessTokenEncrypted: "read-access", refreshTokenEncrypted: "read-refresh", scope: "https://www.googleapis.com/auth/gmail.readonly",
          syncCursor: "cursor-42", lastSyncedAt,
        },
        {
          id: "account_2", userId: "user_2", provider: "gmail", providerEmail: "other@gmail.com", providerId: "google-2",
          accessTokenEncrypted: "other-access", refreshTokenEncrypted: "other-refresh", scope: "https://www.googleapis.com/auth/gmail.readonly",
        },
      ]).run();
    } finally {
      sqlite.close();
    }

    expect((await store.findForUser("user_1"))?.id).toBe("account_1");
    expect((await store.findById("user_1", "account_1"))?.providerAccountId).toBe("google-1");
    expect(await store.findById("user_1", "account_2")).toBeNull();

    const upgraded = await store.upsert({
      userId: "user_1", provider: "gmail", providerAccountId: "google-1", providerEmail: "luke@gmail.com",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
      encryptedAccessToken: "compose-access", encryptedRefreshToken: null, expiresAt: new Date("2026-07-18T21:00:00.000Z"),
    });
    expect(upgraded.id).toBe("account_1");
    expect(upgraded.encryptedRefreshToken).toBe("read-refresh");

    const verification = createDatabaseClient(dbPath);
    try {
      const row = verification.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "account_1")).get()!;
      expect(row.accessTokenEncrypted).toBe("compose-access");
      expect(row.refreshTokenEncrypted).toBe("read-refresh");
      expect(row.scope).toBe("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose");
      expect(row.syncCursor).toBe("cursor-42");
      expect(row.lastSyncedAt).toEqual(lastSyncedAt);
    } finally {
      verification.sqlite.close();
    }
  });

  test("a later callback without a refresh token cannot erase a newer refresh token", async () => {
    const { dbPath, store } = createStore();
    const { db, sqlite } = createDatabaseClient(dbPath);
    try {
      db.insert(users).values({ id: "user_1", email: "luke@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "account_1", userId: "user_1", provider: "gmail", providerEmail: "luke@gmail.com", providerId: "google-1",
        accessTokenEncrypted: "old-access", refreshTokenEncrypted: "old-refresh", scope: "https://www.googleapis.com/auth/gmail.readonly",
      }).run();
    } finally {
      sqlite.close();
    }

    await store.upsert({
      userId: "user_1", provider: "gmail", providerAccountId: "google-1", providerEmail: "luke@gmail.com",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], encryptedAccessToken: "new-access",
      encryptedRefreshToken: "new-refresh", expiresAt: null,
    });
    await store.upsert({
      userId: "user_1", provider: "gmail", providerAccountId: "google-1", providerEmail: "luke@gmail.com",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"], encryptedAccessToken: "later-access",
      encryptedRefreshToken: null, expiresAt: null,
    });

    expect((await store.findById("user_1", "account_1"))?.encryptedRefreshToken).toBe("new-refresh");
  });
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "orca-oauth-store-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "oauth.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  sqlite.close();
  return { dbPath, store: new DatabaseOAuthAccountStore(() => createDatabaseClient(dbPath)) };
}
