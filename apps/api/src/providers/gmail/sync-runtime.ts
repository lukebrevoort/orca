import type { Database } from "bun:sqlite";

import { createDatabaseClient } from "../../db/client.ts";
import { createGmailClient, type GmailClient } from "./client.ts";
import { loadGmailPushConfig, type GmailPushConfig } from "./push-config.ts";
import { backfillGmailAccount, ensureGmailWatch, syncGmailAccountHistory } from "./push.ts";
import {
  createGmailSyncCoordinator,
  type GmailSyncClaim,
  type GmailSyncCoordinator,
} from "./sync-coordinator.ts";
import {
  getGmailAccount,
  resetGmailSyncState,
  syncGmailAccountPage,
  type GmailSyncMetricsRecorder,
  type GmailSyncResult,
} from "./sync.ts";

type DatabaseFactory = typeof createDatabaseClient;

export function createDefaultGmailSyncCoordinator(options: {
  dbFactory?: DatabaseFactory;
  gmailClient?: GmailClient;
  config?: GmailPushConfig;
  now?: () => Date;
  syncPage?: typeof syncGmailAccountPage;
  ownerId?: string;
  logger?: Pick<Console, "error" | "warn">;
} = {}): GmailSyncCoordinator {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const gmailClient = options.gmailClient ?? createGmailClient();
  const config = options.config ?? loadGmailPushConfig();
  const now = options.now ?? (() => new Date());
  const syncPage = options.syncPage ?? syncGmailAccountPage;

  return createGmailSyncCoordinator({
    dbFactory,
    now,
    ownerId: options.ownerId,
    logger: options.logger,
    worker: async (claim) => {
      const { db, sqlite } = dbFactory();
      const runtimeMetrics = createRuntimeMetrics();
      const restorePrepare = countPrepares(sqlite, () => { runtimeMetrics.dbPrepareCount += 1; });
      try {
        claim.lease.assert(db);
        if (claim.fullResync) {
          db.transaction((tx) => {
            claim.lease.assert(tx);
            resetGmailSyncState(tx, claim.accountId, now());
          });
          let watch = null;
          let watchError: string | null = null;
          let watchFailure: Error | null = null;
          if (config.topicName && config.verificationToken) {
            try {
              watch = await ensureGmailWatch(db, {
                accountId: claim.accountId,
                gmailClient,
                config,
                now: now(),
                force: true,
                leaseGuard: claim.lease,
                metrics: runtimeMetrics,
              });
            } catch (error) {
              watchFailure = asError(error, "Gmail watch setup failed");
              watchError = watchFailure.message;
            }
          }
          const backfill = await backfillGmailAccount(db, {
            accountId: claim.accountId,
            gmailClient,
            now: now(),
            pageSize: config.backfillPageSize,
            maxPages: config.backfillMaxPages,
            leaseGuard: claim.lease,
            metrics: runtimeMetrics,
          });
          return withWatchOutcome({
            kind: "reset",
            watch,
            watchError,
            backfill,
            messageCount: backfill.emailCount,
            pageCount: backfill.pages,
          }, runtimeMetrics, watchFailure, claim);
        }

        const fallback = claim.sources.includes("fallback");
        let history = null;
        if (claim.historyId) {
          history = await syncGmailAccountHistory(db, {
            accountId: claim.accountId,
            historyId: claim.historyId,
            gmailClient,
            config,
            now: now(),
            pageSize: config.backfillPageSize,
            maxPages: config.backfillMaxPages,
            leaseGuard: claim.lease,
            metrics: runtimeMetrics,
          });
          if (!fallback) {
            return withMetrics({
              kind: "history",
              history,
              messageCount: history.emailCount,
              pageCount: history.usedBackfill ? 1 : 0,
            }, runtimeMetrics);
          }
        }

        const account = getGmailAccount(db, claim.accountId);
        let watch = null;
        let watchError: string | null = null;
        let watchFailure: Error | null = null;
        let forceBackfill = false;
        if (fallback && config.topicName && config.verificationToken) {
          const wasLegacyAccount = !account.syncHistoryId;
          const shouldEnsureWatch = !account.syncHistoryId
            || !account.watchExpirationAt
            || account.watchExpirationAt <= new Date(now().getTime() + config.watchRenewalWindowMs)
            || account.watchTopic !== config.topicName;
          if (shouldEnsureWatch) {
            try {
              watch = await ensureGmailWatch(db, {
                accountId: claim.accountId,
                gmailClient,
                config,
                now: now(),
                leaseGuard: claim.lease,
                metrics: runtimeMetrics,
              });
            } catch (error) {
              watchFailure = asError(error, "Gmail watch setup failed");
              watchError = watchFailure.message;
            }
          }
          forceBackfill = wasLegacyAccount && Boolean(getGmailAccount(db, claim.accountId).syncHistoryId);
        }

        const current = getGmailAccount(db, claim.accountId);
        if (fallback && ((!current.lastSyncedAt && !current.syncCursor) || forceBackfill)) {
          const backfill = await backfillGmailAccount(db, {
            accountId: claim.accountId,
            gmailClient,
            now: now(),
            pageSize: config.backfillPageSize,
            maxPages: config.backfillMaxPages,
            leaseGuard: claim.lease,
            metrics: runtimeMetrics,
          });
          return withWatchOutcome({
            kind: "fallback",
            watch,
            watchError,
            backfill,
            messageCount: backfill.emailCount,
            pageCount: backfill.pages,
          }, runtimeMetrics, watchFailure, claim);
        }

        if (history) {
          return withWatchOutcome({
            kind: "fallback",
            history,
            watch,
            watchError,
            messageCount: history.emailCount,
            pageCount: history.usedBackfill ? 1 : 0,
          }, runtimeMetrics, watchFailure, claim);
        }

        const pages = await syncIncrementalPages({
          db,
          accountId: claim.accountId,
          gmailClient,
          now: now(),
          pageSize: config.backfillPageSize,
          maxPages: config.backfillMaxPages,
          syncPage,
          claim,
          metrics: runtimeMetrics,
        });
        return withWatchOutcome({
          kind: fallback ? "fallback" : "manual",
          watch,
          watchError,
          ...pages,
          messageCount: pages.emailCount,
          pageCount: pages.pages,
        }, runtimeMetrics, watchFailure, claim);
      } finally {
        restorePrepare();
        sqlite.close();
      }
    },
  });
}

