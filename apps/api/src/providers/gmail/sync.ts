import { asc, desc, eq, sql } from "drizzle-orm";

import type { MailContact, NormalizedMessage } from "@orca/shared";

import { readProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  contacts,
  emailLabels,
  emails,
  labels,
  oauthAccounts,
  threads,
} from "../../db/schema.ts";
import { normalizeGmailLabel, normalizeGmailMessage } from "./normalizer.ts";
import { createGmailClient, GmailApiError, type GmailClient } from "./client.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];
type DatabaseExecutor = Pick<DatabaseClient, "delete" | "insert" | "update" | "select">;

type GmailAccountRecord = {
  id: string;
  provider: string;
  syncCursor: string | null;
};

type SyncCursorState = {
  pageToken: string | null;
  startedAt: string;
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

type SyncOptions = {
  accountId: string;
  cursor?: string | null;
  now?: Date;
  pageSize?: number;
  gmailClient?: GmailClient;
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

export async function syncGmailAccountPage(
  db: DatabaseClient,
  options: SyncOptions,
): Promise<GmailSyncResult> {
  const now = options.now ?? new Date();
  const gmailClient = options.gmailClient ?? createGmailClient();
  const account = getGmailAccount(db, options.accountId);

  const tokenRecord = await readProviderTokens(db, account.id);
  if (!tokenRecord?.accessToken) {
    throw new GmailSyncError("Connected Gmail account is missing provider credentials", "sync_conflict");
  }

  const syncState = resolveSyncCursorState({
    explicitCursor: options.cursor,
    now,
    storedCursor: account.syncCursor,
  });
  const since = new Date(syncState.startedAt);

  let labelList;
  let page;

  try {
    [labelList, page] = await Promise.all([
      gmailClient.listLabels(tokenRecord.accessToken),
      gmailClient.listInboxMessagePage({
        accessToken: tokenRecord.accessToken,
        cursor: syncState.pageToken,
        pageSize: options.pageSize,
        since,
      }),
    ]);
  } catch (error) {
    throw mapGmailError(error);
  }

  let gmailMessages;
  try {
    gmailMessages = await Promise.all(
      page.messageIds.map((messageId) =>
        gmailClient.getMessage(tokenRecord.accessToken as string, messageId),
      ),
    );
  } catch (error) {
    throw mapGmailError(error);
  }

  const normalizedMessages = gmailMessages.map((message) =>
    normalizeGmailMessage(message, { accountId: account.id }),
  );

  const persistedLabels = buildPersistedLabels(account.id, labelList, normalizedMessages);
  const threadIds = [...new Set(normalizedMessages.map((message) => message.threadId))];
  const nowDate = new Date(now);

  db.transaction((tx) => {
    upsertLabels(tx, account.id, persistedLabels, nowDate);
    upsertThreads(tx, normalizedMessages, nowDate);
    upsertEmails(tx, normalizedMessages, nowDate);
    upsertEmailLabels(tx, normalizedMessages, persistedLabels, nowDate);
    upsertContacts(tx, account.id, normalizedMessages, nowDate);
    refreshThreads(tx, threadIds, nowDate);

    tx
      .update(oauthAccounts)
      .set({
        syncCursor: page.nextCursor
          ? JSON.stringify({
              pageToken: page.nextCursor,
              startedAt: syncState.startedAt,
            } satisfies SyncCursorState)
          : null,
        lastSyncedAt: nowDate,
        updatedAt: nowDate,
      })
      .where(eq(oauthAccounts.id, account.id))
      .run();
  });

  return {
    accountId: account.id,
    emailCount: normalizedMessages.length,
    threadCount: threadIds.length,
    labelCount: persistedLabels.length,
    contactCount: collectContacts(normalizedMessages).length,
    nextCursor: page.nextCursor,
    lastSyncedAt: nowDate.toISOString(),
  };
}

function getGmailAccount(db: DatabaseClient, accountId: string): GmailAccountRecord {
  const account = db
    .select({
      id: oauthAccounts.id,
      provider: oauthAccounts.provider,
      syncCursor: oauthAccounts.syncCursor,
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

  for (const labelRow of labelRows) {
    db
      .insert(labels)
      .values({
        ...labelRow,
        accountId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [labels.accountId, labels.providerLabelId],
        set: {
          name: labelRow.name,
          type: labelRow.type,
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

  for (const [threadId, subject] of threadSubjects.entries()) {
    db
      .insert(threads)
      .values({
        id: threadId,
        accountId: normalizedMessages[0]?.raw.accountId ?? "",
        providerThreadId: threadProviderIds.get(threadId) ?? threadId,
        subject,
        latestReceivedAt: new Date(0),
        messageCount: 0,
        isRead: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [threads.accountId, threads.providerThreadId],
        set: {
          subject,
          updatedAt: now,
        },
      })
      .run();
  }
}

function upsertEmails(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedMessage[],
  now: Date,
) {
  for (const message of normalizedMessages) {
    db
      .insert(emails)
      .values({
        id: message.id,
        accountId: message.raw.accountId,
        threadId: message.threadId,
        providerMessageId: message.providerMessageId,
        fromAddress: message.from.email || null,
        fromName: message.from.name,
        subject: message.subject,
        snippet: message.snippet,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        receivedAt: new Date(message.receivedAt),
        internalDate: new Date(message.receivedAt),
        isRead: !message.unread,
        isStarred: message.labels.includes("STARRED"),
        isDraft: message.labels.includes("DRAFT"),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [emails.accountId, emails.providerMessageId],
        set: {
          threadId: message.threadId,
          fromAddress: message.from.email || null,
          fromName: message.from.name,
          subject: message.subject,
          snippet: message.snippet,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          receivedAt: new Date(message.receivedAt),
          internalDate: new Date(message.receivedAt),
          isRead: !message.unread,
          isStarred: message.labels.includes("STARRED"),
          isDraft: message.labels.includes("DRAFT"),
          updatedAt: now,
        },
      })
      .run();
  }
}

function upsertEmailLabels(
  db: DatabaseExecutor,
  normalizedMessages: NormalizedMessage[],
  labelRows: PersistedLabel[],
  now: Date,
) {
  const labelIdByProviderId = new Map(labelRows.map((labelRow) => [labelRow.providerLabelId, labelRow.id]));

  for (const message of normalizedMessages) {
    db.delete(emailLabels).where(eq(emailLabels.emailId, message.id)).run();

    for (const providerLabelId of message.labels) {
      const labelId = labelIdByProviderId.get(providerLabelId);
      if (!labelId) {
        continue;
      }

      db
        .insert(emailLabels)
        .values({
          id: `${message.id}:${labelId}`,
          emailId: message.id,
          labelId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

function upsertContacts(
  db: DatabaseExecutor,
  accountId: string,
  normalizedMessages: NormalizedMessage[],
  now: Date,
) {
  for (const contact of collectContacts(normalizedMessages)) {
    db
      .insert(contacts)
      .values({
        id: buildContactId(accountId, contact.email),
        accountId,
        email: contact.email,
        name: contact.name,
        createdAt: now,
        updatedAt: now,
      })
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

function refreshThreads(db: DatabaseExecutor, threadIds: string[], now: Date) {
  for (const threadId of threadIds) {
    const aggregate = db
      .select({
        threadId: emails.threadId,
        messageCount: sql<number>`count(*)`,
        latestReceivedAt: sql<number>`max(${emails.receivedAt})`,
        unreadCount: sql<number>`sum(case when ${emails.isRead} = 0 then 1 else 0 end)`,
      })
      .from(emails)
      .where(eq(emails.threadId, threadId))
      .groupBy(emails.threadId)
      .get();

    if (!aggregate) {
      continue;
    }

    const latestEmail = db
      .select({
        subject: emails.subject,
      })
      .from(emails)
      .where(eq(emails.threadId, threadId))
      .orderBy(desc(emails.receivedAt), desc(emails.createdAt), asc(emails.id))
      .get();

    db
      .update(threads)
      .set({
        subject: latestEmail?.subject ?? null,
        latestReceivedAt: aggregate.latestReceivedAt
          ? new Date(aggregate.latestReceivedAt)
          : null,
        messageCount: aggregate.messageCount,
        isRead: aggregate.unreadCount === 0,
        updatedAt: now,
      })
      .where(eq(threads.id, threadId))
      .run();
  }
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
  now: Date;
  storedCursor: string | null;
}): SyncCursorState {
  if (input.explicitCursor) {
    return {
      pageToken: input.explicitCursor,
      startedAt: input.now.toISOString(),
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
    };
  }

  return {
    pageToken: null,
    startedAt: new Date(input.now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
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
