import { and, eq, inArray } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";

import { createDatabaseClient } from "../../db/client.ts";
import { emailAttachments, emailLabels, emails, oauthAccounts, threads } from "../../db/schema.ts";
import {
  createGmailClient,
  GmailApiError,
  type GmailClient,
} from "./client.ts";
import type { GmailMessage } from "./types.ts";
import {
  getGmailAccount,
  GmailSyncError,
  persistGmailMessages,
  readGmailProviderTokens,
  refreshThreads,
  syncGmailAccountPage,
} from "./sync.ts";
import { loadGmailPushConfig, type GmailPushConfig } from "./push-config.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export type GmailPushNotification = {
  emailAddress: string;
  historyId: string;
};

export type GmailWatchResult = {
  accountId: string;
  historyId: string;
  expirationAt: string;
  topicName: string;
};

export type GmailBackfillOptions = {
  accountId: string;
  gmailClient?: GmailClient;
  now?: Date;
  pageSize?: number;
  maxPages?: number;
};

export type GmailBackfillResult = {
  accountId: string;
  emailCount: number;
  threadCount: number;
  labelCount: number;
  contactCount: number;
  pages: number;
  nextCursor: string | null;
  lastSyncedAt: string;
};

export type GmailHistorySyncResult = {
  accountId: string;
  historyId: string;
  emailCount: number;
  deletedEmailCount: number;
  threadCount: number;
  labelCount: number;
  contactCount: number;
  usedBackfill: boolean;
  lastSyncedAt: string;
};

export type GmailPushErrorCode =
  | "push_not_configured"
  | "provider_auth_error"
  | "provider_error"
  | "sync_conflict";

export class GmailPushError extends Error {
  constructor(message: string, readonly code: GmailPushErrorCode) {
    super(message);
    this.name = "GmailPushError";
  }
}

export async function watchGmailAccount(
  db: DatabaseClient,
  input: {
    accountId: string;
    gmailClient?: GmailClient;
    config?: GmailPushConfig;
    now?: Date;
  },
): Promise<GmailWatchResult> {
  const now = input.now ?? new Date();
  const config = input.config ?? loadGmailPushConfig();
  if (!config.topicName) {
    throw new GmailPushError("Gmail push notifications are not configured", "push_not_configured");
  }
  const gmailClient = input.gmailClient ?? createGmailClient();
  if (!gmailClient.watch) {
    throw new GmailPushError("Gmail push watch is not available", "provider_error");
  }

  const account = getGmailAccount(db, input.accountId);
  let tokenRecord;
  try {
    tokenRecord = await readGmailProviderTokens(db, account.id);
  } catch (error) {
    throw mapGmailPushError(error);
  }
  if (!tokenRecord?.accessToken) {
    throw new GmailPushError("Connected Gmail account is missing provider credentials", "sync_conflict");
  }

  let response;
  try {
    response = await gmailClient.watch(tokenRecord.accessToken, config.topicName);
  } catch (error) {
    throw mapGmailPushError(error);
  }

  const historyId = String(response.historyId ?? "").trim();
  const expirationAt = parseWatchExpiration(response.expiration, now);
  if (!historyId || !/^\d+$/.test(historyId) || !expirationAt) {
    throw new GmailPushError("Gmail returned an invalid push watch response", "provider_error");
  }

  db
    .update(oauthAccounts)
    .set({
      syncHistoryId: historyId,
      watchExpirationAt: expirationAt,
      watchTopic: config.topicName,
      updatedAt: now,
    })
    .where(eq(oauthAccounts.id, account.id))
    .run();

  return {
    accountId: account.id,
    historyId,
    expirationAt: expirationAt.toISOString(),
    topicName: config.topicName,
  };
}

export async function ensureGmailWatch(
  db: DatabaseClient,
  input: {
    accountId: string;
    gmailClient?: GmailClient;
    config?: GmailPushConfig;
    now?: Date;
    force?: boolean;
  },
): Promise<GmailWatchResult | null> {
  const config = input.config ?? loadGmailPushConfig();
  if (!config.topicName) {
    return null;
  }
  const now = input.now ?? new Date();
  const account = getGmailAccount(db, input.accountId);
  const renewalCutoff = new Date(now.getTime() + config.watchRenewalWindowMs);
  if (
    !input.force &&
    account.watchTopic === config.topicName &&
    account.watchExpirationAt &&
    account.watchExpirationAt > renewalCutoff &&
    account.syncHistoryId
  ) {
    return {
      accountId: account.id,
      historyId: account.syncHistoryId,
      expirationAt: account.watchExpirationAt.toISOString(),
      topicName: config.topicName,
    };
  }

  return watchGmailAccount(db, input);
}

