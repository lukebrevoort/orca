import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { MailContact, NormalizedMessage } from "@orca/shared";

import type { DeterministicPropagationRuntimeOptions } from "../../agents/propagation/runtime.ts";
import { runDeterministicPropagation } from "../../agents/propagation/runtime.ts";
import { backfillHumanClassifications } from "../../classification/backfill.ts";
import { automaticClassificationColumns, classifyHumanSignal } from "../../classification/human-signal.ts";
import { loadGmailOAuthConfig, type GmailOAuthConfig } from "../../auth/gmail/config.ts";
import { decryptSecret } from "../../auth/gmail/crypto.ts";
import { refreshGmailAccessToken, type FetchLike } from "../../auth/gmail/oauth.ts";
import { readProviderTokens, storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { refreshThreadAggregates } from "../../organization/thread-aggregate.ts";
import { evaluateLiveMessageRules } from "../../organization/rules/evaluation-sqlite.ts";
import {
  contacts,
  emailAttachments,
  emailLabels,
  emails,
  labels,
  oauthAccounts,
  organizationRules,
  threads,
} from "../../db/schema.ts";
import { normalizeGmailLabel, normalizeGmailMessage, type NormalizedGmailMessage } from "./normalizer.ts";
import { createGmailClient, GmailApiError, type GmailClient } from "./client.ts";
import type { GmailSyncLeaseGuard } from "./sync-coordinator.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];
type DatabaseExecutor = Pick<DatabaseClient, "delete" | "insert" | "update" | "select">;

export type GmailAccountRecord = {
  id: string;
  provider: string;
  providerEmail: string;
  syncCursor: string | null;
  syncHistoryId: string | null;
  watchExpirationAt: Date | null;
  watchTopic: string | null;
  lastSyncedAt: Date | null;
};

type SyncCursorState = {
  pageToken: string | null;
  startedAt: string;
  checkpointAt: string;
};

export type GmailSyncResult = {
  accountId: string;
  emailCount: number;
  threadCount: number;
  labelCount: number;
  contactCount: number;
  nextCursor: string | null;
  lastSyncedAt: string;
};

export type SyncOptions = {
  accountId: string;
  cursor?: string | null;
  fullBackfill?: boolean;
  now?: Date;
  pageSize?: number;
  gmailClient?: GmailClient;
  tokenFetch?: FetchLike;
  oauthConfig?: GmailOAuthConfig;
  propagation?: DeterministicPropagationRuntimeOptions;
  leaseGuard?: GmailSyncLeaseGuard;
  metrics?: GmailSyncMetricsRecorder;
};

export type GmailSyncMetricsRecorder = {
  recordProviderFetch(durationMs: number): void;
  recordDbWrite(durationMs: number): void;
};

export type GmailProviderTokenRecord = {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
};

type GmailProviderTokenSnapshot = GmailProviderTokenRecord & {
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
};

type PersistedLabel = {
  id: string;
  providerLabelId: string;
  name: string;
  type: "system" | "user";
};

export class GmailSyncError extends Error {
  constructor(
    message: string,
    readonly code: "provider_auth_error" | "provider_error" | "sync_conflict",
  ) {
    super(message);
    this.name = "GmailSyncError";
  }
}

const gmailAccessTokenRefreshSkewMs = 60_000;

const accountSyncLocks = new Map<string, Promise<void>>();
const accountTokenRefreshLocks = new Map<string, Promise<void>>();

/** Serialize push, periodic, and manual sync work for one account. */
export function withGmailSyncLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  return withAccountLock(accountSyncLocks, accountId, task);
}

