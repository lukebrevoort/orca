import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { gmailSyncJobs, gmailSyncRuns, oauthAccounts } from "../../db/schema.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];
type DatabaseExecutor = Pick<DatabaseClient, "insert" | "select" | "update">;
type DatabaseFactory = typeof createDatabaseClient;

export type GmailSyncSource = "push" | "manual" | "fallback" | "reset";

const sourceBits: Record<GmailSyncSource, number> = {
  push: 1,
  manual: 2,
  fallback: 4,
  reset: 8,
};

export type GmailSyncEnqueueInput = {
  accountId: string;
  source: GmailSyncSource;
  historyId?: string | null;
  fullResync?: boolean;
  freshnessAt?: Date;
};

export type GmailSyncExecutionMetrics = {
  messageCount?: number;
  pageCount?: number;
  providerFetchMs?: number;
  dbPrepareCount?: number;
  dbWriteMs?: number;
};

export type GmailSyncRetryIntent = {
  sources: readonly [GmailSyncSource, ...GmailSyncSource[]];
  historyId: string | null;
  fullResync: boolean;
  freshnessAt: Date;
};

/**
 * A worker committed useful progress but could not complete every requested
 * source. The coordinator records the attempt as failed with its metrics and
 * durably queues only the unfinished intent described by `retry`.
 */
export type GmailSyncPartialFailure = {
  error: Error;
  retry: GmailSyncRetryIntent;
};

export type GmailSyncExecutionResult = GmailSyncExecutionMetrics & Record<string, unknown> & {
  partialFailure?: GmailSyncPartialFailure;
};

export type GmailSyncLeaseGuard = {
  readonly accountId: string;
  readonly owner: string;
  readonly version: number;
  assert(db?: DatabaseExecutor): void;
  renew(): boolean;
};

export type GmailSyncClaim = {
  accountId: string;
  requestVersion: number;
  sources: GmailSyncSource[];
  historyId: string | null;
  fullResync: boolean;
  freshnessAt: Date;
  startedAt: Date;
  lease: GmailSyncLeaseGuard;
};

export type GmailSyncWorker = (claim: GmailSyncClaim) => Promise<GmailSyncExecutionResult>;

export type GmailSyncDrainResult = {
  accountId: string;
  acquired: boolean;
  completed: boolean;
  runs: number;
  result: GmailSyncExecutionResult | null;
  error: unknown;
};

export class GmailSyncLeaseLostError extends Error {
  constructor(readonly accountId: string, readonly version: number) {
    super(`Gmail sync lease ${version} for ${accountId} is no longer owned by this worker`);
    this.name = "GmailSyncLeaseLostError";
  }
}

export class GmailSyncAccountNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`Gmail account ${accountId} was not found`);
    this.name = "GmailSyncAccountNotFoundError";
  }
}

export type GmailSyncCoordinator = ReturnType<typeof createGmailSyncCoordinator>;

/**
 * Durable per-account sync coordinator.
 *
 * SQLite is the authority for ownership. The local in-flight map only avoids
 * redundant calls within one process; lease acquisition, stale takeover, and
 * fencing remain correct when several processes share the database.
 */
