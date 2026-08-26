import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  orcaCompilationWorkspaceSchema,
  orcaCompiledRuleRevisionSchema,
  type OrcaRule,
  type OrcaRuleRevision,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  emails,
  oauthAccounts,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
} from "../../db/schema.ts";
import { loadLiveEvaluationInput } from "./evaluation-sqlite.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import type { HistoricalRuleSimulationRepository } from "./simulation.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function toRule(row: typeof organizationRules.$inferSelect): OrcaRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    latestRevision: row.latestRevision,
    activeRevisionId: row.activeRevisionId,
    position: row.position,
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

export function createSqliteHistoricalRuleSimulationRepository(db: Database): HistoricalRuleSimulationRepository {
  const revisions = createSqliteRuleRevisionRepository(db);
  return {
    loadRuleRevision(workspaceId, ruleId, revisionId) {
      const rule = db.select().from(organizationRules).where(and(
        eq(organizationRules.workspaceId, workspaceId),
        eq(organizationRules.id, ruleId),
      )).get();
      const revision = db.select().from(organizationRuleRevisions).where(and(
        eq(organizationRuleRevisions.workspaceId, workspaceId),
        eq(organizationRuleRevisions.ruleId, ruleId),
        eq(organizationRuleRevisions.id, revisionId),
      )).get();
      if (!rule || !revision || !revision.compilationWorkspaceJson) return null;
      return {
        rule: toRule(rule),
        revision: toRevision(revision),
        compilationWorkspace: orcaCompilationWorkspaceSchema.parse(JSON.parse(revision.compilationWorkspaceJson)),
      };
    },
    loadWorkspaceSnapshot(workspaceId) {
      return revisions.loadWorkspaceSnapshot(workspaceId);
    },
    loadRuleSetRevision(workspaceId) {
      const row = db.select({ revision: organizationRuleSets.revision }).from(organizationRuleSets)
        .where(eq(organizationRuleSets.workspaceId, workspaceId)).get();
      if (!row) throw new Error("Historical Simulation Rule Set is unavailable");
      return row.revision;
    },
    listHistoricalEvaluationInputs(workspaceId, accountIds, maximumThreads) {
      const requested = [...accountIds].sort();
      const owned = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
        .where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.id)).all().map(({ id }) => id);
      const ownedSet = new Set(owned);
      if (requested.some((accountId) => !ownedSet.has(accountId))) {
        throw new Error("Historical Simulation Account scope is not owned by this Workspace");
      }
      const currentWorkspace = revisions.loadWorkspaceSnapshot(workspaceId);
      const rows = db.select({
        id: emails.id,
        accountId: emails.accountId,
        threadId: emails.threadId,
        receivedAt: emails.receivedAt,
      }).from(emails).where(inArray(emails.accountId, requested))
        .orderBy(desc(emails.receivedAt), asc(emails.accountId), asc(emails.id)).all();
      const seen = new Set<string>();
      const contexts = [];
      for (const row of rows) {
        const key = `${row.accountId}\0${row.threadId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const context = loadLiveEvaluationInput(db, {
          accountId: row.accountId,
          messageId: row.id,
          eventKind: "message.received",
        });
        if (!context || context.thread.workspaceId !== workspaceId) continue;
        // The live loader minimizes catalog reads to currently active Rules.
        // Historical Simulation must also expose the proposed revision's exact
        // current catalog, so rebind the complete bounded Workspace resources.
        context.workspaceSchema = {
          ...context.workspaceSchema,
          revision: currentWorkspace.revision,
          workflowStates: currentWorkspace.workflowStates,
          facets: currentWorkspace.facets,
          collections: currentWorkspace.collections,
          contextTypes: currentWorkspace.contextTypes,
          contexts: currentWorkspace.contexts,
        };
        contexts.push(context);
        if (contexts.length >= maximumThreads) break;
      }
      return contexts;
    },
  };
}
