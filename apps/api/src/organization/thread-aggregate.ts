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
  const rows = [...eligibleThreadIds].flatMap((threadId) => requiredFacets.map((facet) => ({
        workspaceId: account.workspaceId,
        facetId: facet.id,
        accountId: input.accountId,
        threadId,
        value: facet.defaultValue!,
        updatedAt: input.now,
      })));
  for (let index = 0; index < rows.length; index += 400) {
    db.insert(organizationThreadFacetValues).values(rows.slice(index, index + 400)).onConflictDoNothing().run();
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
  const requestedThreadIds = [...new Set(input.threadIds)];
  if (requestedThreadIds.length === 0) return;
  const aggregates = db.select({
      threadId: emails.threadId,
      messageCount: sql<number>`count(*)`,
      latestReceivedAt: sql<number>`max(${emails.receivedAt})`,
      unreadCount: sql<number>`sum(case when ${emails.isRead} = 0 then 1 else 0 end)`,
    }).from(emails)
      .where(and(eq(emails.accountId, input.accountId), inArray(emails.threadId, requestedThreadIds)))
      .groupBy(emails.threadId)
      .all();
  if (aggregates.length === 0) return;
  const latestSubjects = new Map<string, string | null>();
  for (const message of db.select({ threadId: emails.threadId, subject: emails.subject }).from(emails)
    .where(and(eq(emails.accountId, input.accountId), inArray(emails.threadId, requestedThreadIds)))
    .orderBy(asc(emails.threadId), desc(emails.receivedAt), desc(emails.createdAt), asc(emails.id)).all()) {
    if (!latestSubjects.has(message.threadId)) latestSubjects.set(message.threadId, message.subject);
  }
  const separator = sql.raw(" ");
  db.update(threads).set({
    subject: sql`CASE ${threads.id} ${sql.join(aggregates.map((aggregate) =>
      sql`WHEN ${aggregate.threadId} THEN ${latestSubjects.get(aggregate.threadId) ?? null}`), separator)} ELSE ${threads.subject} END`,
    latestReceivedAt: sql`CASE ${threads.id} ${sql.join(aggregates.map((aggregate) =>
      sql`WHEN ${aggregate.threadId} THEN ${aggregate.latestReceivedAt}`), separator)} ELSE ${threads.latestReceivedAt} END`,
    messageCount: sql`CASE ${threads.id} ${sql.join(aggregates.map((aggregate) =>
      sql`WHEN ${aggregate.threadId} THEN ${aggregate.messageCount}`), separator)} ELSE ${threads.messageCount} END`,
    isRead: sql`CASE ${threads.id} ${sql.join(aggregates.map((aggregate) =>
      sql`WHEN ${aggregate.threadId} THEN ${aggregate.unreadCount === 0}`), separator)} ELSE ${threads.isRead} END`,
    updatedAt: input.now,
  }).where(and(eq(threads.accountId, input.accountId), inArray(threads.id, aggregates.map((aggregate) => aggregate.threadId)))).run();
  initializeRequiredFacetDefaults(db, input);
}
