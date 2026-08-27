import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import type { OrcaCompiledAction, OrcaEvaluationResult, OrganizationCommand } from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads,
  collections,
  organizationChangeActions,
  organizationChangeSets,
  organizationContexts,
  organizationContextRelationshipTypes,
  organizationFacets,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
  oauthAccounts,
} from "../../db/schema.ts";
import { authorizeOrganizationOperation, canonicalOrganizationJson, digestOrganizationCommand } from "../authority.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../module.ts";
import type { OrganizationSystemCapabilityAdapter } from "../system-capability.ts";
import type { OrcaEvaluationInput } from "./evaluator.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type ProjectedAction = Extract<OrcaCompiledAction, {
  kind: "set_workflow_state" | "set_facet" | "unset_facet" | "add_collection" | "remove_collection" | "link_context" | "unlink_context";
}>;
type AuditRow = { actionKind: string; resourceFamily: string; resourceId: string; before: unknown; after: unknown };

function threadResourceId(accountId: string, threadId: string): string {
  return `thread:${accountId}:${threadId}`;
}

function projectionActions(result: OrcaEvaluationResult): ProjectedAction[] {
  return result.trace.winners.flatMap((winner) => {
    const action = winner.action;
    return ["set_workflow_state", "set_facet", "unset_facet", "add_collection", "remove_collection", "link_context", "unlink_context"].includes(action.kind)
      ? [action as ProjectedAction]
      : [];
  });
}

/**
 * Commits one evaluator result through the same Organization authority, CAS,
 * idempotency, Change Set, and ordered action-audit boundary used by humans.
 */