async function syncIncrementalPages(input: {
  db: ReturnType<typeof createDatabaseClient>["db"];
  accountId: string;
  gmailClient: GmailClient;
  now: Date;
  pageSize: number;
  maxPages: number;
  syncPage: typeof syncGmailAccountPage;
  claim: GmailSyncClaim;
  metrics: RuntimeMetrics;
}) {
  let result: GmailSyncResult;
  let pages = 0;
  let emailCount = 0;
  let threadCount = 0;
  let labelCount = 0;
  let contactCount = 0;
  do {
    result = await input.syncPage(input.db, {
      accountId: input.accountId,
      gmailClient: input.gmailClient,
      now: input.now,
      pageSize: input.pageSize,
      leaseGuard: input.claim.lease,
      metrics: input.metrics,
    });
    pages += 1;
    emailCount += result.emailCount;
    threadCount += result.threadCount;
    labelCount += result.labelCount;
    contactCount += result.contactCount;
  } while (result.nextCursor && pages < input.maxPages);
  return { ...result, pages, emailCount, threadCount, labelCount, contactCount };
}

type RuntimeMetrics = GmailSyncMetricsRecorder & {
  providerFetchMs: number;
  dbPrepareCount: number;
  dbWriteMs: number;
};

function createRuntimeMetrics(): RuntimeMetrics {
  return {
    providerFetchMs: 0,
    dbPrepareCount: 0,
    dbWriteMs: 0,
    recordProviderFetch(durationMs) { this.providerFetchMs += durationMs; },
    recordDbWrite(durationMs) { this.dbWriteMs += durationMs; },
  };
}

function withMetrics<T extends Record<string, unknown>>(result: T, metrics: RuntimeMetrics) {
  return {
    ...result,
    providerFetchMs: metrics.providerFetchMs,
    dbPrepareCount: metrics.dbPrepareCount,
    dbWriteMs: metrics.dbWriteMs,
  };
}

function withWatchOutcome<T extends Record<string, unknown>>(
  result: T,
  metrics: RuntimeMetrics,
  watchFailure: Error | null,
  claim: GmailSyncClaim,
) {
  const measured = withMetrics(result, metrics);
  if (!watchFailure) return measured;
  return {
    ...measured,
    partialFailure: {
      error: watchFailure,
      retry: {
        sources: ["fallback"] as const,
        historyId: null,
        fullResync: false,
        freshnessAt: claim.freshnessAt,
      },
    },
  };
}

function asError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function countPrepares(sqlite: Database, onPrepare: () => void): () => void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(sqlite, "prepare");
  const original = sqlite.prepare.bind(sqlite);
  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value(query: string) {
      onPrepare();
      return original(query);
    },
  });
  return () => {
    if (ownDescriptor) Object.defineProperty(sqlite, "prepare", ownDescriptor);
    else delete (sqlite as unknown as { prepare?: unknown }).prepare;
  };
}
