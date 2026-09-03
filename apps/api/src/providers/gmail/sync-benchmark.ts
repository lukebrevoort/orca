import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createGmailSyncCoordinator } from "./sync-coordinator.ts";
import { persistGmailMessages } from "./sync.ts";
import type { GmailMessage } from "./types.ts";

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const outputPath = Bun.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const samples = positiveInteger(Bun.argv.find((arg) => arg.startsWith("--samples="))?.slice("--samples=".length), 5);
const sizes = (Bun.argv.find((arg) => arg.startsWith("--sizes="))?.slice("--sizes=".length) ?? "25,250")
  .split(",").map((value) => positiveInteger(value, 0)).filter((value) => value > 0);
const directory = mkdtempSync(join(tmpdir(), "orca-sync-benchmark-"));

try {
  const batchResults = [];
  for (const size of sizes) {
    const runs = [];
    for (let sample = 0; sample < samples; sample += 1) runs.push(await benchmarkBatch(size, sample));
    batchResults.push({ size, samples: runs, summary: summarize(runs) });
  }
  const triggerResult = await benchmarkTriggers();
  const report = {
    ticket: "BRE-368",
    generatedAt: new Date().toISOString(),
    runtime: `Bun ${Bun.version}`,
    samples,
    batches: batchResults,
    concurrentTriggers: triggerResult,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await Bun.write(outputPath, json);
  process.stdout.write(json);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

async function benchmarkBatch(size: number, sample: number) {
  const client = createDatabaseClient(join(directory, `batch-${size}-${sample}.sqlite`));
  try {
    migrate(client.db, { migrationsFolder });
    seedAccount(client, `account-${size}-${sample}`);
    const gmailMessages = buildMessages(size);
    const prepareCounter = installPrepareCounter(client.sqlite);
    const startedAt = performance.now();
    const first = await persistGmailMessages(client.db, {
      accountId: `account-${size}-${sample}`,
      accountEmail: "benchmark@example.com",
      gmailMessages,
      labelList: [{ id: "INBOX", name: "Inbox" }, { id: "UNREAD", name: "Unread" }],
      now: new Date("2026-09-02T12:00:00.000Z"),
      propagationTrigger: "sync",
      propagationOptions: { enabled: false },
    });
    const writeMs = performance.now() - startedAt;
    const firstPrepareCount = prepareCounter.count();
    prepareCounter.reset();
    const replayStartedAt = performance.now();
    const replay = await persistGmailMessages(client.db, {
      accountId: `account-${size}-${sample}`,
      accountEmail: "benchmark@example.com",
      gmailMessages,
      labelList: [{ id: "INBOX", name: "Inbox" }, { id: "UNREAD", name: "Unread" }],
      now: new Date("2026-09-02T12:01:00.000Z"),
      propagationTrigger: "sync",
      propagationOptions: { enabled: false },
    });
    const replayMs = performance.now() - replayStartedAt;
    return {
      writeMs: round(writeMs),
      prepareCount: firstPrepareCount,
      changed: first.changedEmailCount,
      replayMs: round(replayMs),
      replayPrepareCount: prepareCounter.count(),
      replayUnchanged: replay.unchangedEmailCount,
    };
  } finally {
    client.sqlite.close();
  }
}

async function benchmarkTriggers() {
  const path = join(directory, "triggers.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder });
  seedAccount(client, "trigger-account");
  const claims: Array<{ historyId: string | null; sources: string[] }> = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const coordinator = createGmailSyncCoordinator({
    dbFactory: () => createDatabaseClient(path),
    worker: async (claim) => {
      claims.push({ historyId: claim.historyId, sources: claim.sources });
      if (claims.length === 1) {
        started();
        await gate;
      }
      return {};
    },
  });
  try {
    const startedAt = performance.now();
    coordinator.enqueue({ accountId: "trigger-account", source: "push", historyId: "100" });
    const drain = coordinator.drainAccount("trigger-account");
    await firstStarted;
    coordinator.enqueue({ accountId: "trigger-account", source: "manual" });
    coordinator.enqueue({ accountId: "trigger-account", source: "fallback" });
    coordinator.enqueue({ accountId: "trigger-account", source: "push", historyId: "100" });
    coordinator.enqueue({ accountId: "trigger-account", source: "push", historyId: "101" });
    release();
    const drained = await drain;
    const snapshot = coordinator.snapshot("trigger-account");
    return {
      durationMs: round(performance.now() - startedAt),
      runs: drained.runs,
      claims,
      coalescedCount: snapshot.jobs[0]?.coalescedCount ?? 0,
      totalEnqueued: snapshot.jobs[0]?.totalEnqueued ?? 0,
      finalQueueDepth: snapshot.queueDepth,
    };
  } finally {
    client.sqlite.close();
  }
}

function seedAccount(client: ReturnType<typeof createDatabaseClient>, accountId: string) {
  const userId = `user-${accountId}`;
  client.db.insert(users).values({ id: userId, email: `${userId}@example.com` }).run();
  client.db.insert(oauthAccounts).values({
    id: accountId,
    userId,
    provider: "gmail",
    providerEmail: "benchmark@example.com",
    providerId: `provider-${accountId}`,
  }).run();
}

function buildMessages(count: number): GmailMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    threadId: `thread-${index}`,
    internalDate: String(Date.UTC(2026, 8, 2, 12, 0, index)),
    labelIds: ["INBOX", ...(index % 2 === 0 ? ["UNREAD"] : [])],
    snippet: `Benchmark ${index}`,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Sender ${index} <sender-${index}@example.com>` },
        { name: "To", value: "Benchmark <benchmark@example.com>" },
        { name: "Subject", value: `Benchmark ${index}` },
      ],
      body: { data: Buffer.from(`Benchmark body ${index}`).toString("base64") },
    },
  }));
}

function installPrepareCounter(sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]) {
  let prepares = 0;
  const original = sqlite.prepare.bind(sqlite);
  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value(query: string) {
      prepares += 1;
      return original(query);
    },
  });
  return { count: () => prepares, reset: () => { prepares = 0; } };
}

function summarize(runs: Array<{ writeMs: number; prepareCount: number; replayMs: number; replayPrepareCount: number }>) {
  return {
    writeMsMedian: median(runs.map(({ writeMs }) => writeMs)),
    prepareCountMedian: median(runs.map(({ prepareCount }) => prepareCount)),
    replayMsMedian: median(runs.map(({ replayMs }) => replayMs)),
    replayPrepareCountMedian: median(runs.map(({ replayPrepareCount }) => replayPrepareCount)),
  };
}

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? round((ordered[middle - 1]! + ordered[middle]!) / 2) : ordered[middle]!;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
