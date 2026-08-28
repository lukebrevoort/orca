import { and, asc, eq, inArray } from "drizzle-orm";
import {
  organizationFacetWorkflowApplySchema,
  facetCardinalitySchema,
  facetDefinitionSchema,
  facetValueTypeSchema,
  threadFacetValueSchema,
  threadWorkflowStateSchema,
  workflowStateDefinitionSchema,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationExecutionContext,
  type OrganizationFacetWorkflowAction,
} from "@orca/shared";

import type { createDatabaseClient } from "../db/client.ts";
import {
  oauthAccounts,
  organizationChangeSets,
  organizationFacets,
  organizationThreadFacetValues,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
  threads,
} from "../db/schema.ts";
import { canonicalOrganizationJson, digestOrganizationCommand } from "./authority.ts";
import { applyFacetWorkflowActions, digestFacetWorkflowActions, type FacetWorkflowSnapshot } from "./facet-workflow.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "./module.ts";
import type { OrganizationAgentCapabilitySource } from "./agent-capability.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function dateString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function facetResourceId(id: string): string { return `facet:${id}`; }
function workflowResourceId(id: string): string { return `workflow_state:${id}`; }
function threadResourceId(accountId: string, threadId: string): string { return `thread:${accountId}:${threadId}`; }

function loadSnapshot(executor: Database, workspaceId: string): FacetWorkflowSnapshot {
  const state = executor.select().from(organizationWorkspaceStates)
    .where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const accountIds = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
    .where(eq(oauthAccounts.userId, workspaceId)).all().map((account) => account.id);
  const facetDefinitions = executor.select().from(organizationFacets)
    .where(eq(organizationFacets.workspaceId, workspaceId))
    .orderBy(asc(organizationFacets.position), asc(organizationFacets.id)).all()
    .map((definition) => facetDefinitionSchema.parse({
      id: definition.id,
      name: definition.name,
      position: definition.position,
      valueType: facetValueTypeSchema.parse(parseJson(definition.valueType)),
      cardinality: facetCardinalitySchema.parse(parseJson(definition.cardinality)),
      isOptional: definition.isOptional,
      defaultValue: definition.defaultValue === null ? null : parseJson(definition.defaultValue),
      retiredAt: dateString(definition.retiredAt),
      revision: definition.revision,
    }));
  const workflowStates = executor.select().from(organizationWorkflowStates)
    .where(eq(organizationWorkflowStates.workspaceId, workspaceId))
    .orderBy(asc(organizationWorkflowStates.position), asc(organizationWorkflowStates.id)).all()
    .map((definition) => workflowStateDefinitionSchema.parse({
      id: definition.id,
      name: definition.name,
      position: definition.position,
      retiredAt: dateString(definition.retiredAt),
      revision: definition.revision,
    }));
  const threadRows = accountIds.length === 0 ? [] : executor.select({ id: threads.id, accountId: threads.accountId })
    .from(threads).where(inArray(threads.accountId, accountIds)).all();
  const facetRows = executor.select().from(organizationThreadFacetValues)
    .where(eq(organizationThreadFacetValues.workspaceId, workspaceId)).all();
  const workflowRows = executor.select().from(organizationThreadWorkflowStates)
    .where(eq(organizationThreadWorkflowStates.workspaceId, workspaceId)).all();
  const threadStates = executor.select().from(organizationThreadStates)
    .where(eq(organizationThreadStates.workspaceId, workspaceId)).all();

  return {
    workspaceRevision: state?.revision ?? 1,
    facetDefinitions,
    workflowStates,
    threads: threadRows.map((thread) => ({
      accountId: thread.accountId,
      threadId: thread.id,
      facetValues: facetRows.filter((value) => value.accountId === thread.accountId && value.threadId === thread.id).map((value) => threadFacetValueSchema.parse({
        facetId: value.facetId,
        value: parseJson(value.value),
        updatedAt: value.updatedAt.toISOString(),
      })),
      workflowState: (() => {
        const value = workflowRows.find((candidate) => candidate.accountId === thread.accountId && candidate.threadId === thread.id);
        return value ? threadWorkflowStateSchema.parse({ stateId: value.stateId, updatedAt: value.updatedAt.toISOString() }) : null;
      })(),
      revision: threadStates.find((candidate) => candidate.accountId === thread.accountId && candidate.threadId === thread.id)?.revision ?? null,
    })),
  };
}

function resourceRevisions(snapshot: FacetWorkflowSnapshot): Record<string, number> {
  return Object.fromEntries([
    ...snapshot.facetDefinitions.map((definition) => [facetResourceId(definition.id), definition.revision] as const),
    ...snapshot.workflowStates.map((definition) => [workflowResourceId(definition.id), definition.revision] as const),
    ...snapshot.threads.flatMap((thread) => thread.revision === null ? [] : [[threadResourceId(thread.accountId, thread.threadId), thread.revision] as const]),
  ]);
}