function withAccountLock<T>(
  locks: Map<string, Promise<void>>,
  accountId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(accountId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tracked = run.then(() => undefined, () => undefined);
  locks.set(accountId, tracked);
  void tracked.finally(() => {
    if (locks.get(accountId) === tracked) {
      locks.delete(accountId);
    }
  });
  return run;
}

/**
 * Drop provider pagination/history checkpoints without touching the normalized
 * mail or any Orca organization data. The next sync can safely rebuild the
 * local copy from Gmail.
 */
export function resetGmailSyncState(
  db: DatabaseExecutor,
  accountId: string,
  now = new Date(),
) {
  db
    .update(oauthAccounts)
    .set({
      syncCursor: null,
      syncHistoryId: null,
      watchExpirationAt: null,
      watchTopic: null,
      lastSyncedAt: null,
      updatedAt: now,
    })
    .where(eq(oauthAccounts.id, accountId))
    .run();
}

export async function syncGmailAccountPage(
  db: DatabaseClient,
  options: SyncOptions,
): Promise<GmailSyncResult> {
  const now = options.now ?? new Date();
  const gmailClient = options.gmailClient ?? createGmailClient();
  const account = getGmailAccount(db, options.accountId);

  const tokenRecord = await getGmailProviderTokens(db, account.id, {
    now,
    tokenFetch: options.tokenFetch,
    oauthConfig: options.oauthConfig,
  });
  if (!tokenRecord?.accessToken) {
    throw new GmailSyncError("Connected Gmail account is missing provider credentials", "sync_conflict");
  }

  const syncState = resolveSyncCursorState({
    explicitCursor: options.cursor,
    fullBackfill: options.fullBackfill,
    lastSyncedAt: account.lastSyncedAt,
    now,
    storedCursor: account.syncCursor,
  });
  const since = new Date(syncState.startedAt);

  const syncWithAccessToken = async (accessToken: string): Promise<GmailSyncResult> => {
    const providerStartedAt = performance.now();
    const [labelList, page] = await Promise.all([
      gmailClient.listLabels(accessToken),
      gmailClient.listInboxMessagePage({
        accessToken,
        cursor: syncState.pageToken,
        pageSize: options.pageSize,
        since,
      }),
    ]);
    const gmailMessages = await fetchMessageDetails(gmailClient, accessToken, page.messageIds);
    options.metrics?.recordProviderFetch(performance.now() - providerStartedAt);
    const nowDate = new Date(now);
    const persisted = await persistGmailMessages(db, {
      accountId: account.id,
      accountEmail: account.providerEmail,
      gmailMessages,
      labelList,
      now: nowDate,
      propagationTrigger: "sync",
      propagationOptions: options.propagation,
      leaseGuard: options.leaseGuard,
      metrics: options.metrics,
      afterPersist: (tx) => {
        tx
          .update(oauthAccounts)
          .set({
            syncCursor: page.nextCursor
              ? JSON.stringify({
                  pageToken: page.nextCursor,
                  startedAt: syncState.startedAt,
                  checkpointAt: syncState.checkpointAt,
                } satisfies SyncCursorState)
              : null,
            // A completed page sequence advances the durable high-water mark. While
            // pagination is in progress we keep the previous checkpoint so a failed
            // import can safely resume without skipping mail.
            lastSyncedAt: page.nextCursor ? account.lastSyncedAt : new Date(syncState.checkpointAt),
            updatedAt: nowDate,
          })
          .where(eq(oauthAccounts.id, account.id))
          .run();
      },
    });

    // Older cached rows may predate normalized evidence. Each normal sync moves
    // one bounded, provider-free backfill batch forward without blocking on a
    // live Outlook path or a complete mailbox history.
    backfillHumanClassifications(db, { accountId: account.id, limit: 100, now: nowDate });

    return {
      accountId: account.id,
      emailCount: persisted.emailCount,
      threadCount: persisted.threadCount,
      labelCount: persisted.labelCount,
      contactCount: persisted.contactCount,
      nextCursor: page.nextCursor,
      lastSyncedAt: nowDate.toISOString(),
    };
  };

  try {
    return await syncWithAccessToken(tokenRecord.accessToken);
  } catch (error) {
    if (!isGmailAuthorizationError(error) || !tokenRecord.refreshToken) {
      throw mapGmailError(error);
    }

    const refreshedTokenRecord = await getGmailProviderTokens(db, account.id, {
      forceRefresh: true,
      now,
      tokenFetch: options.tokenFetch,
      oauthConfig: options.oauthConfig,
    });
    if (!refreshedTokenRecord?.accessToken) {
      throw new GmailSyncError("Connected Gmail account is missing provider credentials", "sync_conflict");
    }

    try {
      return await syncWithAccessToken(refreshedTokenRecord.accessToken);
    } catch (retryError) {
      throw mapGmailError(retryError);
    }
  }
}

export type GmailMessagePersistenceInput = {
  accountId: string;
  accountEmail: string;
  gmailMessages: Awaited<ReturnType<GmailClient["getMessage"]>>[];
  labelList: Array<{ id: string; name: string; type?: "system" | "user" }>;
  now: Date;
  propagationTrigger: "sync" | "push";
  propagationOptions?: DeterministicPropagationRuntimeOptions;
  leaseGuard?: GmailSyncLeaseGuard;
  metrics?: GmailSyncMetricsRecorder;
  afterPersist?: (db: DatabaseExecutor) => void;
};

export type GmailMessagePersistenceResult = {
  emailCount: number;
  threadCount: number;
  labelCount: number;
  contactCount: number;
  threadIds: string[];
  changedEmailCount: number;
  unchangedEmailCount: number;
};

/**
 * Persist a batch of fully fetched Gmail messages using the same normalized
 * writes as the regular inbox sync. Push history and periodic fallback both
 * use this seam so their provider-specific fetch strategy cannot drift from
 * the existing account isolation and classification behavior.
 */
export async function persistGmailMessages(
  db: DatabaseClient,
  input: GmailMessagePersistenceInput,
): Promise<GmailMessagePersistenceResult> {
  const normalizedMessages = input.gmailMessages.map((message) =>
    normalizeGmailMessage(message, {
      accountId: input.accountId,
      accountEmail: input.accountEmail,
    }),
  );
  const persistedLabels = buildPersistedLabels(input.accountId, input.labelList, normalizedMessages);
  const threadIds = [...new Set(normalizedMessages.map((message) => message.threadId))];
  const messageIds = normalizedMessages.map((message) => message.id);
  const orderedMessages = [...normalizedMessages]
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt) || left.id.localeCompare(right.id));
  const existingThreadIds = new Set(threadIds.length === 0 ? [] : db.select({ id: threads.id }).from(threads)
    .where(and(eq(threads.accountId, input.accountId), inArray(threads.id, threadIds))).all().map((thread) => thread.id));
  const existingMessages = messageIds.length === 0 ? [] : db.select({
    id: emails.id,
    threadId: emails.threadId,
    providerSnapshotDigest: emails.providerSnapshotDigest,
  }).from(emails).where(and(eq(emails.accountId, input.accountId), inArray(emails.id, messageIds))).all();
  const existingMessageById = new Map(existingMessages.map((message) => [message.id, message]));
  const digestByMessageId = new Map(orderedMessages.map((message) => [message.id, providerSnapshotDigest(message)]));
  const changedMessages = orderedMessages.filter((message) =>
    existingMessageById.get(message.id)?.providerSnapshotDigest !== digestByMessageId.get(message.id));
  const changedMessageIds = new Set(changedMessages.map((message) => message.id));
  const changedThreadIds = [...new Set(changedMessages.flatMap((message) => {
    const previousThreadId = existingMessageById.get(message.id)?.threadId;
    return previousThreadId && previousThreadId !== message.threadId
      ? [previousThreadId, message.threadId]
      : [message.threadId];
  }))];
  const existingMessageIds = new Set(existingMessages.map((message) => message.id));
  const seenThreadIds = new Set(existingThreadIds);
  const evaluationEventsByMessageId = new Map(orderedMessages
    .filter((message) => !existingMessageIds.has(message.id))
    .map((message) => {
      const kind = seenThreadIds.has(message.threadId) ? "thread.updated" as const : "message.received" as const;
      seenThreadIds.add(message.threadId);
      return [message.id, { messageId: message.id, kind }] as const;
    }));

  const existingLabels = persistedLabels.length === 0 ? [] : db.select({
    providerLabelId: labels.providerLabelId,
    name: labels.name,
    type: labels.type,
  }).from(labels).where(eq(labels.accountId, input.accountId)).all();
  const existingLabelByProviderId = new Map(existingLabels.map((label) => [label.providerLabelId, label]));
  const changedLabels = persistedLabels.filter((label) => {
    const existing = existingLabelByProviderId.get(label.providerLabelId);
    return !existing || existing.name !== label.name || existing.type !== label.type;
  });
  const configuredRule = evaluationEventsByMessageId.size === 0 ? undefined : db.select({
    id: organizationRules.id,
    activeRevisionId: organizationRules.activeRevisionId,
  })
    .from(organizationRules)
    .innerJoin(oauthAccounts, eq(oauthAccounts.userId, organizationRules.workspaceId))
    .where(eq(oauthAccounts.id, input.accountId))
    .orderBy(sql`${organizationRules.activeRevisionId} IS NULL`)
    .get();
  const requiresSequentialRuleEvaluation = configuredRule?.activeRevisionId !== null && configuredRule !== undefined;
  const fallbackEvaluationEventsByThread = new Map<string, { messageId: string; kind: "message.received" | "thread.updated" }>();
  if (configuredRule && !requiresSequentialRuleEvaluation) {
    for (const message of changedMessages) {
      const event = evaluationEventsByMessageId.get(message.id);
      if (event) fallbackEvaluationEventsByThread.set(message.threadId, event);
    }
  }

  const dbWriteStartedAt = performance.now();
  db.transaction((tx) => {
    input.leaseGuard?.assert(tx);
    upsertLabels(tx, input.accountId, changedLabels, input.now);
    if (requiresSequentialRuleEvaluation) {
      for (const message of changedMessages) {
        upsertThreads(tx, [message], input.now);
        upsertEmails(tx, [message], digestByMessageId, input.now);
        upsertAttachments(tx, [message], input.now);
        upsertEmailLabels(tx, [message], persistedLabels, input.now);
        upsertContacts(tx, input.accountId, [message], input.now);
        refreshThreadAggregates(tx, { accountId: input.accountId, threadIds: [message.threadId], now: input.now });
        const event = evaluationEventsByMessageId.get(message.id);
        if (event) evaluateLiveMessageRules(tx as unknown as DatabaseClient, { accountId: input.accountId, events: [event] });
      }
    } else {
      upsertThreads(tx, changedMessages, input.now);
      upsertEmails(tx, changedMessages, digestByMessageId, input.now);
      upsertAttachments(tx, changedMessages, input.now);
      upsertEmailLabels(tx, changedMessages, persistedLabels, input.now);
      upsertContacts(tx, input.accountId, changedMessages, input.now);
      refreshThreadAggregates(tx, { accountId: input.accountId, threadIds: changedThreadIds, now: input.now });
      if (fallbackEvaluationEventsByThread.size > 0) {
        evaluateLiveMessageRules(tx as unknown as DatabaseClient, {
          accountId: input.accountId,
          events: [...fallbackEvaluationEventsByThread.values()],
        });
      }
    }
    input.afterPersist?.(tx);
  });
  input.metrics?.recordDbWrite(performance.now() - dbWriteStartedAt);

  await runDeterministicPropagation(db, {
    accountId: input.accountId,
    messages: changedMessages,
    trigger: input.propagationTrigger,
    options: input.propagationOptions,
  });

  return {
    emailCount: normalizedMessages.length,
    threadCount: threadIds.length,
    labelCount: persistedLabels.length,
    contactCount: collectContacts(normalizedMessages).length,
    threadIds,
    changedEmailCount: changedMessageIds.size,
    unchangedEmailCount: normalizedMessages.length - changedMessageIds.size,
  };
}

