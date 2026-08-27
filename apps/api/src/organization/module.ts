import { createHash } from "node:crypto";

import {
  organizationDescribeResponseSchema,
  organizationContextBounds,
  organizationFacetWorkflowApplyResponseSchema,
  organizationFacetWorkflowApplySchema,
  organizationLaneApplyResponseSchema,
  organizationLaneApplySchema,
  organizationQueryResponseSchema,
  organizationQuerySchema,
  organizationReadScopeSchema,
  type AttentionBehavior,
  type HumanClassificationResult,
  type OrganizationDescribeResponse,
  type OrganizationActor,
  type OrganizationAuthorityDenialCode,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
  type OrganizationFacetWorkflowAction,
  type OrganizationFacetWorkflowApplyResponse,
  type OrganizationLaneAction,
  type OrganizationLaneApplyResponse,
  type OrganizationQueryResponse,
  type OrganizationReadScope,
  type WorkspaceThread,
  type WorkspaceThreadMessage,
} from "@orca/shared";
import { authorizeOrganizationOperation, canonicalOrganizationJson } from "./authority.ts";
import { digestFacetWorkflowActions, validateFacetFilters, type FacetWorkflowSnapshot } from "./facet-workflow.ts";
import {
  createOrganizationCollectionsPins,
  type OrganizationCollectionsPinsRepository,
} from "./collections-pins/module.ts";
import {
  createOrganizationContexts,
  type OrganizationContextSnapshot,
  type OrganizationContextsRepository,
} from "./contexts/module.ts";
import { digestLaneActions, fallbackPlacement, type OrganizationLaneSnapshot, type OrganizationLanesRepository } from "./lanes/module.ts";
import { isAgentOrganizationActor, requireOrganizationCapability, type OrganizationAgentCapabilitySource } from "./agent-capability.ts";

export type OrganizationAttentionRule = {
  scope: "address" | "domain";
  value: string;
  behavior: AttentionBehavior;
};

export type OrganizationThreadRecord = {
  id: string;
  accountId: string;
  subject: string;
  latestReceivedAt: string;
  messageCount: number;
  readState: "read" | "unread";
  messages: WorkspaceThreadMessage[];
  attentionRules: OrganizationAttentionRule[];
  facetValues?: WorkspaceThread["organization"]["facetValues"];
  workflowState?: WorkspaceThread["organization"]["workflowState"];
  organizationRevision?: number | null;
};

export type OrganizationReadSnapshot = {
  facetWorkflow: FacetWorkflowSnapshot;
  contexts: OrganizationContextSnapshot | null;
  lanes?: OrganizationLaneSnapshot;
  threads: OrganizationThreadRecord[];
};

/** Storage seam used by the provider-neutral Organization module. */
export type OrganizationRepository = {
  listAccountIds(workspaceId: string): string[];
  listThreads(accountIds: readonly string[], filter?: { threadId?: string }): OrganizationThreadRecord[];
  getFacetWorkflowSnapshot?(workspaceId: string): FacetWorkflowSnapshot;
  readOrganizationSnapshot?(
    workspaceId: string,
    accountIds: readonly string[],
    filter?: { threadId?: string },
  ): OrganizationReadSnapshot;
  getFacetWorkflowAuthorityState?(workspaceId: string): {
    workspaceRevision: number;
    resourceRevisions: Record<string, number>;
    reservedIdempotencyKeys: string[];
  };
  replayFacetWorkflow?(input: {
    scope: OrganizationReadScope;
    command: unknown;
    agentCapabilitySource?: OrganizationAgentCapabilitySource;
  }): FacetWorkflowSnapshot | null;
  applyFacetWorkflow?(input: {
    executionContext: OrganizationExecutionContext;
    authorityTrace: OrganizationAuthorityTrace;
    command: OrganizationCommand;
    actions: readonly OrganizationFacetWorkflowAction[];
    agentCapabilitySource?: OrganizationAgentCapabilitySource;
  }): FacetWorkflowSnapshot;
  collectionsPins?: OrganizationCollectionsPinsRepository;
  contexts?: OrganizationContextsRepository;
  lanes?: OrganizationLanesRepository;
};

export class OrganizationAuthorityError extends Error {
  constructor(readonly code: OrganizationAuthorityDenialCode, message: string) {
    super(message);
    this.name = "OrganizationAuthorityError";
  }
}

