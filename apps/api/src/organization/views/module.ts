import { createHash } from "node:crypto";

import {
  organizationViewCreateRequestSchema,
  organizationViewCommitRequestSchema,
  organizationViewDefinitionSchema,
  organizationViewDefinitionKind,
  organizationViewDraftInputSchema,
  organizationViewPreparationInputSchema,
  organizationViewPreviewRequestSchema,
  organizationViewRemoveRequestSchema,
  organizationViewReorderRequestSchema,
  organizationViewResultQuerySchema,
  organizationViewUpdateRequestSchema,
  summarizeOrganizationViewDefinition,
  type OrganizationAuthorityTrace,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationExecutionContext,
  type OrganizationResourceFamily,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewDraftInput,
  type OrganizationViewCreateRequest,
  type OrganizationViewRemoveRequest,
  type OrganizationViewReorderRequest,
  type OrganizationViewResultPage,
  type OrganizationViewResultQuery,
  type OrganizationViewUpdateRequest,
  type OrganizationViewReviewedDraft,
  type OrganizationViewResultCount,
  type OrganizationViewSelectedMessageReference,
} from "@orca/shared";
import { authorizeOrganizationOperation, canonicalOrganizationJson } from "../authority.ts";
import { requireOrganizationCapability, type OrganizationAgentCapabilitySource } from "../agent-capability.ts";

export class OrganizationViewAccessError extends Error {
  readonly code: "account_denied" | "resource_denied";
  constructor(message = "The requested Account scope is not authorized for this Workspace", code: "account_denied" | "resource_denied" = "account_denied") { super(message); this.code = code; this.name = "OrganizationViewAccessError"; }
}

export class OrganizationViewNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(message = "The requested View was not found") { super(message); this.name = "OrganizationViewNotFoundError"; }
}

export class OrganizationViewConflictError extends Error {
  readonly code = "revision_conflict" as const;
  constructor(message = "The View changed before this request could be applied") { super(message); this.name = "OrganizationViewConflictError"; }
}

export class OrganizationViewQueryError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor(message: string) { super(message); this.name = "OrganizationViewQueryError"; }
}

export class OrganizationViewValidationError extends Error {
  readonly code = "validation_error" as const;
  constructor(message: string) { super(message); this.name = "OrganizationViewValidationError"; }
}

export class OrganizationViewSelectionError extends Error {
  readonly code: "selection_reference_unavailable" | "mixed_account_selection" | "all_selected_senders_are_self";
  constructor(code: OrganizationViewSelectionError["code"], message: string) { super(message); this.code = code; this.name = "OrganizationViewSelectionError"; }
}

export type OrganizationViewScope = {
  workspaceId: string;
  accountIds: string[];
  actor: { id: string; type: "human" | "agent" | "system" };
};

export type OrganizationViewMutationAuthorization = {
  executionContext: OrganizationExecutionContext;
  trace: OrganizationAuthorityTrace;
  authorizationEnvelopeDigest: string;
  command: OrganizationCommand;
  agentCapabilitySource?: OrganizationAgentCapabilitySource;
};

export type OrganizationViewMutationPlan = {
  orderedViewIds: string[];
  expectedViews: Array<{ id: string; position: number; revision: number }>;
};

export type OrganizationViewQueryAuthorization = {
  capabilitySnapshot: OrganizationCapabilitySnapshot;
  requiredResourceFamilies: OrganizationResourceFamily[];
  agentCapabilitySource?: OrganizationAgentCapabilitySource;
};

export type OrganizationViewEvaluationPage = {
  accountIds: string[];
  items: OrganizationViewResultPage["items"];
  nextCursor: string | null;
  limit: number;
  count: OrganizationViewResultCount;
  authorizedScopeDigest: string;
};

