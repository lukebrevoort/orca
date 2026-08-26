import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  facetCardinalitySchema,
  orcaCompiledRuleRevisionSchema,
  orcaEvaluationTraceSchema,
  type OrcaEvaluationEventKind,
  type OrcaEvaluationTrace,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads,
  collections,
  emails,
  oauthAccounts,
  organizationEvaluationTraces,
  organizationFacets,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import { createSqliteOrganizationLanesRepository } from "../lanes/sqlite-repository.ts";
import { gmailSyncOrganizationCapability, type OrganizationSystemCapabilityAdapter } from "../system-capability.ts";
import { applyAuthorizedEvaluationProjection } from "./evaluation-projection-sqlite.ts";
import { evaluateOrcaRules, type OrcaActiveRuleRevision, type OrcaEvaluationInput } from "./evaluator.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export const orcaLiveEvaluationBudgets = Object.freeze({
  maximumRuleRevisions: 100,
  maximumPredicateSteps: 2_000,
  maximumCandidates: 1_000,
  maximumPredicateDepth: 16,
});

function activeRuleSet(db: Database, workspaceId: string): { id: string; revision: number; activeRevisionCount: number; revisions: OrcaActiveRuleRevision[] } {
  const ruleSetRevision = db.select({ revision: organizationRuleSets.revision }).from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, workspaceId)).get()?.revision ?? 1;
  const activeRevisionCount = db.select({ count: sql<number>`count(*)` })
    .from(organizationRules)
    .innerJoin(organizationRuleRevisions, and(
      eq(organizationRuleRevisions.workspaceId, organizationRules.workspaceId),
      eq(organizationRuleRevisions.ruleId, organizationRules.id),
      eq(organizationRuleRevisions.id, organizationRules.activeRevisionId),
    ))
    .where(eq(organizationRules.workspaceId, workspaceId))
    .get()?.count ?? 0;
  const rows = db.select({ rule: organizationRules, revision: organizationRuleRevisions })
    .from(organizationRules)
    .innerJoin(organizationRuleRevisions, and(
      eq(organizationRuleRevisions.workspaceId, organizationRules.workspaceId),
      eq(organizationRuleRevisions.ruleId, organizationRules.id),
      eq(organizationRuleRevisions.id, organizationRules.activeRevisionId),
    ))
    .where(eq(organizationRules.workspaceId, workspaceId))
    .orderBy(asc(organizationRules.position))
    .limit(orcaLiveEvaluationBudgets.maximumRuleRevisions + 1)
    .all();
  const revisions = rows.slice(0, orcaLiveEvaluationBudgets.maximumRuleRevisions).map((row): OrcaActiveRuleRevision => ({
    ruleId: row.rule.id,
    revisionId: row.revision.id,
    revision: row.revision.revision,
    order: row.rule.position,
    compiled: orcaCompiledRuleRevisionSchema.parse(JSON.parse(row.revision.compiledJson)),
  }));
  return {
    id: `active-rule-set:${workspaceId}`,
    revision: ruleSetRevision,
    activeRevisionCount,
    revisions,
  };
}