export class OrganizationRevisionConflictError extends Error {
  readonly code = "revision_conflict" as const;

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Expected Workspace revision ${expectedRevision}, but current revision is ${actualRevision}`);
    this.name = "OrganizationRevisionConflictError";
  }
}

export class OrganizationAccessError extends Error {
  readonly code = "account_denied" as const;

  constructor(message = "The requested Account scope is not authorized for this Workspace") {
    super(message);
    this.name = "OrganizationAccessError";
  }
}

export class OrganizationQueryError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationQueryError";
  }
}

export class OrganizationOperationDisabledError extends Error {
  readonly code = "operation_disabled" as const;

  constructor(readonly operation: "simulate" | "apply" | "revert") {
    super(`Organization ${operation} is disabled in this read-only slice`);
    this.name = "OrganizationOperationDisabledError";
  }
}

const workspaceSchema = Object.freeze({
  revision: 4 as const,
  aggregate: "thread" as const,
  resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"] as const,
  filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] as const,
});

const facetSupport = Object.freeze({
  valueTypes: ["text", "number", "boolean", "datetime", "duration", "email", "domain", "enum"] as const,
  cardinalities: ["single", "multi"] as const,
  missingValue: "absent_assignment" as const,
  clearRequest: null,
  maximumListItems: 50 as const,
  workflowStateIndependentOf: ["lane", "subject_matter"] as const,
  requiredValueLifecycle: "typed_default_for_all_threads" as const,
});

function capabilitiesFor(repository: OrganizationRepository, scope: OrganizationReadScope, agentCapabilitySource?: OrganizationAgentCapabilitySource) {
  const agentScope = isAgentOrganizationActor(scope.actor)
    ? { actor: scope.actor, workspaceId: scope.workspaceId, accountIds: scope.accountIds }
    : null;
  const live = agentScope
    ? agentCapabilitySource?.load(agentScope) ?? null
    : null;
  const snapshot = live?.revokedAt === null
    && live.snapshot.actor.type === "agent"
    && live.snapshot.actor.id === scope.actor.id
    && live.snapshot.scope.workspaceId === scope.workspaceId
    && canonicalOrganizationJson([...live.snapshot.scope.accountIds].sort()) === canonicalOrganizationJson([...scope.accountIds].sort())
    ? live.snapshot
    : null;
  const grants = (
    operation: OrganizationCapabilitySnapshot["operations"][number],
    resourceFamilies: OrganizationCapabilitySnapshot["resourceFamilies"][number][],
  ) => Boolean(snapshot?.operations.includes(operation)
    && snapshot.actionFamilies.includes("organization_structure")
    && resourceFamilies.some((family) => snapshot.resourceFamilies.includes(family)));
  const supportedApplyFamilies: OrganizationCapabilitySnapshot["resourceFamilies"][number][] = [
    ...(repository.lanes ? ["lane" as const, "thread" as const] : []),
    ...(repository.applyFacetWorkflow && repository.getFacetWorkflowAuthorityState ? ["facet" as const, "workflow_state" as const, "thread" as const] : []),
    ...(repository.collectionsPins ? ["collection" as const, "shortcut" as const, "saved_query" as const] : []),
    ...(repository.contexts ? ["context" as const] : []),
  ];
  const human = scope.actor.type === "human";
  const mcp = scope.actor.type === "agent";
  const structureApplyAvailable = Boolean((repository.applyFacetWorkflow && repository.getFacetWorkflowAuthorityState) || repository.lanes);
  const canDescribe = Boolean(snapshot?.operations.includes("describe"));
  const canQuery = Boolean(snapshot?.operations.includes("query"));
  const canSimulate = grants("simulate", ["rule"]);
  const canApply = supportedApplyFamilies.length > 0 && grants("apply", supportedApplyFamilies);
  const canRevert = grants("revert", ["rule", "change_set"]);
  const canCorrect = Boolean(snapshot?.operations.includes("apply")
    && snapshot.actionFamilies.includes("organization_thread")
    && ["thread", "trace", "change_set", "audit"].every((family) => snapshot.resourceFamilies.includes(family as OrganizationCapabilitySnapshot["resourceFamilies"][number])));
  return {
    operations: {
      describe: true as const,
      query: true as const,
      simulate: human || canSimulate,
      apply: human ? structureApplyAvailable : canApply,
      revert: human || canRevert,
    },
    authority: { sendMail: false as const, deleteProviderMail: false as const },
    surfaces: {
      rest: { describe: human, query: human, simulate: human, apply: human && structureApplyAvailable, revert: human, correct: human },
      mcp: { describe: mcp && canDescribe, query: mcp && canQuery, simulate: mcp && canSimulate, apply: mcp && canApply, revert: mcp && canRevert, correct: mcp && canCorrect },
    },
  };
}

function firstPartyHumanCapability(actor: OrganizationActor & { type: "human" }, workspaceId: string, accountIds: string[]): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:${actor.type}:${actor.id}`,
    revision: 1,
    actor,
    scope: { workspaceId, accountIds },
    operations: ["describe", "query", "apply"],
    resourceFamilies: ["workspace_schema", "mail", "thread", "lane", "facet", "context", "workflow_state", "trace", "change_set"],
    actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"],
  };
}

