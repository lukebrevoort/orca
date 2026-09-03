import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { refreshMailboxThroughProvider, startVisibleMailboxRevalidation, type MailboxRevalidationMetric } from "../../web/src/mailbox-revalidation.ts";
import { createSession } from "../src/auth/session-store.ts";
import { createDatabaseClient } from "../src/db/client.ts";
import { emailLabels, humanClassificationOverrides, labels, oauthAccounts, senderAttentionRules, users } from "../src/db/schema.ts";
import { createApp } from "../src/index.ts";
import { createMailboxReader, mailboxReadTargets, type MailboxPageQueryPlan, type MailboxReadMetric } from "../src/mailbox/read.ts";

const SAMPLE_COUNT = Number(Bun.env.MAILBOX_BENCH_SAMPLES ?? 30);
const WARMUP_COUNT = Number(Bun.env.MAILBOX_BENCH_WARMUPS ?? 5);
const FIXTURE_SEED = "BRE-367-v3-two-account-high-association";
const FIXTURE_SIZES = [1_000, 5_000] as const;
const baseTime = Date.parse("2026-09-02T12:00:00.000Z");
process.env.SESSION_SECRET = "BRE-367-benchmark-session-secret-with-32-bytes";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString("base64");

if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1 || !Number.isInteger(WARMUP_COUNT) || WARMUP_COUNT < 0) {
  throw new Error("MAILBOX_BENCH_SAMPLES must be positive and MAILBOX_BENCH_WARMUPS must be non-negative integers");
}

type DatasetResult = {
  fixtureMessages: number;
  samples: number;
  pageSize: number;
  accountCount: number;
  firstPageP95Ms: number;
  firstPageTargetMs: number;
  focusToFreshP95Ms: number;
  focusToFreshTargetMs: number;
  maxPageRowsProjected: number;
  maxPageRowsBound: number;
  maxLabelAssociationRowsLoaded: number;
  maxEffectiveOverridesProjected: number;
  queryPlans: MailboxPageQueryPlan[];
  focusHttpRequests: { status: number; sync: number; inbox: number; total: number };
  coalescedTriggers: number;
  hiddenTriggerRequests: number;
  distinctFocusRevisions: number;
  firstPageSamplesMs: number[];
  focusToFreshSamplesMs: number[];
  passed: boolean;
};

