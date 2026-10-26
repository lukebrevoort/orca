import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { createDatabaseClient } from "../db/client.ts";
import { agentEvents, emails, oauthAccounts, threadReminders, threads } from "../db/schema.ts";
import { summaryMessageLimit, summaryWindowMs, type SummaryInput } from "./rules.ts";

type Db = ReturnType<typeof createDatabaseClient>["db"];
/** Read a single owned account in a consistent snapshot. Message text fields are truncated in
 * SQL, before materialization. All windows and auxiliary lists are bounded. */
export function querySummary(db: Db, userId: string, accountId: string, now: Date): SummaryInput {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid summary time");
  return db.transaction(tx => {
    const account = tx.select({ id: oauthAccounts.id, userId: oauthAccounts.userId, providerEmail: oauthAccounts.providerEmail }).from(oauthAccounts)
      .where(and(eq(oauthAccounts.id, accountId), eq(oauthAccounts.userId, userId))).get();
    if (!account) throw new Error("Mail account was not found");
    const messageProjection = { id: emails.id, accountId: emails.accountId, threadId: emails.threadId, fromAddress: emails.fromAddress,
      toRecipients: emails.toRecipients, subject: sql<string | null>`substr(${emails.subject}, 1, 300)`, snippet: sql<string | null>`substr(${emails.snippet}, 1, 500)`,
      bodyText: sql<string | null>`substr(${emails.bodyText}, 1, 20000)`, receivedAt: emails.receivedAt, isRead: emails.isRead,
      humanSignal: emails.humanSignal, humanClassification: emails.humanClassification, humanClassificationReasons: emails.humanClassificationReasons,
    };
    const messages = tx.select(messageProjection).from(emails).innerJoin(threads, and(eq(threads.id, emails.threadId), eq(threads.accountId, accountId)))
      .where(and(eq(emails.accountId, accountId), eq(emails.isDraft, false), gte(emails.receivedAt, new Date(now.getTime() - summaryWindowMs)), lte(emails.receivedAt, now)))
      .orderBy(desc(emails.receivedAt), desc(emails.id)).limit(summaryMessageLimit).all();
    const events = tx.select({ accountId: agentEvents.accountId, ownerUserId: agentEvents.ownerUserId, messageId: agentEvents.messageId,
      threadId: agentEvents.threadId, lifecycleState: agentEvents.lifecycleState, title: agentEvents.title, whyThisMatters: agentEvents.whyThisMatters, sourceMessage: messageProjection,
    }).from(agentEvents).innerJoin(emails, and(eq(emails.isDraft, false), eq(emails.id, agentEvents.messageId), eq(emails.threadId, agentEvents.threadId), eq(emails.accountId, accountId)))
      .innerJoin(threads, and(eq(threads.id, agentEvents.threadId), eq(threads.accountId, accountId))).where(and(eq(agentEvents.accountId, accountId), eq(agentEvents.ownerUserId, userId), inArray(agentEvents.lifecycleState, ["new", "seen"])))
      .orderBy(desc(agentEvents.updatedAt), desc(agentEvents.id)).limit(summaryMessageLimit).all();
    const reminders = tx.select({ accountId: threadReminders.accountId, threadId: threadReminders.threadId, status: threadReminders.status, sourceMessage: messageProjection })
      .from(threadReminders).innerJoin(threads, and(eq(threads.id, threadReminders.threadId), eq(threads.accountId, accountId)))
      .innerJoin(emails, and(eq(emails.isDraft, false), eq(emails.accountId, accountId), eq(emails.threadId, threadReminders.threadId), sql`${emails.id} = (SELECT latest.id FROM emails latest WHERE latest.account_id = ${accountId} AND latest.thread_id = ${threadReminders.threadId} AND latest.is_draft = 0 AND latest.received_at <= ${now.getTime()} ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1)`))
      .where(and(eq(threadReminders.accountId, accountId), inArray(threadReminders.status, ["scheduled", "resurfaced"])))
      .orderBy(desc(threadReminders.updatedAt), desc(threadReminders.id)).limit(summaryMessageLimit).all();
    return { userId, account, messages, events, reminders };
  }, { behavior: "deferred" });
}