export type OrganizationViewsRepository = {
  list(workspaceId: string): OrganizationView[];
  get(workspaceId: string, viewId: string): OrganizationView | null;
  getWorkspaceRevision(workspaceId: string): number;
  getAuthorityState(workspaceId: string): { workspaceRevision: number; resourceRevisions: Record<string, number>; reservedIdempotencyKeys: string[] };
  replay(input: { scope: OrganizationViewScope; idempotencyKey: string; boundRequest: unknown; agentCapabilitySource?: OrganizationAgentCapabilitySource }): { response: unknown } | null;
  create(input: { workspaceId: string; viewId: string; request: OrganizationViewCreateRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  update(input: { workspaceId: string; viewId: string; request: OrganizationViewUpdateRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView;
  reorder(input: { workspaceId: string; request: OrganizationViewReorderRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): OrganizationView[];
  remove(input: { workspaceId: string; viewId: string; request: OrganizationViewRemoveRequest; boundRequest: unknown; plan: OrganizationViewMutationPlan; authorization: OrganizationViewMutationAuthorization; now: Date }): void;
  validateDefinition(input: { scope: OrganizationViewScope; definition: OrganizationViewDefinition; definitionDigest: string; authorization: OrganizationViewQueryAuthorization }): { accountIds: string[]; authorizedScopeDigest: string };
  resolveSelectedSenders(input: { scope: OrganizationViewScope; references: OrganizationViewSelectedMessageReference[]; authorization: OrganizationViewQueryAuthorization }): { accountId: string; addresses: string[] };
  evaluate(input: { scope: OrganizationViewScope; definition: OrganizationViewDefinition; definitionDigest: string; resultSetKey: string; query: OrganizationViewResultQuery; authorization: OrganizationViewQueryAuthorization }): OrganizationViewEvaluationPage;
};

function authorizedAccountIds(scope: OrganizationViewScope, requested: readonly string[] | undefined) {
  const owned = new Set(scope.accountIds);
  const accountIds = requested ? [...requested] : [...scope.accountIds];
  if (accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationViewAccessError();
  return accountIds.sort();
}

function viewResourceId(viewId: string) { return `view:${viewId}`; }
function digest(value: unknown) { return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`; }

export function digestOrganizationViewDefinition(definition: OrganizationViewDefinition) {
  return digest(organizationViewDefinitionSchema.parse(definition));
}

function definitionResourceFamilies(definition: OrganizationViewDefinition): OrganizationResourceFamily[] {
  return [...new Set<OrganizationResourceFamily>([
    "mail",
    "thread",
    "view",
    ...(definition.laneIds ? ["lane" as const] : []),
    ...(definition.facetFilters ? ["facet" as const] : []),
    ...(definition.contextFilters ? ["context" as const] : []),
    ...(definition.workflowStateIds ? ["workflow_state" as const] : []),
  ])];
}

export function organizationViewOrderResourceId(workspaceId: string) { return `view_order:${workspaceId}`; }
export function digestOrganizationViewOrder(orderedViewIds: readonly string[]) { return digest(orderedViewIds); }

function mutationPlan(current: readonly OrganizationView[], orderedViewIds: readonly string[]): OrganizationViewMutationPlan {
  return {
    orderedViewIds: [...orderedViewIds],
    expectedViews: current.map((view) => ({ id: view.id, position: view.position, revision: view.revision })),
  };
}

function orderChanged(current: readonly OrganizationView[], orderedViewIds: readonly string[]) {
  return current.length !== orderedViewIds.length || current.some((view, position) => view.id !== orderedViewIds[position]);
}

function viewIntent(input: { viewId: string; mutation: "create" | "update"; requestDigest: string; position?: number; remove?: boolean }): OrganizationCommand["intents"][number] {
  return {
    kind: "mutate_view",
    resourceId: viewResourceId(input.viewId),
    mutation: input.mutation,
    changes: { clientRequestDigest: input.requestDigest, ...(input.position === undefined ? {} : { position: input.position }), ...(input.remove ? { remove: true } : {}) },
  };
}

function orderingIntent(workspaceId: string, orderedViewIds: readonly string[], requestDigest: string): OrganizationCommand["intents"][number] {
  return {
    kind: "mutate_view",
    resourceId: organizationViewOrderResourceId(workspaceId),
    mutation: "update",
    changes: {
      clientRequestDigest: requestDigest,
      orderDigest: digestOrganizationViewOrder(orderedViewIds),
      viewCount: orderedViewIds.length,
    },
  };
}

function firstPartyViewsCapability(scope: OrganizationViewScope): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:${scope.actor.type}:${scope.actor.id}`,
    revision: 1,
    actor: scope.actor,
    scope: { workspaceId: scope.workspaceId, accountIds: [...scope.accountIds].sort() },
    operations: ["query", "apply"],
    resourceFamilies: ["view"],
    actionFamilies: ["organization_read", "organization_structure"],
  };
}

function firstPartyViewQueryCapability(scope: OrganizationViewScope): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:${scope.actor.type}:${scope.actor.id}`,
    revision: 1,
    actor: scope.actor,
    scope: { workspaceId: scope.workspaceId, accountIds: [...scope.accountIds].sort() },
    operations: ["query"],
    resourceFamilies: ["mail", "thread", "view", "lane", "facet", "context", "workflow_state"],
    actionFamilies: ["organization_read"],
  };
}

function authorizeQuery(
  scope: OrganizationViewScope,
  definition: OrganizationViewDefinition,
  agentCapabilitySource: OrganizationAgentCapabilitySource | undefined,
): OrganizationViewQueryAuthorization {
  let live;
  try {
    live = requireOrganizationCapability(scope, (actor) => firstPartyViewQueryCapability({ ...scope, actor }), agentCapabilitySource);
  } catch (error) {
    throw new OrganizationViewAccessError(error instanceof Error ? error.message : "View Actor is not authorized", "resource_denied");
  }
  const capability = live.snapshot;
  const requiredResourceFamilies = definitionResourceFamilies(definition);
  if (live.revokedAt !== null
    || capability.actor.id !== scope.actor.id
    || capability.actor.type !== scope.actor.type
    || capability.scope.workspaceId !== scope.workspaceId
    || canonicalOrganizationJson([...capability.scope.accountIds].sort()) !== canonicalOrganizationJson([...scope.accountIds].sort())
    || !capability.operations.includes("query")
    || !capability.actionFamilies.includes("organization_read")
    || requiredResourceFamilies.some((family) => !capability.resourceFamilies.includes(family))) {
    throw new OrganizationViewAccessError("The live Capability does not authorize this View query and every referenced resource family", "resource_denied");
  }
  return {
    capabilitySnapshot: capability,
    requiredResourceFamilies,
    ...(scope.actor.type === "agent" ? { agentCapabilitySource } : {}),
  };
}

function saveEligibility(definition: OrganizationViewDefinition, unsupportedClauses: readonly unknown[]) {
  if (organizationViewDefinitionKind(definition) === "match_all") {
    return { allowed: false as const, code: "blank_definition" as const, detail: "Add at least one complete filter before saving this View." };
  }
  if (unsupportedClauses.length > 0) {
    return { allowed: false as const, code: "unsupported_clauses" as const, detail: "Replace or remove every unsupported clause before saving this View." };
  }
  return { allowed: true as const, code: null, detail: "This reviewed definition is ready to save." };
}

export function createOrganizationViews(repository: OrganizationViewsRepository, dependencies: { newViewId?: () => string; newChangeId?: () => string; now?: () => Date; agentCapabilitySource?: OrganizationAgentCapabilitySource } = {}) {
  const newViewId = dependencies.newViewId ?? (() => `view_${crypto.randomUUID()}`);
  const newChangeId = dependencies.newChangeId ?? (() => `change_${crypto.randomUUID()}`);
  const now = dependencies.now ?? (() => new Date());

  function replay(scope: OrganizationViewScope, idempotencyKey: string, boundRequest: unknown) {
    const existing = repository.replay({ scope, idempotencyKey, boundRequest, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) });
    return existing === null ? { found: false as const, response: null } : { found: true as const, response: existing.response };
  }

  function authorizeBound(scope: OrganizationViewScope, request: { idempotencyKey: string; expectedWorkspaceRevision: number }, command: OrganizationCommand, expectedResources: Record<string, number>): OrganizationViewMutationAuthorization {
    let liveCapability;
    try {
      liveCapability = requireOrganizationCapability(scope, (actor) => firstPartyViewsCapability({ ...scope, actor }), dependencies.agentCapabilitySource);
    } catch (error) {
      throw new OrganizationViewAccessError(error instanceof Error ? error.message : "View Actor is not authorized", "resource_denied");
    }
    const capability = liveCapability.snapshot;
    const live = repository.getAuthorityState(scope.workspaceId);
    const decision = authorizeOrganizationOperation({
      actor: scope.actor,
      capabilitySnapshot: capability,
      operation: "apply",
      scope: capability.scope,
      command,
      expectedRevisions: { workspace: request.expectedWorkspaceRevision, resources: expectedResources },
      idempotencyKey: request.idempotencyKey,
    }, {
      scope: capability.scope,
      capability: liveCapability,
      workspaceRevision: live.workspaceRevision,
      resourceRevisions: live.resourceRevisions,
      reservedIdempotencyKeys: live.reservedIdempotencyKeys,
    });
    if (!decision.allowed) {
      if (["revision_conflict", "duplicate_idempotency_key"].includes(decision.code)) throw new OrganizationViewConflictError(decision.reason);
      throw new OrganizationViewAccessError(decision.reason, "resource_denied");
    }
    return { executionContext: decision.executionContext, trace: decision.trace, authorizationEnvelopeDigest: decision.authorizationEnvelopeDigest, command, ...(scope.actor.type === "agent" ? { agentCapabilitySource: dependencies.agentCapabilitySource } : {}) };
  }

  function draftInput(scope: OrganizationViewScope, input: unknown): OrganizationViewDraftInput {
    const parsed = organizationViewPreparationInputSchema.parse(input);
    if (parsed.kind === "typed_definition") {
      return organizationViewDraftInputSchema.parse({
        mode: "create",
        viewId: null,
        source: parsed.source,
        identity: parsed.identity,
        definition: parsed.definition,
        unsupportedClauses: parsed.unsupportedClauses,
      });
    }
    if (parsed.kind === "selected_senders") {
      const authorization = authorizeQuery(scope, { revision: 1 }, dependencies.agentCapabilitySource);
      const resolved = repository.resolveSelectedSenders({ scope, references: parsed.references, authorization });
      return organizationViewDraftInputSchema.parse({
        mode: "create",
        viewId: null,
        source: parsed.source,
        identity: parsed.identity,
        definition: { revision: 1, accountIds: [resolved.accountId], sender: { addresses: resolved.addresses } },
        unsupportedClauses: [],
      });
    }
    const view = repository.get(scope.workspaceId, parsed.viewId);
    if (!view) throw new OrganizationViewNotFoundError();
    return organizationViewDraftInputSchema.parse({
      mode: "update",
      viewId: view.id,
      source: { kind: "saved_view", label: view.name },
      identity: { name: view.name, description: view.description, color: view.color, position: view.position },
      definition: view.definition,
      unsupportedClauses: [],
    });
  }

  function reviewDraft(scope: OrganizationViewScope, input: unknown, validate = true): { draft: OrganizationViewReviewedDraft; authorization: OrganizationViewQueryAuthorization; workspaceRevision: number } {
    const candidate = organizationViewDraftInputSchema.parse(input);
    const definition = organizationViewDefinitionSchema.parse(candidate.definition);
    const definitionDigest = digestOrganizationViewDefinition(definition);
    const effectiveAccountIds = authorizedAccountIds(scope, definition.accountIds);
    if (effectiveAccountIds.length === 0) throw new OrganizationViewAccessError("A View requires at least one currently authorized Account");
    const authorization = authorizeQuery(scope, definition, dependencies.agentCapabilitySource);
    if (validate) repository.validateDefinition({ scope, definition, definitionDigest, authorization });
    return {
      authorization,
      workspaceRevision: repository.getWorkspaceRevision(scope.workspaceId),
      draft: {
        ...candidate,
        definition,
        definitionDigest,
        definitionKind: organizationViewDefinitionKind(definition),
        effectiveAccountIds,
        summary: summarizeOrganizationViewDefinition(definition),
        saveEligibility: saveEligibility(definition, candidate.unsupportedClauses),
      },
    };
  }

  function evaluateDraft(scope: OrganizationViewScope, input: unknown, query: OrganizationViewResultQuery) {
    const reviewed = reviewDraft(scope, input, false);
    const results = repository.evaluate({
      scope,
      definition: reviewed.draft.definition,
      definitionDigest: reviewed.draft.definitionDigest,
      resultSetKey: "draft",
      query,
      authorization: reviewed.authorization,
    });
    return { ...reviewed, results };
  }

  const module = {
    prepare(input: { scope: OrganizationViewScope; input: unknown }) {
      const reviewed = reviewDraft(input.scope, draftInput(input.scope, input.input));
      return { workspaceId: input.scope.workspaceId, workspaceRevision: reviewed.workspaceRevision, draft: reviewed.draft };
    },
    preview(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewPreviewRequestSchema.parse(input.request);
      const evaluated = evaluateDraft(input.scope, request.draft, organizationViewResultQuerySchema.parse(request.page));
      return {
        workspaceId: input.scope.workspaceId,
        workspaceRevision: evaluated.workspaceRevision,
        draft: evaluated.draft,
        results: {
          accountIds: evaluated.results.accountIds,
          items: evaluated.results.items,
          nextCursor: evaluated.results.nextCursor,
          limit: evaluated.results.limit,
          count: evaluated.results.count,
          state: evaluated.results.count.kind === "exact" && evaluated.results.count.value === 0 ? "zero" as const : "matches" as const,
          provenance: {
            source: "stored_mail" as const,
            definitionDigest: evaluated.draft.definitionDigest,
            authorizedScopeDigest: evaluated.results.authorizedScopeDigest,
            evaluatedAt: now().toISOString(),
          },
        },
      };
    },
    commit(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewCommitRequestSchema.parse(input.request);
      const reviewed = reviewDraft(input.scope, {
        mode: request.draft.mode,
        viewId: request.draft.viewId,
        source: request.draft.source,
        identity: request.draft.identity,
        definition: request.draft.definition,
        unsupportedClauses: request.draft.unsupportedClauses,
      }, false);
      const derived = reviewed.draft;
      if (request.draft.definitionDigest !== derived.definitionDigest
        || request.draft.definitionKind !== derived.definitionKind
        || canonicalOrganizationJson(request.draft.effectiveAccountIds) !== canonicalOrganizationJson(derived.effectiveAccountIds)
        || canonicalOrganizationJson(request.draft.summary) !== canonicalOrganizationJson(derived.summary)
        || canonicalOrganizationJson(request.draft.saveEligibility) !== canonicalOrganizationJson(derived.saveEligibility)) {
        throw new OrganizationViewValidationError("The reviewed View draft no longer matches its canonical definition digest and scope");
      }
      if (!derived.saveEligibility.allowed) throw new OrganizationViewValidationError(derived.saveEligibility.detail);
      const mutation = derived.mode === "update"
        ? (() => {
            if (!derived.viewId || request.expectedRevisions.view === null) throw new OrganizationViewValidationError("An update draft requires its View identity and revision");
            const mutationRequest = organizationViewUpdateRequestSchema.parse({
              idempotencyKey: request.retryKey,
              expectedWorkspaceRevision: request.expectedRevisions.workspace,
              expectedRevision: request.expectedRevisions.view,
              patch: { ...derived.identity, definition: derived.definition },
            });
            return { kind: "update" as const, viewId: derived.viewId, request: mutationRequest, boundRequest: { kind: "update", viewId: derived.viewId, request: mutationRequest } };
          })()
        : (() => {
            const mutationRequest = organizationViewCreateRequestSchema.parse({
              idempotencyKey: request.retryKey,
              expectedWorkspaceRevision: request.expectedRevisions.workspace,
              ...derived.identity,
              definition: derived.definition,
            });
            return { kind: "create" as const, request: mutationRequest, boundRequest: { kind: "create", request: mutationRequest } };
          })();
      const existing = replay(input.scope, request.retryKey, mutation.boundRequest);
      let saved = existing.found ? existing.response as OrganizationView : null;
      if (!saved) {
        const zeroCheck = repository.evaluate({
          scope: input.scope,
          definition: derived.definition,
          definitionDigest: derived.definitionDigest,
          resultSetKey: "draft",
          query: { limit: 1 },
          authorization: reviewed.authorization,
        });
        if (zeroCheck.count.kind === "exact" && zeroCheck.count.value === 0 && request.confirmedZeroMatchDigest !== derived.definitionDigest) {
          throw new OrganizationViewValidationError("Confirm this exact zero-match definition before saving");
        }
      }

      if (mutation.kind === "update") {
        if (!saved) {
          const current = repository.get(input.scope.workspaceId, mutation.viewId);
          if (!current) throw new OrganizationViewNotFoundError();
          const isNoOp = canonicalOrganizationJson({ name: current.name, description: current.description, color: current.color, position: current.position, definition: current.definition })
            === canonicalOrganizationJson({ ...derived.identity, definition: derived.definition });
          if (isNoOp) throw new OrganizationViewValidationError("Change at least one View field before saving");
          saved = module.update({ scope: input.scope, viewId: mutation.viewId, request: mutation.request });
        }
      } else if (!saved) saved = module.create({ scope: input.scope, request: mutation.request });
      const canonical = module.list({ scope: input.scope });
      const view = canonical.items.find((candidate) => candidate.id === saved.id);
      if (!view) throw new OrganizationViewNotFoundError("The committed View could not be reloaded");
      const destination = `view:${view.id}`;
      return {
        workspaceId: input.scope.workspaceId,
        workspaceRevision: canonical.workspaceRevision,
        view,
        navigation: { destination, href: `/?destination=${encodeURIComponent(destination)}` },
      };
    },
    list(input: { scope: OrganizationViewScope }) {
      authorizedAccountIds(input.scope, undefined);
      return { workspaceId: input.scope.workspaceId, workspaceRevision: repository.getWorkspaceRevision(input.scope.workspaceId), items: repository.list(input.scope.workspaceId) };
    },
    create(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewCreateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.definition.accountIds);
      const boundRequest = { kind: "create", request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return existing.response as OrganizationView;
      const viewId = newViewId();
      const current = repository.list(input.scope.workspaceId);
      const orderedViewIds = current.map((view) => view.id);
      orderedViewIds.splice(Math.min(request.position, orderedViewIds.length), 0, viewId);
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId, mutation: "create", requestDigest, position: orderedViewIds.indexOf(viewId) }),
        orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      return repository.create({
        workspaceId: input.scope.workspaceId,
        viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision }),
        now: now(),
      });
    },
    update(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewUpdateRequestSchema.parse(input.request);
      authorizedAccountIds(input.scope, request.patch.definition?.accountIds);
      const boundRequest = { kind: "update", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return existing.response as OrganizationView;
      const current = repository.list(input.scope.workspaceId);
      const target = current.find((view) => view.id === input.viewId);
      if (!target) throw new OrganizationViewNotFoundError();
      const orderedViewIds = current.map((view) => view.id);
      if (request.patch.position !== undefined) {
        orderedViewIds.splice(orderedViewIds.indexOf(input.viewId), 1);
        orderedViewIds.splice(Math.min(request.patch.position, orderedViewIds.length), 0, input.viewId);
      }
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId: input.viewId, mutation: "update", requestDigest, position: orderedViewIds.indexOf(input.viewId) }),
        ...(orderChanged(current, orderedViewIds) ? [orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest)] : []),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      return repository.update({
        workspaceId: input.scope.workspaceId,
        viewId: input.viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, {
          [viewResourceId(input.viewId)]: request.expectedRevision,
          ...(orderChanged(current, orderedViewIds) ? { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision } : {}),
        }),
        now: now(),
      });
    },
    reorder(input: { scope: OrganizationViewScope; request: unknown }) {
      const request = organizationViewReorderRequestSchema.parse(input.request);
      const boundRequest = { kind: "reorder", request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return { workspaceId: input.scope.workspaceId, workspaceRevision: request.expectedWorkspaceRevision + 1, items: existing.response as OrganizationView[] };
      const current = repository.list(input.scope.workspaceId);
      const byId = new Map(current.map((view) => [view.id, view]));
      if (request.items.some((item) => !byId.has(item.id))) throw new OrganizationViewNotFoundError();
      if (request.items.some((item) => item.position >= current.length)) throw new OrganizationViewValidationError("View reorder positions must fit the complete Workspace ordering");
      const ordered = Array<string | undefined>(current.length);
      const requestedIds = new Set(request.items.map((item) => item.id));
      for (const item of request.items) ordered[item.position] = item.id;
      const untouched = current.filter((view) => !requestedIds.has(view.id)).map((view) => view.id);
      for (let index = 0; index < ordered.length; index += 1) if (!ordered[index]) ordered[index] = untouched.shift();
      const orderedViewIds = ordered as string[];
      const requestDigest = digest(boundRequest);
      const intents = [orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest)];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      const items = repository.reorder({
        workspaceId: input.scope.workspaceId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, { [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision }),
        now: now(),
      });
      return { workspaceId: input.scope.workspaceId, workspaceRevision: repository.getWorkspaceRevision(input.scope.workspaceId), items };
    },
    remove(input: { scope: OrganizationViewScope; viewId: string; request: unknown }) {
      const request = organizationViewRemoveRequestSchema.parse(input.request);
      const boundRequest = { kind: "remove", viewId: input.viewId, request };
      const existing = replay(input.scope, request.idempotencyKey, boundRequest);
      if (existing.found) return;
      const current = repository.list(input.scope.workspaceId);
      const target = current.find((view) => view.id === input.viewId);
      if (!target) throw new OrganizationViewNotFoundError();
      const orderedViewIds = current.filter((view) => view.id !== input.viewId).map((view) => view.id);
      const requestDigest = digest(boundRequest);
      const intents = [
        viewIntent({ viewId: input.viewId, mutation: "update", requestDigest, remove: true }),
        orderingIntent(input.scope.workspaceId, orderedViewIds, requestDigest),
      ];
      const command: OrganizationCommand = { id: newChangeId(), intents };
      repository.remove({
        workspaceId: input.scope.workspaceId,
        viewId: input.viewId,
        request,
        boundRequest,
        plan: mutationPlan(current, orderedViewIds),
        authorization: authorizeBound(input.scope, request, command, {
          [viewResourceId(input.viewId)]: request.expectedRevision,
          [organizationViewOrderResourceId(input.scope.workspaceId)]: request.expectedWorkspaceRevision,
        }),
        now: now(),
      });
    },
    results(input: { scope: OrganizationViewScope; viewId: string; query: unknown }) {
      const view = repository.get(input.scope.workspaceId, input.viewId);
      if (!view) throw new OrganizationViewNotFoundError();
      const definitionDigest = digestOrganizationViewDefinition(view.definition);
      authorizedAccountIds(input.scope, view.definition.accountIds);
      const evaluated = repository.evaluate({
        scope: input.scope,
        definition: view.definition,
        definitionDigest,
        resultSetKey: `saved:${view.id}:${view.revision}`,
        query: organizationViewResultQuerySchema.parse(input.query),
        authorization: authorizeQuery(input.scope, view.definition, dependencies.agentCapabilitySource),
      });
      return {
        viewId: view.id,
        viewRevision: view.revision,
        accountIds: evaluated.accountIds,
        items: evaluated.items,
        nextCursor: evaluated.nextCursor,
        limit: evaluated.limit,
      };
    },
  };
  return module;
}
