import {
  classifyOrcaActions,
  orcaCompiledRuleRevisionSchema,
  orcaEvaluatorLimits,
  orcaEvaluationEventSchema,
  orcaEvaluationWorkspaceSchema,
  orcaEvaluationResultSchema,
  validateOrcaCompiledRevisionSemantics,
  type OrcaCompiledAction,
  type OrcaCompiledPredicateExpression,
  type OrcaCompiledRuleRevision,
  type OrcaEvaluationEventKind,
  type OrcaEvaluationEvent,
  type OrcaEvaluationPrecedence,
  type OrcaEvaluationResult,
  type OrcaEvaluationTrace,
  type OrcaEvaluationWorkspace,
  type OrcaWorkspaceSnapshot,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
  type ThreadLanePlacement,
} from "@orca/shared";

type Scalar = string | number | boolean;
type RequiredCapability = OrcaCompiledRuleRevision["requiredCapabilities"][number];
type Candidate = OrcaEvaluationTrace["candidates"][number];
type Loser = OrcaEvaluationTrace["losers"][number];

export type { OrcaEvaluationEvent } from "@orca/shared";

export type OrcaEvaluationThreadSnapshot = {
  workspaceId: string;
  accountId: string;
  id: string;
  subject: string | null;
  sender: { email: string; domain: string } | null;
  messageCount: number;
  unread: boolean;
  latestReceivedAt: string | null;
  humanSignal: number | null;
  facets: Readonly<Record<string, Scalar | undefined>>;
  workflowStateId: string | null;
  collectionIds: readonly string[];
  contextIds: readonly string[];
  lanePlacement: ThreadLanePlacement;
  organizationRevision: number | null;
};

export type OrcaEvaluationWorkspaceSchema = OrcaEvaluationWorkspace;

export type OrcaActiveRuleRevision = {
  ruleId: string;
  revisionId: string;
  revision: number;
  order: number;
  /** Bounded authoritative resource definitions captured at compilation. */
  compilationWorkspace?: OrcaWorkspaceSnapshot;
  compiled: OrcaCompiledRuleRevision;
};

export type OrcaEvaluationBudgets = {
  maximumRuleRevisions: number;
  maximumPredicateSteps: number;
  maximumCandidates: number;
  maximumPredicateDepth?: number;
};

export type OrcaEvaluationInput = {
  event: OrcaEvaluationEvent;
  thread: OrcaEvaluationThreadSnapshot;
  workspaceSchema: OrcaEvaluationWorkspaceSchema;
  ruleSet: { id: string; revision: number; activeRevisionCount?: number; revisions: readonly OrcaActiveRuleRevision[] };
  actor: OrganizationActor;
  capabilities: OrganizationCapabilitySnapshot;
  logicalTime: string;
  budgets: OrcaEvaluationBudgets;
};

export class OrcaEvaluationInputError extends Error {
  readonly code = "invalid_evaluation_context" as const;
  constructor(message: string) { super(message); this.name = "OrcaEvaluationInputError"; }
}

const precedenceRank: Record<OrcaEvaluationPrecedence, number> = {
  safety_lock: 1,
  manual_override: 2,
  rule_revision: 3,
  lane_policy: 4,
  workspace_fallback: 5,
};

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function actionSlot(action: OrcaCompiledAction): string {
  switch (action.kind) {
    case "route_lane": return "lane";
    case "set_workflow_state": return "workflow_state";
    case "set_facet":
    case "unset_facet": return `facet:${action.facetId}`;
    case "add_collection":
    case "remove_collection": return `collection:${action.collectionId}`;
    case "link_context":
    case "unlink_context": return `context:${action.contextTypeId}:${action.contextId}`;
    case "notify":
    case "suppress_interruption":
    case "schedule_review": return "attention";
    case "propose_retention": return "retention";
    case "propose_provider_deletion": return "provider_deletion";
  }
}

function requiredCapabilities(action: OrcaCompiledAction): RequiredCapability[] {
  return classifyOrcaActions([action]).requiredCapabilities;
}

function compareCandidate(left: Candidate, right: Candidate): number {
  return precedenceRank[left.precedence] - precedenceRank[right.precedence]
    || left.ruleOrder - right.ruleOrder
    || left.actionOrder - right.actionOrder
    || compareText(left.candidateId, right.candidateId);
}