export function loadLiveEvaluationInput(db: Database, input: { accountId: string; messageId: string; eventKind: OrcaEvaluationEventKind }, capabilityAdapter: OrganizationSystemCapabilityAdapter = gmailSyncOrganizationCapability): OrcaEvaluationInput | null {
  const account = db.select().from(oauthAccounts).where(eq(oauthAccounts.id, input.accountId)).get();
  const message = db.select().from(emails).where(and(eq(emails.accountId, input.accountId), eq(emails.id, input.messageId))).get();
  if (!account || !message) return null;
  const thread = db.select().from(threads).where(and(eq(threads.accountId, input.accountId), eq(threads.id, message.threadId))).get();
  if (!thread) return null;
  const state = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, account.userId)).get();
  const laneSnapshot = createSqliteOrganizationLanesRepository(db).getSnapshot(account.userId, [input.accountId]);
  const lanePlacement = laneSnapshot.placements.find((placement) => placement.accountId === input.accountId && placement.threadId === thread.id);
  if (!lanePlacement) return null;
  const facets = db.select().from(organizationFacets).where(eq(organizationFacets.workspaceId, account.userId)).orderBy(asc(organizationFacets.position), asc(organizationFacets.id)).all();
  const facetValues = db.select().from(organizationThreadFacetValues).where(and(
    eq(organizationThreadFacetValues.workspaceId, account.userId), eq(organizationThreadFacetValues.accountId, input.accountId), eq(organizationThreadFacetValues.threadId, thread.id),
  )).all();
  const workflow = db.select().from(organizationThreadWorkflowStates).where(and(
    eq(organizationThreadWorkflowStates.workspaceId, account.userId), eq(organizationThreadWorkflowStates.accountId, input.accountId), eq(organizationThreadWorkflowStates.threadId, thread.id),
  )).get();
  const organizationState = db.select().from(organizationThreadStates).where(and(
    eq(organizationThreadStates.workspaceId, account.userId), eq(organizationThreadStates.accountId, input.accountId), eq(organizationThreadStates.threadId, thread.id),
  )).get();
  const memberships = db.select({ id: collections.id }).from(collectionThreads)
    .innerJoin(collections, eq(collections.id, collectionThreads.collectionId))
    .where(and(eq(collectionThreads.threadId, thread.id), eq(collections.accountId, input.accountId))).orderBy(asc(collections.id)).all();
  const contexts = db.select({ id: organizationThreadContextRelationships.contextId }).from(organizationThreadContextRelationships).where(and(
    eq(organizationThreadContextRelationships.workspaceId, account.userId), eq(organizationThreadContextRelationships.accountId, input.accountId), eq(organizationThreadContextRelationships.threadId, thread.id),
  )).orderBy(asc(organizationThreadContextRelationships.contextId)).all();
  const receivedAt = (message.receivedAt ?? thread.latestReceivedAt ?? new Date(0)).toISOString();
  const senderEmail = message.fromAddress?.trim().toLocaleLowerCase() ?? null;
  return {
    event: {
      id: `${input.eventKind}:${message.id}`,
      kind: input.eventKind,
      cause: "provider",
      occurredAt: receivedAt,
      workspaceId: account.userId,
      accountId: input.accountId,
      threadId: thread.id,
      messageId: message.id,
    },
    thread: {
      workspaceId: account.userId,
      accountId: input.accountId,
      id: thread.id,
      subject: message.subject ?? thread.subject,
      sender: senderEmail ? { email: senderEmail, domain: senderEmail.split("@")[1] ?? "" } : null,
      messageCount: thread.messageCount,
      unread: !thread.isRead,
      latestReceivedAt: thread.latestReceivedAt?.toISOString() ?? null,
      humanSignal: message.humanSignal,
      facets: Object.fromEntries(facetValues.map((value) => [value.facetId, JSON.parse(value.value) as string | number | boolean])),
      workflowStateId: workflow?.stateId ?? null,
      collectionIds: memberships.map((membership) => membership.id),
      contextIds: contexts.map((context) => context.id),
      lanePlacement,
      organizationRevision: organizationState?.revision ?? null,
    },
    workspaceSchema: {
      workspaceId: account.userId,
      revision: state?.revision ?? 1,
      fallbackLaneId: laneSnapshot.configuration.fallbackLaneId,
      lanes: laneSnapshot.configuration.lanes.filter((lane) => lane.retiredAt === null).map((lane) => ({ id: lane.id, name: lane.name, defaultPolicyId: lane.defaultPolicyId })),
      lanePolicies: laneSnapshot.configuration.policies.map((policy) => ({ id: policy.id, interruption: policy.interruption, review: policy.review, retention: policy.retention })),
      facets: facets.filter((facet) => facet.retiredAt === null).map((facet) => ({ id: facet.id, cardinality: facetCardinalitySchema.parse(JSON.parse(facet.cardinality)).kind })),
    },
    ruleSet: activeRuleSet(db, account.userId),
    actor: { id: "system:gmail-sync", type: "system" },
    capabilities: capabilityAdapter.snapshot({ workspaceId: account.userId, accountId: input.accountId }),
    logicalTime: receivedAt,
    budgets: orcaLiveEvaluationBudgets,
  };
}

