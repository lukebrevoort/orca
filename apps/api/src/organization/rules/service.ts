import { createHash, randomUUID } from "node:crypto";
import {
  orcaRuleCompileRequestSchema,
  orcaRuleCompileResponseSchema,
  orcaRuleRevisionListSchema,
  type OrcaRule,
  type OrcaRuleCompileRequest,
  type OrcaRuleCompileResponse,
  type OrcaRuleRevision,
  type OrcaRuleRevisionList,
  type OrganizationActor,
} from "@orca/shared";

import { compileOrcaRule, type OrcaWorkspaceSnapshot } from "./compiler.ts";

export class WorkspaceSchemaConflictError extends Error {
  readonly code = "workspace_schema_conflict";
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Workspace Schema revision ${expectedRevision} is stale; current revision is ${actualRevision}`);
  }
}
export class RuleRevisionConflictError extends Error {
  readonly code = "rule_revision_conflict";
  constructor(readonly expectedRevision: number | null, readonly actualRevision: number | null) {
    super(actualRevision === null ? "Rule is unavailable in this Workspace" : `Rule revision ${expectedRevision ?? "new"} is stale; current revision is ${actualRevision}`);
  }
}

export type RuleRevisionRepository = {
  loadWorkspaceSnapshot(workspaceId: string): OrcaWorkspaceSnapshot;
  append(input: {
    expectedWorkspaceSchemaRevision: number;
    expectedRuleRevision: number | null;
    rule: OrcaRule;
    revision: OrcaRuleRevision;
  }): OrcaRuleCompileResponse & { ok: true };
  get(workspaceId: string, ruleId: string): OrcaRuleRevisionList | null;
};

export function createRuleRevisionService(repository: RuleRevisionRepository, options: {
  now?: () => Date;
  id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  return {
    compile(input: { actor: OrganizationActor; workspaceId: string; request: unknown }): OrcaRuleCompileResponse {
      const request = orcaRuleCompileRequestSchema.parse(input.request);
      const workspace = repository.loadWorkspaceSnapshot(input.workspaceId);
      if (request.workspaceSchemaRevision !== workspace.revision) {
        throw new WorkspaceSchemaConflictError(request.workspaceSchemaRevision, workspace.revision);
      }
      const compilation = compileOrcaRule({ source: request.source, workspace });
      if (!compilation.ok) return orcaRuleCompileResponseSchema.parse(compilation);

      const existing = request.ruleId ? repository.get(input.workspaceId, request.ruleId) : null;
      const actualRevision = existing?.rule.latestRevision ?? null;
      if (request.ruleId && (!existing || actualRevision !== request.expectedRuleRevision)) {
        throw new RuleRevisionConflictError(request.expectedRuleRevision, actualRevision);
      }
      const timestamp = now().toISOString();
      const ruleId = existing?.rule.id ?? id();
      const revisionNumber = (actualRevision ?? 0) + 1;
      const rule: OrcaRule = {
        id: ruleId,
        workspaceId: input.workspaceId,
        name: compilation.revision.name,
        latestRevision: revisionNumber,
        activeRevisionId: existing?.rule.activeRevisionId ?? null,
        createdAt: existing?.rule.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const revision: OrcaRuleRevision = {
        id: id(),
        ruleId,
        workspaceId: input.workspaceId,
        revision: revisionNumber,
        source: request.source,
        sourceDigest: `sha256:${createHash("sha256").update(request.source).digest("hex")}`,
        compiled: compilation.revision,
        actor: input.actor,
        createdAt: timestamp,
      };
      return repository.append({
        expectedWorkspaceSchemaRevision: request.workspaceSchemaRevision,
        expectedRuleRevision: request.expectedRuleRevision,
        rule,
        revision,
      });
    },
    get(input: { workspaceId: string; ruleId: string }): OrcaRuleRevisionList {
      const result = repository.get(input.workspaceId, input.ruleId);
      if (!result) throw new RuleRevisionConflictError(null, null);
      return orcaRuleRevisionListSchema.parse(result);
    },
  };
}