function facetResourceId(id: string): string { return `facet:${id}`; }
function workflowResourceId(id: string): string { return `workflow_state:${id}`; }
function threadResourceId(accountId: string, threadId: string): string { return `thread:${accountId}:${threadId}`; }
function laneResourceId(id: string): string { return `lane:${id}`; }
function lanePolicyResourceId(id: string): string { return `lane_policy:${id}`; }
function fallbackResourceId(workspaceId: string): string { return `workspace_fallback:${workspaceId}`; }

function bindFacetWorkflowCommand(command: ReturnType<typeof organizationFacetWorkflowApplySchema.parse>): {
  command: OrganizationCommand;
  expectedResources: Record<string, number>;
} {
  const intents: OrganizationCommand["intents"] = [];
  const expectedResources: Record<string, number> = {};
  const typedActionsDigest = digestFacetWorkflowActions(command.actions);
  const threadActions = new Map<string, { accountId: string; threadId: string; expected: number | null; count: number }>();
  for (const action of command.actions) {
    if (action.kind === "define_facet") {
      intents.push({ kind: "mutate_facet", resourceId: facetResourceId(action.id), mutation: "create", changes: { name: action.name, typedActionsDigest } });
    } else if (action.kind === "update_facet") {
      const resourceId = facetResourceId(action.facetId);
      intents.push({ kind: "mutate_facet", resourceId, mutation: "update", changes: { revision: action.expectedRevision, typedActionsDigest } });
      expectedResources[resourceId] = action.expectedRevision;
    } else if (action.kind === "define_workflow_state") {
      intents.push({ kind: "mutate_workflow_state", resourceId: workflowResourceId(action.id), mutation: "create", changes: { name: action.name, typedActionsDigest } });
    } else if (action.kind === "update_workflow_state") {
      const resourceId = workflowResourceId(action.stateId);
      intents.push({ kind: "mutate_workflow_state", resourceId, mutation: "update", changes: { revision: action.expectedRevision, typedActionsDigest } });
      expectedResources[resourceId] = action.expectedRevision;
    } else {
      const resourceId = threadResourceId(action.accountId, action.threadId);
      const current = threadActions.get(resourceId);
      if (current && current.expected !== action.expectedThreadRevision) {
        throw new OrganizationAuthorityError("invalid_request", `Thread ${action.threadId} actions must agree on one expected Organization revision`);
      }
      threadActions.set(resourceId, {
        accountId: action.accountId,
        threadId: action.threadId,
        expected: action.expectedThreadRevision,
        count: (current?.count ?? 0) + 1,
      });
    }
  }
  for (const [resourceId, target] of threadActions) {
    intents.push({ kind: "organize_thread", resourceId, mutation: target.expected === null ? "create" : "update", changes: { actionCount: target.count, typedActionsDigest } });
    if (target.expected !== null) expectedResources[resourceId] = target.expected;
  }
  return { command: { id: command.id, intents }, expectedResources };
}

function bindLaneCommand(command: ReturnType<typeof organizationLaneApplySchema.parse>, workspaceId: string): {
  command: OrganizationCommand;
  expectedResources: Record<string, number>;
} {
  const intents: OrganizationCommand["intents"] = [];
  const expectedResources: Record<string, number> = {};
  const typedActionsDigest = digestLaneActions(command.actions);
  for (const action of command.actions) {
    let resourceId: string;
    let mutation: "create" | "update";
    let kind: OrganizationCommand["intents"][number]["kind"];
    if (action.kind === "define_lane_policy") {
      resourceId = lanePolicyResourceId(action.id); mutation = "create"; kind = "mutate_lane";
    } else if (action.kind === "update_lane_policy") {
      resourceId = lanePolicyResourceId(action.policyId); mutation = "update"; kind = "mutate_lane"; expectedResources[resourceId] = action.expectedRevision;
    } else if (action.kind === "define_lane") {
      resourceId = laneResourceId(action.id); mutation = "create"; kind = "mutate_lane";
    } else if (action.kind === "update_lane") {
      resourceId = laneResourceId(action.laneId); mutation = "update"; kind = "mutate_lane"; expectedResources[resourceId] = action.expectedRevision;
    } else if (action.kind === "set_fallback_lane") {
      resourceId = fallbackResourceId(workspaceId); mutation = "update"; kind = "mutate_lane"; expectedResources[resourceId] = 1;
    } else {
      resourceId = threadResourceId(action.accountId, action.threadId); mutation = action.expectedThreadRevision === null ? "create" : "update"; kind = "organize_thread";
      if (action.expectedThreadRevision !== null) expectedResources[resourceId] = action.expectedThreadRevision;
    }
    intents.push({ kind, resourceId, mutation, changes: { actionKind: action.kind, typedActionsDigest } });
  }
  return { command: { id: command.id, intents }, expectedResources };
}