async function fetchMessageDetails(
  gmailClient: GmailClient,
  accessToken: string,
  messageIds: string[],
) {
  const messages = [];
  const concurrentRequests = 5;

  for (let index = 0; index < messageIds.length; index += concurrentRequests) {
    const batch = messageIds.slice(index, index + concurrentRequests);
    messages.push(...await Promise.all(batch.map((messageId) => gmailClient.getMessage(accessToken, messageId))));
  }

  return messages;
}

export function getGmailAccount(db: DatabaseClient, accountId: string): GmailAccountRecord {
  const account = db
    .select({
      id: oauthAccounts.id,
      provider: oauthAccounts.provider,
      providerEmail: oauthAccounts.providerEmail,
      syncCursor: oauthAccounts.syncCursor,
      syncHistoryId: oauthAccounts.syncHistoryId,
      watchExpirationAt: oauthAccounts.watchExpirationAt,
      watchTopic: oauthAccounts.watchTopic,
      lastSyncedAt: oauthAccounts.lastSyncedAt,
    })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.id, accountId))
    .get();

  if (!account) {
    throw new Error(`Gmail account ${accountId} was not found`);
  }

  if (account.provider !== "gmail") {
    throw new Error(`OAuth account ${accountId} is not a Gmail account`);
  }

  return account;
}

