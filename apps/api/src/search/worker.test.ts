import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { MailboxScopeError } from "../mailbox/read.ts";
import { initializeSearchBuild, enableSearch } from "./indexing/admin.ts";
import { acquireWriterOwnership } from "./indexing/ownership.ts";
import { acknowledgeReceipt, claimNextJob, enqueueBaseline } from "./indexing/queue.ts";
import { getSearchIndexPath, openCanonicalReadOnly, readSearchControl, readSourceAccounts } from "./indexing/schema.ts";
import { applyIndexJob, publishAccountReady } from "./indexing/worker-core.ts";
import { createRankedSearchExecutor, type RankedSearchExecutionObservation } from "./executor.ts";
import type { RankedSearchInput } from "./read.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("real read worker returns indexed pages and legacy counts through private IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "orca-ranked-worker-")); directories.push(root);
  const path = join(root, "canonical.sqlite");
  const client = createDatabaseClient(path);
  const executor = createRankedSearchExecutor();
  let index: Database | undefined;
  let source: Database | undefined;
  let owner: ReturnType<typeof acquireWriterOwnership> | undefined;
  try {
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    client.db.insert(users).values({ id: "user", email: "user@example.test", displayName: "User" }).run();
    client.db.insert(oauthAccounts).values({ id: "account", userId: "user", provider: "gmail", providerEmail: "user@example.test", providerId: "account" }).run();
    const indexPath = getSearchIndexPath(path); initializeSearchBuild(client.sqlite, indexPath);
    index = new Database(indexPath); index.exec("PRAGMA synchronous=FULL");
    client.sqlite.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
    owner = acquireWriterOwnership(index, indexPath, readSearchControl(client.sqlite));
    const control = readSearchControl(client.sqlite);
    const identity = { sourceId: control.source_id, buildId: control.build_id, ownerToken: owner.token };
    for (const id of ["subject", "body"]) {
      client.db.insert(threads).values({ id: `thread-${id}`, accountId: "account", providerThreadId: id }).run();
      client.db.insert(emails).values({ id, accountId: "account", threadId: `thread-${id}`, providerMessageId: id,
        fromAddress: "sender@example.test", subject: id === "subject" ? "Appointment update" : "A note",
        snippet: "Synthetic fixture", bodyText: id === "body" ? "Appointment details" : null,
        receivedAt: new Date("2026-01-01T12:00:00.000Z") }).run();
    }
    source = openCanonicalReadOnly(path);
    for (const mode of ["metadata", "full"] as const) enqueueBaseline(client.sqlite, "account", mode);
    let job; while ((job = claimNextJob(client.sqlite))) acknowledgeReceipt(client.sqlite, applyIndexJob(source, index, job, identity));
    for (const mode of ["metadata", "full"] as const) {
      const account = readSourceAccounts(client.sqlite, ["account"], mode)[0]!;
      expect(publishAccountReady(source, index, "account", account.incarnation, mode, identity)).toBe(true);
    }
    enableSearch(client.sqlite, index);
    const input: RankedSearchInput = { databasePath: path, authorization: { userId: "user" }, query: { query: "appointment", limit: 10 }, mode: "full", cursorKey: "synthetic-only-cursor-key" };
    const observations: RankedSearchExecutionObservation[] = [];
    const full = await executor.read(input, { observe: observation => observations.push(observation) });
    expect(full.page.messages.map(message => message.id)).toEqual(["subject", "body"]);
    expect(full.page.coverage).toBe("stored-plaintext");
    expect(full.counts).toBeUndefined();
    expect(observations[0]!.readerDurationMs).toBeGreaterThanOrEqual(0);
    if (process.platform === "linux") expect(observations[0]!.peakRssBytes).toBeGreaterThan(0);
    const metadata = await executor.read({ ...input, mode: "metadata", exactCounts: true, query: { ...input.query, limit: 100 } });
    expect(metadata.page.messages.map(message => message.id)).toEqual(["subject"]);
    expect(metadata.counts?.attention.all).toBe(1);
    expect(metadata.page.coverage).toBe("stored-metadata");
    await expect(executor.read({ ...input, authorization: { userId: "unconnected" } })).rejects.toBeInstanceOf(MailboxScopeError);
  } finally {
    await executor.shutdown(); source?.close(); owner?.release(); index?.close(); client.sqlite.close();
  }
});