export function createSqliteFacetWorkflowRepository(db: Database) {
  return {
    getFacetWorkflowSnapshot(workspaceId: string) {
      return loadSnapshot(db, workspaceId);
    },

    getFacetWorkflowAuthorityState(workspaceId: string) {
      const snapshot = loadSnapshot(db, workspaceId);
      return {
        workspaceRevision: snapshot.workspaceRevision,
        resourceRevisions: resourceRevisions(snapshot),
        reservedIdempotencyKeys: db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
          .where(eq(organizationChangeSets.workspaceId, workspaceId)).all().map((row) => row.key),
      };
    },

    replayFacetWorkflow(input: {
      scope: { actor: OrganizationExecutionContext["actor"]; workspaceId: string; accountIds: string[] };
      command: unknown;
      agentCapabilitySource?: OrganizationAgentCapabilitySource;
    }) {
      const parsed = organizationFacetWorkflowApplySchema.parse(input.command);
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        if (input.scope.actor.type === "agent") {
          const live = input.agentCapabilitySource?.load({ ...input.scope, actor: input.scope.actor as typeof input.scope.actor & { type: "agent" } }, executor) ?? null;
          if (!live || live.revokedAt !== null || !live.snapshot.operations.includes("apply")) throw new OrganizationAuthorityError("actor_operation_denied", "The persisted MCP Organization grant no longer authorizes apply");
        }
        const row = executor.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.scope.workspaceId),
          eq(organizationChangeSets.idempotencyKey, parsed.idempotencyKey),
          eq(organizationChangeSets.resourceFamily, "facet_workflow"),
        )).get();
        if (!row) return null;
        const stored = JSON.parse(row.commandJson) as { request?: unknown; scope?: unknown; response?: unknown };
        const replayScope = { actor: input.scope.actor, workspaceId: input.scope.workspaceId, accountIds: [...input.scope.accountIds].sort() };
        if (canonicalOrganizationJson(stored.request) !== canonicalOrganizationJson(parsed)
          || canonicalOrganizationJson(stored.scope) !== canonicalOrganizationJson(replayScope)) {
          throw new OrganizationAuthorityError("duplicate_idempotency_key", "The idempotency key was already used for a different Facet/Workflow request or scope");
        }
        return stored.response as FacetWorkflowSnapshot;
      });
    },

    applyFacetWorkflow(input: {
      executionContext: OrganizationExecutionContext;
      authorityTrace: OrganizationAuthorityTrace;
      command: OrganizationCommand;
      actions: readonly OrganizationFacetWorkflowAction[];
      agentCapabilitySource?: OrganizationAgentCapabilitySource;
    }) {
      return db.transaction((transaction) => {
        const workspaceId = input.executionContext.workspaceId;
        transaction.insert(organizationWorkspaceStates).values({ workspaceId }).onConflictDoNothing().run();
        const executor = transaction as unknown as Database;
        if (input.executionContext.actor.type === "agent") {
          const liveCapability = input.agentCapabilitySource?.load({
            actor: input.executionContext.actor as typeof input.executionContext.actor & { type: "agent" },
            workspaceId: input.executionContext.workspaceId,
            accountIds: input.executionContext.accountIds,
          }, executor) ?? null;
          if (!liveCapability || liveCapability.revokedAt !== null
            || JSON.stringify(liveCapability.snapshot) !== JSON.stringify(input.authorityTrace.capabilitySnapshot)) {
            throw new OrganizationAuthorityError("actor_operation_denied", "The persisted MCP Organization grant changed before commit");
          }
        }
        const current = loadSnapshot(executor, workspaceId);
        const expectedWorkspaceRevision = input.executionContext.expectedRevisions.workspace;
        if (expectedWorkspaceRevision === null || current.workspaceRevision !== expectedWorkspaceRevision) {
          throw new OrganizationRevisionConflictError(expectedWorkspaceRevision ?? 0, current.workspaceRevision);
        }
        if (input.executionContext.command.digest !== digestOrganizationCommand(input.command)) {
          throw new OrganizationAuthorityError("invalid_request", "The authorized command digest does not match the execution payload");
        }
        const typedActionsDigest = digestFacetWorkflowActions(input.actions);
        if (input.command.intents.some((intent) => intent.changes?.typedActionsDigest !== typedActionsDigest)) {
          throw new OrganizationAuthorityError("invalid_request", "The authorized command does not match the exact typed Facet and Workflow actions");
        }
        const liveResources = resourceRevisions(current);
        for (const intent of input.command.intents) {
          if (intent.mutation === "create" && liveResources[intent.resourceId] !== undefined) {
            throw new OrganizationAuthorityError("revision_conflict", `Create target ${intent.resourceId} now exists`);
          }
          if (intent.mutation === "update" && liveResources[intent.resourceId] !== input.executionContext.expectedRevisions.resources[intent.resourceId]) {
            throw new OrganizationAuthorityError("revision_conflict", `Update target ${intent.resourceId} changed before commit`);
          }
        }
        const idempotencyKey = input.executionContext.idempotencyKey;
        if (!idempotencyKey) throw new OrganizationAuthorityError("idempotency_key_required", "An authorized apply must reserve an idempotency key");
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets)
          .where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.id, input.command.id))).get()) {
          throw new OrganizationAuthorityError("invalid_request", `Change Set ${input.command.id} already exists in this Workspace`);
        }
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets)
          .where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get()) {
          throw new OrganizationAuthorityError("duplicate_idempotency_key", "The idempotency key was already reserved");
        }

        const now = new Date().toISOString();
        const next = applyFacetWorkflowActions(current, input.actions, {
          workspaceId,
          authorizedAccountIds: input.executionContext.accountIds,
          now,
        });
        transaction.insert(organizationChangeSets).values({
          workspaceId,
          id: input.command.id,
          idempotencyKey,
          commandDigest: input.executionContext.command.digest,
          authorityTrace: JSON.stringify(input.authorityTrace),
          resourceFamily: "facet_workflow",
          operation: "apply",
          commandJson: JSON.stringify({ request: { id: input.command.id, idempotencyKey, expectedWorkspaceRevision, actions: input.actions }, scope: { actor: input.executionContext.actor, workspaceId, accountIds: [...input.executionContext.accountIds].sort() }, response: next }),
          workspaceRevisionBefore: current.workspaceRevision,
          workspaceRevisionAfter: next.workspaceRevision,
          createdAt: new Date(now),
        }).run();

        transaction.delete(organizationFacets).where(eq(organizationFacets.workspaceId, workspaceId)).run();
        transaction.delete(organizationWorkflowStates).where(eq(organizationWorkflowStates.workspaceId, workspaceId)).run();
        if (next.facetDefinitions.length > 0) transaction.insert(organizationFacets).values(next.facetDefinitions.map((definition) => ({
          id: definition.id,
          workspaceId,
          name: definition.name,
          position: definition.position,
          valueType: JSON.stringify(definition.valueType),
          cardinality: JSON.stringify(definition.cardinality),
          isOptional: definition.isOptional,
          defaultValue: definition.defaultValue === null ? null : JSON.stringify(definition.defaultValue),
          retiredAt: definition.retiredAt ? new Date(definition.retiredAt) : null,
          revision: definition.revision,
          updatedAt: new Date(now),
        }))).run();
        if (next.workflowStates.length > 0) transaction.insert(organizationWorkflowStates).values(next.workflowStates.map((definition) => ({
          id: definition.id,
          workspaceId,
          name: definition.name,
          position: definition.position,
          retiredAt: definition.retiredAt ? new Date(definition.retiredAt) : null,
          revision: definition.revision,
          updatedAt: new Date(now),
        }))).run();

        transaction.delete(organizationThreadFacetValues).where(eq(organizationThreadFacetValues.workspaceId, workspaceId)).run();
        transaction.delete(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.workspaceId, workspaceId)).run();
        transaction.delete(organizationThreadStates).where(eq(organizationThreadStates.workspaceId, workspaceId)).run();
        const facetValues = next.threads.flatMap((thread) => thread.facetValues.map((value) => ({
          workspaceId,
          facetId: value.facetId,
          accountId: thread.accountId,
          threadId: thread.threadId,
          value: JSON.stringify(value.value),
          updatedAt: new Date(value.updatedAt),
        })));
        if (facetValues.length > 0) transaction.insert(organizationThreadFacetValues).values(facetValues).run();
        const workflowValues = next.threads.flatMap((thread) => thread.workflowState ? [{
          workspaceId,
          threadId: thread.threadId,
          accountId: thread.accountId,
          stateId: thread.workflowState.stateId,
          updatedAt: new Date(thread.workflowState.updatedAt),
        }] : []);
        if (workflowValues.length > 0) transaction.insert(organizationThreadWorkflowStates).values(workflowValues).run();
        const threadStates = next.threads.flatMap((thread) => thread.revision === null ? [] : [{
          workspaceId,
          accountId: thread.accountId,
          threadId: thread.threadId,
          revision: thread.revision,
          updatedAt: new Date(now),
        }]);
        if (threadStates.length > 0) transaction.insert(organizationThreadStates).values(threadStates).run();

        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.workspaceRevision, updatedAt: new Date(now) })
          .where(and(eq(organizationWorkspaceStates.workspaceId, workspaceId), eq(organizationWorkspaceStates.revision, current.workspaceRevision)))
          .returning({ workspaceId: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.workspaceRevision, current.workspaceRevision + 1);
        return next;
      });
    },
  };
}
