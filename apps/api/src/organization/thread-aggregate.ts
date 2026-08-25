import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, organizationFacets, organizationThreadFacetValues, threads } from "../db/schema.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type DatabaseExecutor = Pick<Database, "insert" | "select" | "update">;

function initializeRequiredFacetDefaults(
  db: DatabaseExecutor,
  input: { accountId: string; threadIds: readonly string[]; now: Date },
): void {
  const account = db.select({ workspaceId: oauthAccounts.userId }).from(oauthAccounts)
    .where(eq(oauthAccounts.id, input.accountId)).get();
  if (!account) return;
  const requestedThreadIds = [...new Set(input.threadIds)];
  if (requestedThreadIds.length === 0) return;
  const eligibleThreadIds = new Set(db.select({ id: threads.id }).from(threads).where(and(
    eq(threads.accountId, input.accountId),
    inArray(threads.id, requestedThreadIds),
  )).all().map((thread) => thread.id));
  const requiredFacets = db.select({
    id: organizationFacets.id,
    defaultValue: organizationFacets.defaultValue,
    isOptional: organizationFacets.isOptional,
    retiredAt: organizationFacets.retiredAt,
  }).from(organizationFacets)
    .where(eq(organizationFacets.workspaceId, account.workspaceId)).all()
    .filter((facet) => !facet.isOptional && facet.retiredAt === null && facet.defaultValue !== null);
  for (const threadId of eligibleThreadIds) {
    for (const facet of requiredFacets) {
      db.insert(organizationThreadFacetValues).values({
        workspaceId: account.workspaceId,
        facetId: facet.id,
        accountId: input.accountId,
        threadId,
        value: facet.defaultValue!,
        updatedAt: input.now,
      }).onConflictDoNothing().run();
    }
  }
}

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
  initializeRequiredFacetDefaults(db, input);
}
