import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  facetCardinalitySchema,
  facetValueTypeSchema,
  orcaCompilationWorkspaceSchema,
  orcaCompiledRuleRevisionSchema,
  orcaEvaluatorLimits,
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
  organizationContextTypes,
  organizationContexts,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkspaceStates,
  organizationWorkflowStates,
  threads,
} from "../../db/schema.ts";
import { createSqliteOrganizationLanesRepository } from "../lanes/sqlite-repository.ts";
import { gmailSyncOrganizationCapability, type OrganizationSystemCapabilityAdapter } from "../system-capability.ts";
import { applyAuthorizedEvaluationProjection } from "./evaluation-projection-sqlite.ts";
import { evaluateOrcaRules, type OrcaActiveRuleRevision, type OrcaEvaluationInput } from "./evaluator.ts";
import { decodePersistedOrcaEvaluationTrace } from "./persisted-trace.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export const orcaLiveEvaluationBudgets = orcaEvaluatorLimits;

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
    compilationWorkspace: row.revision.compilationWorkspaceJson
      ? orcaCompilationWorkspaceSchema.parse(JSON.parse(row.revision.compilationWorkspaceJson))
      : undefined,
  }));
  return {
    id: `active-rule-set:${workspaceId}`,
    revision: ruleSetRevision,
    activeRevisionCount,
    revisions,
  };
}

function referencedCatalogIds(ruleSet: ReturnType<typeof activeRuleSet>): {
  workflowStates: Set<string>;
  facets: Set<string>;
  collections: Set<string>;
  contextTypes: Set<string>;
  contexts: Set<string>;
} {
  const ids = {
    workflowStates: new Set<string>(),
    facets: new Set<string>(),
    collections: new Set<string>(),
    contextTypes: new Set<string>(),
    contexts: new Set<string>(),
  };
  for (const revision of ruleSet.revisions) {
    for (const { expression } of revision.compiled.predicates) {
      if ("facetId" in expression && expression.facetId) ids.facets.add(expression.facetId);
    }
    for (const action of revision.compiled.actions) {
      if (action.kind === "set_workflow_state") ids.workflowStates.add(action.stateId);
      else if (action.kind === "set_facet" || action.kind === "unset_facet") ids.facets.add(action.facetId);
      else if (action.kind === "add_collection" || action.kind === "remove_collection") ids.collections.add(action.collectionId);
      else if (action.kind === "link_context" || action.kind === "unlink_context") {
        ids.contextTypes.add(action.contextTypeId);
        ids.contexts.add(action.contextId);
      }
    }
  }
  return ids;
}