export function createGmailSyncCoordinator(options: {
  worker: GmailSyncWorker;
  dbFactory?: DatabaseFactory;
  now?: () => Date;
  ownerId?: string;
  leaseMs?: number;
  retryBaseMs?: number;
  maxClaimsPerDrain?: number;
  logger?: Pick<Console, "error" | "warn">;
}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const now = options.now ?? (() => new Date());
  const ownerId = options.ownerId ?? `gmail-sync:${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(100, options.leaseMs ?? 30_000);
  const retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000);
  const maxClaimsPerDrain = Math.max(1, options.maxClaimsPerDrain ?? 8);
  const logger = options.logger ?? console;
  const localDrains = new Map<string, Promise<GmailSyncDrainResult>>();

  function enqueue(input: GmailSyncEnqueueInput) {
    const requestedAt = now();
    const freshnessAt = earliestDate(input.freshnessAt, requestedAt);
    const { db, sqlite } = dbFactory();
    try {
      return db.transaction((tx) => {
        const account = tx.select({ id: oauthAccounts.id, provider: oauthAccounts.provider })
          .from(oauthAccounts).where(eq(oauthAccounts.id, input.accountId)).get();
        if (!account || account.provider !== "gmail") throw new GmailSyncAccountNotFoundError(input.accountId);

        const existing = tx.select().from(gmailSyncJobs).where(eq(gmailSyncJobs.accountId, input.accountId)).get();
        if (!existing) {
          tx.insert(gmailSyncJobs).values({
            accountId: input.accountId,
            state: "queued",
            requestVersion: 1,
            pendingSources: sourceBits[input.source],
            pendingHistoryId: input.historyId ?? null,
            pendingFullResync: input.fullResync ?? input.source === "reset",
            pendingFreshnessAt: freshnessAt,
            availableAt: requestedAt,
            totalEnqueued: 1,
            createdAt: requestedAt,
            updatedAt: requestedAt,
          }).run();
          return { accountId: input.accountId, coalesced: false, requestVersion: 1, queueDepth: queueDepth(tx) };
        }

        const fullResync = input.fullResync ?? input.source === "reset";
        const coveredByActive = existing.state === "running" && requestCovered({
          source: input.source,
          historyId: input.historyId ?? null,
          fullResync,
          activeSources: existing.activeSources,
          activeHistoryId: existing.activeHistoryId,
          activeFullResync: existing.activeFullResync,
          pendingSources: existing.pendingSources,
          pendingHistoryId: existing.pendingHistoryId,
          pendingFullResync: existing.pendingFullResync,
        });
        const coalesced = existing.state !== "idle";
        const mergeIntoPending = existing.state !== "running" || !coveredByActive;
        const pendingSources = mergeIntoPending
          ? existing.pendingSources | sourceBits[input.source]
          : existing.pendingSources;
        const pendingHistoryId = mergeIntoPending
          ? laterHistoryId(existing.pendingHistoryId, input.historyId ?? null)
          : existing.pendingHistoryId;
        const pendingFullResync = mergeIntoPending
          ? existing.pendingFullResync || fullResync
          : existing.pendingFullResync;
        const pendingFreshnessAt = mergeIntoPending
          ? earliestDate(existing.pendingFreshnessAt, freshnessAt)
          : existing.pendingFreshnessAt;

        tx.update(gmailSyncJobs).set({
          state: existing.state === "idle" ? "queued" : existing.state,
          requestVersion: existing.requestVersion + 1,
          pendingSources,
          pendingHistoryId,
          pendingFullResync,
          pendingFreshnessAt,
          availableAt: existing.state === "idle" ? requestedAt : existing.availableAt,
          coalescedCount: existing.coalescedCount + (coalesced ? 1 : 0),
          totalEnqueued: existing.totalEnqueued + 1,
          lastError: existing.state === "idle" ? null : existing.lastError,
          updatedAt: requestedAt,
        }).where(eq(gmailSyncJobs.accountId, input.accountId)).run();

        return {
          accountId: input.accountId,
          coalesced,
          requestVersion: existing.requestVersion + 1,
          queueDepth: queueDepth(tx),
        };
      });
    } finally {
      sqlite.close();
    }
  }

  async function drainAccount(accountId: string): Promise<GmailSyncDrainResult> {
    const existing = localDrains.get(accountId);
    if (existing) return existing;
    const drain = drainOwned(accountId).finally(() => {
      if (localDrains.get(accountId) === drain) localDrains.delete(accountId);
    });
    localDrains.set(accountId, drain);
    return drain;
  }

  async function drainOwned(accountId: string): Promise<GmailSyncDrainResult> {
    let acquired = false;
    let runs = 0;
    let result: GmailSyncExecutionResult | null = null;
    for (; runs < maxClaimsPerDrain; runs += 1) {
      const claim = acquire(accountId);
      if (!claim) return { accountId, acquired, completed: acquired, runs, result, error: null };
      acquired = true;
      const heartbeat = setInterval(() => claim.lease.renew(), Math.max(25, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      try {
        result = await options.worker(claim);
        claim.lease.assert();
        if (result.partialFailure) {
          fail(claim, result.partialFailure.error, result, result.partialFailure.retry);
          return {
            accountId,
            acquired: true,
            completed: false,
            runs: runs + 1,
            result,
            error: result.partialFailure.error,
          };
        }
        const hasPending = finish(claim, "succeeded", result, null);
        if (!hasPending) return { accountId, acquired: true, completed: true, runs: runs + 1, result, error: null };
      } catch (error) {
        if (!(error instanceof GmailSyncLeaseLostError)) {
          fail(claim, error);
        }
        return { accountId, acquired: true, completed: false, runs: runs + 1, result: null, error };
      } finally {
        clearInterval(heartbeat);
      }
    }
    logger.warn("Gmail sync drain reached its bounded claim limit", { accountId, maxClaimsPerDrain });
    return { accountId, acquired, completed: true, runs, result, error: null };
  }

  function kick(accountId: string): void {
    queueMicrotask(() => {
      void drainAccount(accountId).then((drained) => {
        if (drained.error) logger.error("Gmail sync job failed", { accountId, error: errorName(drained.error) });
      });
    });
  }

  async function drainReady(): Promise<GmailSyncDrainResult[]> {
    const { db, sqlite } = dbFactory();
    let accountIds: string[];
    try {
      const at = now();
      accountIds = db.select({ accountId: gmailSyncJobs.accountId }).from(gmailSyncJobs).where(or(
        and(eq(gmailSyncJobs.state, "queued"), lte(gmailSyncJobs.availableAt, at)),
        and(eq(gmailSyncJobs.state, "running"), lte(gmailSyncJobs.leaseExpiresAt, at)),
      )).orderBy(asc(gmailSyncJobs.availableAt), asc(gmailSyncJobs.accountId)).all().map((row) => row.accountId);
    } finally {
      sqlite.close();
    }
    return Promise.all(accountIds.map((id) => drainAccount(id)));
  }

  function acquire(accountId: string): GmailSyncClaim | null {
    const acquiredAt = now();
    const { db, sqlite } = dbFactory();
    try {
      const claimed = db.transaction((tx) => {
        const job = tx.select().from(gmailSyncJobs).where(and(
          eq(gmailSyncJobs.accountId, accountId),
          or(
            and(eq(gmailSyncJobs.state, "queued"), lte(gmailSyncJobs.availableAt, acquiredAt)),
            and(eq(gmailSyncJobs.state, "running"), lte(gmailSyncJobs.leaseExpiresAt, acquiredAt)),
          ),
        )).get();
        if (!job) return null;

        const staleTakeover = job.state === "running";
        const sources = (staleTakeover ? job.activeSources : 0) | job.pendingSources;
        if (sources === 0) return null;
        const historyId = laterHistoryId(staleTakeover ? job.activeHistoryId : null, job.pendingHistoryId);
        const fullResync = (staleTakeover && job.activeFullResync) || job.pendingFullResync;
        const freshnessAt = earliestDate(
          staleTakeover ? job.activeFreshnessAt : null,
          job.pendingFreshnessAt,
          acquiredAt,
        );
        const leaseVersion = job.leaseVersion + 1;
        const leaseExpiresAt = new Date(acquiredAt.getTime() + leaseMs);
        const updated = tx.update(gmailSyncJobs).set({
          state: "running",
          activeSources: sources,
          activeHistoryId: historyId,
          activeFullResync: fullResync,
          activeFreshnessAt: freshnessAt,
          pendingSources: 0,
          pendingHistoryId: null,
          pendingFullResync: false,
          pendingFreshnessAt: null,
          leaseOwner: ownerId,
          leaseVersion,
          leaseExpiresAt,
          attemptCount: job.attemptCount + 1,
          lastStartedAt: acquiredAt,
          lastError: null,
          updatedAt: acquiredAt,
        }).where(and(
          eq(gmailSyncJobs.accountId, accountId),
          eq(gmailSyncJobs.leaseVersion, job.leaseVersion),
          eq(gmailSyncJobs.state, job.state),
        )).returning().get();
        return updated ? { row: updated, freshnessAt, startedAt: acquiredAt } : null;
      });
      if (!claimed) return null;
      const version = claimed.row.leaseVersion;
      const lease: GmailSyncLeaseGuard = {
        accountId,
        owner: ownerId,
        version,
        assert(executor) {
          assertLease(executor ?? null, accountId, version);
        },
        renew() {
          return renewLease(accountId, version);
        },
      };
      return {
        accountId,
        requestVersion: claimed.row.requestVersion,
        sources: decodeSources(claimed.row.activeSources),
        historyId: claimed.row.activeHistoryId,
        fullResync: claimed.row.activeFullResync,
        freshnessAt: claimed.freshnessAt,
        startedAt: claimed.startedAt,
        lease,
      };
    } finally {
      sqlite.close();
    }
  }

  function assertLease(executor: DatabaseExecutor | null, accountId: string, version: number): void {
    const owned = (db: DatabaseExecutor) => db.select({ accountId: gmailSyncJobs.accountId }).from(gmailSyncJobs).where(and(
      eq(gmailSyncJobs.accountId, accountId),
      eq(gmailSyncJobs.state, "running"),
      eq(gmailSyncJobs.leaseOwner, ownerId),
      eq(gmailSyncJobs.leaseVersion, version),
      gt(gmailSyncJobs.leaseExpiresAt, now()),
    )).get();
    if (executor) {
      if (!owned(executor)) throw new GmailSyncLeaseLostError(accountId, version);
      return;
    }
    const { db, sqlite } = dbFactory();
    try {
      if (!owned(db)) throw new GmailSyncLeaseLostError(accountId, version);
    } finally {
      sqlite.close();
    }
  }

  function renewLease(accountId: string, version: number): boolean {
    const renewedAt = now();
    const { db, sqlite } = dbFactory();
    try {
      const updated = db.update(gmailSyncJobs).set({
        leaseExpiresAt: new Date(renewedAt.getTime() + leaseMs),
        updatedAt: renewedAt,
      }).where(and(
        eq(gmailSyncJobs.accountId, accountId),
        eq(gmailSyncJobs.state, "running"),
        eq(gmailSyncJobs.leaseOwner, ownerId),
        eq(gmailSyncJobs.leaseVersion, version),
        gt(gmailSyncJobs.leaseExpiresAt, renewedAt),
      )).returning({ accountId: gmailSyncJobs.accountId }).get();
      return Boolean(updated);
    } catch {
      return false;
    } finally {
      sqlite.close();
    }
  }

  function finish(
    claim: GmailSyncClaim,
    status: "succeeded" | "failed",
    metrics: GmailSyncExecutionMetrics,
    error: unknown,
  ): boolean {
    const finishedAt = now();
    const { db, sqlite } = dbFactory();
    try {
      return db.transaction((tx) => {
        const job = ownedJob(tx, claim);
        if (!job) throw new GmailSyncLeaseLostError(claim.accountId, claim.lease.version);
        tx.insert(gmailSyncRuns).values({
          id: randomUUID(),
          accountId: claim.accountId,
          requestVersion: claim.requestVersion,
          leaseVersion: claim.lease.version,
          sources: job.activeSources,
          historyId: job.activeHistoryId,
          fullResync: job.activeFullResync,
          status,
          messageCount: Math.max(0, Math.trunc(metrics.messageCount ?? 0)),
          pageCount: Math.max(0, Math.trunc(metrics.pageCount ?? 0)),
          providerFetchMs: milliseconds(metrics.providerFetchMs),
          dbPrepareCount: Math.max(0, Math.trunc(metrics.dbPrepareCount ?? 0)),
          dbWriteMs: milliseconds(metrics.dbWriteMs),
          freshnessMs: Math.max(0, finishedAt.getTime() - claim.freshnessAt.getTime()),
          startedAt: claim.startedAt,
          finishedAt,
          error: errorMessage(error),
        }).run();
        const hasPending = job.pendingSources !== 0;
        tx.update(gmailSyncJobs).set({
          state: hasPending ? "queued" : "idle",
          activeSources: 0,
          activeHistoryId: null,
          activeFullResync: false,
          activeFreshnessAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          availableAt: finishedAt,
          attemptCount: status === "succeeded" ? 0 : job.attemptCount,
          totalRuns: job.totalRuns + 1,
          lastFinishedAt: finishedAt,
          lastError: errorMessage(error),
          updatedAt: finishedAt,
        }).where(and(
          eq(gmailSyncJobs.accountId, claim.accountId),
          eq(gmailSyncJobs.leaseOwner, ownerId),
          eq(gmailSyncJobs.leaseVersion, claim.lease.version),
        )).run();
        return hasPending;
      });
    } finally {
      sqlite.close();
    }
  }

  function fail(
    claim: GmailSyncClaim,
    error: unknown,
    metrics: GmailSyncExecutionMetrics = {},
    retry?: GmailSyncRetryIntent,
  ): void {
    const failedAt = now();
    const { db, sqlite } = dbFactory();
    try {
      db.transaction((tx) => {
        const job = ownedJob(tx, claim);
        if (!job) return;
        const retryDelay = Math.min(60_000, retryBaseMs * 2 ** Math.min(6, Math.max(0, job.attemptCount - 1)));
        tx.insert(gmailSyncRuns).values({
          id: randomUUID(),
          accountId: claim.accountId,
          requestVersion: claim.requestVersion,
          leaseVersion: claim.lease.version,
          sources: job.activeSources,
          historyId: job.activeHistoryId,
          fullResync: job.activeFullResync,
          status: "failed",
          messageCount: Math.max(0, Math.trunc(metrics.messageCount ?? 0)),
          pageCount: Math.max(0, Math.trunc(metrics.pageCount ?? 0)),
          providerFetchMs: milliseconds(metrics.providerFetchMs),
          dbPrepareCount: Math.max(0, Math.trunc(metrics.dbPrepareCount ?? 0)),
          dbWriteMs: milliseconds(metrics.dbWriteMs),
          freshnessMs: Math.max(0, failedAt.getTime() - claim.freshnessAt.getTime()),
          startedAt: claim.startedAt,
          finishedAt: failedAt,
          error: errorMessage(error),
        }).run();
        tx.update(gmailSyncJobs).set({
          state: "queued",
          pendingSources: job.pendingSources | (retry ? encodeSources(retry.sources) : job.activeSources),
          pendingHistoryId: laterHistoryId(job.pendingHistoryId, retry ? retry.historyId : job.activeHistoryId),
          pendingFullResync: job.pendingFullResync || (retry ? retry.fullResync : job.activeFullResync),
          pendingFreshnessAt: earliestDate(
            job.pendingFreshnessAt,
            retry ? retry.freshnessAt : job.activeFreshnessAt,
            failedAt,
          ),
          activeSources: 0,
          activeHistoryId: null,
          activeFullResync: false,
          activeFreshnessAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          availableAt: new Date(failedAt.getTime() + retryDelay),
          totalRuns: job.totalRuns + 1,
          lastFinishedAt: failedAt,
          lastError: errorMessage(error),
          updatedAt: failedAt,
        }).where(and(
          eq(gmailSyncJobs.accountId, claim.accountId),
          eq(gmailSyncJobs.leaseOwner, ownerId),
          eq(gmailSyncJobs.leaseVersion, claim.lease.version),
        )).run();
      });
    } finally {
      sqlite.close();
    }
  }

  function snapshot(accountId?: string) {
    const { db, sqlite } = dbFactory();
    try {
      const jobs = accountId
        ? db.select().from(gmailSyncJobs).where(eq(gmailSyncJobs.accountId, accountId)).all()
        : db.select().from(gmailSyncJobs).orderBy(asc(gmailSyncJobs.accountId)).all();
      const runs = accountId
        ? db.select().from(gmailSyncRuns).where(eq(gmailSyncRuns.accountId, accountId)).orderBy(asc(gmailSyncRuns.finishedAt)).all()
        : db.select().from(gmailSyncRuns).orderBy(asc(gmailSyncRuns.finishedAt)).all();
      return { queueDepth: queueDepth(db), jobs, runs };
    } finally {
      sqlite.close();
    }
  }

  /** Account-bounded live status read; intentionally excludes immutable run history. */
  function jobsForAccounts(accountIds: readonly string[]) {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return [];
    const { db, sqlite } = dbFactory();
    try {
      return db.select().from(gmailSyncJobs)
        .where(inArray(gmailSyncJobs.accountId, ids))
        .orderBy(asc(gmailSyncJobs.accountId))
        .all();
    } finally {
      sqlite.close();
    }
  }

  function ownedJob(db: DatabaseExecutor, claim: GmailSyncClaim) {
    return db.select().from(gmailSyncJobs).where(and(
      eq(gmailSyncJobs.accountId, claim.accountId),
      eq(gmailSyncJobs.state, "running"),
      eq(gmailSyncJobs.leaseOwner, ownerId),
      eq(gmailSyncJobs.leaseVersion, claim.lease.version),
      gt(gmailSyncJobs.leaseExpiresAt, now()),
    )).get();
  }

  return { enqueue, drainAccount, drainReady, kick, snapshot, jobsForAccounts, ownerId };
}

function queueDepth(db: DatabaseExecutor): number {
  return Number(db.select({ count: sql<number>`count(*)` }).from(gmailSyncJobs)
    .where(or(eq(gmailSyncJobs.state, "queued"), eq(gmailSyncJobs.state, "running"))).get()?.count ?? 0);
}

function requestCovered(input: {
  source: GmailSyncSource;
  historyId: string | null;
  fullResync: boolean;
  activeSources: number;
  activeHistoryId: string | null;
  activeFullResync: boolean;
  pendingSources: number;
  pendingHistoryId: string | null;
  pendingFullResync: boolean;
}): boolean {
  if (input.fullResync) return input.activeFullResync || input.pendingFullResync;
  if (input.source === "fallback") {
    return ((input.activeSources | input.pendingSources) & sourceBits.fallback) !== 0;
  }
  if (input.source !== "push") return input.activeSources !== 0 || input.pendingSources !== 0;
  if (!input.historyId) return true;
  const coveredHistory = laterHistoryId(input.activeHistoryId, input.pendingHistoryId);
  return coveredHistory !== null && compareHistoryIds(input.historyId, coveredHistory) <= 0;
}

function decodeSources(mask: number): GmailSyncSource[] {
  return (Object.entries(sourceBits) as Array<[GmailSyncSource, number]>)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([source]) => source);
}

function encodeSources(sources: readonly GmailSyncSource[]): number {
  return sources.reduce((mask, source) => mask | sourceBits[source], 0);
}

function laterHistoryId(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return compareHistoryIds(left, right) >= 0 ? left : right;
}

function compareHistoryIds(left: string, right: string): number {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function earliestDate(...values: Array<Date | null | undefined>): Date {
  const timestamps = values.filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime()).filter(Number.isFinite);
  return new Date(Math.min(...timestamps));
}

function milliseconds(value: number | undefined): number {
  return Math.max(0, Math.round(value ?? 0));
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : error === null || error === undefined ? null : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "GmailSyncWorkerError";
}