export async function backfillGmailAccount(
  db: DatabaseClient,
  input: GmailBackfillOptions,
): Promise<GmailBackfillResult> {
  const now = input.now ?? new Date();
  const pageSize = input.pageSize ?? loadGmailPushConfig().backfillPageSize;
  const maxPages = input.maxPages ?? loadGmailPushConfig().backfillMaxPages;
  const gmailClient = input.gmailClient ?? createGmailClient();
  let result;
  let pages = 0;
  let emailCount = 0;
  let threadCount = 0;
  let labelCount = 0;
  let contactCount = 0;

  do {
    result = await syncGmailAccountPage(db, {
      accountId: input.accountId,
      gmailClient,
      fullBackfill: pages === 0,
      now,
      pageSize,
    });
    pages += 1;
    emailCount += result.emailCount;
    threadCount += result.threadCount;
    labelCount += result.labelCount;
    contactCount += result.contactCount;
  } while (result.nextCursor && pages < maxPages);

  return {
    accountId: input.accountId,
    emailCount,
    threadCount,
    labelCount,
    contactCount,
    pages,
    nextCursor: result.nextCursor,
    lastSyncedAt: result.lastSyncedAt,
  };
}

export async function syncGmailAccountHistory(
  db: DatabaseClient,
  input: {
    accountId: string;
    historyId: string;
    gmailClient?: GmailClient;
    config?: GmailPushConfig;
    now?: Date;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<GmailHistorySyncResult> {
  const now = input.now ?? new Date();
  const account = getGmailAccount(db, input.accountId);
  const gmailClient = input.gmailClient ?? createGmailClient();
  let tokenRecord;
  try {
    tokenRecord = await readGmailProviderTokens(db, account.id);
  } catch (error) {
    throw mapGmailPushError(error);
  }
  if (!tokenRecord?.accessToken) {
    throw new GmailPushError("Connected Gmail account is missing provider credentials", "sync_conflict");
  }

  if (!account.syncHistoryId || isHistoryIdAtOrBefore(input.historyId, account.syncHistoryId)) {
    const backfill = !account.syncHistoryId
      ? await backfillGmailAccount(db, {
          accountId: account.id,
          gmailClient,
          now,
          pageSize: input.pageSize ?? input.config?.backfillPageSize,
          maxPages: input.maxPages ?? input.config?.backfillMaxPages,
        })
      : null;
    const nextHistoryId = account.syncHistoryId ?? input.historyId;
    updateHistoryCursor(db, account.id, nextHistoryId, now);
    return {
      accountId: account.id,
      historyId: nextHistoryId,
      emailCount: backfill?.emailCount ?? 0,
      deletedEmailCount: 0,
      threadCount: backfill?.threadCount ?? 0,
      labelCount: backfill?.labelCount ?? 0,
      contactCount: backfill?.contactCount ?? 0,
      usedBackfill: backfill !== null,
      lastSyncedAt: now.toISOString(),
    };
  }

  if (!gmailClient.listHistory) {
    throw new GmailPushError("Gmail history sync is not available", "provider_error");
  }

  const messageIds = new Set<string>();
  const deletedMessageIds = new Set<string>();
  const historyPageSize = input.pageSize ?? input.config?.backfillPageSize ?? loadGmailPushConfig().backfillPageSize;
  const maxHistoryPages = input.maxPages ?? input.config?.backfillMaxPages ?? loadGmailPushConfig().backfillMaxPages;
  let cursor: string | null = null;
  let historyId = input.historyId;
  let pages = 0;

  try {
    do {
      const page = await gmailClient.listHistory({
        accessToken: tokenRecord.accessToken,
        startHistoryId: account.syncHistoryId,
        cursor,
        pageSize: historyPageSize,
      });
      pages += 1;
      for (const messageId of page.messageIds) {
        messageIds.add(messageId);
        deletedMessageIds.delete(messageId);
      }
      for (const messageId of page.deletedMessageIds) {
        if (!messageIds.has(messageId)) deletedMessageIds.add(messageId);
      }
      if (page.historyId) historyId = page.historyId;
      cursor = page.nextCursor;
    } while (cursor && pages < maxHistoryPages);
    if (cursor) {
      throw new GmailPushError("Gmail history pagination did not complete", "provider_error");
    }
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      const backfill = await backfillGmailAccount(db, {
        accountId: account.id,
        gmailClient,
        now,
        pageSize: input.pageSize ?? input.config?.backfillPageSize,
        maxPages: input.maxPages ?? input.config?.backfillMaxPages,
      });
      updateHistoryCursor(db, account.id, input.historyId, now);
      return {
        accountId: account.id,
        historyId: input.historyId,
        emailCount: backfill.emailCount,
        deletedEmailCount: 0,
        threadCount: backfill.threadCount,
        labelCount: backfill.labelCount,
        contactCount: backfill.contactCount,
        usedBackfill: true,
        lastSyncedAt: now.toISOString(),
      };
    }
    throw mapGmailPushError(error);
  }

  let persisted = {
    emailCount: 0,
    threadCount: 0,
    labelCount: 0,
    contactCount: 0,
    threadIds: [] as string[],
  };
  let deletedEmailCount = 0;

  if (messageIds.size > 0) {
    let gmailMessages: GmailMessage[];
    try {
      gmailMessages = await fetchMessageDetails(gmailClient, tokenRecord.accessToken, [...messageIds]);
      const labelList = await gmailClient.listLabels(tokenRecord.accessToken);
      persisted = persistGmailMessages(db, {
        accountId: account.id,
        accountEmail: account.providerEmail,
        gmailMessages,
        labelList,
        now,
      });
    } catch (error) {
      throw mapGmailPushError(error);
    }
  }

  if (deletedMessageIds.size > 0) {
    deletedEmailCount = deleteGmailMessages(db, account.id, [...deletedMessageIds], now);
  }

  updateHistoryCursor(db, account.id, historyId, now);

  return {
    accountId: account.id,
    historyId,
    emailCount: persisted.emailCount,
    deletedEmailCount,
    threadCount: persisted.threadCount,
    labelCount: persisted.labelCount,
    contactCount: persisted.contactCount,
    usedBackfill: false,
    lastSyncedAt: now.toISOString(),
  };
}

export function parseGmailPubSubNotification(body: unknown): GmailPushNotification | null {
  if (!isRecord(body) || !isRecord(body.message) || typeof body.message.data !== "string") {
    return null;
  }

  let decoded: unknown;
  try {
    const encoded = body.message.data.replace(/-/g, "+").replace(/_/g, "/");
    decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }

  if (!isRecord(decoded)) return null;
  const emailAddress = typeof decoded.emailAddress === "string" ? decoded.emailAddress.trim().toLowerCase() : "";
  const historyId = typeof decoded.historyId === "string" ? decoded.historyId.trim() : "";
  if (!emailAddress || !historyId || !/^\d+$/.test(historyId) || !emailAddress.includes("@")) {
    return null;
  }

  return { emailAddress, historyId };
}

export function verifyGmailPushToken(request: Request, config: GmailPushConfig): boolean {
  if (!config.verificationToken) return false;
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const candidates = [
    url.searchParams.get("token"),
    url.searchParams.get("verificationToken"),
    request.headers.get("x-goog-pubsub-token"),
    request.headers.get("x-orca-push-token"),
    authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.some((candidate) => safeEqual(candidate, config.verificationToken!));
}

function updateHistoryCursor(db: DatabaseClient, accountId: string, historyId: string, now: Date) {
  db
    .update(oauthAccounts)
    .set({ syncHistoryId: historyId, updatedAt: now })
    .where(eq(oauthAccounts.id, accountId))
    .run();
}

function deleteGmailMessages(db: DatabaseClient, accountId: string, providerMessageIds: string[], now: Date): number {
  const existing = db
    .select({ id: emails.id, threadId: emails.threadId })
    .from(emails)
    .where(and(eq(emails.accountId, accountId), inArray(emails.providerMessageId, providerMessageIds)))
    .all();
  if (existing.length === 0) return 0;

  db.transaction((tx) => {
    tx.delete(emailAttachments).where(inArray(emailAttachments.emailId, existing.map((row) => row.id))).run();
    tx.delete(emailLabels).where(inArray(emailLabels.emailId, existing.map((row) => row.id))).run();
    tx.delete(emails).where(inArray(emails.id, existing.map((row) => row.id))).run();
    const threadIds = [...new Set(existing.map((row) => row.threadId))];
    refreshThreads(tx, threadIds, now);
    for (const threadId of threadIds) {
      const remaining = tx.select({ id: emails.id }).from(emails).where(eq(emails.threadId, threadId)).get();
      if (!remaining) tx.delete(threads).where(eq(threads.id, threadId)).run();
    }
  });

  return existing.length;
}

async function fetchMessageDetails(
  gmailClient: GmailClient,
  accessToken: string,
  messageIds: string[],
): Promise<GmailMessage[]> {
  const messages: GmailMessage[] = [];
  const concurrentRequests = 5;
  for (let index = 0; index < messageIds.length; index += concurrentRequests) {
    const batch = messageIds.slice(index, index + concurrentRequests);
    messages.push(...await Promise.all(batch.map((messageId) => gmailClient.getMessage(accessToken, messageId))));
  }
  return messages;
}

function parseWatchExpiration(value: string | number, now: Date): Date | null {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= now.getTime()) return null;
  return new Date(timestamp);
}

function isHistoryIdAtOrBefore(next: string, current: string): boolean {
  try {
    return BigInt(next) <= BigInt(current);
  } catch {
    return next === current;
  }
}

function mapGmailPushError(error: unknown): GmailPushError {
  if (error instanceof GmailPushError) return error;
  if (error instanceof GmailSyncError) {
    return new GmailPushError(error.message, error.code);
  }
  if (error instanceof GmailApiError) {
    if (error.status === 401 || error.status === 403) {
      return new GmailPushError("Gmail credentials need to be refreshed", "provider_auth_error");
    }
    return new GmailPushError("Gmail provider request failed", "provider_error");
  }
  if (error instanceof Error) {
    return new GmailPushError(error.message, "provider_error");
  }
  return new GmailPushError("Unknown Gmail push sync failure", "provider_error");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
