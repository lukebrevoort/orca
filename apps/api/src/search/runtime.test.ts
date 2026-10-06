import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { initializeSearchBuild } from "./indexing/admin.ts";
import { getSearchIndexPath, readSearchControl } from "./indexing/schema.ts";
import { enqueueBaseline } from "./indexing/queue.ts";
import { createSearchIndexScheduler } from "./runtime.ts";

test("scheduler stays disabled until operator opt-in, drains bounded work and shuts down without enabling reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-search-runtime-"));
  const path = join(directory, "canonical.sqlite"); const indexPath = getSearchIndexPath(path);
  const { db, sqlite } = createDatabaseClient(path);
  let scheduler: ReturnType<typeof createSearchIndexScheduler> | undefined;
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    db.insert(users).values({ id: "user", email: "user@example.test" }).run();
    db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerId: "account", providerEmail: "user@example.test" }).run();
    db.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "thread" }).run();
    db.insert(emails).values({ id: "message", accountId: "account", threadId: "thread", providerMessageId: "message", fromAddress: "sender@example.test", subject: "Synthetic appointment", bodyText: "A small ordinary fixture" }).run();
    scheduler = createSearchIndexScheduler({ databasePath: path, intervalMs: 60_000 });
    await scheduler.start(); await scheduler.stop();
    expect(existsSync(indexPath)).toBe(false);
    expect(sqlite.query("SELECT count(*) n FROM mail_search_outbox").get()).toEqual({ n: 2 });
    initializeSearchBuild(sqlite, indexPath);
    enqueueBaseline(sqlite, "account", "metadata"); enqueueBaseline(sqlite, "account", "full");
    sqlite.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
    scheduler = createSearchIndexScheduler({ databasePath: path, intervalMs: 60_000 });
    await scheduler.start(); await scheduler.stop();
    expect(sqlite.query("SELECT count(*) n FROM mail_search_outbox").get()).toEqual({ n: 0 });
    expect(readSearchControl(sqlite).enabled).toBe(0);
    expect(existsSync(`${indexPath}.writer-lock`)).toBe(false);
  } finally { await scheduler?.stop(); sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
});