export async function readGmailProviderTokens(
  db: DatabaseClient,
  accountId: string,
  oauthConfig?: GmailOAuthConfig,
): Promise<GmailProviderTokenRecord | null> {
  const snapshot = await readGmailProviderTokenSnapshot(db, accountId, oauthConfig);
  return snapshot ? toGmailProviderTokenRecord(snapshot) : null;
}

async function readGmailProviderTokenSnapshot(
  db: DatabaseClient,
  accountId: string,
  oauthConfig?: GmailOAuthConfig,
): Promise<GmailProviderTokenSnapshot | null> {
  const account = db.select({
    accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
    refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
    tokenExpiry: oauthAccounts.tokenExpiry,
  }).from(oauthAccounts).where(eq(oauthAccounts.id, accountId)).get();

  if (!account?.accessTokenEncrypted) {
    return null;
  }

  try {
    const tokens = account.accessTokenEncrypted.startsWith("v1:")
      ? {
          accessToken: decryptSecret(
            account.accessTokenEncrypted,
            (oauthConfig ?? loadGmailOAuthConfig()).tokenEncryptionKey,
          ),
          refreshToken: account.refreshTokenEncrypted
            ? decryptSecret(
                account.refreshTokenEncrypted,
                (oauthConfig ?? loadGmailOAuthConfig()).tokenEncryptionKey,
              )
            : null,
          tokenExpiry: account.tokenExpiry,
        }
      : await readProviderTokens(db, accountId);

    if (!tokens) {
      return null;
    }

    return {
      ...tokens,
      accessTokenEncrypted: account.accessTokenEncrypted,
      refreshTokenEncrypted: account.refreshTokenEncrypted,
    };
  } catch {
    throw new GmailSyncError("Gmail credentials can no longer be decrypted", "provider_auth_error");
  }
}