export function applyAuthorizedEvaluationProjection(
  db: Database,
  input: OrcaEvaluationInput,
  result: OrcaEvaluationResult,
  capabilityAdapter: OrganizationSystemCapabilityAdapter,
  options?: { alreadyInTransaction?: boolean },
): void {
  const laneWinner = result.trace.winners.find((winner) => winner.slot === "lane");
  const applyLowerLane = laneWinner?.precedence !== "safety_lock";
  const actions = projectionActions(result);
  if (!applyLowerLane && actions.length === 0) return;

  const resourceId = threadResourceId(input.thread.accountId, input.thread.id);
  const payload = { lowerLanePlacement: applyLowerLane ? result.trace.lowerLanePlacement : null, actions };
  const projectionDigest = `sha256:${createHash("sha256").update(canonicalOrganizationJson(payload)).digest("hex")}`;
  const command: OrganizationCommand = {
    id: result.trace.id,
    intents: [{
      kind: "organize_thread",
      resourceId,
      mutation: input.thread.organizationRevision === null ? "create" : "update",
      changes: { projectionDigest, actionCount: actions.length + (applyLowerLane ? 1 : 0) },
    }],
  };
  const expectedResources = input.thread.organizationRevision === null ? {} : { [resourceId]: input.thread.organizationRevision };
  const idempotencyKey = `evaluation:${result.trace.event.id}:projection`;
  const claimedCapability = input.capabilities;

  const project = (executor: Database) => {
    const workspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.thread.workspaceId)).get();
    const threadState = executor.select().from(organizationThreadStates).where(and(
      eq(organizationThreadStates.workspaceId, input.thread.workspaceId),
      eq(organizationThreadStates.accountId, input.thread.accountId),
      eq(organizationThreadStates.threadId, input.thread.id),
    )).get();
    const ownedAccount = executor.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(
      eq(oauthAccounts.userId, input.thread.workspaceId), eq(oauthAccounts.id, input.thread.accountId),
    )).get();
    const liveCapability = capabilityAdapter.live({ workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, executor });
    const reservedIdempotencyKey = executor.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
      .where(and(eq(organizationChangeSets.workspaceId, input.thread.workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get();
    const liveResourceRevisions = threadState ? { [resourceId]: threadState.revision } : {};
    const decision = authorizeOrganizationOperation({
      actor: input.actor,
      capabilitySnapshot: claimedCapability,
      operation: "apply",
      scope: { workspaceId: input.thread.workspaceId, accountIds: [input.thread.accountId] },
      command,
      expectedRevisions: { workspace: input.workspaceSchema.revision, resources: expectedResources },
      idempotencyKey,
    }, {
      scope: { workspaceId: input.thread.workspaceId, accountIds: ownedAccount ? [ownedAccount.id] : [] },
      capability: liveCapability,
      workspaceRevision: workspace?.revision ?? 1,
      resourceRevisions: liveResourceRevisions,
      reservedIdempotencyKeys: reservedIdempotencyKey ? [reservedIdempotencyKey.key] : [],
    });
    if (!decision.allowed) throw new OrganizationAuthorityError(decision.code, decision.reason);
    if (decision.executionContext.command.digest !== digestOrganizationCommand(command)) {
      throw new OrganizationAuthorityError("invalid_request", "Authorized evaluation projection digest does not match its execution payload");
    }

    const logicalTime = new Date(input.logicalTime);
    const auditRows: AuditRow[] = [];
    if (applyLowerLane) {
      const before = executor.select().from(organizationThreadLaneStates).where(and(
        eq(organizationThreadLaneStates.workspaceId, input.thread.workspaceId),
        eq(organizationThreadLaneStates.accountId, input.thread.accountId),
        eq(organizationThreadLaneStates.threadId, input.thread.id),
      )).get();
      if (!before || before.revision !== input.thread.lanePlacement.revision) {
        throw new OrganizationAuthorityError("revision_conflict", "Thread Lane placement changed before evaluator commit");
      }
      const lower = result.trace.lowerLanePlacement;
      const updated = executor.update(organizationThreadLaneStates).set({
        primaryLaneId: lower.laneId,
        placementSource: lower.placementSource,
        sourceId: lower.sourceId,
        actorId: lower.actor.id,
        actorType: lower.actor.type,
        reason: lower.reason,
        revision: before.revision + 1,
        updatedAt: logicalTime,
      }).where(and(
        eq(organizationThreadLaneStates.workspaceId, input.thread.workspaceId),
        eq(organizationThreadLaneStates.accountId, input.thread.accountId),
        eq(organizationThreadLaneStates.threadId, input.thread.id),
        eq(organizationThreadLaneStates.revision, before.revision),
      )).returning({ revision: organizationThreadLaneStates.revision }).get();
      if (!updated) throw new OrganizationAuthorityError("revision_conflict", "Thread Lane placement changed before evaluator commit");
      auditRows.push({
        actionKind: "route_lane", resourceFamily: "lane", resourceId: lower.laneId,
        before: { laneId: before.primaryLaneId, placementSource: before.placementSource, sourceId: before.sourceId, revision: before.revision },
        after: { laneId: lower.laneId, placementSource: lower.placementSource, sourceId: lower.sourceId, revision: updated.revision },
      });
    }

    for (const action of actions) {
      if (action.kind === "set_workflow_state") {
        const definition = executor.select({ id: organizationWorkflowStates.id }).from(organizationWorkflowStates).where(and(
          eq(organizationWorkflowStates.workspaceId, input.thread.workspaceId), eq(organizationWorkflowStates.id, action.stateId),
        )).get();
        if (!definition) throw new OrganizationAuthorityError("revision_conflict", `Workflow State ${action.stateId} is not live`);
        const before = executor.select().from(organizationThreadWorkflowStates).where(and(
          eq(organizationThreadWorkflowStates.workspaceId, input.thread.workspaceId), eq(organizationThreadWorkflowStates.accountId, input.thread.accountId), eq(organizationThreadWorkflowStates.threadId, input.thread.id),
        )).get();
        executor.insert(organizationThreadWorkflowStates).values({ workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id, stateId: action.stateId, updatedAt: logicalTime })
          .onConflictDoUpdate({ target: [organizationThreadWorkflowStates.workspaceId, organizationThreadWorkflowStates.accountId, organizationThreadWorkflowStates.threadId], set: { stateId: action.stateId, updatedAt: logicalTime } }).run();
        auditRows.push({ actionKind: action.kind, resourceFamily: "workflow_state", resourceId: action.stateId, before: before?.stateId ?? null, after: action.stateId });
      } else if (action.kind === "set_facet" || action.kind === "unset_facet") {
        const definition = executor.select({ id: organizationFacets.id }).from(organizationFacets).where(and(
          eq(organizationFacets.workspaceId, input.thread.workspaceId), eq(organizationFacets.id, action.facetId),
        )).get();
        if (!definition) throw new OrganizationAuthorityError("revision_conflict", `Facet ${action.facetId} is not live`);
        const before = executor.select().from(organizationThreadFacetValues).where(and(
          eq(organizationThreadFacetValues.workspaceId, input.thread.workspaceId), eq(organizationThreadFacetValues.accountId, input.thread.accountId),
          eq(organizationThreadFacetValues.threadId, input.thread.id), eq(organizationThreadFacetValues.facetId, action.facetId),
        )).get();
        if (action.kind === "set_facet") {
          executor.insert(organizationThreadFacetValues).values({ workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id, facetId: action.facetId, value: JSON.stringify(action.value), updatedAt: logicalTime })
            .onConflictDoUpdate({ target: [organizationThreadFacetValues.workspaceId, organizationThreadFacetValues.facetId, organizationThreadFacetValues.accountId, organizationThreadFacetValues.threadId], set: { value: JSON.stringify(action.value), updatedAt: logicalTime } }).run();
        } else {
          executor.delete(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.thread.workspaceId), eq(organizationThreadFacetValues.accountId, input.thread.accountId),
            eq(organizationThreadFacetValues.threadId, input.thread.id), eq(organizationThreadFacetValues.facetId, action.facetId),
          )).run();
        }
        auditRows.push({ actionKind: action.kind, resourceFamily: "facet", resourceId: action.facetId, before: before ? JSON.parse(before.value) : null, after: action.kind === "set_facet" ? action.value : null });
      } else if (action.kind === "add_collection" || action.kind === "remove_collection") {
        if (action.accountId !== input.thread.accountId) throw new OrganizationAuthorityError("account_denied", "Collection projection is bound to a different Account");
        const collection = executor.select({ id: collections.id }).from(collections).where(and(eq(collections.accountId, input.thread.accountId), eq(collections.id, action.collectionId))).get();
        if (!collection) throw new OrganizationAuthorityError("account_denied", `Collection ${action.collectionId} is outside the Thread Account`);
        const before = executor.select({ id: collectionThreads.id }).from(collectionThreads).where(and(eq(collectionThreads.collectionId, action.collectionId), eq(collectionThreads.threadId, input.thread.id))).get();
        if (action.kind === "add_collection") {
          executor.insert(collectionThreads).values({ id: `${result.trace.id}:collection:${action.collectionId}`, collectionId: action.collectionId, threadId: input.thread.id, createdAt: logicalTime }).onConflictDoNothing().run();
        } else {
          executor.delete(collectionThreads).where(and(eq(collectionThreads.collectionId, action.collectionId), eq(collectionThreads.threadId, input.thread.id))).run();
        }
        auditRows.push({ actionKind: action.kind, resourceFamily: "collection", resourceId: action.collectionId, before: Boolean(before), after: action.kind === "add_collection" });
      } else {
        const context = executor.select({ id: organizationContexts.id }).from(organizationContexts).where(and(
          eq(organizationContexts.workspaceId, input.thread.workspaceId), eq(organizationContexts.id, action.contextId), eq(organizationContexts.contextTypeId, action.contextTypeId),
        )).get();
        if (!context) throw new OrganizationAuthorityError("revision_conflict", `Context ${action.contextId} is not live`);
        const relationshipType = executor.select().from(organizationContextRelationshipTypes).where(and(
          eq(organizationContextRelationshipTypes.workspaceId, input.thread.workspaceId), eq(organizationContextRelationshipTypes.contextTypeId, action.contextTypeId), eq(organizationContextRelationshipTypes.direction, "thread_to_context"),
        )).orderBy(asc(organizationContextRelationshipTypes.position), asc(organizationContextRelationshipTypes.id)).get();
        if (!relationshipType) throw new OrganizationAuthorityError("revision_conflict", `Context Type ${action.contextTypeId} has no live Thread relationship`);
        const before = executor.select({ id: organizationThreadContextRelationships.id }).from(organizationThreadContextRelationships).where(and(
          eq(organizationThreadContextRelationships.workspaceId, input.thread.workspaceId), eq(organizationThreadContextRelationships.accountId, input.thread.accountId),
          eq(organizationThreadContextRelationships.threadId, input.thread.id), eq(organizationThreadContextRelationships.contextTypeId, action.contextTypeId), eq(organizationThreadContextRelationships.contextId, action.contextId),
        )).get();
        if (action.kind === "link_context") {
          executor.insert(organizationThreadContextRelationships).values({
            workspaceId: input.thread.workspaceId, id: `${result.trace.id}:context:${action.contextId}:${relationshipType.id}`,
            accountId: input.thread.accountId, threadId: input.thread.id, contextTypeId: action.contextTypeId, contextId: action.contextId,
            relationshipTypeId: relationshipType.id, direction: "thread_to_context", revision: 1, createdAt: logicalTime, updatedAt: logicalTime,
          }).onConflictDoNothing().run();
        } else {
          executor.delete(organizationThreadContextRelationships).where(and(
            eq(organizationThreadContextRelationships.workspaceId, input.thread.workspaceId), eq(organizationThreadContextRelationships.accountId, input.thread.accountId),
            eq(organizationThreadContextRelationships.threadId, input.thread.id), eq(organizationThreadContextRelationships.contextTypeId, action.contextTypeId), eq(organizationThreadContextRelationships.contextId, action.contextId),
          )).run();
        }
        auditRows.push({ actionKind: action.kind, resourceFamily: "context", resourceId: action.contextId, before: Boolean(before), after: action.kind === "link_context" });
      }
    }

    const beforeThreadRevision = threadState?.revision ?? null;
    const nextThreadRevision = (beforeThreadRevision ?? 0) + 1;
    if (threadState) {
      const updated = executor.update(organizationThreadStates).set({ revision: nextThreadRevision, updatedAt: logicalTime }).where(and(
        eq(organizationThreadStates.workspaceId, input.thread.workspaceId), eq(organizationThreadStates.accountId, input.thread.accountId),
        eq(organizationThreadStates.threadId, input.thread.id), eq(organizationThreadStates.revision, threadState.revision),
      )).returning({ revision: organizationThreadStates.revision }).get();
      if (!updated) throw new OrganizationAuthorityError("revision_conflict", "Thread Organization revision changed before evaluator commit");
    } else {
      executor.insert(organizationThreadStates).values({ workspaceId: input.thread.workspaceId, accountId: input.thread.accountId, threadId: input.thread.id, revision: 1, updatedAt: logicalTime }).run();
    }
    auditRows.push({ actionKind: "organize_thread", resourceFamily: "thread", resourceId, before: beforeThreadRevision, after: nextThreadRevision });

    const workspaceRevisionBefore = workspace?.revision ?? 1;
    const workspaceUpdated = executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionBefore + 1, updatedAt: logicalTime }).where(and(
      eq(organizationWorkspaceStates.workspaceId, input.thread.workspaceId), eq(organizationWorkspaceStates.revision, workspaceRevisionBefore),
    )).returning({ revision: organizationWorkspaceStates.revision }).get();
    if (!workspaceUpdated) throw new OrganizationRevisionConflictError(workspaceRevisionBefore, workspaceRevisionBefore + 1);

    executor.insert(organizationChangeSets).values({
      workspaceId: input.thread.workspaceId,
      id: command.id,
      idempotencyKey,
      commandDigest: decision.executionContext.command.digest,
      authorityTrace: JSON.stringify(decision.trace),
      resourceFamily: "thread",
      operation: "apply",
      commandJson: JSON.stringify({ command, payload }),
      workspaceRevisionBefore,
      workspaceRevisionAfter: workspaceRevisionBefore + 1,
      createdAt: logicalTime,
    }).run();
    executor.insert(organizationChangeActions).values(auditRows.map((row, position) => ({
      workspaceId: input.thread.workspaceId,
      changeId: command.id,
      position,
      actionKind: row.actionKind,
      resourceFamily: row.resourceFamily,
      resourceId: row.resourceId,
      beforeJson: row.before === null ? null : JSON.stringify(row.before),
      afterJson: row.after === null ? null : JSON.stringify(row.after),
    }))).run();
  };
  if (options?.alreadyInTransaction) project(db);
  else db.transaction((transaction) => project(transaction as unknown as Database));
}
