import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  organizationCapabilitySnapshotSchema,
  organizationCommandSchema,
  organizationAuthorityTraceSchema,
  mcpOrganizationApprovalSchema,
  orcaRuleActivationRequestSchema,
  orcaRuleRevertRequestSchema,
  type OrcaEvaluationTrace,
  type OrcaCompiledAction,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrcaRuleRisk,
  type McpOrganizationApproval,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads,
  collections,
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationContexts,
  organizationContextRelationshipTypes,
  organizationRuleRevisions,
  organizationRules,
  organizationRuleSets,
  organizationThreadFacetValues,
  organizationThreadContextRelationships,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
} from "../../db/schema.ts";
import {
  authorizeOrganizationOperation,
  canonicalOrganizationJson,
  digestOrganizationCommand,
} from "../authority.ts";
import { createHistoricalRuleSimulationService } from "./simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./simulation-sqlite.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

type ProjectedAction = Extract<OrcaCompiledAction, {
  kind: "route_lane" | "set_workflow_state" | "set_facet" | "unset_facet"
    | "add_collection" | "remove_collection" | "link_context" | "unlink_context";
}>;

export const bre317ActionSupport = {
  route_lane: "projected",
  set_workflow_state: "projected",
  set_facet: "projected",
  unset_facet: "projected",
  add_collection: "projected",
  remove_collection: "projected",
  link_context: "projected",
  unlink_context: "projected",
  notify: "proposal_only",
  suppress_interruption: "proposal_only",
  schedule_review: "proposal_only",
  propose_retention: "proposal_only",
  propose_provider_deletion: "proposal_only",
} as const satisfies Record<OrcaCompiledAction["kind"], "projected" | "proposal_only">;

function isProjectedAction(action: OrcaCompiledAction): action is ProjectedAction {
  return bre317ActionSupport[action.kind] === "projected";
}

export type RuleChangeSetLiveCapability = {
  snapshot: OrganizationCapabilitySnapshot;
  revokedAt: string | null;
};

export type RuleChangeSetCapabilitySource = {
  load(db: Database, input: { workspaceId: string }): RuleChangeSetLiveCapability | null;
};

/**
 * Resolves the first-party human grant from persisted Workspace/Account
 * ownership. Callers may present this immutable snapshot, but only a fresh
 * transaction-side resolution is accepted as live authority.
 */
export const sqliteRuleChangeSetCapabilitySource: RuleChangeSetCapabilitySource = {
  load(db, { workspaceId }) {
    const accountIds = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
      .where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.id)).all()
      .map(({ id: accountId }) => accountId);
    return {
      snapshot: {
        id: `first_party:rule_change_set:human:${workspaceId}`,
        revision: 1,
        actor: { id: workspaceId, type: "human" },
        scope: { workspaceId, accountIds },
        operations: ["simulate", "apply", "revert"],
        resourceFamilies: ["rule", "thread", "lane", "facet", "workflow_state", "collection", "context", "change_set", "trace", "audit"],
        actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"],
      },
      revokedAt: null,
    };
  },
};

function loadRequiredCapability(source: RuleChangeSetCapabilitySource, db: Database, workspaceId: string): RuleChangeSetLiveCapability {
  const capability = source.load(db, { workspaceId });
  if (!capability) throw new OrcaRuleChangeSetError("capability_missing", "No current live Capability authorizes this Rule Change Set operation");
  return capability;
}

export type OrcaRuleChangeSetResult = {
  changeSetId: string;
  status: "active" | "reverted" | "conflicted";
  operation: "apply" | "revert";
  ruleId: string;
  revisionId: string;
  simulationId: string;
  revertsChangeSetId: string | null;
  workspaceRevisionBefore: number;
  workspaceRevisionAfter: number;
  ruleSetRevisionAfter: number;
  traceCount: number;
  risk: OrcaRuleRisk;
  conflicts: Array<{ resourceId: string; expectedRevision: number; actualRevision: number | null }>;
};

export class OrcaRuleChangeSetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OrcaRuleChangeSetError";
  }
}

export class OrcaRuleCompensationConflictError extends OrcaRuleChangeSetError {
  constructor(readonly conflicts: OrcaRuleChangeSetResult["conflicts"]) {
    super("compensation_conflict", "Newer Organization state conflicts with this compensating Change Set");
    this.name = "OrcaRuleCompensationConflictError";
  }
}

