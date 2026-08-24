import { and, asc, eq, inArray } from "drizzle-orm";
import {
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
import { digestOrganizationCommand } from "./authority.ts";
import { applyFacetWorkflowActions, type FacetWorkflowSnapshot } from "./facet-workflow.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "./module.ts";

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

    applyFacetWorkflow(input: {
      executionContext: OrganizationExecutionContext;
      authorityTrace: OrganizationAuthorityTrace;
      command: OrganizationCommand;
      actions: readonly OrganizationFacetWorkflowAction[];
    }) {
      return db.transaction((transaction) => {
        const workspaceId = input.executionContext.workspaceId;
        transaction.insert(organizationWorkspaceStates).values({ workspaceId }).onConflictDoNothing().run();
        const executor = transaction as unknown as Database;
        const current = loadSnapshot(executor, workspaceId);
        const expectedWorkspaceRevision = input.executionContext.expectedRevisions.workspace;
        if (expectedWorkspaceRevision === null || current.workspaceRevision !== expectedWorkspaceRevision) {
          throw new OrganizationRevisionConflictError(expectedWorkspaceRevision ?? 0, current.workspaceRevision);
        }
        if (input.executionContext.command.digest !== digestOrganizationCommand(input.command)) {
          throw new OrganizationAuthorityError("invalid_request", "The authorized command digest does not match the execution payload");
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