function unconfiguredLaneSnapshot(workspaceRevision: number, accountIds: readonly string[], threads: readonly OrganizationThreadRecord[]): OrganizationLaneSnapshot {
  const policyId = "unconfigured-lane-policy";
  const laneId = "unconfigured-fallback-lane";
  return {
    configuration: {
      workspaceRevision,
      fallbackLaneId: laneId,
      policies: [{ id: policyId, visibility: "standard", interruption: "badge", review: "daily", retention: { mode: "keep", days: null }, providerDeletion: false, revision: 1 }],
      lanes: [{ id: laneId, name: "Everything else", position: 0, defaultPolicyId: policyId, retiredAt: null, revision: 1 }],
    },
    placements: threads.filter((thread) => accountIds.includes(thread.accountId)).map((thread) => fallbackPlacement({ accountId: thread.accountId, threadId: thread.id, fallbackLaneId: laneId })),
  };
}

function authorizedAccounts(repository: OrganizationRepository, untrustedScope: unknown): {
  scope: OrganizationReadScope;
  accountIds: string[];
} {
  const scope = organizationReadScopeSchema.parse(untrustedScope);
  const owned = new Set(repository.listAccountIds(scope.workspaceId));
  if (scope.accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationAccessError();
  return { scope, accountIds: [...scope.accountIds].sort() };
}

function resolveAttention(address: string, rules: readonly OrganizationAttentionRule[]): AttentionBehavior {
  const normalized = address.trim().toLocaleLowerCase();
  const exact = rules.find((rule) => rule.scope === "address" && rule.value === normalized);
  if (exact) return exact.behavior;
  const domain = normalized.split("@")[1] ?? "";
  return rules.find((rule) => rule.scope === "domain" && rule.value === domain)?.behavior ?? "normal";
}

function matchesAttention(behavior: AttentionBehavior, filter: "focus" | "normal" | "quiet" | "hidden" | "all" | undefined): boolean {
  if (!filter) return behavior !== "quiet" && behavior !== "hidden";
  if (filter === "all") return true;
  if (filter === "focus") return behavior === "notify" || behavior === "focus";
  return behavior === filter;
}

function matchesClassification(
  classification: HumanClassificationResult | null,
  filter: "human" | "tideline" | "uncertain" | "all" | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  const value = classification?.effective.classification ?? "unclassified";
  if (filter === "human") return value === "likely_human";
  if (filter === "tideline") return value === "automated_or_bulk";
  return value === "uncertain" || value === "unclassified";
}

const attentionRank: Record<AttentionBehavior, number> = {
  notify: 0,
  focus: 1,
  normal: 2,
  quiet: 3,
  hidden: 4,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function cursorFingerprint(accountIds: readonly string[], query: ReturnType<typeof organizationQuerySchema.parse>): string {
  return sha256(JSON.stringify({
    accountIds,
    threadId: query.threadId ?? null,
    attention: query.attention ?? null,
    classification: query.classification ?? null,
    text: query.text?.trim().toLocaleLowerCase() ?? null,
    sender: query.sender?.trim().toLocaleLowerCase() ?? null,
    receivedAfter: query.receivedAfter ?? null,
    receivedBefore: query.receivedBefore ?? null,
    facetFilters: query.facetFilters ?? null,
    workflowStateIds: query.workflowStateIds ?? null,
    laneIds: query.laneIds ?? null,
    contextFilters: query.contextFilters ?? null,
  }));
}

function threadCursorKey(thread: Pick<WorkspaceThread, "accountId" | "id">): string {
  return sha256(JSON.stringify([thread.accountId, thread.id]));
}

function decodeCursor(cursor: string | undefined, fingerprint: string): string | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      parsed && typeof parsed === "object"
      && "version" in parsed && parsed.version === 1
      && "row" in parsed && typeof parsed.row === "string"
      && "fingerprint" in parsed && parsed.fingerprint === fingerprint
    ) return parsed.row;
  } catch { /* The caller receives one stable error below. */ }
  throw new OrganizationQueryError("The Organization cursor does not match this Account scope or filter");
}

function encodeCursor(thread: Pick<WorkspaceThread, "accountId" | "id">, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ version: 1, row: threadCursorKey(thread), fingerprint }), "utf8").toString("base64url");
}