type ThreadPlan = {
  accountId: string;
  threadId: string;
  expectedRevision: number;
  actions: Array<{ action: ProjectedAction; reason: string; traceCandidateId: string }>;
  trace: OrcaEvaluationTrace;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`;
}

function sameRequest(left: unknown, right: unknown): boolean {
  return canonicalOrganizationJson(left) === canonicalOrganizationJson(right);
}

function parseReplay(row: typeof organizationChangeSets.$inferSelect, request: unknown, approval?: McpOrganizationApproval): OrcaRuleChangeSetResult {
  const stored = JSON.parse(row.commandJson) as { request?: unknown; response?: OrcaRuleChangeSetResult; approval?: unknown };
  if (!stored.response || !sameRequest(stored.request, request) || (approval !== undefined && !sameRequest(stored.approval, approval))) {
    throw new OrcaRuleChangeSetError("duplicate_idempotency_key", "The idempotency key belongs to a different Change Set request");
  }
  return stored.response;
}

function denyReplay(code: string, reason: string): never {
  throw new OrcaRuleChangeSetError(code, reason);
}

function validateCurrentCapabilityClaim(input: {
  actor: OrganizationActor;
  capabilitySnapshot: OrganizationCapabilitySnapshot;
  liveCapability: RuleChangeSetLiveCapability;
  workspaceId: string;
  accountIds: string[];
  operation: "apply" | "revert";
}) {
  if (input.actor.id !== input.capabilitySnapshot.actor.id
    || input.actor.type !== input.capabilitySnapshot.actor.type) {
    denyReplay("actor_mismatch", "The Capability snapshot belongs to a different Actor identity or type");
  }
  if (input.liveCapability.revokedAt !== null) {
    denyReplay("capability_revoked", "The live Capability has been revoked");
  }
  if (JSON.stringify(input.capabilitySnapshot) !== JSON.stringify(input.liveCapability.snapshot)) {
    denyReplay("capability_stale", "The Capability snapshot is not the current live revision");
  }
  if (input.workspaceId !== input.capabilitySnapshot.scope.workspaceId
    || input.workspaceId !== input.liveCapability.snapshot.scope.workspaceId) {
    denyReplay("workspace_denied", "Workspace scope is not both current and granted");
  }
  const liveAccounts = new Set(input.liveCapability.snapshot.scope.accountIds);
  const grantedAccounts = new Set(input.capabilitySnapshot.scope.accountIds);
  if (input.accountIds.some((accountId) => !liveAccounts.has(accountId) || !grantedAccounts.has(accountId))) {
    denyReplay("account_denied", "Account scope is not owned or granted");
  }
  if (!input.capabilitySnapshot.operations.includes(input.operation)) {
    denyReplay("missing_operation_capability", `The Capability snapshot does not grant ${input.operation}`);
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function legacyReplayCommand(trace: ReturnType<typeof organizationAuthorityTraceSchema.parse>): OrganizationCommand {
  return organizationCommandSchema.parse({
    id: trace.command.id,
    intents: trace.requestedResourceIds.map((resourceId) => ({
      kind: resourceId.startsWith("thread:") ? "organize_thread" : "mutate_rule",
      resourceId,
      mutation: "update",
      changes: { replay: true },
    })),
  });
}

function authorizeReplay(input: {
  row: typeof organizationChangeSets.$inferSelect;
  actor: OrganizationActor;
  capabilitySnapshot: OrganizationCapabilitySnapshot;
  liveCapability: RuleChangeSetLiveCapability;
  workspaceId: string;
  accountIds: string[];
  operation: "apply" | "revert";
  idempotencyKey: string;
}) {
  let trace: ReturnType<typeof organizationAuthorityTraceSchema.parse>;
  let storedCommand: OrganizationCommand | undefined;
  try {
    trace = organizationAuthorityTraceSchema.parse(JSON.parse(input.row.authorityTrace));
    const stored = JSON.parse(input.row.commandJson) as { command?: unknown };
    if (stored.command !== undefined) storedCommand = organizationCommandSchema.parse(stored.command);
  } catch {
    denyReplay("invalid_change_set", "The stored Change Set authority evidence is invalid");
  }
  if (input.row.operation !== input.operation) {
    denyReplay("duplicate_idempotency_key", "The idempotency key belongs to a different Change Set request");
  }
  if (trace.operation !== input.operation
    || trace.command.digest !== input.row.commandDigest
    || trace.scope.workspaceId !== input.workspaceId
    || !sameAccountScope(trace.scope.accountIds, input.accountIds)) {
    denyReplay("invalid_change_set", "The stored Change Set authority evidence does not match this replay");
  }

  const command = storedCommand ?? legacyReplayCommand(trace);
  if (storedCommand && digestOrganizationCommand(storedCommand) !== input.row.commandDigest) {
    denyReplay("invalid_change_set", "The stored Change Set command digest is invalid");
  }
  const decision = authorizeOrganizationOperation({
    actor: input.actor,
    capabilitySnapshot: input.capabilitySnapshot,
    operation: input.operation,
    scope: { workspaceId: input.workspaceId, accountIds: input.accountIds },
    command,
    expectedRevisions: trace.expectedRevisions,
    idempotencyKey: input.idempotencyKey,
  }, {
    scope: input.liveCapability.snapshot.scope,
    capability: input.liveCapability,
    workspaceRevision: trace.expectedRevisions.workspace,
    resourceRevisions: trace.expectedRevisions.resources,
    reservedIdempotencyKeys: [],
  });
  if (!decision.allowed) denyReplay(decision.code, decision.reason);
  if (!storedCommand && (
    !sameValues(decision.trace.requestedResourceFamilies, trace.requestedResourceFamilies)
    || !sameValues(decision.trace.requestedActionFamilies, trace.requestedActionFamilies)
    || !sameValues(decision.trace.requestedResourceIds, trace.requestedResourceIds)
    || decision.trace.risk !== trace.risk
  )) {
    denyReplay("invalid_change_set", "The legacy Change Set authority requirements are inconsistent");
  }
}

function proposedWinners(trace: OrcaEvaluationTrace, revisionId: string) {
  return trace.winners.filter((winner) => winner.revisionId === revisionId);
}

function buildThreadPlans(
  preparation: ReturnType<ReturnType<typeof createHistoricalRuleSimulationService>["prepare"]>,
  revisionId: string,
): ThreadPlan[] {
  return preparation.evaluations.flatMap(({ context, result }): ThreadPlan[] => {
    const winners = proposedWinners(result.trace, revisionId);
    const actions: ThreadPlan["actions"] = [];
    for (const winner of winners) {
      const action = winner.action;
      const support = bre317ActionSupport[action.kind];
      if (!support) throw new OrcaRuleChangeSetError("unsupported_action", `Winning Action ${String((action as { kind?: unknown }).kind)} has no BRE-317 projection contract`);
      if (support === "proposal_only") continue;
      if (!isProjectedAction(action)) throw new OrcaRuleChangeSetError("unsupported_action", `Winning Action ${action.kind} has no BRE-317 projection contract`);
      if (action.kind === "route_lane" && action.laneId === context.thread.lanePlacement.primaryLaneId) continue;
      if (action.kind === "set_workflow_state" && action.stateId === context.thread.workflowStateId) continue;
      if (action.kind === "set_facet" && context.thread.facets[action.facetId] === action.value) continue;
      if (action.kind === "unset_facet" && context.thread.facets[action.facetId] === undefined) continue;
      if (action.kind === "add_collection" && context.thread.collectionIds.includes(action.collectionId)) continue;
      if (action.kind === "remove_collection" && !context.thread.collectionIds.includes(action.collectionId)) continue;
      if (action.kind === "link_context" && context.thread.contextIds.includes(action.contextId)) continue;
      if (action.kind === "unlink_context" && !context.thread.contextIds.includes(action.contextId)) continue;
      actions.push({ action, reason: winner.reason, traceCandidateId: winner.candidateId });
    }
    if (actions.length === 0) return [];
    if (context.thread.organizationRevision === null) {
      throw new OrcaRuleChangeSetError("expected_revision_required", `Thread ${context.thread.id} lacks an Organization revision`);
    }
    return [{
      accountId: context.thread.accountId,
      threadId: context.thread.id,
      expectedRevision: context.thread.organizationRevision,
      actions,
      trace: result.trace,
    }];
  });
}

function changeSetCommand(
  workspaceId: string,
  changeSetId: string,
  ruleId: string,
  revisionId: string,
  simulationId: string,
  ruleSetRevision: number,
  plans: ThreadPlan[],
): OrganizationCommand {
  return organizationCommandSchema.parse({
    id: changeSetId,
    intents: [
      {
        kind: "mutate_rule",
        resourceId: `rule:${ruleId}`,
        mutation: "update",
        changes: { activeRevisionId: revisionId, simulationId },
      },
      {
        kind: "mutate_rule",
        resourceId: `rule_set:${workspaceId}`,
        mutation: "update",
        changes: { revision: ruleSetRevision + 1, simulationId },
      },
      ...plans.map((plan) => ({
        kind: "organize_thread" as const,
        resourceId: `thread:${plan.accountId}:${plan.threadId}`,
        mutation: "update" as const,
        changes: {
          planDigest: digest(plan.actions),
          revision: plan.expectedRevision + 1,
        },
      })),
    ],
  });
}

type StoredInverseThread = {
  accountId: string;
  threadId: string;
  expectedRevisionAfter: number;
  beforeLane: Record<string, unknown> | null;
  beforeFacets: Array<Record<string, unknown>>;
  beforeWorkflow?: Record<string, unknown> | null;
  beforeCollections?: Array<{ collectionId: string; membership: Record<string, unknown> | null }>;
  beforeContexts?: Array<{ contextTypeId: string; contextId: string; relationship: Record<string, unknown> | null }>;
  beforeRevision: number;
};

type StoredApplyInverse = {
  rule: { activeRevisionId: string | null };
  ruleSetRevision: number;
  threads: StoredInverseThread[];
};

function parseApplyEvidence(row: typeof organizationChangeSets.$inferSelect): {
  response: OrcaRuleChangeSetResult;
  inverse: StoredApplyInverse;
  request: { accountIds: string[] };
} {
  try {
    const command = JSON.parse(row.commandJson) as {
      request?: { accountIds?: unknown };
      response?: OrcaRuleChangeSetResult;
    };
    const inverse = JSON.parse(row.inverseJson) as StoredApplyInverse;
    if (!command.response
      || !command.request
      || !Array.isArray(command.request.accountIds)
      || !inverse.rule
      || !Number.isInteger(inverse.ruleSetRevision)
      || !Array.isArray(inverse.threads)
      || inverse.threads.some((thread) => !thread.accountId || !thread.threadId
        || !Number.isInteger(thread.expectedRevisionAfter)
        || !Array.isArray(thread.beforeFacets)
        || (thread.beforeCollections !== undefined && !Array.isArray(thread.beforeCollections))
        || (thread.beforeContexts !== undefined && !Array.isArray(thread.beforeContexts)))) {
      throw new Error("incomplete evidence");
    }
    return {
      response: command.response,
      inverse,
      request: { accountIds: command.request.accountIds as string[] },
    };
  } catch {
    throw new OrcaRuleChangeSetError("invalid_change_set", "The original Change Set lacks complete inverse evidence");
  }
}

function sameAccountScope(left: string[], right: string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((accountId, index) => accountId === [...right].sort()[index]);
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new OrcaRuleChangeSetError("invalid_change_set", "Inverse evidence contains an invalid timestamp");
  return parsed;
}

function asDate(value: unknown, field: string): Date {
  const parsed = asNullableDate(value);
  if (!parsed) throw new OrcaRuleChangeSetError("invalid_change_set", `Inverse evidence lacks ${field}`);
  return parsed;
}

function asInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new OrcaRuleChangeSetError("invalid_change_set", `Inverse evidence lacks ${field}`);
  return value as number;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new OrcaRuleChangeSetError("invalid_change_set", `Inverse evidence lacks ${field}`);
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, "a nullable string");
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new OrcaRuleChangeSetError("invalid_change_set", "Inverse evidence lacks a boolean safety lock");
  return value;
}

function revertCommand(
  workspaceId: string,
  changeSetId: string,
  evidence: ReturnType<typeof parseApplyEvidence>,
  currentRuleSetRevision: number,
): OrganizationCommand {
  return organizationCommandSchema.parse({
    id: changeSetId,
    intents: [
      {
        kind: "mutate_rule",
        resourceId: `rule:${evidence.response.ruleId}`,
        mutation: "update",
        changes: { activeRevisionId: evidence.inverse.rule.activeRevisionId, revertsChangeSetId: evidence.response.changeSetId },
      },
      {
        kind: "mutate_rule",
        resourceId: `rule_set:${workspaceId}`,
        mutation: "update",
        changes: { revision: currentRuleSetRevision + 1, revertsChangeSetId: evidence.response.changeSetId },
      },
      ...evidence.inverse.threads.map((thread) => ({
        kind: "organize_thread" as const,
        resourceId: `thread:${thread.accountId}:${thread.threadId}`,
        mutation: "update" as const,
        changes: {
          revision: thread.expectedRevisionAfter + 1,
          compensationDigest: digest({
            beforeLane: thread.beforeLane,
            beforeFacets: thread.beforeFacets,
            beforeWorkflow: thread.beforeWorkflow,
            beforeCollections: thread.beforeCollections,
            beforeContexts: thread.beforeContexts,
          }),
        },
      })),
    ],
  });
}

export function createSqliteRuleChangeSetService(db: Database, options: {
  id?: () => string;
  now?: () => Date;
  capabilitySource?: RuleChangeSetCapabilitySource;
} = {}) {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const capabilitySource = options.capabilitySource ?? sqliteRuleChangeSetCapabilitySource;
  const simulations = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));

  return {
    activate(input: {
      actor: OrganizationActor;
      capabilitySnapshot: OrganizationCapabilitySnapshot | unknown;
      workspaceId: string;
      request: unknown;
      approval?: unknown;
    }): OrcaRuleChangeSetResult {
      const request = orcaRuleActivationRequestSchema.parse(input.request);
      const approval = input.actor.type === "agent" ? mcpOrganizationApprovalSchema.parse(input.approval) : undefined;
      const capabilitySnapshot = organizationCapabilitySnapshotSchema.parse(input.capabilitySnapshot);
      const liveCapability = loadRequiredCapability(capabilitySource, db, input.workspaceId);
      validateCurrentCapabilityClaim({
        actor: input.actor,
        capabilitySnapshot,
        liveCapability,
        workspaceId: input.workspaceId,
        accountIds: request.accountIds,
        operation: "apply",
      });
      const replay = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
      )).get();
      if (replay) {
        authorizeReplay({
          row: replay,
          actor: input.actor,
          capabilitySnapshot,
          liveCapability,
          workspaceId: input.workspaceId,
          accountIds: request.accountIds,
          operation: "apply",
          idempotencyKey: request.idempotencyKey,
        });
        return parseReplay(replay, request, approval);
      }

      const revisionRow = db.select().from(organizationRuleRevisions).where(and(
        eq(organizationRuleRevisions.workspaceId, input.workspaceId),
        eq(organizationRuleRevisions.ruleId, request.ruleId),
        eq(organizationRuleRevisions.id, request.revisionId),
      )).get();
      if (!revisionRow) throw new OrcaRuleChangeSetError("simulation_binding_conflict", "The simulated Rule Revision is unavailable");
      const preparation = simulations.prepare({
        actor: input.actor,
        workspaceId: input.workspaceId,
        request: {
          ruleId: request.ruleId,
          revisionId: request.revisionId,
          workspaceSchemaRevision: revisionRow.workspaceSchemaRevision,
          accountIds: request.accountIds,
          maximumThreads: request.maximumThreads,
        },
      });
      if (preparation.report.simulationId !== request.simulationId
        || preparation.report.state !== "simulated"
        || preparation.report.binding.workspaceRevision !== request.expectedWorkspaceRevision) {
        throw new OrcaRuleChangeSetError("simulation_binding_conflict", "Activation requires the exact current successful Simulation");
      }
      if (approval && (approval.simulationId !== preparation.report.simulationId || approval.acknowledgedRisk !== preparation.report.risk)) {
        throw new OrcaRuleChangeSetError("approval_binding_conflict", "Agent approval must bind the exact successful Simulation and its derived risk");
      }

      const workspace = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
      const rule = db.select().from(organizationRules).where(and(
        eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
      )).get();
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
      if (!workspace || !rule || !ruleSet) throw new OrcaRuleChangeSetError("revision_conflict", "Rule activation roots are unavailable");
      if (workspace.revision !== request.expectedWorkspaceRevision
        || rule.latestRevision !== request.expectedRuleRevision
        || revisionRow.revision !== request.expectedRuleRevision
        || ruleSet.revision !== request.expectedRuleSetRevision) {
        throw new OrcaRuleChangeSetError("revision_conflict", "Rule activation expected revisions are stale");
      }

      const plans = buildThreadPlans(preparation, request.revisionId);
      const changeSetId = id();
      const command = changeSetCommand(
        input.workspaceId,
        changeSetId,
        request.ruleId,
        request.revisionId,
        request.simulationId,
        ruleSet.revision,
        plans,
      );
      const expectedResources = Object.fromEntries([
        [`rule:${request.ruleId}`, rule.latestRevision],
        [`rule_set:${input.workspaceId}`, ruleSet.revision],
        ...plans.map((plan) => [`thread:${plan.accountId}:${plan.threadId}`, plan.expectedRevision] as const),
      ]);
      const ownedAccounts = liveCapability.snapshot.scope.accountIds;
      const liveResourceRevisions = {
        ...expectedResources,
      };
      const reservedKeys = db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
        .where(eq(organizationChangeSets.workspaceId, input.workspaceId)).all().map(({ key }) => key);
      const authority = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot,
        operation: "apply",
        scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
        command,
        expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: { workspaceId: input.workspaceId, accountIds: ownedAccounts },
        capability: liveCapability,
        workspaceRevision: workspace.revision,
        resourceRevisions: liveResourceRevisions,
        reservedIdempotencyKeys: reservedKeys,
      });
      if (!authority.allowed) throw new OrcaRuleChangeSetError(authority.code, authority.reason);

      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const duplicate = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
        )).get();
        if (duplicate) return parseReplay(duplicate, request, approval);

        const currentWorkspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
        )).get();
        const currentRuleSet = executor.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
        const currentAccounts = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, input.workspaceId)).orderBy(asc(oauthAccounts.id)).all().map(({ id: accountId }) => accountId);
        if (!currentWorkspace || currentWorkspace.revision !== request.expectedWorkspaceRevision
          || !currentRule || currentRule.latestRevision !== request.expectedRuleRevision
          || !currentRuleSet || currentRuleSet.revision !== request.expectedRuleSetRevision
          || request.accountIds.some((accountId) => !currentAccounts.includes(accountId))) {
          throw new OrcaRuleChangeSetError("revision_conflict", "Activation state changed before the Change Set transaction");
        }
        for (const plan of plans) {
          const state = executor.select().from(organizationThreadStates).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, plan.accountId),
            eq(organizationThreadStates.threadId, plan.threadId),
          )).get();
          if (!state || state.revision !== plan.expectedRevision) {
            throw new OrcaRuleChangeSetError("revision_conflict", `Thread ${plan.threadId} changed after Simulation`);
          }
        }

        const currentLiveCapability = loadRequiredCapability(capabilitySource, executor, input.workspaceId);
        const transactionAuthority = authorizeOrganizationOperation({
          actor: input.actor,
          capabilitySnapshot,
          operation: "apply",
          scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
          command,
          expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
          idempotencyKey: request.idempotencyKey,
        }, {
          scope: { workspaceId: input.workspaceId, accountIds: currentAccounts },
          capability: currentLiveCapability,
          workspaceRevision: currentWorkspace.revision,
          resourceRevisions: expectedResources,
          reservedIdempotencyKeys: [],
        });
        if (!transactionAuthority.allowed) throw new OrcaRuleChangeSetError(transactionAuthority.code, transactionAuthority.reason);

        const timestamp = now();
        const inverseThreads: Array<Record<string, unknown>> = [];
        const actionRows: Array<typeof organizationChangeActions.$inferInsert> = [];
        let actionPosition = 0;
        actionRows.push({
          workspaceId: input.workspaceId,
          changeId: changeSetId,
          position: actionPosition++,
          actionKind: "activate_rule_revision",
          resourceFamily: "rule",
          resourceId: request.ruleId,
          beforeJson: JSON.stringify({ activeRevisionId: currentRule.activeRevisionId, ruleSetRevision: currentRuleSet.revision }),
          afterJson: JSON.stringify({ activeRevisionId: request.revisionId, ruleSetRevision: currentRuleSet.revision + 1 }),
        });

        for (const plan of plans) {
          const beforeLane = executor.select().from(organizationThreadLaneStates).where(and(
            eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
            eq(organizationThreadLaneStates.accountId, plan.accountId),
            eq(organizationThreadLaneStates.threadId, plan.threadId),
          )).get();
          const beforeFacets = executor.select().from(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, plan.accountId),
            eq(organizationThreadFacetValues.threadId, plan.threadId),
          )).all();
          const beforeWorkflow = executor.select().from(organizationThreadWorkflowStates).where(and(
            eq(organizationThreadWorkflowStates.workspaceId, input.workspaceId),
            eq(organizationThreadWorkflowStates.accountId, plan.accountId),
            eq(organizationThreadWorkflowStates.threadId, plan.threadId),
          )).get() ?? null;
          const beforeCollections: NonNullable<StoredInverseThread["beforeCollections"]> = [];
          const beforeContexts: NonNullable<StoredInverseThread["beforeContexts"]> = [];

          for (const planned of plan.actions) {
            const action = planned.action;
            if (action.kind === "route_lane") {
              if (!beforeLane) throw new OrcaRuleChangeSetError("revision_conflict", `Thread ${plan.threadId} has no Lane placement`);
              executor.update(organizationThreadLaneStates).set({
                primaryLaneId: action.laneId,
                placementSource: "rule_revision",
                sourceId: request.revisionId,
                actorId: input.actor.id,
                actorType: input.actor.type,
                reason: planned.reason,
                revision: beforeLane.revision + 1,
                updatedAt: timestamp,
              }).where(and(
                eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
                eq(organizationThreadLaneStates.accountId, plan.accountId),
                eq(organizationThreadLaneStates.threadId, plan.threadId),
                eq(organizationThreadLaneStates.revision, beforeLane.revision),
              )).run();
              actionRows.push({
                workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
                actionKind: action.kind, resourceFamily: "lane", resourceId: `thread:${plan.accountId}:${plan.threadId}`,
                beforeJson: JSON.stringify(beforeLane),
                afterJson: JSON.stringify({ laneId: action.laneId, revision: beforeLane.revision + 1, traceCandidateId: planned.traceCandidateId }),
              });
            } else if (action.kind === "set_workflow_state") {
              const definition = executor.select({ id: organizationWorkflowStates.id }).from(organizationWorkflowStates).where(and(
                eq(organizationWorkflowStates.workspaceId, input.workspaceId), eq(organizationWorkflowStates.id, action.stateId),
              )).get();
              if (!definition) throw new OrcaRuleChangeSetError("revision_conflict", `Workflow State ${action.stateId} is not live`);
              executor.insert(organizationThreadWorkflowStates).values({
                workspaceId: input.workspaceId, accountId: plan.accountId, threadId: plan.threadId,
                stateId: action.stateId, updatedAt: timestamp,
              }).onConflictDoUpdate({
                target: [organizationThreadWorkflowStates.workspaceId, organizationThreadWorkflowStates.accountId, organizationThreadWorkflowStates.threadId],
                set: { stateId: action.stateId, updatedAt: timestamp },
              }).run();
              actionRows.push({
                workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
                actionKind: action.kind, resourceFamily: "workflow_state", resourceId: `thread:${plan.accountId}:${plan.threadId}:workflow`,
                beforeJson: beforeWorkflow ? JSON.stringify(beforeWorkflow) : null,
                afterJson: JSON.stringify({ stateId: action.stateId, traceCandidateId: planned.traceCandidateId }),
              });
            } else if (action.kind === "set_facet" || action.kind === "unset_facet") {
              const before = beforeFacets.find((item) => item.facetId === action.facetId) ?? null;
              if (action.kind === "unset_facet") {
              executor.delete(organizationThreadFacetValues).where(and(
                eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
                eq(organizationThreadFacetValues.facetId, action.facetId),
                eq(organizationThreadFacetValues.accountId, plan.accountId),
                eq(organizationThreadFacetValues.threadId, plan.threadId),
              )).run();
            } else if (before) {
              executor.update(organizationThreadFacetValues).set({ value: JSON.stringify(action.value), updatedAt: timestamp }).where(and(
                eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
                eq(organizationThreadFacetValues.facetId, action.facetId),
                eq(organizationThreadFacetValues.accountId, plan.accountId),
                eq(organizationThreadFacetValues.threadId, plan.threadId),
              )).run();
            } else {
              executor.insert(organizationThreadFacetValues).values({
                workspaceId: input.workspaceId, facetId: action.facetId, accountId: plan.accountId,
                threadId: plan.threadId, value: JSON.stringify(action.value), updatedAt: timestamp,
              }).run();
            }
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: action.kind,
              resourceFamily: "facet", resourceId: `thread:${plan.accountId}:${plan.threadId}:facet:${action.facetId}`,
              beforeJson: before ? JSON.stringify(before) : null,
              afterJson: action.kind === "set_facet" ? JSON.stringify({ value: action.value, traceCandidateId: planned.traceCandidateId }) : null,
            });
            } else if (action.kind === "add_collection" || action.kind === "remove_collection") {
              if (action.accountId !== plan.accountId) throw new OrcaRuleChangeSetError("account_denied", "Collection projection is bound to a different Account");
              const collection = executor.select({ id: collections.id }).from(collections).where(and(
                eq(collections.id, action.collectionId), eq(collections.accountId, plan.accountId),
              )).get();
              if (!collection) throw new OrcaRuleChangeSetError("account_denied", `Collection ${action.collectionId} is outside the Thread Account`);
              const membership = executor.select().from(collectionThreads).where(and(
                eq(collectionThreads.collectionId, action.collectionId), eq(collectionThreads.threadId, plan.threadId),
              )).get() ?? null;
              beforeCollections.push({ collectionId: action.collectionId, membership });
              if (action.kind === "add_collection") {
                executor.insert(collectionThreads).values({
                  id: `${changeSetId}:collection:${actionPosition}`, collectionId: action.collectionId,
                  threadId: plan.threadId, createdAt: timestamp,
                }).onConflictDoNothing().run();
              } else {
                executor.delete(collectionThreads).where(and(
                  eq(collectionThreads.collectionId, action.collectionId), eq(collectionThreads.threadId, plan.threadId),
                )).run();
              }
              actionRows.push({
                workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
                actionKind: action.kind, resourceFamily: "collection", resourceId: `thread:${plan.accountId}:${plan.threadId}:collection:${action.collectionId}`,
                beforeJson: membership ? JSON.stringify(membership) : null,
                afterJson: JSON.stringify({ member: action.kind === "add_collection", traceCandidateId: planned.traceCandidateId }),
              });
            } else {
              const context = executor.select({ id: organizationContexts.id }).from(organizationContexts).where(and(
                eq(organizationContexts.workspaceId, input.workspaceId), eq(organizationContexts.id, action.contextId),
                eq(organizationContexts.contextTypeId, action.contextTypeId),
              )).get();
              if (!context) throw new OrcaRuleChangeSetError("revision_conflict", `Context ${action.contextId} is not live`);
              const relationshipType = executor.select().from(organizationContextRelationshipTypes).where(and(
                eq(organizationContextRelationshipTypes.workspaceId, input.workspaceId),
                eq(organizationContextRelationshipTypes.contextTypeId, action.contextTypeId),
                eq(organizationContextRelationshipTypes.direction, "thread_to_context"),
              )).orderBy(asc(organizationContextRelationshipTypes.position), asc(organizationContextRelationshipTypes.id)).get();
              if (!relationshipType) throw new OrcaRuleChangeSetError("revision_conflict", `Context Type ${action.contextTypeId} has no live Thread relationship`);
              const relationship = executor.select().from(organizationThreadContextRelationships).where(and(
                eq(organizationThreadContextRelationships.workspaceId, input.workspaceId),
                eq(organizationThreadContextRelationships.accountId, plan.accountId),
                eq(organizationThreadContextRelationships.threadId, plan.threadId),
                eq(organizationThreadContextRelationships.contextTypeId, action.contextTypeId),
                eq(organizationThreadContextRelationships.contextId, action.contextId),
              )).get() ?? null;
              beforeContexts.push({ contextTypeId: action.contextTypeId, contextId: action.contextId, relationship });
              if (action.kind === "link_context") {
                executor.insert(organizationThreadContextRelationships).values({
                  workspaceId: input.workspaceId, id: `${changeSetId}:context:${actionPosition}`,
                  accountId: plan.accountId, threadId: plan.threadId, contextTypeId: action.contextTypeId, contextId: action.contextId,
                  relationshipTypeId: relationshipType.id, direction: "thread_to_context", revision: 1,
                  createdAt: timestamp, updatedAt: timestamp,
                }).onConflictDoNothing().run();
              } else {
                executor.delete(organizationThreadContextRelationships).where(and(
                  eq(organizationThreadContextRelationships.workspaceId, input.workspaceId),
                  eq(organizationThreadContextRelationships.accountId, plan.accountId),
                  eq(organizationThreadContextRelationships.threadId, plan.threadId),
                  eq(organizationThreadContextRelationships.contextTypeId, action.contextTypeId),
                  eq(organizationThreadContextRelationships.contextId, action.contextId),
                )).run();
              }
              actionRows.push({
                workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
                actionKind: action.kind, resourceFamily: "context", resourceId: `thread:${plan.accountId}:${plan.threadId}:context:${action.contextId}`,
                beforeJson: relationship ? JSON.stringify(relationship) : null,
                afterJson: JSON.stringify({ linked: action.kind === "link_context", traceCandidateId: planned.traceCandidateId }),
              });
            }
          }
          inverseThreads.push({
            accountId: plan.accountId,
            threadId: plan.threadId,
            expectedRevisionAfter: plan.expectedRevision + 1,
            beforeLane,
            beforeFacets,
            beforeWorkflow,
            beforeCollections,
            beforeContexts,
            beforeRevision: plan.expectedRevision,
          });
          executor.update(organizationThreadStates).set({
            revision: plan.expectedRevision + 1,
            updatedAt: timestamp,
          }).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, plan.accountId),
            eq(organizationThreadStates.threadId, plan.threadId),
            eq(organizationThreadStates.revision, plan.expectedRevision),
          )).run();
        }

        const workspaceRevisionAfter = request.expectedWorkspaceRevision + 1;
        const ruleSetRevisionAfter = request.expectedRuleSetRevision + 1;
        executor.update(organizationRules).set({ activeRevisionId: request.revisionId, updatedAt: timestamp }).where(and(
          eq(organizationRules.workspaceId, input.workspaceId), eq(organizationRules.id, request.ruleId),
        )).run();
        executor.update(organizationRuleSets).set({ revision: ruleSetRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationRuleSets.workspaceId, input.workspaceId), eq(organizationRuleSets.revision, request.expectedRuleSetRevision),
        )).run();
        executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationWorkspaceStates.workspaceId, input.workspaceId), eq(organizationWorkspaceStates.revision, request.expectedWorkspaceRevision),
        )).run();

        const response: OrcaRuleChangeSetResult = {
          changeSetId,
          status: "active",
          operation: "apply",
          ruleId: request.ruleId,
          revisionId: request.revisionId,
          simulationId: request.simulationId,
          revertsChangeSetId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          ruleSetRevisionAfter,
          traceCount: preparation.evaluations.length,
          risk: preparation.report.risk,
          conflicts: [],
        };
        const resultingRevisions = {
          workspace: workspaceRevisionAfter,
          ruleSet: ruleSetRevisionAfter,
          rule: currentRule.latestRevision,
          threads: Object.fromEntries(plans.map((plan) => [`${plan.accountId}:${plan.threadId}`, plan.expectedRevision + 1])),
        };
        executor.insert(organizationChangeSets).values({
          workspaceId: input.workspaceId,
          id: changeSetId,
          idempotencyKey: request.idempotencyKey,
          commandDigest: transactionAuthority.executionContext.command.digest,
          authorityTrace: JSON.stringify(transactionAuthority.trace),
          resourceFamily: "rule",
          operation: "apply",
          commandJson: JSON.stringify({ request, response, command, ...(approval ? { approval } : {}) }),
          revertsChangeId: null,
          simulationId: request.simulationId,
          risk: preparation.report.risk,
          traceJson: JSON.stringify(preparation.evaluations.map(({ result }) => result.trace)),
          inverseJson: JSON.stringify({
            rule: { activeRevisionId: currentRule.activeRevisionId },
            ruleSetRevision: currentRuleSet.revision,
            threads: inverseThreads,
          }),
          resultingRevisionsJson: JSON.stringify(resultingRevisions),
          status: "active",
          revertedByChangeId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          createdAt: timestamp,
        }).run();
        if (actionRows.length) executor.insert(organizationChangeActions).values(actionRows).run();
        return response;
      });
    },
    revert(input: {
      actor: OrganizationActor;
      capabilitySnapshot: OrganizationCapabilitySnapshot | unknown;
      workspaceId: string;
      request: unknown;
    }): OrcaRuleChangeSetResult {
      const request = orcaRuleRevertRequestSchema.parse(input.request);
      const capabilitySnapshot = organizationCapabilitySnapshotSchema.parse(input.capabilitySnapshot);
      const liveCapability = loadRequiredCapability(capabilitySource, db, input.workspaceId);
      validateCurrentCapabilityClaim({
        actor: input.actor,
        capabilitySnapshot,
        liveCapability,
        workspaceId: input.workspaceId,
        accountIds: request.accountIds,
        operation: "revert",
      });
      const replay = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
      )).get();
      if (replay) {
        authorizeReplay({
          row: replay,
          actor: input.actor,
          capabilitySnapshot,
          liveCapability,
          workspaceId: input.workspaceId,
          accountIds: request.accountIds,
          operation: "revert",
          idempotencyKey: request.idempotencyKey,
        });
        return parseReplay(replay, request);
      }

      const original = db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId),
        eq(organizationChangeSets.id, request.changeSetId),
      )).get();
      if (!original || original.operation !== "apply" || original.resourceFamily !== "rule") {
        throw new OrcaRuleChangeSetError("change_set_not_found", "The applied Rule Change Set is unavailable");
      }
      if (original.status !== "active" || original.revertedByChangeId) {
        throw new OrcaRuleChangeSetError("change_set_already_reverted", "The Rule Change Set was already reverted");
      }
      const evidence = parseApplyEvidence(original);
      if (!sameAccountScope(request.accountIds, evidence.request.accountIds)
        || evidence.inverse.threads.some((thread) => !request.accountIds.includes(thread.accountId))) {
        throw new OrcaRuleChangeSetError("account_denied", "Revert requires the exact Account scope of the applied Change Set");
      }

      const workspace = db.select().from(organizationWorkspaceStates)
        .where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
      const rule = db.select().from(organizationRules).where(and(
        eq(organizationRules.workspaceId, input.workspaceId),
        eq(organizationRules.id, evidence.response.ruleId),
      )).get();
      const ruleSet = db.select().from(organizationRuleSets)
        .where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
      if (!workspace || !rule || !ruleSet) {
        throw new OrcaRuleChangeSetError("revision_conflict", "Rule revert roots are unavailable");
      }
      if (workspace.revision !== request.expectedWorkspaceRevision
        || original.workspaceRevisionAfter !== request.expectedWorkspaceRevision) {
        throw new OrcaRuleChangeSetError("revision_conflict", "The expected Workspace revision is stale");
      }

      const conflicts: OrcaRuleChangeSetResult["conflicts"] = [];
      if (rule.activeRevisionId !== evidence.response.revisionId) {
        conflicts.push({ resourceId: `rule:${rule.id}`, expectedRevision: evidence.response.ruleSetRevisionAfter - 1, actualRevision: rule.latestRevision });
      }
      if (ruleSet.revision !== evidence.response.ruleSetRevisionAfter) {
        conflicts.push({ resourceId: `rule_set:${input.workspaceId}`, expectedRevision: evidence.response.ruleSetRevisionAfter, actualRevision: ruleSet.revision });
      }
      for (const thread of evidence.inverse.threads) {
        const current = db.select().from(organizationThreadStates).where(and(
          eq(organizationThreadStates.workspaceId, input.workspaceId),
          eq(organizationThreadStates.accountId, thread.accountId),
          eq(organizationThreadStates.threadId, thread.threadId),
        )).get();
        if (!current || current.revision !== thread.expectedRevisionAfter) {
          conflicts.push({
            resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            expectedRevision: thread.expectedRevisionAfter,
            actualRevision: current?.revision ?? null,
          });
        }
      }
      if (conflicts.length) throw new OrcaRuleCompensationConflictError(conflicts);

      const changeSetId = id();
      const command = revertCommand(input.workspaceId, changeSetId, evidence, ruleSet.revision);
      const expectedResources = Object.fromEntries([
        [`rule:${rule.id}`, rule.latestRevision],
        [`rule_set:${input.workspaceId}`, ruleSet.revision],
        ...evidence.inverse.threads.map((thread) => [
          `thread:${thread.accountId}:${thread.threadId}`,
          thread.expectedRevisionAfter,
        ] as const),
      ]);
      const ownedAccounts = liveCapability.snapshot.scope.accountIds;
      const reservedKeys = db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets)
        .where(eq(organizationChangeSets.workspaceId, input.workspaceId)).all().map(({ key }) => key);
      const authority = authorizeOrganizationOperation({
        actor: input.actor,
        capabilitySnapshot,
        operation: "revert",
        scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
        command,
        expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
        idempotencyKey: request.idempotencyKey,
      }, {
        scope: { workspaceId: input.workspaceId, accountIds: ownedAccounts },
        capability: liveCapability,
        workspaceRevision: workspace.revision,
        resourceRevisions: expectedResources,
        reservedIdempotencyKeys: reservedKeys,
      });
      if (!authority.allowed) throw new OrcaRuleChangeSetError(authority.code, authority.reason);

      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const duplicate = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.idempotencyKey, request.idempotencyKey),
        )).get();
        if (duplicate) return parseReplay(duplicate, request);

        const currentOriginal = executor.select().from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.id, request.changeSetId),
        )).get();
        const currentWorkspace = executor.select().from(organizationWorkspaceStates)
          .where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.workspaceId),
          eq(organizationRules.id, evidence.response.ruleId),
        )).get();
        const currentRuleSet = executor.select().from(organizationRuleSets)
          .where(eq(organizationRuleSets.workspaceId, input.workspaceId)).get();
        const currentAccounts = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, input.workspaceId)).all().map(({ id: accountId }) => accountId);
        if (!currentOriginal || currentOriginal.status !== "active" || currentOriginal.revertedByChangeId
          || !currentWorkspace || currentWorkspace.revision !== request.expectedWorkspaceRevision
          || !currentRule || currentRule.activeRevisionId !== evidence.response.revisionId
          || !currentRuleSet || currentRuleSet.revision !== evidence.response.ruleSetRevisionAfter
          || request.accountIds.some((accountId) => !currentAccounts.includes(accountId))) {
          throw new OrcaRuleChangeSetError("revision_conflict", "Organization state changed before the compensating transaction");
        }
        for (const thread of evidence.inverse.threads) {
          const current = executor.select().from(organizationThreadStates).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, thread.accountId),
            eq(organizationThreadStates.threadId, thread.threadId),
          )).get();
          if (!current || current.revision !== thread.expectedRevisionAfter) {
            throw new OrcaRuleCompensationConflictError([{
              resourceId: `thread:${thread.accountId}:${thread.threadId}`,
              expectedRevision: thread.expectedRevisionAfter,
              actualRevision: current?.revision ?? null,
            }]);
          }
        }


        const currentLiveCapability = loadRequiredCapability(capabilitySource, executor, input.workspaceId);
        const transactionAuthority = authorizeOrganizationOperation({
          actor: input.actor,
          capabilitySnapshot,
          operation: "revert",
          scope: { workspaceId: input.workspaceId, accountIds: request.accountIds },
          command,
          expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
          idempotencyKey: request.idempotencyKey,
        }, {
          scope: { workspaceId: input.workspaceId, accountIds: currentAccounts },
          capability: currentLiveCapability,
          workspaceRevision: currentWorkspace.revision,
          resourceRevisions: expectedResources,
          reservedIdempotencyKeys: [],
        });
        if (!transactionAuthority.allowed) throw new OrcaRuleChangeSetError(transactionAuthority.code, transactionAuthority.reason);

        const timestamp = now();
        const inverseThreads: Array<Record<string, unknown>> = [];
        const actionRows: Array<typeof organizationChangeActions.$inferInsert> = [];
        let actionPosition = 0;
        actionRows.push({
          workspaceId: input.workspaceId,
          changeId: changeSetId,
          position: actionPosition++,
          actionKind: "revert_rule_revision",
          resourceFamily: "rule",
          resourceId: currentRule.id,
          beforeJson: JSON.stringify({ activeRevisionId: currentRule.activeRevisionId, ruleSetRevision: currentRuleSet.revision }),
          afterJson: JSON.stringify({ activeRevisionId: evidence.inverse.rule.activeRevisionId, ruleSetRevision: currentRuleSet.revision + 1 }),
        });

        for (const thread of evidence.inverse.threads) {
          const currentLane = executor.select().from(organizationThreadLaneStates).where(and(
            eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
            eq(organizationThreadLaneStates.accountId, thread.accountId),
            eq(organizationThreadLaneStates.threadId, thread.threadId),
          )).get();
          const currentFacets = executor.select().from(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, thread.accountId),
            eq(organizationThreadFacetValues.threadId, thread.threadId),
          )).all();
          const currentWorkflow = thread.beforeWorkflow === undefined ? undefined : executor.select().from(organizationThreadWorkflowStates).where(and(
            eq(organizationThreadWorkflowStates.workspaceId, input.workspaceId),
            eq(organizationThreadWorkflowStates.accountId, thread.accountId),
            eq(organizationThreadWorkflowStates.threadId, thread.threadId),
          )).get() ?? null;
          const currentCollections = thread.beforeCollections?.map(({ collectionId }) => ({
            collectionId,
            membership: executor.select().from(collectionThreads).where(and(
              eq(collectionThreads.collectionId, collectionId), eq(collectionThreads.threadId, thread.threadId),
            )).get() ?? null,
          }));
          const currentContexts = thread.beforeContexts?.map(({ contextTypeId, contextId }) => ({
            contextTypeId,
            contextId,
            relationship: executor.select().from(organizationThreadContextRelationships).where(and(
              eq(organizationThreadContextRelationships.workspaceId, input.workspaceId),
              eq(organizationThreadContextRelationships.accountId, thread.accountId),
              eq(organizationThreadContextRelationships.threadId, thread.threadId),
              eq(organizationThreadContextRelationships.contextTypeId, contextTypeId),
              eq(organizationThreadContextRelationships.contextId, contextId),
            )).get() ?? null,
          }));
          inverseThreads.push({
            accountId: thread.accountId,
            threadId: thread.threadId,
            expectedRevisionAfter: thread.expectedRevisionAfter + 1,
            beforeLane: currentLane,
            beforeFacets: currentFacets,
            beforeWorkflow: currentWorkflow,
            beforeCollections: currentCollections,
            beforeContexts: currentContexts,
            beforeRevision: thread.expectedRevisionAfter,
          });

          if (thread.beforeLane) {
            const beforeLane = thread.beforeLane;
            executor.update(organizationThreadLaneStates).set({
              primaryLaneId: asString(beforeLane.primaryLaneId, "the original Lane"),
              placementSource: asString(beforeLane.placementSource, "the original placement source"),
              sourceId: asString(beforeLane.sourceId, "the original source"),
              actorId: asString(beforeLane.actorId, "the original Actor"),
              actorType: asString(beforeLane.actorType, "the original Actor type"),
              reason: asString(beforeLane.reason, "the original reason"),
              manualOverrideLaneId: asNullableString(beforeLane.manualOverrideLaneId),
              manualOverrideActorId: asNullableString(beforeLane.manualOverrideActorId),
              manualOverrideActorType: asNullableString(beforeLane.manualOverrideActorType),
              manualOverrideReason: asNullableString(beforeLane.manualOverrideReason),
              manualOverrideAt: asNullableDate(beforeLane.manualOverrideAt),
              safetyLocked: asBoolean(beforeLane.safetyLocked),
              safetyLockActorId: asNullableString(beforeLane.safetyLockActorId),
              safetyLockActorType: asNullableString(beforeLane.safetyLockActorType),
              safetyLockReason: asNullableString(beforeLane.safetyLockReason),
              safetyLockUpdatedAt: asNullableDate(beforeLane.safetyLockUpdatedAt),
              revision: (currentLane?.revision ?? Number(beforeLane.revision)) + 1,
              updatedAt: timestamp,
            }).where(and(
              eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
              eq(organizationThreadLaneStates.accountId, thread.accountId),
              eq(organizationThreadLaneStates.threadId, thread.threadId),
            )).run();
          } else if (currentLane) {
            executor.delete(organizationThreadLaneStates).where(and(
              eq(organizationThreadLaneStates.workspaceId, input.workspaceId),
              eq(organizationThreadLaneStates.accountId, thread.accountId),
              eq(organizationThreadLaneStates.threadId, thread.threadId),
            )).run();
          }
          actionRows.push({
            workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
            actionKind: "restore_lane", resourceFamily: "lane", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            beforeJson: currentLane ? JSON.stringify(currentLane) : null,
            afterJson: thread.beforeLane ? JSON.stringify(thread.beforeLane) : null,
          });

          executor.delete(organizationThreadFacetValues).where(and(
            eq(organizationThreadFacetValues.workspaceId, input.workspaceId),
            eq(organizationThreadFacetValues.accountId, thread.accountId),
            eq(organizationThreadFacetValues.threadId, thread.threadId),
          )).run();
          for (const beforeFacet of thread.beforeFacets) {
            executor.insert(organizationThreadFacetValues).values({
              workspaceId: input.workspaceId,
              facetId: asString(beforeFacet.facetId, "the original Facet"),
              accountId: thread.accountId,
              threadId: thread.threadId,
              value: asString(beforeFacet.value, "the original Facet value"),
              updatedAt: timestamp,
            }).run();
          }
          actionRows.push({
            workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
            actionKind: "restore_facets", resourceFamily: "facet", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
            beforeJson: JSON.stringify(currentFacets),
            afterJson: JSON.stringify(thread.beforeFacets),
          });

          if (thread.beforeWorkflow !== undefined) {
            executor.delete(organizationThreadWorkflowStates).where(and(
              eq(organizationThreadWorkflowStates.workspaceId, input.workspaceId),
              eq(organizationThreadWorkflowStates.accountId, thread.accountId),
              eq(organizationThreadWorkflowStates.threadId, thread.threadId),
            )).run();
            if (thread.beforeWorkflow) {
              executor.insert(organizationThreadWorkflowStates).values({
                workspaceId: input.workspaceId,
                accountId: thread.accountId,
                threadId: thread.threadId,
                stateId: asString(thread.beforeWorkflow.stateId, "the original Workflow State"),
                updatedAt: timestamp,
              }).run();
            }
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: "restore_workflow_state", resourceFamily: "workflow_state", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
              beforeJson: currentWorkflow ? JSON.stringify(currentWorkflow) : null,
              afterJson: thread.beforeWorkflow ? JSON.stringify(thread.beforeWorkflow) : null,
            });
          }

          for (const beforeCollection of thread.beforeCollections ?? []) {
            executor.delete(collectionThreads).where(and(
              eq(collectionThreads.collectionId, beforeCollection.collectionId), eq(collectionThreads.threadId, thread.threadId),
            )).run();
            if (beforeCollection.membership) {
              executor.insert(collectionThreads).values({
                id: asString(beforeCollection.membership.id, "the original Collection membership"),
                collectionId: beforeCollection.collectionId,
                threadId: thread.threadId,
                createdAt: asDate(beforeCollection.membership.createdAt, "the original Collection membership timestamp"),
              }).run();
            }
          }
          if (thread.beforeCollections !== undefined) {
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: "restore_collections", resourceFamily: "collection", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
              beforeJson: JSON.stringify(currentCollections), afterJson: JSON.stringify(thread.beforeCollections),
            });
          }

          for (const beforeContext of thread.beforeContexts ?? []) {
            executor.delete(organizationThreadContextRelationships).where(and(
              eq(organizationThreadContextRelationships.workspaceId, input.workspaceId),
              eq(organizationThreadContextRelationships.accountId, thread.accountId),
              eq(organizationThreadContextRelationships.threadId, thread.threadId),
              eq(organizationThreadContextRelationships.contextTypeId, beforeContext.contextTypeId),
              eq(organizationThreadContextRelationships.contextId, beforeContext.contextId),
            )).run();
            if (beforeContext.relationship) {
              const relationship = beforeContext.relationship;
              executor.insert(organizationThreadContextRelationships).values({
                workspaceId: input.workspaceId,
                id: asString(relationship.id, "the original Context relationship"),
                accountId: thread.accountId,
                threadId: thread.threadId,
                contextTypeId: beforeContext.contextTypeId,
                contextId: beforeContext.contextId,
                relationshipTypeId: asString(relationship.relationshipTypeId, "the original Context relationship type"),
                direction: asString(relationship.direction, "the original Context relationship direction"),
                revision: asInteger(relationship.revision, "the original Context relationship revision"),
                createdAt: asDate(relationship.createdAt, "the original Context relationship creation time"),
                updatedAt: timestamp,
              }).run();
            }
          }
          if (thread.beforeContexts !== undefined) {
            actionRows.push({
              workspaceId: input.workspaceId, changeId: changeSetId, position: actionPosition++,
              actionKind: "restore_contexts", resourceFamily: "context", resourceId: `thread:${thread.accountId}:${thread.threadId}`,
              beforeJson: JSON.stringify(currentContexts), afterJson: JSON.stringify(thread.beforeContexts),
            });
          }
          executor.update(organizationThreadStates).set({
            revision: thread.expectedRevisionAfter + 1,
            updatedAt: timestamp,
          }).where(and(
            eq(organizationThreadStates.workspaceId, input.workspaceId),
            eq(organizationThreadStates.accountId, thread.accountId),
            eq(organizationThreadStates.threadId, thread.threadId),
            eq(organizationThreadStates.revision, thread.expectedRevisionAfter),
          )).run();
        }

        const workspaceRevisionAfter = request.expectedWorkspaceRevision + 1;
        const ruleSetRevisionAfter = currentRuleSet.revision + 1;
        executor.update(organizationRules).set({
          activeRevisionId: evidence.inverse.rule.activeRevisionId,
          updatedAt: timestamp,
        }).where(and(
          eq(organizationRules.workspaceId, input.workspaceId),
          eq(organizationRules.id, currentRule.id),
        )).run();
        executor.update(organizationRuleSets).set({ revision: ruleSetRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationRuleSets.workspaceId, input.workspaceId),
          eq(organizationRuleSets.revision, currentRuleSet.revision),
        )).run();
        executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionAfter, updatedAt: timestamp }).where(and(
          eq(organizationWorkspaceStates.workspaceId, input.workspaceId),
          eq(organizationWorkspaceStates.revision, request.expectedWorkspaceRevision),
        )).run();

        const response: OrcaRuleChangeSetResult = {
          changeSetId,
          status: "reverted",
          operation: "revert",
          ruleId: evidence.response.ruleId,
          revisionId: evidence.response.revisionId,
          simulationId: evidence.response.simulationId,
          revertsChangeSetId: original.id,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          ruleSetRevisionAfter,
          traceCount: evidence.response.traceCount,
          risk: evidence.response.risk,
          conflicts: [],
        };
        const resultingRevisions = {
          workspace: workspaceRevisionAfter,
          ruleSet: ruleSetRevisionAfter,
          rule: currentRule.latestRevision,
          threads: Object.fromEntries(evidence.inverse.threads.map((thread) => [
            `${thread.accountId}:${thread.threadId}`,
            thread.expectedRevisionAfter + 1,
          ])),
        };
        executor.insert(organizationChangeSets).values({
          workspaceId: input.workspaceId,
          id: changeSetId,
          idempotencyKey: request.idempotencyKey,
          commandDigest: transactionAuthority.executionContext.command.digest,
          authorityTrace: JSON.stringify(transactionAuthority.trace),
          resourceFamily: "rule",
          operation: "revert",
          commandJson: JSON.stringify({ request, response, command }),
          revertsChangeId: original.id,
          simulationId: evidence.response.simulationId,
          risk: evidence.response.risk,
          traceJson: original.traceJson,
          inverseJson: JSON.stringify({
            rule: { activeRevisionId: currentRule.activeRevisionId },
            ruleSetRevision: currentRuleSet.revision,
            threads: inverseThreads,
          }),
          resultingRevisionsJson: JSON.stringify(resultingRevisions),
          status: "reverted",
          revertedByChangeId: null,
          workspaceRevisionBefore: request.expectedWorkspaceRevision,
          workspaceRevisionAfter,
          createdAt: timestamp,
        }).run();
        executor.update(organizationChangeSets).set({
          status: "reverted",
          revertedByChangeId: changeSetId,
        }).where(and(
          eq(organizationChangeSets.workspaceId, input.workspaceId),
          eq(organizationChangeSets.id, original.id),
          eq(organizationChangeSets.status, "active"),
        )).run();
        if (actionRows.length) executor.insert(organizationChangeActions).values(actionRows).run();
        return response;
      });
    },
  };
}
