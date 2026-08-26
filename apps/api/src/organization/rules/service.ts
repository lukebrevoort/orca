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
  type OrganizationAuthorityDenialCode,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
} from "@orca/shared";

import { authorizeOrganizationOperation, canonicalOrganizationJson } from "../authority.ts";
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
export class RuleIdempotencyConflictError extends Error {
  readonly code = "duplicate_idempotency_key" as const;
  constructor(message = "Idempotency key was already used for a different Rule compilation") { super(message); }
}
export class RuleAuthorityError extends Error {
  constructor(readonly code: OrganizationAuthorityDenialCode, message: string) { super(message); }
}

declare const ruleAuthorizationAnchorBrand: unique symbol;
export type RuleAuthorizationAnchor = Readonly<{ [ruleAuthorizationAnchorBrand]: true }>;
export type RulePersistenceIntent = Readonly<{
  request: OrcaRuleCompileRequest;
  changeId: string;
  command: OrganizationCommand;
  executionContext: OrganizationExecutionContext;
  authorityTrace: OrganizationAuthorityTrace;
  authorizationEnvelopeDigest: string;
  expectedWorkspaceSchemaRevision: number;
  expectedRuleRevision: number | null;
  rule: OrcaRule;
  revision: OrcaRuleRevision;
}>;
type RuleAuthorizationBinding = Readonly<{
  actor: OrganizationActor;
  workspaceId: string;
  accountIds: string[];
  authorizationEnvelopeDigest: string;
  persistenceIntentDigest: string;
}>;
const ruleAuthorizationAnchors = new WeakMap<object, RuleAuthorizationBinding>();