export function loadLiveEvaluationInput(db: Database, input: { accountId: string; messageId: string; eventKind: "message.received" | "thread.updated" | "user.corrected" }, capabilityAdapter: OrganizationSystemCapabilityAdapter = gmailSyncOrganizationCapability): OrcaEvaluationInput | null {
  const account = db.select().from(oauthAccounts).where(eq(oauthAccounts.id, input.accountId)).get();
  const message = db.select().from(emails).where(and(eq(emails.accountId, input.accountId), eq(emails.id, input.messageId))).get();
  if (!account || !message) return null;
  const thread = db.select().from(threads).where(and(eq(threads.accountId, input.accountId), eq(threads.id, message.threadId))).get();
  if (!thread) return null;
  const state = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, account.userId)).get();
  const laneSnapshot = createSqliteOrganizationLanesRepository(db).getSnapshot(account.userId, [input.accountId]);
  const lanePlacement = laneSnapshot.placements.find((placement) => placement.accountId === input.accountId && placement.threadId === thread.id);
  if (!lanePlacement) return null;
  const ruleSet = activeRuleSet(db, account.userId);
  const referenced = referencedCatalogIds(ruleSet);
  const facetIds = [...referenced.facets];
  const facets = facetIds.length === 0 ? [] : db.select().from(organizationFacets).where(and(
    eq(organizationFacets.workspaceId, account.userId),
    inArray(organizationFacets.id, facetIds),
    isNull(organizationFacets.retiredAt),
  )).orderBy(asc(organizationFacets.position), asc(organizationFacets.id)).all();
  const workflowStateIds = [...referenced.workflowStates];
  const workflowStates = workflowStateIds.length === 0 ? [] : db.select({ id: organizationWorkflowStates.id, name: organizationWorkflowStates.name }).from(organizationWorkflowStates)
    .where(and(eq(organizationWorkflowStates.workspaceId, account.userId), inArray(organizationWorkflowStates.id, workflowStateIds), isNull(organizationWorkflowStates.retiredAt)))
    .orderBy(asc(organizationWorkflowStates.position), asc(organizationWorkflowStates.id)).all();
  const collectionIds = [...referenced.collections];
  const workspaceCollections = collectionIds.length === 0 ? [] : db.select({ id: collections.id, name: collections.name, accountId: collections.accountId }).from(collections)
    .innerJoin(oauthAccounts, and(eq(oauthAccounts.id, collections.accountId), eq(oauthAccounts.userId, account.userId)))
    .where(inArray(collections.id, collectionIds))
    .orderBy(asc(collections.accountId), asc(collections.position), asc(collections.id)).all();
  const contextTypeIds = [...referenced.contextTypes];
  const contextTypes = contextTypeIds.length === 0 ? [] : db.select({ id: organizationContextTypes.id, name: organizationContextTypes.name }).from(organizationContextTypes)
    .where(and(eq(organizationContextTypes.workspaceId, account.userId), inArray(organizationContextTypes.id, contextTypeIds), isNull(organizationContextTypes.retiredAt)))
    .orderBy(asc(organizationContextTypes.position), asc(organizationContextTypes.id)).all();
  const contextIds = [...referenced.contexts];
  const workspaceContexts = contextIds.length === 0 ? [] : db.select({ id: organizationContexts.id, name: organizationContexts.name, contextTypeId: organizationContexts.contextTypeId }).from(organizationContexts)
    .where(and(eq(organizationContexts.workspaceId, account.userId), inArray(organizationContexts.id, contextIds), isNull(organizationContexts.retiredAt)))
    .orderBy(asc(organizationContexts.id)).all();
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
    event: input.eventKind === "message.received" ? {
      id: `${input.eventKind}:${message.id}`,
      kind: input.eventKind,
      cause: "provider",
      occurredAt: receivedAt,
      workspaceId: account.userId,
      accountId: input.accountId,
      threadId: thread.id,
      messageId: message.id,
    } : input.eventKind === "thread.updated" ? {
      id: `${input.eventKind}:${message.id}`,
      kind: input.eventKind,
      cause: "provider",
      occurredAt: receivedAt,
      workspaceId: account.userId,
      accountId: input.accountId,
      threadId: thread.id,
    } : {
      id: `${input.eventKind}:${message.id}`,
      kind: input.eventKind,
      cause: "user",
      occurredAt: receivedAt,
      workspaceId: account.userId,
      accountId: input.accountId,
      threadId: thread.id,
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
      workflowStates,
      facets: facets.filter((facet) => facet.retiredAt === null).map((facet) => ({
        id: facet.id,
        name: facet.name,
        valueType: facetValueTypeSchema.parse(JSON.parse(facet.valueType)),
        cardinality: facetCardinalitySchema.parse(JSON.parse(facet.cardinality)).kind,
        optional: facet.isOptional,
      })),
      collections: workspaceCollections,
      contextTypes,
      contexts: workspaceContexts,
    },
    ruleSet,
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
  options?: { alreadyInTransaction?: boolean; onPersist?: (executor: Database, trace: OrcaEvaluationTrace) => void },
): OrcaEvaluationTrace {
  const result = evaluateOrcaRules(context);
  // Exhaustion is reportable in memory but is never durable evaluation
  // evidence: persisting either the fallback projection or its Trace would
  // make a partial evaluator outcome indistinguishable from a complete one.
  if (result.trace.budget.exhausted) return result.trace;
  const persist = (executor: Database) => {
    applyAuthorizedEvaluationProjection(executor, context, result, capabilityAdapter, { alreadyInTransaction: true });
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
    options?.onPersist?.(executor, result.trace);
  };
  if (options?.alreadyInTransaction) persist(db);
  else db.transaction((transaction) => persist(transaction as unknown as Database));
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
    if (existing) { traces.push(decodePersistedOrcaEvaluationTrace(JSON.parse(existing.traceJson))); continue; }
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
  return row ? decodePersistedOrcaEvaluationTrace(JSON.parse(row.traceJson)) : null;
}