/**
 * The complete Organization interface. REST, MCP, sync, background work, and
 * React are adapters; organizational meaning and Account enforcement live here.
 */
export function createOrganization(repository: OrganizationRepository, dependencies: { agentCapabilitySource?: OrganizationAgentCapabilitySource } = {}) {
  // One Organization instance represents one stable read transaction. Adapters
  // may page it without reloading and re-sorting the complete mailbox each time.
  const rankedSnapshots = new Map<string, {
    threads: WorkspaceThread[];
    counts: { threads: number; messages: number };
    cursorIndexes: Map<string, number>;
    facetDefinitions: FacetWorkflowSnapshot["facetDefinitions"];
    workflowStates: FacetWorkflowSnapshot["workflowStates"];
    contextTypes: ReturnType<OrganizationContextsRepository["getSnapshot"]>["contextTypes"];
    contextRelationshipTypes: ReturnType<OrganizationContextsRepository["getSnapshot"]>["relationshipTypes"];
    contexts: ReturnType<OrganizationContextsRepository["getSnapshot"]>["contexts"];
    laneConfiguration: OrganizationLaneSnapshot["configuration"];
  }>();
  const facetWorkflowSnapshot = (workspaceId: string): FacetWorkflowSnapshot => repository.getFacetWorkflowSnapshot?.(workspaceId) ?? {
    workspaceRevision: 1,
    facetDefinitions: [],
    workflowStates: [],
    threads: [],
  };
  const collectionsPins = repository.collectionsPins ? createOrganizationCollectionsPins(repository.collectionsPins, { agentCapabilitySource: dependencies.agentCapabilitySource }) : null;
  const contexts = repository.contexts ? createOrganizationContexts(repository.contexts, { agentCapabilitySource: dependencies.agentCapabilitySource }) : null;
  const laneSnapshot = (workspaceId: string, accountIds: readonly string[], records?: readonly OrganizationThreadRecord[]): OrganizationLaneSnapshot => {
    if (repository.lanes) return repository.lanes.getSnapshot(workspaceId, accountIds);
    const facet = facetWorkflowSnapshot(workspaceId);
    return unconfiguredLaneSnapshot(facet.workspaceRevision, accountIds, records ?? repository.listThreads(accountIds));
  };

  return {
    describe(input: { scope: unknown }): OrganizationDescribeResponse {
      const { scope, accountIds } = authorizedAccounts(repository, input.scope);
      const facetWorkflow = facetWorkflowSnapshot(scope.workspaceId);
      const lanes = laneSnapshot(scope.workspaceId, accountIds);
      return organizationDescribeResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds,
        workspaceSchema,
        capabilities: capabilitiesFor(repository, scope, dependencies.agentCapabilitySource),
        workspaceRevision: facetWorkflow.workspaceRevision,
        facetDefinitions: facetWorkflow.facetDefinitions,
        workflowStates: facetWorkflow.workflowStates,
        facetSupport,
        ...(collectionsPins ? { collectionsPins: collectionsPins.describe({ scope }) } : {}),
        ...(contexts ? { contexts: contexts.describe({ scope }) } : {}),
        laneConfiguration: lanes.configuration,
      });
    },

    query(input: { scope: unknown; query: unknown }): OrganizationQueryResponse {
      const { scope, accountIds: authorizedAccountIds } = authorizedAccounts(repository, input.scope);
      const query = organizationQuerySchema.parse(input.query);
      const requestedAccountIds = query.accountIds ? [...query.accountIds].sort() : authorizedAccountIds;
      const authorized = new Set(authorizedAccountIds);
      if (requestedAccountIds.some((accountId) => !authorized.has(accountId))) throw new OrganizationAccessError();
      const fingerprint = cursorFingerprint(requestedAccountIds, query);
      let snapshot = rankedSnapshots.get(fingerprint);
      if (!snapshot) {
        const threadFilter = query.threadId ? { threadId: query.threadId } : undefined;
        const fallbackThreads = repository.readOrganizationSnapshot ? null : repository.listThreads(requestedAccountIds, threadFilter);
        const readSnapshot = repository.readOrganizationSnapshot?.(scope.workspaceId, requestedAccountIds, threadFilter) ?? {
          facetWorkflow: facetWorkflowSnapshot(scope.workspaceId),
          contexts: repository.contexts?.getSnapshot(scope.workspaceId) ?? null,
          lanes: laneSnapshot(scope.workspaceId, requestedAccountIds, fallbackThreads ?? undefined),
          threads: fallbackThreads ?? [],
        };
        const coherentLanes = readSnapshot.lanes ?? unconfiguredLaneSnapshot(readSnapshot.facetWorkflow.workspaceRevision, requestedAccountIds, readSnapshot.threads);
        validateFacetFilters(readSnapshot.facetWorkflow.facetDefinitions, query.facetFilters ?? []);
        const contextSnapshot = readSnapshot.contexts;
        for (const [index, filter] of (query.contextFilters ?? []).entries()) {
          const context = contextSnapshot?.contexts.find((item) => item.id === filter.context.contextId && item.contextTypeId === filter.context.contextTypeId);
          const relationshipType = contextSnapshot?.relationshipTypes.find((item) => item.id === filter.relationshipTypeId);
          if (!context || !relationshipType || relationshipType.contextTypeId !== context.contextTypeId) {
            throw new OrganizationQueryError(`Context filter ${index + 1} does not resolve to a matching stable Context and Relationship Type`);
          }
        }
        const requested = new Set(requestedAccountIds);
        const text = query.text?.trim().toLocaleLowerCase() ?? "";
        const sender = query.sender?.trim().toLocaleLowerCase() ?? "";
        const after = query.receivedAfter ? Date.parse(query.receivedAfter) : null;
        const before = query.receivedBefore ? Date.parse(query.receivedBefore) : null;
        const relationshipsByThread = new Map<string, NonNullable<typeof contextSnapshot>["relationships"]>();
        for (const relationship of contextSnapshot?.relationships ?? []) {
          const key = `${relationship.accountId}\0${relationship.threadId}`;
          const relationships = relationshipsByThread.get(key) ?? [];
          if (relationships.length >= organizationContextBounds.maximumRelationshipsPerThread) {
            throw new OrganizationQueryError("Thread Context relationship fan-out exceeds the supported bound");
          }
          relationships.push(relationship);
          relationshipsByThread.set(key, relationships);
        }
        const ranked = readSnapshot.threads.flatMap((record): WorkspaceThread[] => {
          if (!requested.has(record.accountId)) throw new OrganizationAccessError();
          if (query.threadId && record.id !== query.threadId) return [];
          if (query.workflowStateIds && !query.workflowStateIds.includes(record.workflowState?.stateId ?? "")) return [];
          const lanePlacement = coherentLanes.placements.find((placement) => placement.accountId === record.accountId && placement.threadId === record.id)
            ?? fallbackPlacement({ accountId: record.accountId, threadId: record.id, fallbackLaneId: coherentLanes.configuration.fallbackLaneId });
          if (query.laneIds && !query.laneIds.includes(lanePlacement.primaryLaneId)) return [];
          const contextRelationships = relationshipsByThread.get(`${record.accountId}\0${record.id}`) ?? [];
          if (query.contextFilters?.some((filter) => !contextRelationships.some((relationship) => relationship.contextId === filter.context.contextId && relationship.contextTypeId === filter.context.contextTypeId && relationship.relationshipTypeId === filter.relationshipTypeId && (filter.direction === undefined || relationship.direction === filter.direction)))) return [];
          if (query.facetFilters?.some((filter) => {
            const assigned = record.facetValues?.find((value) => value.facetId === filter.facetId);
            if (filter.operator === "missing") return assigned !== undefined;
            if (filter.operator === "present") return assigned === undefined;
            if (!("value" in filter)) return true;
            if (!assigned) return true;
            const values = Array.isArray(assigned.value) ? assigned.value : [assigned.value];
            if (filter.operator === "equals") return !values.some((value) => value === filter.value);
            return !values.some((value) => typeof value === "string" && typeof filter.value === "string"
              ? value.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())
              : value === filter.value);
          })) return [];
          const latest = record.messages[0];
          const attentionBehavior = resolveAttention(latest?.from.email ?? "", record.attentionRules);
          if (!matchesAttention(attentionBehavior, query.attention)) return [];
          const humanClassification = latest?.humanClassification ?? null;
          if (!matchesClassification(humanClassification, query.classification)) return [];
          const matchingMessages = record.messages.filter((message) => {
            const receivedAt = Date.parse(message.receivedAt);
            if (after !== null && receivedAt < after) return false;
            if (before !== null && receivedAt > before) return false;
            const senderText = `${message.from.name ?? ""}\n${message.from.email}`.toLocaleLowerCase();
            if (sender && !senderText.includes(sender)) return false;
            if (text && !`${senderText}\n${message.subject}\n${message.snippet}`.toLocaleLowerCase().includes(text)) return false;
            return true;
          });
          const requiresMessageMatch = Boolean(text || sender || after !== null || before !== null);
          if (matchingMessages.length === 0 && requiresMessageMatch) return [];
          const humanSignal = record.messages.reduce<number | null>((highest, message) => {
            if (message.humanSignal === null) return highest;
            return highest === null ? message.humanSignal : Math.max(highest, message.humanSignal);
          }, null);
          return [{
            id: record.id,
            accountId: record.accountId,
            subject: record.subject,
            latestReceivedAt: record.latestReceivedAt,
            messageCount: record.messageCount,
            readState: record.readState,
            organization: {
              attentionBehavior,
              humanSignal,
              humanClassification,
              facetValues: record.facetValues ?? [],
              workflowState: record.workflowState ?? null,
              contextRelationships: contextRelationships.map((relationship) => ({ relationshipId: relationship.id, relationshipTypeId: relationship.relationshipTypeId, direction: relationship.direction, context: { contextTypeId: relationship.contextTypeId, contextId: relationship.contextId } })),
              lanePlacement,
              revision: record.organizationRevision ?? null,
            },
            messages: matchingMessages.length > 0 ? matchingMessages : record.messages,
          }];
        });
        ranked.sort((left, right) => attentionRank[left.organization.attentionBehavior] - attentionRank[right.organization.attentionBehavior]
          || Date.parse(right.latestReceivedAt) - Date.parse(left.latestReceivedAt)
          || left.accountId.localeCompare(right.accountId)
          || left.id.localeCompare(right.id));
        snapshot = {
          threads: ranked,
          counts: {
            threads: ranked.length,
            messages: ranked.reduce((total, thread) => total + thread.messages.length, 0),
          },
          cursorIndexes: new Map(ranked.map((thread, index) => [threadCursorKey(thread), index])),
          facetDefinitions: readSnapshot.facetWorkflow.facetDefinitions,
          workflowStates: readSnapshot.facetWorkflow.workflowStates,
          contextTypes: contextSnapshot?.contextTypes ?? [],
          contextRelationshipTypes: contextSnapshot?.relationshipTypes ?? [],
          contexts: contextSnapshot?.contexts ?? [],
          laneConfiguration: coherentLanes.configuration,
        };
        rankedSnapshots.set(fingerprint, snapshot);
      }

      const cursorRow = decodeCursor(query.cursor, fingerprint);
      const cursorIndex = cursorRow ? (snapshot.cursorIndexes.get(cursorRow) ?? -1) : -1;
      if (cursorRow && cursorIndex < 0) throw new OrganizationQueryError("The Organization cursor is not part of this result");
      const start = cursorIndex + 1;
      const threads = snapshot.threads.slice(start, start + query.limit);
      const last = threads.at(-1);
      const contextRefs = new Set(threads.flatMap((thread) => (thread.organization.contextRelationships ?? []).map((relationship) => `${relationship.context.contextTypeId}\0${relationship.context.contextId}`)));
      const relationshipTypeIds = new Set(threads.flatMap((thread) => (thread.organization.contextRelationships ?? []).map((relationship) => relationship.relationshipTypeId)));
      const pageContexts = snapshot.contexts.filter((context) => contextRefs.has(`${context.contextTypeId}\0${context.id}`));
      const contextTypeIds = new Set(pageContexts.map((context) => context.contextTypeId));
      const pageContextTypes = snapshot.contextTypes.filter((contextType) => contextTypeIds.has(contextType.id));
      const pageRelationshipTypes = snapshot.contextRelationshipTypes.filter((relationshipType) => relationshipTypeIds.has(relationshipType.id));
      if (pageContexts.length !== contextRefs.size || pageContextTypes.length !== contextTypeIds.size || pageRelationshipTypes.length !== relationshipTypeIds.size) {
        throw new OrganizationQueryError("Stored Thread Context relationship references are incomplete");
      }
      return organizationQueryResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds: requestedAccountIds,
        threads,
        counts: snapshot.counts,
        nextCursor: last && start + threads.length < snapshot.threads.length ? encodeCursor(last, fingerprint) : null,
        facetDefinitions: snapshot.facetDefinitions,
        workflowStates: snapshot.workflowStates,
        contextTypes: pageContextTypes,
        contextRelationshipTypes: pageRelationshipTypes,
        contexts: pageContexts,
        laneConfiguration: snapshot.laneConfiguration,
      });
    },

    simulate(_input: { scope: unknown }): never {
      throw new OrganizationOperationDisabledError("simulate");
    },
    apply(input: { scope: unknown; command: unknown }): OrganizationFacetWorkflowApplyResponse | OrganizationLaneApplyResponse {
      const { scope, accountIds } = authorizedAccounts(repository, input.scope);
      const laneResult = organizationLaneApplySchema.safeParse(input.command);
      if (laneResult.success) {
        if (!repository.lanes) throw new OrganizationOperationDisabledError("apply");
        const applyCommand = laneResult.data;
        const replay = repository.lanes.replay({ scope: { ...scope, accountIds }, command: applyCommand, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) });
        if (replay) return organizationLaneApplyResponseSchema.parse(replay);
        const bound = bindLaneCommand(applyCommand, scope.workspaceId);
        let liveCapability;
        try {
          liveCapability = requireOrganizationCapability(scope, (actor) => firstPartyHumanCapability(actor, scope.workspaceId, accountIds), dependencies.agentCapabilitySource);
        } catch (error) {
          throw new OrganizationAuthorityError("actor_operation_denied", error instanceof Error ? error.message : "Organization Actor is not authorized");
        }
        const capabilitySnapshot = liveCapability.snapshot;
        const live = repository.lanes.getAuthorityState(scope.workspaceId);
        const decision = authorizeOrganizationOperation({
          actor: scope.actor,
          capabilitySnapshot,
          operation: "apply",
          scope: { workspaceId: scope.workspaceId, accountIds },
          command: bound.command,
          expectedRevisions: { workspace: applyCommand.expectedWorkspaceRevision, resources: bound.expectedResources },
          idempotencyKey: applyCommand.idempotencyKey,
        }, {
          scope: { workspaceId: scope.workspaceId, accountIds },
          capability: liveCapability,
          workspaceRevision: live.workspaceRevision,
          resourceRevisions: live.resourceRevisions,
          reservedIdempotencyKeys: live.reservedIdempotencyKeys,
        });
        if (!decision.allowed) throw new OrganizationAuthorityError(decision.code, decision.reason);
        return organizationLaneApplyResponseSchema.parse(repository.lanes.apply({ executionContext: decision.executionContext, authorityTrace: decision.trace, boundCommand: bound.command, command: applyCommand, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) }));
      }
      const applyCommand = organizationFacetWorkflowApplySchema.parse(input.command);
      if (!repository.applyFacetWorkflow || !repository.getFacetWorkflowAuthorityState) throw new OrganizationOperationDisabledError("apply");
      const facetReplay = repository.replayFacetWorkflow?.({ scope: { ...scope, accountIds }, command: applyCommand, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) });
      if (facetReplay) return organizationFacetWorkflowApplyResponseSchema.parse({
        changeSetId: applyCommand.id,
        workspaceId: scope.workspaceId,
        workspaceRevision: facetReplay.workspaceRevision,
        appliedActions: applyCommand.actions.length,
        facetDefinitions: facetReplay.facetDefinitions,
        workflowStates: facetReplay.workflowStates,
      });
      const bound = bindFacetWorkflowCommand(applyCommand);
      let liveCapability;
      try {
        liveCapability = requireOrganizationCapability(scope, (actor) => firstPartyHumanCapability(actor, scope.workspaceId, accountIds), dependencies.agentCapabilitySource);
      } catch (error) {
        throw new OrganizationAuthorityError("actor_operation_denied", error instanceof Error ? error.message : "Organization Actor is not authorized");
      }
      const capabilitySnapshot = liveCapability.snapshot;
      const live = repository.getFacetWorkflowAuthorityState(scope.workspaceId);
      const decision = authorizeOrganizationOperation({
        actor: scope.actor,
        capabilitySnapshot,
        operation: "apply",
        scope: { workspaceId: scope.workspaceId, accountIds },
        command: bound.command,
        expectedRevisions: { workspace: applyCommand.expectedWorkspaceRevision, resources: bound.expectedResources },
        idempotencyKey: applyCommand.idempotencyKey,
      }, {
        scope: { workspaceId: scope.workspaceId, accountIds },
        capability: liveCapability,
        workspaceRevision: live.workspaceRevision,
        resourceRevisions: live.resourceRevisions,
        reservedIdempotencyKeys: live.reservedIdempotencyKeys,
      });
      if (!decision.allowed) throw new OrganizationAuthorityError(decision.code, decision.reason);
      const next = repository.applyFacetWorkflow({
        executionContext: decision.executionContext,
        authorityTrace: decision.trace,
        command: bound.command,
        actions: applyCommand.actions,
        ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}),
      });
      return organizationFacetWorkflowApplyResponseSchema.parse({
        changeSetId: bound.command.id,
        workspaceId: scope.workspaceId,
        workspaceRevision: next.workspaceRevision,
        appliedActions: applyCommand.actions.length,
        facetDefinitions: next.facetDefinitions,
        workflowStates: next.workflowStates,
      });
    },
    revert(_input: { scope: unknown }): never {
      throw new OrganizationOperationDisabledError("revert");
    },
    collectionsPins,
    contexts,
  };
}
