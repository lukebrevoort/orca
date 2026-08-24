import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { createDatabaseClient } from "../db/client.ts";
import { emails, threads } from "../db/schema.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type DatabaseExecutor = Pick<Database, "select" | "update">;

/**
 * Organization-owned projection of message facts into Thread aggregate truth.
 * The explicit Account predicate is applied to every read and write so a
 * provider adapter cannot refresh a Thread outside its sync scope.
 */
export function refreshThreadAggregates(
  db: DatabaseExecutor,
  input: { accountId: string; threadIds: readonly string[]; now: Date },
): void {
  for (const threadId of new Set(input.threadIds)) {
    const aggregate = db.select({
      threadId: emails.threadId,
      messageCount: sql<number>`count(*)`,
      latestReceivedAt: sql<number>`max(${emails.receivedAt})`,
      unreadCount: sql<number>`sum(case when ${emails.isRead} = 0 then 1 else 0 end)`,
    }).from(emails)
      .where(and(eq(emails.accountId, input.accountId), eq(emails.threadId, threadId)))
      .groupBy(emails.threadId)
      .get();
    if (!aggregate) continue;

    const latestEmail = db.select({ subject: emails.subject }).from(emails)
      .where(and(eq(emails.accountId, input.accountId), eq(emails.threadId, threadId)))
      .orderBy(desc(emails.receivedAt), desc(emails.createdAt), asc(emails.id))
      .get();
    db.update(threads).set({
      subject: latestEmail?.subject ?? null,
      latestReceivedAt: aggregate.latestReceivedAt ? new Date(aggregate.latestReceivedAt) : null,
      messageCount: aggregate.messageCount,
      isRead: aggregate.unreadCount === 0,
      updatedAt: input.now,
    }).where(and(eq(threads.accountId, input.accountId), eq(threads.id, threadId))).run();
  }
}