export async function getGmailProviderTokens(
  db: DatabaseClient,
  accountId: string,
  options: {
    forceRefresh?: boolean;
    now?: Date;
    tokenFetch?: FetchLike;
    oauthConfig?: GmailOAuthConfig;
  } = {},
): Promise<GmailProviderTokenRecord | null> {
  const observed = await readGmailProviderTokenSnapshot(db, accountId, options.oauthConfig);
  if (!observed?.accessToken) {
    return observed ? toGmailProviderTokenRecord(observed) : null;
  }

  const now = options.now ?? new Date();
  if (!shouldRefreshGmailAccessToken(observed, now, options.forceRefresh)) {
    return toGmailProviderTokenRecord(observed);
  }

  return withAccountLock(accountTokenRefreshLocks, accountId, async () => {
    const current = await readGmailProviderTokenSnapshot(db, accountId, options.oauthConfig);
    if (!current?.accessToken) {
      return current ? toGmailProviderTokenRecord(current) : null;
    }

    // Another request may have refreshed this account while this request was
    // waiting for the in-process lock. Reuse its credentials instead of
    // submitting the old refresh token again.
    if (!sameGmailCredentialSnapshot(current, observed)) {
      return toGmailProviderTokenRecord(current);
    }

    if (!shouldRefreshGmailAccessToken(current, now, options.forceRefresh)) {
      return toGmailProviderTokenRecord(current);
    }

    if (!current.refreshToken) {
      return toGmailProviderTokenRecord(current);
    }

    const refreshed = await refreshGmailAccessToken({
      refreshToken: current.refreshToken,
      config: options.oauthConfig ?? loadGmailOAuthConfig(),
      fetchImpl: options.tokenFetch,
      now,
    });
    if (!refreshed.ok) {
      const winner = await readGmailProviderTokenSnapshot(db, accountId, options.oauthConfig);
      if (winner?.accessToken && !sameGmailCredentialSnapshot(winner, current)) {
        return toGmailProviderTokenRecord(winner);
      }

      throw new GmailSyncError(
        refreshed.message,
        refreshed.code === "refresh_token_rejected" ? "provider_auth_error" : "provider_error",
      );
    }

    const refreshToken = refreshed.refreshToken ?? current.refreshToken;
    const stored = await storeProviderTokens(db, {
      oauthAccountId: accountId,
      accessToken: refreshed.accessToken,
      refreshToken,
      tokenExpiry: refreshed.expiresAt,
      expected: {
        accessTokenEncrypted: current.accessTokenEncrypted,
        refreshTokenEncrypted: current.refreshTokenEncrypted,
        tokenExpiry: current.tokenExpiry,
      },
    });

    if (!stored) {
      const winner = await readGmailProviderTokenSnapshot(db, accountId, options.oauthConfig);
      if (winner?.accessToken && !sameGmailCredentialSnapshot(winner, current)) {
        return toGmailProviderTokenRecord(winner);
      }

      throw new GmailSyncError("Gmail credentials changed while refreshing", "sync_conflict");
    }

    return {
      accessToken: refreshed.accessToken,
      refreshToken,
      tokenExpiry: refreshed.expiresAt,
    };
  });
}