function compareResolvedAction(left: Candidate, right: Candidate): number {
  if (left.slot === "lane" && right.slot !== "lane") return -1;
  if (right.slot === "lane" && left.slot !== "lane") return 1;
  return compareCandidate(left, right);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Stable semantic serialization for equality checks, digests, fixtures, and persistence. */
export function serializeOrcaEvaluation(result: OrcaEvaluationResult): string {
  return JSON.stringify(canonical(result));
}

function assertEvaluationContext(input: OrcaEvaluationInput): {
  activeRevisionCount: number;
  budgets: Required<OrcaEvaluationBudgets>;
  revisions: readonly OrcaActiveRuleRevision[];
  ruleRevisionLimitExceeded: boolean;
} {
  if (!orcaEvaluationEventSchema.safeParse(input.event).success) {
    throw new OrcaEvaluationInputError("Event provenance must match the strict immutable Event contract");
  }
  const workspace = orcaEvaluationWorkspaceSchema.safeParse(input.workspaceSchema);
  if (!workspace.success) throw new OrcaEvaluationInputError("Workspace Schema snapshot failed strict runtime validation");
  const workspaceIds = [input.event.workspaceId, input.thread.workspaceId, input.workspaceSchema.workspaceId, input.capabilities.scope.workspaceId];
  if (workspaceIds.some((id) => id !== workspaceIds[0])) throw new OrcaEvaluationInputError("Evaluation Context Workspace identities must agree");
  if (input.event.threadId !== input.thread.id) throw new OrcaEvaluationInputError("Event and Thread snapshot identities must agree");
  if (input.event.accountId && input.event.accountId !== input.thread.accountId) throw new OrcaEvaluationInputError("Event and Thread snapshot Account identities must agree");
  if (!input.capabilities.scope.accountIds.includes(input.thread.accountId)) throw new OrcaEvaluationInputError("Thread Account is outside the immutable Capability Snapshot");
  if (input.actor.id !== input.capabilities.actor.id || input.actor.type !== input.capabilities.actor.type) throw new OrcaEvaluationInputError("Actor and Capability Snapshot Actor must agree");
  if (!Number.isInteger(input.ruleSet.revision) || input.ruleSet.revision < 1) throw new OrcaEvaluationInputError("Rule Set revision must be positive");
  const activeRevisionCount = input.ruleSet.activeRevisionCount ?? input.ruleSet.revisions.length;
  if (!Number.isInteger(activeRevisionCount) || activeRevisionCount < input.ruleSet.revisions.length) {
    throw new OrcaEvaluationInputError("Rule Set active revision count must cover the bounded revision prefix");
  }
  for (const [name, value] of Object.entries(input.budgets)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new OrcaEvaluationInputError(`${name} must be a positive integer`);
  }
  const budgets = {
    maximumRuleRevisions: Math.min(input.budgets.maximumRuleRevisions, orcaEvaluatorLimits.maximumRuleRevisions),
    maximumPredicateSteps: Math.min(input.budgets.maximumPredicateSteps, orcaEvaluatorLimits.maximumPredicateSteps),
    maximumCandidates: Math.min(input.budgets.maximumCandidates, orcaEvaluatorLimits.maximumCandidates),
    maximumPredicateDepth: Math.min(input.budgets.maximumPredicateDepth ?? orcaEvaluatorLimits.maximumPredicateDepth, orcaEvaluatorLimits.maximumPredicateDepth),
  };
  // Count is inspected before any per-item schema work. Only the bounded
  // prefix is ever parsed or sorted, even when an untrusted caller supplies a
  // much larger raw collection.
  const revisions = input.ruleSet.revisions.slice(0, budgets.maximumRuleRevisions);
  for (const revision of revisions) {
    const compiled = orcaCompiledRuleRevisionSchema.safeParse(revision.compiled);
    if (!compiled.success) {
      throw new OrcaEvaluationInputError(`Rule Revision ${revision.revisionId} failed typed IR classification validation`);
    }
    const compilationWorkspace = revision.compilationWorkspace
      ?? (compiled.data.workspaceSchemaRevision === workspace.data.revision ? workspace.data : null);
    if (!compilationWorkspace) {
      throw new OrcaEvaluationInputError(`Rule Revision ${revision.revisionId} lacks its authoritative compilation-time Workspace Schema snapshot`);
    }
    const compilationIssues = validateOrcaCompiledRevisionSemantics(compiled.data, compilationWorkspace, { revisionBinding: "exact" });
    if (compilationIssues.length > 0) {
      throw new OrcaEvaluationInputError(`Rule Revision ${revision.revisionId} failed compilation Workspace Schema semantic binding: ${compilationIssues[0]!.message}`);
    }
    const currentIssues = validateOrcaCompiledRevisionSemantics(compiled.data, workspace.data, { revisionBinding: "current" });
    if (currentIssues.length > 0) {
      throw new OrcaEvaluationInputError(`Rule Revision ${revision.revisionId} failed current Workspace Schema semantic binding: ${currentIssues[0]!.message}`);
    }
  }
  return {
    activeRevisionCount,
    budgets,
    revisions,
    ruleRevisionLimitExceeded: activeRevisionCount > budgets.maximumRuleRevisions,
  };
}

function observedField(input: OrcaEvaluationInput, field: string): { present: boolean; value?: Scalar } {
  let value: Scalar | null | undefined;
  if (field === "subject") value = input.thread.subject;
  else if (field === "sender.domain") value = input.thread.sender?.domain;
  else if (field === "sender.email") value = input.thread.sender?.email;
  else if (field === "thread.message_count") value = input.thread.messageCount;
  else if (field === "thread.unread") value = input.thread.unread;
  else if (field === "thread.latest_received_at") value = input.thread.latestReceivedAt;
  else if (field === "thread.human_signal") value = input.thread.humanSignal;
  else if (field.startsWith("facet:")) value = input.thread.facets[field.slice("facet:".length)];
  return value === null || value === undefined ? { present: false } : { present: true, value };
}

function compareValues(left: Scalar, operator: "equals" | "contains" | "greater_than" | "less_than", right: Scalar): boolean {
  if (operator === "equals") return left === right;
  if (operator === "contains") return typeof left === "string" && typeof right === "string" && left.includes(right);
  if (typeof left === "number" && typeof right === "number") return operator === "greater_than" ? left > right : left < right;
  if (typeof left === "string" && typeof right === "string") {
    const leftDate = Date.parse(left); const rightDate = Date.parse(right);
    if (!Number.isNaN(leftDate) && !Number.isNaN(rightDate)) return operator === "greater_than" ? leftDate > rightDate : leftDate < rightDate;
    return operator === "greater_than" ? left > right : left < right;
  }
  return false;
}

function lanePolicyAction(policy: OrcaEvaluationWorkspaceSchema["lanePolicies"][number]): OrcaCompiledAction {
  if (policy.interruption === "notify") return { kind: "notify", urgency: "immediate" };
  if (policy.interruption === "badge") return { kind: "notify", urgency: "digest" };
  return { kind: "suppress_interruption" };
}

/**
 * Pure deterministic Rule evaluator. It reads only the supplied immutable
 * Evaluation Context, memoizes named Predicate graph nodes, and resolves every
 * candidate through the single global precedence law.
 */
export function evaluateOrcaRules(input: OrcaEvaluationInput): OrcaEvaluationResult {
  const validated = assertEvaluationContext(input);
  const { budgets, activeRevisionCount, ruleRevisionLimitExceeded } = validated;
  const maximumPredicateDepth = budgets.maximumPredicateDepth;
  const usage = { ruleRevisions: 0, predicateSteps: 0, candidates: 0, exhausted: false };
  const observed = new Map<string, { field: string; present: boolean; value?: Scalar }>();
  const predicateResults: OrcaEvaluationTrace["predicateResults"] = [];
  const considered: OrcaEvaluationTrace["consideredRevisions"] = [];
  const candidates: Candidate[] = [];

  const addCandidate = (candidate: Omit<Candidate, "candidateId"> & { candidateId: string }) => {
    if (usage.exhausted) return false;
    if (usage.candidates >= budgets.maximumCandidates) { usage.exhausted = true; return false; }
    usage.candidates += 1;
    candidates.push(candidate);
    return true;
  };

  const placement = input.thread.lanePlacement;
  if (placement.safetyLock.locked) {
    addCandidate({
      candidateId: "safety-lock:lane", action: { kind: "route_lane", laneId: placement.primaryLaneId }, slot: "lane",
      precedence: "safety_lock", ruleOrder: 0, actionOrder: 0,
      actor: placement.safetyLock.actor ?? placement.evidence.actor,
      reason: placement.safetyLock.reason ?? "Safety Lock preserves the current Lane.", authorized: true,
    });
  }
  if (placement.manualOverride) {
    addCandidate({
      candidateId: "manual-override:lane", action: { kind: "route_lane", laneId: placement.manualOverride.laneId }, slot: "lane",
      precedence: "manual_override", ruleOrder: 0, actionOrder: 0, actor: placement.manualOverride.actor,
      reason: placement.manualOverride.reason, authorized: true,
    });
  }
  if (placement.evidence.winningSource === "lane_policy") {
    addCandidate({
      candidateId: "lane-policy:lane", action: { kind: "route_lane", laneId: placement.primaryLaneId }, slot: "lane",
      precedence: "lane_policy", ruleOrder: 0, actionOrder: 0, actor: placement.evidence.actor,
      reason: placement.evidence.reason, authorized: true,
    });
  }
  addCandidate({
    candidateId: "workspace-fallback:lane", action: { kind: "route_lane", laneId: input.workspaceSchema.fallbackLaneId }, slot: "lane",
    precedence: "workspace_fallback", ruleOrder: 0, actionOrder: 0,
    actor: { id: "system:workspace-fallback", type: "system" },
    reason: "No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.", authorized: true,
  });

  const orderedRevisions = [...validated.revisions].sort((left, right) => left.order - right.order
    || compareText(left.ruleId, right.ruleId) || left.revision - right.revision || compareText(left.revisionId, right.revisionId));
  if (ruleRevisionLimitExceeded) usage.exhausted = true;

  for (const rule of orderedRevisions) {
    usage.ruleRevisions += 1;
    const eventMatched = rule.compiled.event.kind === input.event.kind;
    if (ruleRevisionLimitExceeded) {
      considered.push({
        ruleId: rule.ruleId, revisionId: rule.revisionId, revision: rule.revision, order: rule.order,
        eventMatched, predicateMatched: false, authorized: false, reason: "budget_exhausted",
      });
      continue;
    }
    if (!eventMatched) {
      considered.push({
        ruleId: rule.ruleId, revisionId: rule.revisionId, revision: rule.revision, order: rule.order,
        eventMatched: false, predicateMatched: false, authorized: false,
        reason: "event_not_matched",
      });
      continue;
    }
    // Persisting an immutable Rule Revision is itself an authoritative
    // Organization mutation, so the live Workspace revision advances beyond
    // the schema snapshot used to compile it. Historical snapshots remain
    // valid by stable resource ID; only future-dated or cross-Workspace IR is
    // ineligible for live evaluation.
    if (rule.compiled.workspaceSchemaRevision > input.workspaceSchema.revision || rule.compiled.workspaceId !== input.workspaceSchema.workspaceId) {
      considered.push({ ruleId: rule.ruleId, revisionId: rule.revisionId, revision: rule.revision, order: rule.order, eventMatched: true, predicateMatched: false, authorized: false, reason: "predicate_not_matched" });
      continue;
    }

    const definitions = new Map(rule.compiled.predicates.flatMap((predicate) => predicate.name ? [[predicate.name, predicate.expression] as const] : []));
    const memo = new Map<string, boolean>();
    const active = new Set<string>();
    const evaluateExpression = (expression: OrcaCompiledPredicateExpression, label: string, depth: number): boolean => {
      if (usage.exhausted) return false;
      if (depth > maximumPredicateDepth || usage.predicateSteps >= budgets.maximumPredicateSteps) { usage.exhausted = true; return false; }
      usage.predicateSteps += 1;
      const observedFields: string[] = [];
      let result = false;
      if (expression.kind === "reference") {
        if (memo.has(expression.predicate)) result = memo.get(expression.predicate)!;
        else if (!active.has(expression.predicate)) {
          const target = definitions.get(expression.predicate);
          if (target) {
            active.add(expression.predicate);
            result = evaluateExpression(target, expression.predicate, depth + 1);
            active.delete(expression.predicate);
            memo.set(expression.predicate, result);
          }
        }
      } else if (expression.kind === "all" || expression.kind === "any") {
        const values = expression.predicates.map((name) => {
          if (memo.has(name)) return memo.get(name)!;
          if (active.has(name)) return false;
          const target = definitions.get(name);
          if (!target) return false;
          active.add(name);
          const value = evaluateExpression(target, name, depth + 1);
          active.delete(name);
          memo.set(name, value);
          return value;
        });
        result = expression.kind === "all" ? values.every(Boolean) : values.some(Boolean);
      } else if (expression.kind === "not") {
        if (memo.has(expression.predicate)) result = !memo.get(expression.predicate)!;
        else {
          const target = definitions.get(expression.predicate);
          if (target && !active.has(expression.predicate)) {
            active.add(expression.predicate);
            const value = evaluateExpression(target, expression.predicate, depth + 1);
            active.delete(expression.predicate);
            memo.set(expression.predicate, value);
            result = !value;
          }
        }
      } else if ("field" in expression) {
        const value = observedField(input, expression.field);
        observed.set(expression.field, { field: expression.field, ...value });
        observedFields.push(expression.field);
        if (expression.kind === "exists") result = value.present;
        else if (expression.kind === "missing") result = !value.present;
        else if ("operator" in expression) result = value.present ? compareValues(value.value!, expression.operator, expression.value) : false;
      }
      predicateResults.push({ revisionId: rule.revisionId, predicate: label, kind: expression.kind, result, observedFields });
      return result;
    };

    const gates = rule.compiled.predicates.filter((predicate) => predicate.name === null);
    const effectiveGates = gates.length ? gates : rule.compiled.predicates;
    const gateResults: boolean[] = [];
    for (const [index, predicate] of rule.compiled.predicates.entries()) {
      if (predicate.name && memo.has(predicate.name)) continue;
      const result = evaluateExpression(predicate.expression, predicate.name ?? `when:${index}`, 1);
      if (predicate.name) memo.set(predicate.name, result);
      if (effectiveGates.includes(predicate)) gateResults.push(result);
      if (usage.exhausted) break;
    }
    const predicateMatched = !usage.exhausted && gateResults.length > 0 && gateResults.every(Boolean);
    const granted = new Set(input.capabilities.actionFamilies);
    const ruleAuthorized = rule.compiled.requiredCapabilities.every((capability) => granted.has(capability));
    considered.push({
      ruleId: rule.ruleId, revisionId: rule.revisionId, revision: rule.revision, order: rule.order,
      eventMatched: true, predicateMatched, authorized: predicateMatched && ruleAuthorized,
      reason: usage.exhausted ? "budget_exhausted" : predicateMatched ? "matched" : "predicate_not_matched",
    });
    if (usage.exhausted) break;
    if (!predicateMatched) continue;
    for (const [actionOrder, action] of rule.compiled.actions.entries()) {
      const missingCapabilities = requiredCapabilities(action).filter((capability) => !granted.has(capability));
      const collectionAccountDenied = (action.kind === "add_collection" || action.kind === "remove_collection")
        && action.accountId !== input.thread.accountId;
      const added = addCandidate({
        candidateId: `rule:${rule.ruleId}:${rule.revisionId}:${actionOrder}`,
        action, slot: actionSlot(action), precedence: "rule_revision", ruleOrder: rule.order, actionOrder,
        actor: input.actor, reason: rule.compiled.because, authorized: missingCapabilities.length === 0 && !collectionAccountDenied,
        revisionId: rule.revisionId,
        ...(collectionAccountDenied ? { authorityDenialCode: "account_denied" as const } : {}),
        ...(missingCapabilities.length ? { missingCapabilities } : {}),
      });
      if (!added) break;
    }
    if (usage.exhausted) break;
  }

  const ruleCandidatesAllowed = !usage.exhausted;
  const provisionalLane = candidates.filter((candidate) => candidate.slot === "lane" && candidate.authorized
    && (ruleCandidatesAllowed || candidate.precedence !== "rule_revision")).sort(compareCandidate)[0];
  const effectiveLaneId = provisionalLane?.action.kind === "route_lane" ? provisionalLane.action.laneId : input.workspaceSchema.fallbackLaneId;
  const lane = input.workspaceSchema.lanes.find((item) => item.id === effectiveLaneId);
  const policy = lane && input.workspaceSchema.lanePolicies.find((item) => item.id === lane.defaultPolicyId);
  if (policy) {
    const action = lanePolicyAction(policy);
    addCandidate({
      candidateId: `lane-policy:${policy.id}:attention`, action, slot: "attention", precedence: "lane_policy",
      ruleOrder: 0, actionOrder: 0, actor: { id: `system:lane-policy:${policy.id}`, type: "system" },
      reason: `Lane Policy ${policy.id} supplies the default interruption behavior for Lane ${effectiveLaneId}.`, authorized: true,
    });
  }

  const winners: Candidate[] = [];
  const losers: Loser[] = [];
  const winnerBySlot = new Map<string, Candidate>();
  for (const candidate of [...candidates].sort(compareCandidate)) {
    if (!candidate.authorized) {
      losers.push({ ...candidate, candidateReason: candidate.reason, reason: candidate.authorityDenialCode ?? "capability_denied" });
      continue;
    }
    if (usage.exhausted && candidate.precedence === "rule_revision") {
      losers.push({ ...candidate, candidateReason: candidate.reason, reason: "budget_exhausted" });
      continue;
    }
    const winner = winnerBySlot.get(candidate.slot);
    if (!winner) { winnerBySlot.set(candidate.slot, candidate); winners.push(candidate); }
    else losers.push({ ...candidate, candidateReason: candidate.reason, reason: "higher_precedence_candidate", winnerCandidateId: winner.candidateId });
  }
  winners.sort(compareCandidate);
  losers.sort(compareCandidate);
  const lowerLaneCandidate = candidates.filter((candidate) => candidate.slot === "lane"
    && candidate.action.kind === "route_lane"
    && candidate.authorized
    && ["rule_revision", "lane_policy", "workspace_fallback"].includes(candidate.precedence)
    && (!usage.exhausted || candidate.precedence !== "rule_revision"))
    .sort(compareCandidate)[0];
  if (!lowerLaneCandidate || lowerLaneCandidate.action.kind !== "route_lane"
    || !["rule_revision", "lane_policy", "workspace_fallback"].includes(lowerLaneCandidate.precedence)) {
    throw new OrcaEvaluationInputError("Evaluation did not resolve an authoritative lower Lane placement");
  }
  const lowerLanePlacement = {
    candidateId: lowerLaneCandidate.candidateId,
    laneId: lowerLaneCandidate.action.laneId,
    placementSource: lowerLaneCandidate.precedence as "rule_revision" | "lane_policy" | "workspace_fallback",
    sourceId: lowerLaneCandidate.precedence === "rule_revision"
      ? lowerLaneCandidate.revisionId!
      : lowerLaneCandidate.precedence === "lane_policy"
        ? input.thread.lanePlacement.evidence.sourceId
        : lowerLaneCandidate.action.laneId,
    actor: lowerLaneCandidate.actor,
    reason: lowerLaneCandidate.reason,
  };
  /**
   * The top-level reason is the authoritative reason of the primary Lane
   * winner. Evaluations without a Lane winner use the first resolved winner;
   * only an evaluation with no winner at all uses an evaluator status label.
   */
  const primaryWinner = winners.find((winner) => winner.slot === "lane") ?? winners[0];
  const reason = primaryWinner?.reason
    ?? (usage.exhausted
      ? "Evaluation budget exhausted; no candidate Action was resolved."
      : "No candidate Action was authorized.");

  return orcaEvaluationResultSchema.parse({
    actions: [...winners].sort(compareResolvedAction).map((winner) => winner.action),
    trace: {
      id: `evaluation:${input.event.id}:${input.ruleSet.id}:${input.ruleSet.revision}`,
      event: input.event,
      workspaceSchemaRevision: input.workspaceSchema.revision,
      ruleSet: { id: input.ruleSet.id, revision: input.ruleSet.revision, activeRevisionCount },
      logicalTime: input.logicalTime,
      actor: input.actor,
      capabilities: input.capabilities,
      consideredRevisions: considered,
      observedValues: [...observed.values()].sort((left, right) => compareText(left.field, right.field)),
      predicateResults,
      candidates,
      winners,
      losers,
      lowerLanePlacement,
      reason,
      budget: {
        status: usage.exhausted ? "exhausted" : "complete",
        maximumRuleRevisions: budgets.maximumRuleRevisions,
        maximumPredicateSteps: budgets.maximumPredicateSteps,
        maximumCandidates: budgets.maximumCandidates,
        maximumPredicateDepth,
        ...usage,
      },
    },
  });
}