async function createFixture(messageCount: number) {
  const directory = mkdtempSync(join(tmpdir(), `orca-mailbox-bench-${messageCount}-`));
  const dbPath = join(directory, "mailbox.sqlite");
  const client = createDatabaseClient(dbPath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  client.db.insert(users).values({ id: "user", email: "benchmark@example.com", displayName: "Benchmark" }).run();
  const accountIds = ["account-a", "account-b"] as const;
  client.db.insert(oauthAccounts).values(accountIds.map((accountId, index) => ({
    id: accountId,
    userId: "user",
    provider: "gmail" as const,
    providerEmail: `benchmark-${index + 1}@example.com`,
    providerId: `gmail-benchmark-${index + 1}`,
    syncHistoryId: `history-${messageCount}-${index + 1}`,
    // The primary account is the deterministic sync target. Keeping the
    // second account ahead makes aggregate freshness advance with that sync.
    lastSyncedAt: new Date(baseTime + index * 3_600_000),
    createdAt: new Date(baseTime + index),
    updatedAt: new Date(baseTime),
  }))).run();
  const behaviors = ["notify", "focus", "normal", "quiet", "hidden"] as const;
  client.db.insert(senderAttentionRules).values(accountIds.flatMap((accountId) => behaviors.map((behavior, index) => ({
    id: `${accountId}-rule-${behavior}`,
    accountId,
    scope: "domain",
    value: `group-${index}.example`,
    behavior,
    source: "user_choice",
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  })))).run();
  const fixtureLabels = ["benchmark-one", "benchmark-two", "benchmark-three"];
  client.db.insert(labels).values(accountIds.flatMap((accountId) => fixtureLabels.map((name) => ({
    id: `${accountId}-label-${name}`,
    accountId,
    providerLabelId: name.toUpperCase(),
    name,
    type: "user",
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  })))).run();
  client.db.insert(humanClassificationOverrides).values(accountIds.flatMap((accountId) => behaviors.map((_, index) => ({
    id: `${accountId}-override-domain-${index}`,
    accountId,
    targetType: "sender_domain",
    targetValue: `group-${index}.example`,
    classification: "automated_or_bulk",
    source: "user_choice",
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  })))).run();

  const insertThread = client.sqlite.prepare(`
    insert into threads (
      id, account_id, provider_thread_id, subject, latest_received_at,
      message_count, is_read, created_at, updated_at
    ) values (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  const insertEmail = client.sqlite.prepare(`
    insert into emails (
      id, account_id, thread_id, provider_message_id, from_address, from_name,
      subject, snippet, received_at, is_read, human_signal, human_classification,
      human_classification_reasons, human_classifier_version, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'benchmark-v1', ?, ?)`);
  const insertEmailLabel = client.sqlite.prepare(`
    insert into email_labels (id, email_id, label_id, created_at)
    values (?, ?, ?, ?)`);
  const insertOverride = client.sqlite.prepare(`
    insert into human_classification_overrides (
      id, account_id, target_type, target_value, classification, source, created_at, updated_at
    ) values (?, ?, ?, ?, ?, 'user_choice', ?, ?)`);
  client.sqlite.transaction(() => {
    for (let index = 0; index < messageCount; index += 1) {
      const suffix = index.toString().padStart(5, "0");
      const accountId = accountIds[index % accountIds.length]!;
      const timestamp = baseTime - index * 1_000;
      const isHuman = index % 3 !== 0;
      insertThread.run(`thread-${suffix}`, accountId, `provider-thread-${index}`, `Subject ${index}`, timestamp, index % 2, timestamp, baseTime);
      insertEmail.run(
        `message-${suffix}`,
        accountId,
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
      for (const name of fixtureLabels) {
        insertEmailLabel.run(`email-label-${suffix}-${name}`, `message-${suffix}`, `${accountId}-label-${name}`, baseTime);
      }
      insertOverride.run(`override-address-${suffix}`, accountId, "sender_address", `sender-${index}@group-${index % behaviors.length}.example`, "likely_human", baseTime, baseTime);
      insertOverride.run(`override-message-${suffix}`, accountId, "message", `message-${suffix}`, "uncertain", baseTime, baseTime);
    }
  })();

  const session = await createSession(client.db, "user");
  let syncTick = 0;
  const mailboxMetrics: MailboxReadMetric[] = [];
  const app = createApp({
    dbFactory: () => createDatabaseClient(dbPath),
    mailboxReadObserver: (metric) => mailboxMetrics.push(metric),
    syncPage: async (db, input) => {
      syncTick += 1;
      const syncedAt = new Date(baseTime + syncTick);
      db.update(oauthAccounts).set({
        syncHistoryId: `history-${messageCount}-${syncTick}`,
        lastSyncedAt: syncedAt,
        updatedAt: syncedAt,
      }).where(eq(oauthAccounts.id, input.accountId)).run();
      return {
        accountId: input.accountId,
        emailCount: 0,
        threadCount: 0,
        labelCount: 0,
        contactCount: 0,
        nextCursor: null,
        lastSyncedAt: syncedAt.toISOString(),
      };
    },
  });
  return { ...client, authorization: { userId: "user", accountIds }, app, authHeaders: { cookie: `orca_session=${session.token}` }, mailboxMetrics, directory };
}

function percentile95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function rounded(value: number) {
  return Number(value.toFixed(2));
}

async function benchmarkDataset(messageCount: (typeof FIXTURE_SIZES)[number]): Promise<DatasetResult> {
  const fixture = await createFixture(messageCount);
  try {
    const plans: MailboxPageQueryPlan[] = [];
    createMailboxReader(fixture.sqlite, { observePageQueryPlan: (plan) => plans.push(plan) }).read({
      authorization: fixture.authorization,
      query: { view: "all", classification: "all", limit: 100 },
    });
    const inboxPath = "/v1/inbox?view=all&classification=all&limit=100";
    const requestJson = async (path: string, init?: RequestInit) => {
      const response = await fixture.app.request(path, {
        ...init,
        headers: { ...fixture.authHeaders, ...(init?.headers ?? {}) },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
      return payload;
    };
    for (let iteration = 0; iteration < WARMUP_COUNT; iteration += 1) await requestJson(inboxPath);

    const firstPageSamples: number[] = [];
    fixture.mailboxMetrics.length = 0;
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
      const startedAt = performance.now();
      await requestJson(inboxPath);
      firstPageSamples.push(performance.now() - startedAt);
    }

    const focusMetrics: MailboxRevalidationMetric[] = [];
    const focusRevisions: string[] = [];
    const visibilitySource = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const focusRequests = { status: 0, sync: 0, inbox: 0 };
    const refresh = () => refreshMailboxThroughProvider({
      readStatus: async () => {
        focusRequests.status += 1;
        return requestJson("/v1/sync/status");
      },
      sync: async () => {
        focusRequests.sync += 1;
        await requestJson("/v1/sync/gmail", { method: "POST" });
      },
      readInbox: async () => {
        focusRequests.inbox += 1;
        const inbox = await requestJson(inboxPath) as { freshness?: { revision?: string } };
        if (inbox.freshness?.revision) focusRevisions.push(inbox.freshness.revision);
        return inbox;
      },
    });
    const controller = startVisibleMailboxRevalidation({
      load: refresh,
      visibilitySource,
      focusSource: new EventTarget(),
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      observe: (metric) => focusMetrics.push(metric),
    });
    for (let iteration = 0; iteration < WARMUP_COUNT; iteration += 1) await controller.revalidate("focus");
    focusMetrics.length = 0;
    focusRevisions.length = 0;
    focusRequests.status = 0;
    focusRequests.sync = 0;
    focusRequests.inbox = 0;
    visibilitySource.visibilityState = "hidden";
    const beforeHidden = focusRequests.status + focusRequests.sync + focusRequests.inbox;
    await controller.revalidate("focus");
    const hiddenTriggerRequests = focusRequests.status + focusRequests.sync + focusRequests.inbox - beforeHidden;
    visibilitySource.visibilityState = "visible";
    for (let iteration = 0; iteration < SAMPLE_COUNT; iteration += 1) {
      await Promise.all([controller.revalidate("focus"), controller.revalidate("visibility")]);
    }
    controller.stop();

    const focusToFreshSamples = focusMetrics.map((metric) => metric.durationMs);
    const firstPageP95Ms = rounded(percentile95(firstPageSamples));
    const focusToFreshP95Ms = rounded(percentile95(focusToFreshSamples));
    const firstPageTargetMs = mailboxReadTargets.firstPageP95Ms[messageCount];
    const focusToFreshTargetMs = mailboxReadTargets.focusToFreshP95Ms[messageCount];
    const maxPageRowsProjected = Math.max(...fixture.mailboxMetrics.map((metric) => metric.pageRowsProjected));
    const maxPageRowsBound = Math.max(...fixture.mailboxMetrics.map((metric) => metric.maxPageRowsBound));
    const maxLabelAssociationRowsLoaded = Math.max(...fixture.mailboxMetrics.map((metric) => metric.labelAssociationRowsLoaded));
    const maxEffectiveOverridesProjected = Math.max(...fixture.mailboxMetrics.map((metric) => metric.effectiveOverridesProjected));
    const focusHttpRequests = {
      ...focusRequests,
      total: focusRequests.status + focusRequests.sync + focusRequests.inbox,
    };
    const coalescedTriggers = SAMPLE_COUNT * 2 - focusMetrics.length;
    const distinctFocusRevisions = new Set(focusRevisions).size;
    return {
      fixtureMessages: messageCount,
      samples: SAMPLE_COUNT,
      pageSize: 100,
      accountCount: fixture.authorization.accountIds.length,
      firstPageP95Ms,
      firstPageTargetMs,
      focusToFreshP95Ms,
      focusToFreshTargetMs,
      maxPageRowsProjected,
      maxPageRowsBound,
      maxLabelAssociationRowsLoaded,
      maxEffectiveOverridesProjected,
      queryPlans: plans,
      focusHttpRequests,
      coalescedTriggers,
      hiddenTriggerRequests,
      distinctFocusRevisions,
      firstPageSamplesMs: firstPageSamples.map(rounded),
      focusToFreshSamplesMs: focusToFreshSamples.map(rounded),
      passed: firstPageP95Ms <= firstPageTargetMs
        && focusToFreshP95Ms <= focusToFreshTargetMs
        && maxPageRowsProjected <= maxPageRowsBound
        && maxPageRowsBound === fixture.authorization.accountIds.length * 101
        && new Set(plans.map((plan) => plan.accountId)).size === fixture.authorization.accountIds.length
        && plans.every((plan) => plan.details.some((detail) => detail.includes("emails_mailbox_account_page_idx")))
        && plans.every((plan) => plan.details.every((detail) => !detail.includes("USE TEMP B-TREE FOR ORDER BY")))
        && focusMetrics.length === SAMPLE_COUNT
        && focusRequests.status === SAMPLE_COUNT * 2
        && focusRequests.sync === SAMPLE_COUNT
        && focusRequests.inbox === SAMPLE_COUNT
        && distinctFocusRevisions === SAMPLE_COUNT
        && hiddenTriggerRequests === 0,
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
  measurementBoundary: {
    firstPage: "authenticated Hono GET /v1/inbox through SQLite and JSON parsing",
    focusToFresh: ["GET /v1/sync/status", "POST /v1/sync/gmail (deterministic local provider)", "GET /v1/inbox", "GET /v1/sync/status"],
    controller: "visible-tab controller; paired focus + visibility triggers per sample",
  },
  fixtureSeed: FIXTURE_SEED,
  generatedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  host: {
    platform: platform(),
    release: release(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  warmups: WARMUP_COUNT,
  datasets,
  passed: datasets.every((dataset) => dataset.passed),
};
const json = `${JSON.stringify(report, null, 2)}\n`;
console.log(json.trimEnd());
const outputArgument = Bun.argv.find((argument) => argument.startsWith("--output="));
if (outputArgument) writeFileSync(outputArgument.slice("--output=".length), json, "utf8");
if (!report.passed) process.exitCode = 1;
