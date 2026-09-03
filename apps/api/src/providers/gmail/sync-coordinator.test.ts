import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { gmailSyncJobs, gmailSyncRuns, oauthAccounts, users } from "../../db/schema.ts";
import {
  createGmailSyncCoordinator,
  GmailSyncLeaseLostError,
  type GmailSyncClaim,
} from "./sync-coordinator.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");

function setup(accountIds = ["account-a"]) {
  const directory = mkdtempSync(join(tmpdir(), "orca-sync-coordinator-"));
  tempDirs.push(directory);
  const path = join(directory, "coordinator.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder });
  client.db.insert(users).values({ id: "user", email: "user@example.com" }).run();
  client.db.insert(oauthAccounts).values(accountIds.map((id) => ({
    id,
    userId: "user",
    provider: "gmail",
    providerEmail: `${id}@example.com`,
    providerId: id,
  }))).run();
  return { ...client, path, dbFactory: () => createDatabaseClient(path) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable Gmail sync coordinator", () => {
  test("collapses duplicate queued requests and runs the highest history cursor once", async () => {
    const { db, sqlite, dbFactory } = setup();
    const claims: GmailSyncClaim[] = [];
    const coordinator = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "worker-a",
      worker: async (claim) => {
        claims.push(claim);
        return { messageCount: 25, pageCount: 1, providerFetchMs: 12, dbPrepareCount: 18, dbWriteMs: 4 };
      },
    });

    try {
      assert.equal(coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "101" }).coalesced, false);
      assert.equal(coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "101" }).coalesced, true);
      assert.equal(coordinator.enqueue({ accountId: "account-a", source: "manual" }).coalesced, true);
      assert.equal(coordinator.enqueue({ accountId: "account-a", source: "fallback" }).coalesced, true);
      assert.equal(coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "105" }).coalesced, true);

      const drained = await coordinator.drainAccount("account-a");
      assert.equal(drained.completed, true);
      assert.equal(drained.runs, 1);
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.historyId, "105");
      assert.deepEqual(claims[0]?.sources, ["push", "manual", "fallback"]);

      const job = db.select().from(gmailSyncJobs).where(eq(gmailSyncJobs.accountId, "account-a")).get()!;
      assert.equal(job.state, "idle");
      assert.equal(job.coalescedCount, 4);
      assert.equal(job.totalEnqueued, 5);
      assert.equal(job.totalRuns, 1);
      const run = db.select().from(gmailSyncRuns).get()!;
      assert.equal(run.status, "succeeded");
      assert.equal(run.messageCount, 25);
      assert.equal(run.dbPrepareCount, 18);
    } finally {
      sqlite.close();
    }
  });

  test("coalesces concurrent manual and fallback triggers while preserving a newer push", async () => {
    const { sqlite, dbFactory } = setup();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const historyIds: Array<string | null> = [];
    const coordinator = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "combined-worker",
      worker: async (claim) => {
        historyIds.push(claim.historyId);
        if (historyIds.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {};
      },
    });

    try {
      coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "101" });
      const drain = coordinator.drainAccount("account-a");
      await firstStarted.promise;
      coordinator.enqueue({ accountId: "account-a", source: "manual" });
      coordinator.enqueue({ accountId: "account-a", source: "fallback" });
      coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "101" });
      coordinator.enqueue({ accountId: "account-a", source: "push", historyId: "105" });
      releaseFirst.resolve();

      const result = await drain;
      assert.equal(result.runs, 2);
      assert.deepEqual(historyIds, ["101", "105"]);
    } finally {
      sqlite.close();
    }
  });

  test("allows only one lease owner across coordinator instances", async () => {
    const { sqlite, dbFactory } = setup();
    const started = deferred<void>();
    const release = deferred<void>();
    let executions = 0;
    const first = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "process-one",
      worker: async () => {
        executions += 1;
        started.resolve();
        await release.promise;
        return {};
      },
    });
    const second = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "process-two",
      worker: async () => {
        executions += 1;
        return {};
      },
    });

    try {
      first.enqueue({ accountId: "account-a", source: "fallback" });
      const firstDrain = first.drainAccount("account-a");
      await started.promise;
      const secondDrain = await second.drainAccount("account-a");
      assert.equal(secondDrain.acquired, false);
      release.resolve();
      assert.equal((await firstDrain).completed, true);
      assert.equal(executions, 1);
    } finally {
      sqlite.close();
    }
  });

  test("allows only one active worker across Bun processes", async () => {
    const { db, sqlite, path } = setup();
    try {
      sqlite.exec("CREATE TABLE process_sync_executions (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL)");
      const fixture = resolve(import.meta.dir, "sync-coordinator-process-fixture.ts");
      const children = ["child-one", "child-two"].map((owner) => Bun.spawn({
        cmd: [process.execPath, fixture, path, owner],
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      }));
      const exits = await Promise.all(children.map((child) => child.exited));
      if (exits.some((code) => code !== 0)) {
        const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
        assert.fail(`child coordinator failed: ${errors.join("\n")}`);
      }
      assert.equal((db.select().from(gmailSyncRuns).all()).length, 1);
      assert.equal((sqlite.query("SELECT COUNT(*) AS count FROM process_sync_executions").get() as { count: number }).count, 1);
    } finally {
      sqlite.close();
    }
  });

  test("takes over a stale lease after a crash and fences the old owner", async () => {
    const { db, sqlite, dbFactory } = setup();
    let clock = new Date("2026-09-02T00:00:00.000Z");
    const started = deferred<void>();
    const release = deferred<void>();
    const first = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "crashed-process",
      leaseMs: 1_000,
      now: () => clock,
      worker: async () => {
        started.resolve();
        await release.promise;
        return { messageCount: 1 };
      },
    });
    const second = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "recovery-process",
      leaseMs: 1_000,
      now: () => clock,
      worker: async (claim) => {
        claim.lease.assert();
        return { messageCount: 2 };
      },
    });

    try {
      first.enqueue({ accountId: "account-a", source: "push", historyId: "200" });
      const staleDrain = first.drainAccount("account-a");
      await started.promise;
      clock = new Date(clock.getTime() + 2_000);
      const recovered = await second.drainAccount("account-a");
      assert.equal(recovered.completed, true);
      release.resolve();
      const stale = await staleDrain;
      assert.equal(stale.completed, false);
      assert.ok(stale.error instanceof GmailSyncLeaseLostError);
      assert.equal(db.select().from(gmailSyncRuns).all().length, 1);
      assert.equal(db.select().from(gmailSyncJobs).get()?.state, "idle");
    } finally {
      sqlite.close();
    }
  });

  test("requeues a partial failure with bounded backoff and recovers on restart", async () => {
    const { db, sqlite, dbFactory } = setup();
    let clock = new Date("2026-09-02T00:00:00.000Z");
    const failing = createGmailSyncCoordinator({
      dbFactory,
      ownerId: "failing-process",
      retryBaseMs: 50,
      now: () => clock,
      worker: async () => { throw new Error("provider interrupted"); },
    });

    try {
      failing.enqueue({ accountId: "account-a", source: "manual" });
      const failed = await failing.drainAccount("account-a");
      assert.equal(failed.completed, false);
      assert.equal(db.select().from(gmailSyncJobs).get()?.state, "queued");
      assert.equal(db.select().from(gmailSyncRuns).get()?.status, "failed");

      const restarted = createGmailSyncCoordinator({
        dbFactory,
        ownerId: "restarted-process",
        now: () => clock,
        worker: async () => ({ messageCount: 3 }),
      });
      assert.equal((await restarted.drainReady()).length, 0, "backoff prevents a hot retry loop");
      clock = new Date(clock.getTime() + 50);
      const [recovered] = await restarted.drainReady();
      assert.equal(recovered?.completed, true);
      assert.equal(db.select().from(gmailSyncJobs).get()?.state, "idle");
      assert.deepEqual(db.select().from(gmailSyncRuns).all().map((run) => run.status), ["failed", "succeeded"]);
    } finally {
      sqlite.close();
    }
  });

  test("keeps account leases isolated", async () => {
    const { sqlite, dbFactory } = setup(["account-a", "account-b"]);
    const active = new Set<string>();
    let simultaneous = false;
    const gate = deferred<void>();
    const coordinator = createGmailSyncCoordinator({
      dbFactory,
      worker: async ({ accountId }) => {
        active.add(accountId);
        if (active.size === 2) simultaneous = true;
        await gate.promise;
        active.delete(accountId);
        return {};
      },
    });

    try {
      coordinator.enqueue({ accountId: "account-a", source: "fallback" });
      coordinator.enqueue({ accountId: "account-b", source: "fallback" });
      const drains = Promise.all([
        coordinator.drainAccount("account-a"),
        coordinator.drainAccount("account-b"),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      gate.resolve();
      await drains;
      assert.equal(simultaneous, true);
    } finally {
      sqlite.close();
    }
  });

  test("records queue depth, coalescing, and end-to-end freshness from publish time", async () => {
    const { db, sqlite, dbFactory } = setup();
    const clock = new Date("2026-09-02T12:00:05.000Z");
    const coordinator = createGmailSyncCoordinator({
      dbFactory,
      now: () => clock,
      worker: async () => ({ providerFetchMs: 7.4, dbPrepareCount: 12, dbWriteMs: 3.2 }),
    });
    try {
      const first = coordinator.enqueue({
        accountId: "account-a",
        source: "push",
        historyId: "300",
        freshnessAt: new Date("2026-09-02T12:00:00.000Z"),
      });
      assert.equal(first.queueDepth, 1);
      coordinator.enqueue({ accountId: "account-a", source: "manual", freshnessAt: clock });
      await coordinator.drainAccount("account-a");
      const run = db.select().from(gmailSyncRuns).get()!;
      assert.equal(run.freshnessMs, 5_000);
      assert.equal(run.providerFetchMs, 7);
      assert.equal(run.dbPrepareCount, 12);
      assert.equal(run.dbWriteMs, 3);
      assert.equal(coordinator.snapshot().queueDepth, 0);
    } finally {
      sqlite.close();
    }
  });
});