function toGmailProviderTokenRecord(snapshot: GmailProviderTokenSnapshot): GmailProviderTokenRecord {
  return {
    accessToken: snapshot.accessToken,
    refreshToken: snapshot.refreshToken,
    tokenExpiry: snapshot.tokenExpiry,
  };
}

function shouldRefreshGmailAccessToken(
  tokenRecord: GmailProviderTokenRecord,
  now: Date,
  forceRefresh = false,
): boolean {
  if (forceRefresh) {
    return Boolean(tokenRecord.refreshToken);
  }

  const expiresSoon = tokenRecord.tokenExpiry !== null
    && tokenRecord.tokenExpiry.getTime() <= now.getTime() + gmailAccessTokenRefreshSkewMs;
  return expiresSoon && Boolean(tokenRecord.refreshToken);
}

function sameGmailCredentialSnapshot(
  left: GmailProviderTokenSnapshot,
  right: GmailProviderTokenSnapshot,
): boolean {
  return left.accessTokenEncrypted === right.accessTokenEncrypted
    && left.refreshTokenEncrypted === right.refreshTokenEncrypted
    && left.tokenExpiry?.getTime() === right.tokenExpiry?.getTime();
}

function buildPersistedLabels(
  accountId: string,
  gmailLabels: Array<{ id: string; name: string; type?: "system" | "user" }>,
  normalizedMessages: Array<{ labels: string[] }>,
): PersistedLabel[] {
  const mappedLabels = new Map<string, PersistedLabel>();

  for (const label of gmailLabels) {
    const normalized = normalizeGmailLabel(label);
    mappedLabels.set(label.id, {
      id: buildLabelId(accountId, normalized.providerLabelId),
      providerLabelId: normalized.providerLabelId,
      name: normalized.name,
      type: normalized.type,
    });
  }

  for (const message of normalizedMessages) {
    for (const providerLabelId of message.labels) {
      if (!mappedLabels.has(providerLabelId)) {
        const normalized = normalizeGmailLabel({
          id: providerLabelId,
          name: providerLabelId,
        });
        mappedLabels.set(providerLabelId, {
          id: buildLabelId(accountId, normalized.providerLabelId),
          providerLabelId: normalized.providerLabelId,
          name: normalized.name,
          type: normalized.type,
        });
      }
    }
  }

  return [...mappedLabels.values()];
}

function upsertLabels(
  db: DatabaseExecutor,
  accountId: string,
  labelRows: PersistedLabel[],
  now: Date,
) {
  if (labelRows.length === 0) {
    return;
  }

  for (const batch of chunks(labelRows, 400)) {
    db.insert(labels)
      .values(batch.map((labelRow) => ({ ...labelRow, accountId, createdAt: now, updatedAt: now })))
      .onConflictDoUpdate({
        target: [labels.accountId, labels.providerLabelId],
        set: {
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          updatedAt: now,
        },
      })
      .run();
  }
}

function upsertThreads(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedMessage[],
  now: Date,
) {
  const threadSubjects = new Map<string, string>();
  const threadProviderIds = new Map<string, string>();

  for (const message of normalizedMessages) {
    threadSubjects.set(message.threadId, message.subject);
    threadProviderIds.set(message.threadId, message.raw.threadId);
  }

  const rows = [...threadSubjects.entries()].map(([threadId, subject]) => ({
        id: threadId,
        accountId: normalizedMessages[0]?.raw.accountId ?? "",
        providerThreadId: threadProviderIds.get(threadId) ?? threadId,
        subject,
        latestReceivedAt: new Date(0),
        messageCount: 0,
        isRead: true,
        createdAt: now,
        updatedAt: now,
      }));
  for (const batch of chunks(rows, 400)) {
    db.insert(threads).values(batch)
      .onConflictDoUpdate({
        target: [threads.accountId, threads.providerThreadId],
        set: {
          subject: sql`excluded.subject`,
          updatedAt: now,
        },
      })
      .run();
  }
}