export function evaluateAndPersistLiveContext(
  db: Database,
  context: OrcaEvaluationInput,
  capabilityAdapter: OrganizationSystemCapabilityAdapter = gmailSyncOrganizationCapability,
): OrcaEvaluationTrace {
  const result = evaluateOrcaRules(context);
  // Exhaustion is reportable in memory but is never durable evaluation
  // evidence: persisting either the fallback projection or its Trace would
  // make a partial evaluator outcome indistinguishable from a complete one.
  if (result.trace.budget.exhausted) return result.trace;
  db.transaction((transaction) => {
    const executor = transaction as unknown as Database;
    applyAuthorizedEvaluationProjection(executor, context, result, capabilityAdapter);
    executor.insert(organizationEvaluationTraces).values({
      workspaceId: context.thread.workspaceId,
      id: result.trace.id,
      accountId: context.thread.accountId,
      threadId: context.thread.id,
      eventId: context.event.id,
      eventKind: context.event.kind,
      ruleSetRevision: context.ruleSet.revision,
      traceJson: JSON.stringify(result.trace),
      actionsJson: JSON.stringify(result.actions),
      logicalTime: new Date(context.logicalTime),
      createdAt: new Date(context.logicalTime),
    }).run();
  });
  return result.trace;
}

export function evaluateLiveMessageRules(db: Database, input: {
  accountId: string;
  events: readonly { messageId: string; kind: "message.received" | "thread.updated" }[];
  capabilityAdapter?: OrganizationSystemCapabilityAdapter;
}): OrcaEvaluationTrace[] {
  const capabilityAdapter = input.capabilityAdapter ?? gmailSyncOrganizationCapability;
  const eventKindByMessageId = new Map(input.events.map((event) => [event.messageId, event.kind]));
  const messageIds = [...eventKindByMessageId.keys()];
  const messages = messageIds.length === 0 ? [] : db.select({ id: emails.id, receivedAt: emails.receivedAt }).from(emails)
    .where(and(eq(emails.accountId, input.accountId), inArray(emails.id, messageIds)))
    .orderBy(asc(emails.receivedAt), asc(emails.id)).all();
  const traces: OrcaEvaluationTrace[] = [];
  for (const message of messages) {
    const eventKind = eventKindByMessageId.get(message.id);
    if (!eventKind) continue;
    const context = loadLiveEvaluationInput(db, { accountId: input.accountId, messageId: message.id, eventKind }, capabilityAdapter);
    if (!context) continue;
    const existing = db.select({ traceJson: organizationEvaluationTraces.traceJson }).from(organizationEvaluationTraces).where(and(
      eq(organizationEvaluationTraces.workspaceId, context.thread.workspaceId), eq(organizationEvaluationTraces.eventId, context.event.id),
    )).get();
    if (existing) { traces.push(orcaEvaluationTraceSchema.parse(JSON.parse(existing.traceJson))); continue; }
    traces.push(evaluateAndPersistLiveContext(db, context, capabilityAdapter));
  }
  return traces;
}

export function getLatestOrcaEvaluationTrace(db: Database, input: { workspaceId: string; accountId?: string; threadId?: string }): OrcaEvaluationTrace | null {
  const row = db.select({ traceJson: organizationEvaluationTraces.traceJson }).from(organizationEvaluationTraces).where(and(
    eq(organizationEvaluationTraces.workspaceId, input.workspaceId),
    ...(input.accountId ? [eq(organizationEvaluationTraces.accountId, input.accountId)] : []),
    ...(input.threadId ? [eq(organizationEvaluationTraces.threadId, input.threadId)] : []),
  )).orderBy(desc(organizationEvaluationTraces.logicalTime), desc(organizationEvaluationTraces.id)).get();
  return row ? orcaEvaluationTraceSchema.parse(JSON.parse(row.traceJson)) : null;
}
