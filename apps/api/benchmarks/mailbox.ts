import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { startVisibleMailboxRevalidation, type MailboxRevalidationMetric } from "../../web/src/mailbox-revalidation.ts";
import { createDatabaseClient } from "../src/db/client.ts";
import { humanClassificationOverrides, oauthAccounts, senderAttentionRules, users } from "../src/db/schema.ts";
import { createMailboxReader, mailboxReadTargets, type MailboxReadAccount } from "../src/mailbox/read.ts";

const SAMPLE_COUNT = Number(Bun.env.MAILBOX_BENCH_SAMPLES ?? 30);
const WARMUP_COUNT = Number(Bun.env.MAILBOX_BENCH_WARMUPS ?? 5);
const FIXTURE_SEED = "BRE-367-v1";
const FIXTURE_SIZES = [1_000, 5_000] as const;
const baseTime = Date.parse("2026-09-02T12:00:00.000Z");

if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1 || !Number.isInteger(WARMUP_COUNT) || WARMUP_COUNT < 0) {
  throw new Error("MAILBOX_BENCH_SAMPLES must be positive and MAILBOX_BENCH_WARMUPS must be non-negative integers");
}

type DatasetResult = {
  fixtureMessages: number;
  samples: number;
  pageSize: number;
  firstPageP95Ms: number;
  firstPageTargetMs: number;
  focusToFreshP95Ms: number;
  focusToFreshTargetMs: number;
  maxProjectedRows: number;
  projectedRowsTarget: number;
  firstPageSamplesMs: number[];
  focusToFreshSamplesMs: number[];
  passed: boolean;
};

function createFixture(messageCount: number) {
  const directory = mkdtempSync(join(tmpdir(), `orca-mailbox-bench-${messageCount}-`));
  const client = createDatabaseClient(join(directory, "mailbox.sqlite"));
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  client.db.insert(users).values({ id: "user", email: "benchmark@example.com", displayName: "Benchmark" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account",
    userId: "user",
    provider: "gmail",
    providerEmail: "benchmark@example.com",
    providerId: "gmail-benchmark",
    syncHistoryId: `history-${messageCount}`,
    lastSyncedAt: new Date(baseTime),
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  }).run();
  const behaviors = ["notify", "focus", "normal", "quiet", "hidden"] as const;
  client.db.insert(senderAttentionRules).values(behaviors.map((behavior, index) => ({
    id: `rule-${behavior}`,
    accountId: "account",
    scope: "domain",
    value: `group-${index}.example`,
    behavior,
    source: "user_choice",
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  }))).run();

  const insertThread = client.sqlite.prepare(`
    insert into threads (
      id, account_id, provider_thread_id, subject, latest_received_at,
      message_count, is_read, created_at, updated_at
    ) values (?, 'account', ?, ?, ?, 1, ?, ?, ?)`);
  const insertEmail = client.sqlite.prepare(`
    insert into emails (
      id, account_id, thread_id, provider_message_id, from_address, from_name,
      subject, snippet, received_at, is_read, human_signal, human_classification,
      human_classification_reasons, human_classifier_version, created_at, updated_at
    ) values (?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'benchmark-v1', ?, ?)`);
  client.sqlite.transaction(() => {
    for (let index = 0; index < messageCount; index += 1) {
      const suffix = index.toString().padStart(5, "0");
      const timestamp = baseTime - index * 1_000;
      const isHuman = index % 3 !== 0;
      insertThread.run(`thread-${suffix}`, `provider-thread-${index}`, `Subject ${index}`, timestamp, index % 2, timestamp, baseTime);
      insertEmail.run(
        `message-${suffix}`,
        `thread-${suffix}`,
        `provider-message-${index}`,
        `sender-${index}@group-${index % behaviors.length}.example`,
        `Sender ${index}`,
        `Subject ${index}`,
        `${FIXTURE_SEED} message ${index}`,
        timestamp,
        index % 2,
        isHuman ? 8 : 2,
        isHuman ? "likely_human" : "automated_or_bulk",
        JSON.stringify([isHuman ? "direct_recipient" : "list_id_header"]),
        timestamp,
        baseTime,
      );
    }
  })();
  client.db.insert(humanClassificationOverrides).values([
    { id: "override-domain", accountId: "account", targetType: "sender_domain", targetValue: "group-0.example", classification: "automated_or_bulk", source: "user_choice", createdAt: new Date(baseTime), updatedAt: new Date(baseTime) },
    { id: "override-address", accountId: "account", targetType: "sender_address", targetValue: "sender-1@group-1.example", classification: "likely_human", source: "user_choice", createdAt: new Date(baseTime), updatedAt: new Date(baseTime) },
    { id: "override-message", accountId: "account", targetType: "message", targetValue: "message-00002", classification: "uncertain", source: "user_choice", createdAt: new Date(baseTime), updatedAt: new Date(baseTime) },
  ]).run();

  const account: MailboxReadAccount = {
    id: "account",
    provider: "gmail",
    syncHistoryId: `history-${messageCount}`,
    lastSyncedAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
    serialized: {
      id: "account",
      provider: "gmail",
      email: "benchmark@example.com",
      displayName: "Benchmark",
      capabilities: { read: true, draft: false, send: false },
    },
  };
  return { ...client, account, directory };
}