function upsertEmails(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedMessage[],
  digestByMessageId: ReadonlyMap<string, string>,
  now: Date,
) {
  const rows = normalizedMessages.map((message) => {
    const automaticClassification = classifyHumanSignal(message.classificationEvidence);
    const classificationColumns = automaticClassificationColumns(automaticClassification);
    return {
        id: message.id,
        accountId: message.raw.accountId,
        threadId: message.threadId,
        providerMessageId: message.providerMessageId,
        fromAddress: message.from.email || null,
        fromName: message.from.name,
        toRecipients: JSON.stringify(message.to),
        ccRecipients: JSON.stringify(message.cc),
        bccRecipients: JSON.stringify(message.bcc),
        subject: message.subject,
        snippet: message.snippet,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        internetMessageId: message.internetMessageId,
        references: JSON.stringify(message.references),
        receivedAt: new Date(message.receivedAt),
        internalDate: new Date(message.receivedAt),
        isRead: !message.unread,
        isStarred: message.labels.includes("STARRED"),
        isDraft: message.labels.includes("DRAFT"),
        ...classificationColumns,
        humanClassificationEvidence: message.classificationEvidence
          ? JSON.stringify(message.classificationEvidence)
          : null,
        providerSnapshotDigest: digestByMessageId.get(message.id)!,
        createdAt: now,
        updatedAt: now,
      };
  });
  for (const batch of chunks(rows, 200)) {
    db.insert(emails).values(batch)
      .onConflictDoUpdate({
        target: [emails.accountId, emails.providerMessageId],
        set: {
          threadId: sql`excluded.thread_id`,
          fromAddress: sql`excluded.from_address`,
          fromName: sql`excluded.from_name`,
          toRecipients: sql`excluded.to_recipients`,
          ccRecipients: sql`excluded.cc_recipients`,
          bccRecipients: sql`excluded.bcc_recipients`,
          subject: sql`excluded.subject`,
          snippet: sql`excluded.snippet`,
          bodyText: sql`excluded.body_text`,
          bodyHtml: sql`excluded.body_html`,
          internetMessageId: sql`excluded.internet_message_id`,
          references: sql.raw('excluded."references"'),
          receivedAt: sql`excluded.received_at`,
          internalDate: sql`excluded.internal_date`,
          isRead: sql`CASE WHEN ${emails.isRead} = 1 AND excluded.is_read = 0 THEN 1 ELSE excluded.is_read END`,
          isStarred: sql`excluded.is_starred`,
          isDraft: sql`excluded.is_draft`,
          humanSignal: sql`excluded.human_signal`,
          humanClassification: sql`excluded.human_classification`,
          humanClassificationReasons: sql`excluded.human_classification_reasons`,
          humanClassifierVersion: sql`excluded.human_classifier_version`,
          humanClassificationEvidence: sql`excluded.human_classification_evidence`,
          providerSnapshotDigest: sql`excluded.provider_snapshot_digest`,
          updatedAt: now,
        },
      })
      .run();
  }
}

function upsertAttachments(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedGmailMessage[],
  now: Date,
) {
  const messageIds = normalizedMessages.map((message) => message.id);
  if (messageIds.length === 0) return;
  db.delete(emailAttachments).where(inArray(emailAttachments.emailId, messageIds)).run();
  const rows = normalizedMessages.flatMap((message) => message.attachments.flatMap((attachment) => {
      const providerAttachmentId = attachment.id.split(":attachment:").at(-1);
      if (!providerAttachmentId) return [];
      return [{
        id: attachment.id,
        emailId: message.id,
        providerAttachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: now,
        updatedAt: now,
      }];
    }));
  for (const batch of chunks(rows, 400)) {
    db.insert(emailAttachments).values(batch).run();
  }
}

function upsertEmailLabels(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedMessage[],
  labelRows: PersistedLabel[],
  now: Date,
) {
  const labelIdByProviderId = new Map(labelRows.map((labelRow) => [labelRow.providerLabelId, labelRow.id]));

  const messageIds = normalizedMessages.map((message) => message.id);
  if (messageIds.length === 0) return;
  db.delete(emailLabels).where(inArray(emailLabels.emailId, messageIds)).run();
  const rows = normalizedMessages.flatMap((message) => message.labels.flatMap((providerLabelId) => {
      const labelId = labelIdByProviderId.get(providerLabelId);
      if (!labelId) return [];
      return [{
          id: `${message.id}:${labelId}`,
          emailId: message.id,
          labelId,
          createdAt: now,
        }];
    }));
  for (const batch of chunks(rows, 400)) {
    db.insert(emailLabels).values(batch).onConflictDoNothing().run();
  }
}

