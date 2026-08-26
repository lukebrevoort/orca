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
  organizationContextRelationshipTypes,
  organizationEvaluationTraces,
  organizationFacets,
  organizationLanePolicies,
  organizationLanes,
  organizationRuleRevisions,
  organizationRules,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import { createSqliteOrganizationLanesRepository } from "../lanes/sqlite-repository.ts";
import { evaluateOrcaRules, type OrcaActiveRuleRevision, type OrcaEvaluationInput } from "./evaluator.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export const orcaLiveEvaluationBudgets = Object.freeze({
  maximumRuleRevisions: 100,
  maximumPredicateSteps: 2_000,
  maximumCandidates: 1_000,
  maximumPredicateDepth: 16,
});

function stableRuleSetRevision(revisions: readonly OrcaActiveRuleRevision[]): number {
  let hash = 2_166_136_261;
  const semanticIdentity = revisions.map((revision) => `${revision.order}:${revision.ruleId}:${revision.revisionId}:${revision.revision}`).join("\n");
  for (let index = 0; index < semanticIdentity.length; index += 1) {
    hash ^= semanticIdentity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return Math.max(1, hash);
}

function activeRuleSet(db: Database, workspaceId: string): { id: string; revision: number; revisions: OrcaActiveRuleRevision[] } {
  const rows = db.select({ rule: organizationRules, revision: organizationRuleRevisions })
    .from(organizationRules)
    .innerJoin(organizationRuleRevisions, and(
      eq(organizationRuleRevisions.workspaceId, organizationRules.workspaceId),
      eq(organizationRuleRevisions.ruleId, organizationRules.id),
      eq(organizationRuleRevisions.id, organizationRules.activeRevisionId),
    ))
    .where(eq(organizationRules.workspaceId, workspaceId))
    .orderBy(asc(organizationRules.createdAt), asc(organizationRules.id))
    .all();
  const revisions = rows.map((row, order): OrcaActiveRuleRevision => ({
    ruleId: row.rule.id,
    revisionId: row.revision.id,
    revision: row.revision.revision,
    order,
    compiled: orcaCompiledRuleRevisionSchema.parse(JSON.parse(row.revision.compiledJson)),
  }));
  return { id: `active-rule-set:${workspaceId}`, revision: stableRuleSetRevision(revisions), revisions };
}

function lowerLaneCandidate(trace: OrcaEvaluationTrace) {
  return [...trace.candidates]
    .filter((candidate) => candidate.slot === "lane" && candidate.authorized && ["rule_revision", "lane_policy", "workspace_fallback"].includes(candidate.precedence))
    .sort((left, right) => {
      const rank = { rule_revision: 3, lane_policy: 4, workspace_fallback: 5 } as const;
      return rank[left.precedence as keyof typeof rank] - rank[right.precedence as keyof typeof rank]
        || left.ruleOrder - right.ruleOrder || left.actionOrder - right.actionOrder || left.candidateId.localeCompare(right.candidateId);
    })[0];
}

function applyResolvedActions(db: Database, input: OrcaEvaluationInput, trace: OrcaEvaluationTrace): void {
  const logicalTime = new Date(input.logicalTime);
  let projected = false;
  const laneCandidate = lowerLaneCandidate(trace);
  const laneWinner = trace.winners.find((winner) => winner.slot === "lane");
  if (laneWinner?.precedence !== "safety_lock" && laneCandidate?.action.kind === "route_lane") {
    db.update(organizationThreadLaneStates).set({
      primaryLaneId: laneCandidate.action.laneId,
      placementSource: laneCandidate.precedence,
      sourceId: laneCandidate.revisionId ?? laneCandidate.action.laneId,
      actorId: laneCandidate.actor.id,
      actorType: laneCandidate.actor.type,
      reason: laneCandidate.reason,
      revision: sql`${organizationThreadLaneStates.revision} + 1`,
      updatedAt: logicalTime,
    }).where(and(
      eq(organizationThreadLaneStates.workspaceId, input.thread.workspaceId),
      eq(organizationThreadLaneStates.accountId, input.thread.accountId),
      eq(organizationThreadLaneStates.threadId, input.thread.id),
    )).run();
    projected = true;
  }

  for (const action of trace.winners.map((winner) => winner.action)) {
    if (action.kind === "set_workflow_state") {
      db.insert(organizationThreadWorkflowStates).values({
        workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id,
        stateId: action.stateId, updatedAt: logicalTime,
      }).onConflictDoUpdate({
        target: [organizationThreadWorkflowStates.workspaceId, organizationThreadWorkflowStates.accountId, organizationThreadWorkflowStates.threadId],
        set: { stateId: action.stateId, updatedAt: logicalTime },
      }).run();
      projected = true;
    } else if (action.kind === "set_facet") {
      db.insert(organizationThreadFacetValues).values({
        workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id,
        facetId: action.facetId, value: JSON.stringify(action.value), updatedAt: logicalTime,
      }).onConflictDoUpdate({
        target: [organizationThreadFacetValues.workspaceId, organizationThreadFacetValues.facetId, organizationThreadFacetValues.accountId, organizationThreadFacetValues.threadId],
        set: { value: JSON.stringify(action.value), updatedAt: logicalTime },
      }).run();
      projected = true;
    } else if (action.kind === "unset_facet") {
      db.delete(organizationThreadFacetValues).where(and(
        eq(organizationThreadFacetValues.workspaceId, input.thread.workspaceId),
        eq(organizationThreadFacetValues.accountId, input.thread.accountId),
        eq(organizationThreadFacetValues.threadId, input.thread.id),
        eq(organizationThreadFacetValues.facetId, action.facetId),
      )).run();
      projected = true;
    } else if (action.kind === "add_collection") {
      db.insert(collectionThreads).values({
        id: `${trace.id}:collection:${action.collectionId}`,
        collectionId: action.collectionId,
        threadId: input.thread.id,
        createdAt: logicalTime,
      }).onConflictDoNothing().run();
      projected = true;
    } else if (action.kind === "remove_collection") {
      db.delete(collectionThreads).where(and(eq(collectionThreads.collectionId, action.collectionId), eq(collectionThreads.threadId, input.thread.id))).run();
      projected = true;
    } else if (action.kind === "link_context") {
      const relationshipType = db.select().from(organizationContextRelationshipTypes).where(and(
        eq(organizationContextRelationshipTypes.workspaceId, input.thread.workspaceId),
        eq(organizationContextRelationshipTypes.contextTypeId, action.contextTypeId),
        eq(organizationContextRelationshipTypes.direction, "thread_to_context"),
      )).orderBy(asc(organizationContextRelationshipTypes.position), asc(organizationContextRelationshipTypes.id)).get();
      if (relationshipType) {
        db.insert(organizationThreadContextRelationships).values({
          workspaceId: input.thread.workspaceId,
          id: `${trace.id}:context:${action.contextId}:${relationshipType.id}`,
          accountId: input.thread.accountId,
          threadId: input.thread.id,
          contextTypeId: action.contextTypeId,
          contextId: action.contextId,
          relationshipTypeId: relationshipType.id,
          direction: "thread_to_context",
          revision: 1,
          createdAt: logicalTime,
          updatedAt: logicalTime,
        }).onConflictDoNothing().run();
        projected = true;
      }
    } else if (action.kind === "unlink_context") {
      db.delete(organizationThreadContextRelationships).where(and(
        eq(organizationThreadContextRelationships.workspaceId, input.thread.workspaceId),
        eq(organizationThreadContextRelationships.accountId, input.thread.accountId),
        eq(organizationThreadContextRelationships.threadId, input.thread.id),
        eq(organizationThreadContextRelationships.contextTypeId, action.contextTypeId),
        eq(organizationThreadContextRelationships.contextId, action.contextId),
      )).run();
      projected = true;
    }
  }

  if (projected) {
    db.insert(organizationThreadStates).values({
      workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id, revision: 1, updatedAt: logicalTime,
    }).onConflictDoUpdate({
      target: [organizationThreadStates.workspaceId, organizationThreadStates.accountId, organizationThreadStates.threadId],
      set: { revision: sql`${organizationThreadStates.revision} + 1`, updatedAt: logicalTime },
    }).run();
  }
}

function evaluationInput(db: Database, input: { accountId: string; messageId: string; eventKind: OrcaEvaluationEventKind }): OrcaEvaluationInput | null {
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
    capabilities: {
      id: `system:gmail-sync:${input.accountId}`,
      revision: 1,
      actor: { id: "system:gmail-sync", type: "system" },
      scope: { workspaceId: account.userId, accountIds: [input.accountId] },
      operations: ["apply"],
      resourceFamilies: ["mail", "thread", "lane", "collection", "facet", "context", "workflow_state", "trace", "change_set"],
      actionFamilies: ["organization_thread", "organization_attention"],
    },
    logicalTime: receivedAt,
    budgets: orcaLiveEvaluationBudgets,
  };
}

