import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { refreshThreadAggregates } from "./thread-aggregate.ts";

describe("Organization Thread aggregate sync adapter", () => {
  test("refreshes aggregate truth only inside the explicit Account scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-thread-aggregate-"));
    const { db, sqlite } = createDatabaseClient(join(directory, "aggregate.sqlite"));
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values({ id: "workspace", email: "owner@example.com" }).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "workspace", provider: "gmail", providerEmail: "a@example.com", providerId: "a" },
        { id: "account_b", userId: "workspace", provider: "gmail", providerEmail: "b@example.com", providerId: "b" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "a", subject: "stale-a", messageCount: 0, isRead: true },
        { id: "thread_b", accountId: "account_b", providerThreadId: "b", subject: "stale-b", messageCount: 99, isRead: false },
      ]).run();
      db.insert(emails).values([
        { id: "a1", accountId: "account_a", threadId: "thread_a", providerMessageId: "a1", subject: "Earlier", receivedAt: new Date("2026-08-23T10:00:00.000Z"), isRead: true },
        { id: "a2", accountId: "account_a", threadId: "thread_a", providerMessageId: "a2", subject: "Latest", receivedAt: new Date("2026-08-23T11:00:00.000Z"), isRead: false },
        { id: "b1", accountId: "account_b", threadId: "thread_b", providerMessageId: "b1", subject: "Private latest", receivedAt: new Date("2026-08-23T12:00:00.000Z"), isRead: true },
      ]).run();

      refreshThreadAggregates(db, {
        accountId: "account_a",
        threadIds: ["thread_a", "thread_b"],
        now: new Date("2026-08-23T13:00:00.000Z"),
      });

      const owned = db.select().from(threads).where(eq(threads.id, "thread_a")).get()!;
      assert.equal(owned.subject, "Latest");
      assert.equal(owned.messageCount, 2);
      assert.equal(owned.isRead, false);
      assert.equal(owned.latestReceivedAt?.toISOString(), "2026-08-23T11:00:00.000Z");
      const other = db.select().from(threads).where(eq(threads.id, "thread_b")).get()!;
      assert.equal(other.subject, "stale-b");
      assert.equal(other.messageCount, 99);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