function upsertContacts(
  db: DatabaseExecutor,
  accountId: string,
  normalizedMessages: NormalizedMessage[],
  now: Date,
) {
  const rows = collectContacts(normalizedMessages).map((contact) => ({
        id: buildContactId(accountId, contact.email),
        accountId,
        email: contact.email,
        name: contact.name,
        createdAt: now,
        updatedAt: now,
      }));
  for (const batch of chunks(rows, 400)) {
    db.insert(contacts).values(batch)
      .onConflictDoUpdate({
        target: [contacts.accountId, contacts.email],
        set: {
          name: sql`coalesce(excluded.name, ${contacts.name})`,
          updatedAt: now,
        },
      })
      .run();
  }
}

function providerSnapshotDigest(message: NormalizedGmailMessage): string {
  return createHash("sha256").update(JSON.stringify({
    threadId: message.threadId,
    providerMessageId: message.providerMessageId,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    snippet: message.snippet,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    internetMessageId: message.internetMessageId,
    references: message.references,
    receivedAt: message.receivedAt,
    unread: message.unread,
    labels: [...message.labels].sort(),
    classificationEvidence: message.classificationEvidence,
    attachments: [...message.attachments].sort((left, right) => left.id.localeCompare(right.id)),
  })).digest("hex");
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function collectContacts(
  normalizedMessages: NormalizedMessage[],
): MailContact[] {
  const deduped = new Map<string, MailContact>();

  for (const message of normalizedMessages) {
    for (const contact of [message.from, ...message.to, ...message.cc, ...message.bcc]) {
      const email = contact.email.trim().toLowerCase();
      if (!email) {
        continue;
      }

      const existing = deduped.get(email);
      if (!existing || (!existing.name && contact.name)) {
        deduped.set(email, {
          email,
          name: contact.name?.trim() || null,
        });
      }
    }
  }

  return [...deduped.values()];
}

function buildLabelId(accountId: string, providerLabelId: string) {
  return `gmail:${accountId}:label:${providerLabelId}`;
}

function buildContactId(accountId: string, email: string) {
  return `gmail:${accountId}:contact:${email.trim().toLowerCase()}`;
}

function resolveSyncCursorState(input: {
  explicitCursor?: string | null;
  fullBackfill?: boolean;
  lastSyncedAt: Date | null;
  now: Date;
  storedCursor: string | null;
}): SyncCursorState {
  if (input.fullBackfill) {
    return {
      pageToken: null,
      startedAt: new Date(0).toISOString(),
      checkpointAt: input.now.toISOString(),
    };
  }

  if (input.explicitCursor) {
    return {
      pageToken: input.explicitCursor,
      startedAt: input.now.toISOString(),
      checkpointAt: input.now.toISOString(),
    };
  }

  if (input.storedCursor) {
    const parsed = parseStoredSyncCursor(input.storedCursor);
    if (parsed) {
      return parsed;
    }

    return {
      pageToken: input.storedCursor,
      startedAt: input.now.toISOString(),
      checkpointAt: input.now.toISOString(),
    };
  }

  return {
    pageToken: null,
    startedAt: input.lastSyncedAt?.toISOString() ?? new Date(0).toISOString(),
    checkpointAt: input.now.toISOString(),
  };
}

function parseStoredSyncCursor(value: string): SyncCursorState | null {
  try {
    const parsed = JSON.parse(value) as Partial<SyncCursorState>;
    if (
      typeof parsed.pageToken === "string" &&
      typeof parsed.startedAt === "string" &&
      !Number.isNaN(Date.parse(parsed.startedAt))
    ) {
      return {
        pageToken: parsed.pageToken,
        startedAt: parsed.startedAt,
        checkpointAt: typeof parsed.checkpointAt === "string" && !Number.isNaN(Date.parse(parsed.checkpointAt))
          ? parsed.checkpointAt
          : parsed.startedAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function mapGmailError(error: unknown): GmailSyncError {
  if (error instanceof GmailSyncError) {
    return error;
  }

  if (error instanceof GmailApiError) {
    if (error.status === 401 || error.status === 403) {
      return new GmailSyncError("Gmail credentials need to be refreshed", "provider_auth_error");
    }

    return new GmailSyncError("Gmail provider request failed", "provider_error");
  }

  if (error instanceof Error) {
    return new GmailSyncError(error.message, "provider_error");
  }

  return new GmailSyncError("Unknown Gmail sync failure", "provider_error");
}

function isGmailAuthorizationError(error: unknown): error is GmailApiError {
  return error instanceof GmailApiError && (error.status === 401 || error.status === 403);
}