function percentile95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function rounded(value: number) {
  return Number(value.toFixed(2));
}

async function benchmarkDataset(messageCount: (typeof FIXTURE_SIZES)[number]): Promise<DatasetResult> {
  const fixture = createFixture(messageCount);
  try {
    const reader = createMailboxReader(fixture.sqlite);
    const read = () => reader.read({
      accounts: [fixture.account],
      query: { view: "all", classification: "all", limit: 100 },
    });
    for (let iteration = 0; iteration < WARMUP_COUNT; iteration += 1) read();

    const firstPageSamples: number[] = [];
    let maxProjectedRows = 0;
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
      const result = read();
      firstPageSamples.push(result.metric.durationMs);
      maxProjectedRows = Math.max(maxProjectedRows, result.metric.projectedRows);
    }

    const focusMetrics: MailboxRevalidationMetric[] = [];
    const visibilitySource = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const controller = startVisibleMailboxRevalidation({
      load: async () => { read(); },
      visibilitySource,
      focusSource: new EventTarget(),
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      observe: (metric) => focusMetrics.push(metric),
    });
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) await controller.revalidate("focus");
    controller.stop();

    const focusToFreshSamples = focusMetrics.map((metric) => metric.durationMs);
    const firstPageP95Ms = rounded(percentile95(firstPageSamples));
    const focusToFreshP95Ms = rounded(percentile95(focusToFreshSamples));
    const firstPageTargetMs = mailboxReadTargets.firstPageP95Ms[messageCount];
    const focusToFreshTargetMs = mailboxReadTargets.focusToFreshP95Ms[messageCount];
    const projectedRowsTarget = 105;
    return {
      fixtureMessages: messageCount,
      samples: SAMPLE_COUNT,
      pageSize: 100,
      firstPageP95Ms,
      firstPageTargetMs,
      focusToFreshP95Ms,
      focusToFreshTargetMs,
      maxProjectedRows,
      projectedRowsTarget,
      firstPageSamplesMs: firstPageSamples.map(rounded),
      focusToFreshSamplesMs: focusToFreshSamples.map(rounded),
      passed: firstPageP95Ms <= firstPageTargetMs
        && focusToFreshP95Ms <= focusToFreshTargetMs
        && maxProjectedRows <= projectedRowsTarget,
    };
  } finally {
    fixture.sqlite.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

const datasets: DatasetResult[] = [];
for (const fixtureSize of FIXTURE_SIZES) datasets.push(await benchmarkDataset(fixtureSize));
const report = {
  benchmark: "BRE-367 bounded mailbox first-page and focus-to-fresh",
  fixtureSeed: FIXTURE_SEED,
  generatedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  warmups: WARMUP_COUNT,
  datasets,
  passed: datasets.every((dataset) => dataset.passed),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
console.log(json.trimEnd());
const outputArgument = Bun.argv.find((argument) => argument.startsWith("--output="));
if (outputArgument) writeFileSync(outputArgument.slice("--output=".length), json, "utf8");
if (!report.passed) process.exitCode = 1;
