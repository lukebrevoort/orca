import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  facetCardinalitySchema,
  facetValueTypeSchema,
  orcaCompiledRuleRevisionSchema,
  orcaRuleCompileResponseSchema,
  orcaRuleRevisionListSchema,
  type OrcaRule,
  type OrcaRuleRevision,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  collections,
  oauthAccounts,
  organizationContexts,
  organizationContextTypes,
  organizationFacets,
  organizationLanes,
  organizationRuleRevisions,
  organizationRules,
  organizationWorkflowStates,
  organizationWorkspaceStates,
} from "../../db/schema.ts";
import type { OrcaWorkspaceSnapshot } from "./compiler.ts";
import { RuleRevisionConflictError, WorkspaceSchemaConflictError, type RuleRevisionRepository } from "./service.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function toRule(row: typeof organizationRules.$inferSelect): OrcaRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    latestRevision: row.latestRevision,
    activeRevisionId: row.activeRevisionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevision(row: typeof organizationRuleRevisions.$inferSelect): OrcaRuleRevision {
  return {
    id: row.id,
    ruleId: row.ruleId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    source: row.source,
    sourceDigest: row.sourceDigest,
    compiled: orcaCompiledRuleRevisionSchema.parse(JSON.parse(row.compiledJson)),
    actor: { id: row.actorId, type: row.actorType as "human" | "agent" | "system" },
    createdAt: row.createdAt.toISOString(),
  };
}

function loadWorkspaceSnapshot(executor: Database, workspaceId: string): OrcaWorkspaceSnapshot {
  const state = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const accountIds = executor.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).all().map((row) => row.id);
  const facets = executor.select().from(organizationFacets)
    .where(and(eq(organizationFacets.workspaceId, workspaceId), isNull(organizationFacets.retiredAt)))
    .orderBy(asc(organizationFacets.position), asc(organizationFacets.id)).all().map((row) => {
      const valueType = facetValueTypeSchema.parse(JSON.parse(row.valueType));
      const cardinality = facetCardinalitySchema.parse(JSON.parse(row.cardinality));
      return {
        id: row.id,
        name: row.name,
        valueType: valueType.kind === "enum"
          ? { kind: "enum" as const, options: valueType.options.map((option) => ({ id: option.id, label: option.label })) }
          : { kind: valueType.kind },
        cardinality: cardinality.kind,
        optional: row.isOptional,
      };
    });
  return {
    workspaceId,
    revision: state?.revision ?? 1,
    lanes: executor.select({ id: organizationLanes.id, name: organizationLanes.name }).from(organizationLanes)
      .where(and(eq(organizationLanes.workspaceId, workspaceId), isNull(organizationLanes.retiredAt))).orderBy(asc(organizationLanes.position), asc(organizationLanes.id)).all(),
    workflowStates: executor.select({ id: organizationWorkflowStates.id, name: organizationWorkflowStates.name }).from(organizationWorkflowStates)
      .where(and(eq(organizationWorkflowStates.workspaceId, workspaceId), isNull(organizationWorkflowStates.retiredAt))).orderBy(asc(organizationWorkflowStates.position), asc(organizationWorkflowStates.id)).all(),
    facets,
    collections: accountIds.length === 0 ? [] : executor.select({ id: collections.id, name: collections.name }).from(collections)
      .where(inArray(collections.accountId, accountIds)).orderBy(asc(collections.position), asc(collections.id)).all(),
    contextTypes: executor.select({ id: organizationContextTypes.id, name: organizationContextTypes.name }).from(organizationContextTypes)
      .where(and(eq(organizationContextTypes.workspaceId, workspaceId), isNull(organizationContextTypes.retiredAt))).orderBy(asc(organizationContextTypes.position), asc(organizationContextTypes.id)).all(),
    contexts: executor.select({ id: organizationContexts.id, contextTypeId: organizationContexts.contextTypeId, name: organizationContexts.name }).from(organizationContexts)
      .where(and(eq(organizationContexts.workspaceId, workspaceId), isNull(organizationContexts.retiredAt))).orderBy(asc(organizationContexts.id)).all(),
  };
}

export function createSqliteRuleRevisionRepository(db: Database): RuleRevisionRepository {
  const get = (workspaceId: string, ruleId: string) => {
    const ruleRow = db.select().from(organizationRules).where(and(eq(organizationRules.workspaceId, workspaceId), eq(organizationRules.id, ruleId))).get();
    if (!ruleRow) return null;
    const revisions = db.select().from(organizationRuleRevisions)
      .where(and(eq(organizationRuleRevisions.workspaceId, workspaceId), eq(organizationRuleRevisions.ruleId, ruleId)))
      .orderBy(asc(organizationRuleRevisions.revision)).all().map(toRevision);
    return orcaRuleRevisionListSchema.parse({ rule: toRule(ruleRow), revisions });
  };
  return {
    loadWorkspaceSnapshot(workspaceId) { return loadWorkspaceSnapshot(db, workspaceId); },
    get,
    append(input) {
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const currentWorkspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.rule.workspaceId)).get();
        const actualWorkspaceRevision = currentWorkspace?.revision ?? 1;
        if (actualWorkspaceRevision !== input.expectedWorkspaceSchemaRevision) {
          throw new WorkspaceSchemaConflictError(input.expectedWorkspaceSchemaRevision, actualWorkspaceRevision);
        }
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.rule.workspaceId), eq(organizationRules.id, input.rule.id),
        )).get();
        const actualRuleRevision = currentRule?.latestRevision ?? null;
        if (actualRuleRevision !== input.expectedRuleRevision) throw new RuleRevisionConflictError(input.expectedRuleRevision, actualRuleRevision);
        if (currentRule) {
          executor.update(organizationRules).set({ name: input.rule.name, latestRevision: input.rule.latestRevision, updatedAt: new Date(input.rule.updatedAt) })
            .where(and(eq(organizationRules.workspaceId, input.rule.workspaceId), eq(organizationRules.id, input.rule.id))).run();
        } else {
          executor.insert(organizationRules).values({
            workspaceId: input.rule.workspaceId, id: input.rule.id, name: input.rule.name, latestRevision: input.rule.latestRevision,
            activeRevisionId: input.rule.activeRevisionId, createdAt: new Date(input.rule.createdAt), updatedAt: new Date(input.rule.updatedAt),
          }).run();
        }
        executor.insert(organizationRuleRevisions).values({
          workspaceId: input.revision.workspaceId,
          id: input.revision.id,
          ruleId: input.revision.ruleId,
          revision: input.revision.revision,
          workspaceSchemaRevision: input.revision.compiled.workspaceSchemaRevision,
          languageVersion: input.revision.compiled.languageVersion,
          source: input.revision.source,
          sourceDigest: input.revision.sourceDigest,
          compiledJson: JSON.stringify(input.revision.compiled),
          requiredCapabilities: JSON.stringify(input.revision.compiled.requiredCapabilities),
          risk: input.revision.compiled.risk,
          actorId: input.revision.actor.id,
          actorType: input.revision.actor.type,
          createdAt: new Date(input.revision.createdAt),
        }).run();
        return orcaRuleCompileResponseSchema.parse({ ok: true, rule: input.rule, revision: input.revision, diagnostics: [] }) as ReturnType<RuleRevisionRepository["append"]>;
      });
    },
  };
}