export function evaluateLiveMessageRules(db: Database, input: {
  accountId: string;
  events: readonly { messageId: string; kind: "message.received" | "thread.updated" }[];
}): OrcaEvaluationTrace[] {
  const eventKindByMessageId = new Map(input.events.map((event) => [event.messageId, event.kind]));
  const messageIds = [...eventKindByMessageId.keys()];
  const messages = messageIds.length === 0 ? [] : db.select({ id: emails.id, receivedAt: emails.receivedAt }).from(emails)
    .where(and(eq(emails.accountId, input.accountId), inArray(emails.id, messageIds)))
    .orderBy(asc(emails.receivedAt), asc(emails.id)).all();
  const traces: OrcaEvaluationTrace[] = [];
  for (const message of messages) {
    const eventKind = eventKindByMessageId.get(message.id);
    if (!eventKind) continue;
    const context = evaluationInput(db, { accountId: input.accountId, messageId: message.id, eventKind });
    if (!context) continue;
    const existing = db.select({ traceJson: organizationEvaluationTraces.traceJson }).from(organizationEvaluationTraces).where(and(
      eq(organizationEvaluationTraces.workspaceId, context.thread.workspaceId), eq(organizationEvaluationTraces.eventId, context.event.id),
    )).get();
    if (existing) { traces.push(orcaEvaluationTraceSchema.parse(JSON.parse(existing.traceJson))); continue; }
    const result = evaluateOrcaRules(context);
    applyResolvedActions(db, context, result.trace);
    db.insert(organizationEvaluationTraces).values({
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
    traces.push(result.trace);
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