/** Canonically binds every caller-controlled field that can affect Rule authority or persistence. */
export function digestRulePersistenceIntent(input: RulePersistenceIntent): string {
  const intent: RulePersistenceIntent = {
    request: input.request,
    changeId: input.changeId,
    command: input.command,
    executionContext: input.executionContext,
    authorityTrace: input.authorityTrace,
    authorizationEnvelopeDigest: input.authorizationEnvelopeDigest,
    expectedWorkspaceSchemaRevision: input.expectedWorkspaceSchemaRevision,
    expectedRuleRevision: input.expectedRuleRevision,
    rule: input.rule,
    revision: input.revision,
  };
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(intent)).digest("hex")}`;
}

function issueRuleAuthorizationAnchor(binding: RuleAuthorizationBinding): RuleAuthorizationAnchor {
  const anchor = Object.freeze({}) as RuleAuthorizationAnchor;
  ruleAuthorizationAnchors.set(anchor, structuredClone(binding));
  return anchor;
}

/** Transaction adapters consume a service-issued authorization binding exactly once. */
export function consumeRuleAuthorizationAnchor(anchor: unknown): RuleAuthorizationBinding | null {
  if (typeof anchor !== "object" || anchor === null) return null;
  const binding = ruleAuthorizationAnchors.get(anchor);
  ruleAuthorizationAnchors.delete(anchor);
  return binding ? structuredClone(binding) : null;
}

export type RuleRevisionRepository = {
  loadWorkspaceSnapshot(workspaceId: string): OrcaWorkspaceSnapshot;
  getAuthorityState(workspaceId: string): {
    accountIds: string[];
    workspaceRevision: number;
    resourceRevisions: Record<string, number>;
    reservedIdempotencyKeys: string[];
  };
  getIdempotent(workspaceId: string, idempotencyKey: string): {
    request: OrcaRuleCompileRequest;
    response: OrcaRuleCompileResponse & { ok: true };
  } | null;
  append(input: RulePersistenceIntent & {
    authorizationAnchor: RuleAuthorizationAnchor;
  }): OrcaRuleCompileResponse & { ok: true };
  get(workspaceId: string, ruleId: string): OrcaRuleRevisionList | null;
};

export function createRuleRevisionService(repository: RuleRevisionRepository, options: {
  now?: () => Date;
  id?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const capability = (actor: OrganizationActor, workspaceId: string, accountIds: string[]): OrganizationCapabilitySnapshot => ({
    id: `first_party:rule_compiler:${actor.type}:${actor.id}`,
    revision: 1,
    actor,
    scope: { workspaceId, accountIds },
    operations: ["query", "apply"],
    resourceFamilies: ["rule", "audit", "change_set"],
    actionFamilies: ["organization_read", "organization_structure"],
  });
  return {
    compile(input: { actor: OrganizationActor; workspaceId: string; request: unknown }): OrcaRuleCompileResponse {
      const request = orcaRuleCompileRequestSchema.parse(input.request);
      const replay = repository.getIdempotent(input.workspaceId, request.idempotencyKey);
      if (replay) {
        if (canonicalOrganizationJson(replay.request) !== canonicalOrganizationJson(request)) throw new RuleIdempotencyConflictError();
        return replay.response;
      }
      const workspace = repository.loadWorkspaceSnapshot(input.workspaceId);
      if (request.workspaceSchemaRevision !== workspace.revision) {
        throw new WorkspaceSchemaConflictError(request.workspaceSchemaRevision, workspace.revision);
      }
      const compilation = compileOrcaRule({ source: request.source, workspace });
      if (!compilation.ok) return orcaRuleCompileResponseSchema.parse(compilation);

      const existing = request.ruleId ? repository.get(input.workspaceId, request.ruleId) : null;
      const actualRevision = existing?.rule.latestRevision ?? null;
      if (request.expectedRuleRevision !== null && (!existing || actualRevision !== request.expectedRuleRevision)) {
        throw new RuleRevisionConflictError(request.expectedRuleRevision, actualRevision);
      }
      if (request.expectedRuleRevision === null && existing) throw new RuleRevisionConflictError(null, actualRevision);
      const timestamp = now().toISOString();
      const ruleId = existing?.rule.id ?? request.ruleId ?? id();
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
      const changeId = id();
      const command: OrganizationCommand = {
        id: changeId,
        intents: [{
          kind: "mutate_rule",
          resourceId: `rule:${ruleId}`,
          mutation: request.expectedRuleRevision === null ? "create" : "update",
          changes: { sourceDigest: revision.sourceDigest, revision: revisionNumber },
        }],
      };
      const live = repository.getAuthorityState(input.workspaceId);
      const granted = capability(input.actor, input.workspaceId, live.accountIds);
      const decision = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot: granted,
        operation: "apply",
        scope: granted.scope,
        command,
        expectedRevisions: {
          workspace: request.workspaceSchemaRevision,
          resources: request.expectedRuleRevision === null ? {} : { [`rule:${ruleId}`]: request.expectedRuleRevision },
        },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: granted.scope,
        capability: { snapshot: granted, revokedAt: null },
        workspaceRevision: live.workspaceRevision,
        resourceRevisions: live.resourceRevisions,
        reservedIdempotencyKeys: live.reservedIdempotencyKeys,
      });
      if (!decision.allowed) {
        if (decision.code === "duplicate_idempotency_key") throw new RuleIdempotencyConflictError(decision.reason);
        throw new RuleAuthorityError(decision.code, decision.reason);
      }
      const persistenceIntent: RulePersistenceIntent = {
        request,
        changeId,
        command,
        executionContext: decision.executionContext,
        authorityTrace: decision.trace,
        authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest,
        expectedWorkspaceSchemaRevision: request.workspaceSchemaRevision,
        expectedRuleRevision: request.expectedRuleRevision,
        rule,
        revision,
      };
      return repository.append({
        ...persistenceIntent,
        authorizationAnchor: issueRuleAuthorizationAnchor({
          actor: input.actor,
          workspaceId: input.workspaceId,
          accountIds: granted.scope.accountIds,
          authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest,
          persistenceIntentDigest: digestRulePersistenceIntent(persistenceIntent),
        }),
      });
    },
    get(input: { workspaceId: string; ruleId: string }): OrcaRuleRevisionList {
      const result = repository.get(input.workspaceId, input.ruleId);
      if (!result) throw new RuleRevisionConflictError(null, null);
      return orcaRuleRevisionListSchema.parse(result);
    },
  };
}
