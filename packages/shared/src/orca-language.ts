import { z } from "zod";

import {
  organizationActorSchema,
  organizationCapabilitySnapshotSchema,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
} from "./organization-contract.ts";
import { facetValueTypeSchema, validateFacetScalarValue } from "./organization-facets.ts";

export const orcaLanguageTextLimits = Object.freeze({
  maximumIdentifierCodeUnits: 200,
  maximumSourceCodeUnits: 64 * 1024,
});

const identifierSchema = z.string().trim().min(1).max(orcaLanguageTextLimits.maximumIdentifierCodeUnits);
const sourceTextSchema = z.string().min(1).max(orcaLanguageTextLimits.maximumSourceCodeUnits);
const sourcePositionSchema = z.object({
  offset: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).strict();
export type OrcaSourcePosition = z.infer<typeof sourcePositionSchema>;

export const orcaCompilerLimits = Object.freeze({
  maximumSourceBytes: 64 * 1024,
  maximumLines: 1_000,
  maximumLineBytes: 2_000,
  maximumTokens: 8_000,
  maximumAstNodes: 1_000,
  maximumExpressionDepth: 16,
  maximumPredicates: 100,
  maximumActions: 100,
});

const orcaCompilerLimitNameSchema = z.enum([
  "source_bytes",
  "lines",
  "line_bytes",
  "tokens",
  "ast_nodes",
  "expression_depth",
  "predicates",
  "actions",
]);
export const orcaCompileBudgetSchema = z.object({
  status: z.enum(["complete", "exhausted"]),
  exhausted: z.array(orcaCompilerLimitNameSchema),
  limits: z.object({
    maximumSourceBytes: z.number().int().positive(),
    maximumLines: z.number().int().positive(),
    maximumLineBytes: z.number().int().positive(),
    maximumTokens: z.number().int().positive(),
    maximumAstNodes: z.number().int().positive(),
    maximumExpressionDepth: z.number().int().positive(),
    maximumPredicates: z.number().int().positive(),
    maximumActions: z.number().int().positive(),
  }).strict(),
  usage: z.object({
    sourceBytes: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    maximumLineBytes: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    astNodes: z.number().int().nonnegative(),
    expressionDepth: z.number().int().nonnegative(),
    predicates: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((budget, context) => {
  if ((budget.status === "exhausted") !== (budget.exhausted.length > 0)) {
    context.addIssue({ code: "custom", message: "Compiler budget status and exhausted limits must agree" });
  }
  if (new Set(budget.exhausted).size !== budget.exhausted.length) {
    context.addIssue({ code: "custom", path: ["exhausted"], message: "Exhausted compiler limits must be unique" });
  }
});
export type OrcaCompileBudget = z.infer<typeof orcaCompileBudgetSchema>;

export const orcaSourceSpanSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema,
}).strict();
export type OrcaSourceSpan = z.infer<typeof orcaSourceSpanSchema>;

export const orcaDiagnosticSchema = z.object({
  severity: z.literal("error"),
  phase: z.enum(["limits", "parse", "resolve", "type"]),
  code: identifierSchema,
  message: z.string().trim().min(1).max(1_000),
  span: orcaSourceSpanSchema,
  hint: z.string().trim().min(1).max(1_000).optional(),
}).strict();
export type OrcaDiagnostic = z.infer<typeof orcaDiagnosticSchema>;

export const orcaScalarTypeSchema = z.enum(["text", "number", "boolean", "datetime", "duration", "email", "domain", "enum"]);
export type OrcaScalarType = z.infer<typeof orcaScalarTypeSchema>;

const predicateReferenceSchema = z.object({ kind: z.literal("reference"), predicate: identifierSchema }).strict();
const predicateGroupSchema = z.object({ kind: z.enum(["all", "any"]), predicates: z.array(identifierSchema).min(1).max(orcaCompilerLimits.maximumPredicates) }).strict();
const predicateNotSchema = z.object({ kind: z.literal("not"), predicate: identifierSchema }).strict();
const predicateExistenceSchema = z.object({
  kind: z.enum(["exists", "missing"]),
  field: identifierSchema,
  valueType: orcaScalarTypeSchema,
  optional: z.boolean(),
  facetId: identifierSchema.optional(),
}).strict();
const predicateComparisonSchema = z.object({
  kind: z.literal("compare"),
  field: identifierSchema,
  operator: z.enum(["equals", "contains", "greater_than", "less_than"]),
  value: z.union([z.string(), z.number().finite(), z.boolean()]),
  valueType: orcaScalarTypeSchema,
  optional: z.boolean(),
  missingBehavior: z.literal("false"),
  facetId: identifierSchema.optional(),
}).strict();

export const orcaCompiledPredicateExpressionSchema = z.union([
  predicateReferenceSchema,
  predicateGroupSchema,
  predicateNotSchema,
  predicateExistenceSchema,
  predicateComparisonSchema,
]);
export type OrcaCompiledPredicateExpression = z.infer<typeof orcaCompiledPredicateExpressionSchema>;

const resourceAction = <Kind extends string, Key extends string>(kind: Kind, key: Key) => z.object({
  kind: z.literal(kind),
  [key]: identifierSchema,
} as Record<Key, typeof identifierSchema> & { kind: z.ZodLiteral<Kind> }).strict();

export const orcaCompiledActionSchema = z.union([
  resourceAction("route_lane", "laneId"),
  resourceAction("set_workflow_state", "stateId"),
  z.object({ kind: z.literal("set_facet"), facetId: identifierSchema, value: z.union([z.string(), z.number().finite(), z.boolean()]) }).strict(),
  resourceAction("unset_facet", "facetId"),
  z.object({ kind: z.literal("add_collection"), accountId: identifierSchema, collectionId: identifierSchema }).strict(),
  z.object({ kind: z.literal("remove_collection"), accountId: identifierSchema, collectionId: identifierSchema }).strict(),
  z.object({ kind: z.enum(["link_context", "unlink_context"]), contextTypeId: identifierSchema, contextId: identifierSchema }).strict(),
  z.object({ kind: z.literal("notify"), urgency: z.enum(["immediate", "digest"]) }).strict(),
  z.object({ kind: z.literal("suppress_interruption") }).strict(),
  z.object({ kind: z.literal("schedule_review"), duration: z.string().regex(/^P/) }).strict(),
  z.object({ kind: z.literal("propose_retention"), mode: z.enum(["keep", "review_after"]), days: z.number().int().min(1).max(3_650).nullable() }).strict(),
  z.object({ kind: z.literal("propose_provider_deletion") }).strict(),
]);
export type OrcaCompiledAction = z.infer<typeof orcaCompiledActionSchema>;

export const orcaEventKindSchema = z.enum([
  "message.received",
  "thread.updated",
  "schedule.reached",
  "user.corrected",
]);
export type OrcaEventKind = z.infer<typeof orcaEventKindSchema>;
export const orcaRequiredCapabilitySchema = z.enum(["organization_attention", "organization_thread", "provider_delete"]);
export type OrcaRequiredCapability = z.infer<typeof orcaRequiredCapabilitySchema>;
export const orcaRuleRiskSchema = z.enum(["low", "medium", "high", "destructive"]);
export type OrcaRuleRisk = z.infer<typeof orcaRuleRiskSchema>;

/**
 * Authoritative classification of resolved typed Actions. Source labels and
 * caller-supplied metadata are never inputs to this decision.
 */
export function classifyOrcaActions(actions: readonly OrcaCompiledAction[]): {
  requiredCapabilities: OrcaRequiredCapability[];
  risk: OrcaRuleRisk;
} {
  const capabilities = new Set<OrcaRequiredCapability>();
  let risk: OrcaRuleRisk = "low";
  for (const action of actions) {
    if (action.kind === "propose_provider_deletion") {
      capabilities.add("provider_delete");
      risk = "destructive";
    } else {
      capabilities.add("organization_thread");
      if (action.kind === "notify" || action.kind === "suppress_interruption" || action.kind === "schedule_review") {
        capabilities.add("organization_attention");
        if (risk === "low") risk = "medium";
      } else if (action.kind === "propose_retention" && risk !== "destructive") {
        risk = "high";
      }
    }
  }
  return { requiredCapabilities: [...capabilities].sort(), risk };
}

export const orcaCompiledRuleRevisionSchema = z.object({
  languageVersion: z.literal(1),
  workspaceId: identifierSchema,
  workspaceSchemaRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  event: z.object({ kind: orcaEventKindSchema }).strict(),
  predicates: z.array(z.object({ name: identifierSchema.nullable(), expression: orcaCompiledPredicateExpressionSchema }).strict()).min(1).max(orcaCompilerLimits.maximumPredicates),
  actions: z.array(orcaCompiledActionSchema).min(1).max(orcaCompilerLimits.maximumActions),
  because: z.string().trim().min(1).max(1_000),
  requiredCapabilities: z.array(orcaRequiredCapabilitySchema).max(3).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Required Capabilities must be unique" });
  }),
  risk: orcaRuleRiskSchema,
}).strict().superRefine((revision, context) => {
  const classification = classifyOrcaActions(revision.actions);
  if (classification.risk !== revision.risk) {
    context.addIssue({ code: "custom", path: ["risk"], message: "Rule risk must be derived from resolved typed Actions" });
  }
  if (classification.requiredCapabilities.length !== revision.requiredCapabilities.length
    || classification.requiredCapabilities.some((capability, index) => capability !== revision.requiredCapabilities[index])) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Required Capabilities must exactly match resolved typed Actions" });
  }
});
export type OrcaCompiledRuleRevision = z.infer<typeof orcaCompiledRuleRevisionSchema>;

const orcaCompilerNamedResourceSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
}).strict();

export const orcaWorkspaceSnapshotSchema = z.object({
  workspaceId: identifierSchema,
  revision: z.number().int().positive(),
  lanes: z.array(orcaCompilerNamedResourceSchema),
  workflowStates: z.array(orcaCompilerNamedResourceSchema),
  facets: z.array(z.object({
    id: identifierSchema,
    name: identifierSchema,
    valueType: facetValueTypeSchema,
    cardinality: z.enum(["single", "multi"]),
    optional: z.boolean(),
  }).strict()),
  collections: z.array(orcaCompilerNamedResourceSchema.extend({ accountId: identifierSchema }).strict()),
  contextTypes: z.array(orcaCompilerNamedResourceSchema),
  contexts: z.array(orcaCompilerNamedResourceSchema.extend({ contextTypeId: identifierSchema }).strict()),
}).strict();
export type OrcaWorkspaceSnapshot = z.infer<typeof orcaWorkspaceSnapshotSchema>;

export const orcaCompilationWorkspaceResourceLimit = orcaCompilerLimits.maximumPredicates + orcaCompilerLimits.maximumActions;
export const orcaCompilationWorkspaceSchema = orcaWorkspaceSnapshotSchema.superRefine((workspace, context) => {
  for (const family of ["lanes", "workflowStates", "facets", "collections", "contextTypes", "contexts"] as const) {
    if (workspace[family].length > orcaCompilationWorkspaceResourceLimit) {
      context.addIssue({
        code: "too_big",
        maximum: orcaCompilationWorkspaceResourceLimit,
        origin: "array",
        inclusive: true,
        path: [family],
        message: `Compilation Workspace ${family} exceed the bounded referenced-resource limit`,
      });
    }
  }
});

/**
 * Preserves only the authoritative Workspace resources referenced by one
 * bounded compiled revision. This revision-time snapshot is persisted apart
 * from caller-mutable compiled IR and is sufficient for later semantic
 * re-binding without relabeling the current catalog as historical state.
 */
export function snapshotOrcaCompiledRevisionWorkspace(
  revision: OrcaCompiledRuleRevision,
  workspace: OrcaWorkspaceSnapshot,
): OrcaWorkspaceSnapshot {
  const laneIds = new Set<string>();
  const workflowStateIds = new Set<string>();
  const facetIds = new Set<string>();
  const collectionIds = new Set<string>();
  const contextTypeIds = new Set<string>();
  const contextIds = new Set<string>();
  for (const { expression } of revision.predicates) {
    if ("facetId" in expression && expression.facetId) facetIds.add(expression.facetId);
  }
  for (const action of revision.actions) {
    if (action.kind === "route_lane") laneIds.add(action.laneId);
    else if (action.kind === "set_workflow_state") workflowStateIds.add(action.stateId);
    else if (action.kind === "set_facet" || action.kind === "unset_facet") facetIds.add(action.facetId);
    else if (action.kind === "add_collection" || action.kind === "remove_collection") collectionIds.add(action.collectionId);
    else if (action.kind === "link_context" || action.kind === "unlink_context") {
      contextTypeIds.add(action.contextTypeId);
      contextIds.add(action.contextId);
    }
  }
  return orcaCompilationWorkspaceSchema.parse({
    workspaceId: workspace.workspaceId,
    revision: workspace.revision,
    lanes: workspace.lanes.filter(({ id }) => laneIds.has(id)),
    workflowStates: workspace.workflowStates.filter(({ id }) => workflowStateIds.has(id)),
    facets: workspace.facets.filter(({ id }) => facetIds.has(id)),
    collections: workspace.collections.filter(({ id }) => collectionIds.has(id)),
    contextTypes: workspace.contextTypes.filter(({ id }) => contextTypeIds.has(id)),
    contexts: workspace.contexts.filter(({ id }) => contextIds.has(id)),
  });
}

export const orcaEvaluationWorkspaceSchema = orcaWorkspaceSnapshotSchema.extend({
  fallbackLaneId: identifierSchema,
  lanes: z.array(orcaCompilerNamedResourceSchema.extend({ defaultPolicyId: identifierSchema }).strict()),
  lanePolicies: z.array(z.object({
    id: identifierSchema,
    interruption: z.enum(["notify", "badge", "quiet"]),
    review: z.enum(["continuous", "daily", "weekly", "manual"]),
    retention: z.union([
      z.object({ mode: z.literal("keep"), days: z.null() }).strict(),
      z.object({ mode: z.literal("review_after"), days: z.number().int().positive() }).strict(),
    ]),
  }).strict()),
}).strict();
export type OrcaEvaluationWorkspace = z.infer<typeof orcaEvaluationWorkspaceSchema>;

export type OrcaSemanticBindingIssue = {
  code: "workspace_mismatch" | "schema_revision_mismatch" | "resource_not_found" | "resource_family_mismatch" | "facet_cardinality_mismatch" | "facet_value_invalid" | "required_facet_unset"
    | "predicate_reference_invalid" | "predicate_cycle" | "predicate_field_invalid" | "predicate_facet_mismatch" | "predicate_metadata_mismatch" | "predicate_operator_invalid" | "predicate_value_invalid";
  actionIndex: number | null;
  predicateIndex: number | null;
  message: string;
};

const orcaPredicateFieldSemantics: Readonly<Record<string, { valueType: OrcaScalarType; optional: boolean; scalarType: z.infer<typeof facetValueTypeSchema> }>> = Object.freeze({
  subject: { valueType: "text", optional: true, scalarType: { kind: "text", maxLength: 10_000 } },
  "sender.domain": { valueType: "domain", optional: true, scalarType: { kind: "domain" } },
  "sender.email": { valueType: "email", optional: true, scalarType: { kind: "email", allowDisplayName: false } },
  "thread.message_count": { valueType: "number", optional: false, scalarType: { kind: "number", integer: false } },
  "thread.unread": { valueType: "boolean", optional: false, scalarType: { kind: "boolean" } },
  "thread.latest_received_at": { valueType: "datetime", optional: true, scalarType: { kind: "datetime" } },
  "thread.human_signal": { valueType: "number", optional: true, scalarType: { kind: "number", integer: false } },
});

/**
 * Re-binds immutable compiled IR to one exact authoritative Workspace Schema
 * snapshot. Evaluation and future Simulation share this semantic seam.
 */
export function validateOrcaCompiledRevisionSemantics(
  revision: OrcaCompiledRuleRevision,
  workspace: OrcaWorkspaceSnapshot,
  options: { revisionBinding?: "exact" | "current" } = {},
): OrcaSemanticBindingIssue[] {
  const issues: OrcaSemanticBindingIssue[] = [];
  const issue = (value: Omit<OrcaSemanticBindingIssue, "actionIndex" | "predicateIndex"> & { actionIndex?: number | null; predicateIndex?: number | null }): void => {
    issues.push({ actionIndex: null, predicateIndex: null, ...value });
  };
  if (revision.workspaceId !== workspace.workspaceId) {
    issue({ code: "workspace_mismatch", message: "Compiled Rule Workspace does not match the Evaluation Workspace Schema" });
  }
  const revisionBinding = options.revisionBinding ?? "exact";
  if (revisionBinding === "exact" && revision.workspaceSchemaRevision !== workspace.revision) {
    issue({ code: "schema_revision_mismatch", message: `Compiled Rule Workspace Schema revision ${revision.workspaceSchemaRevision} does not match Evaluation revision ${workspace.revision}` });
  } else if (revisionBinding === "current" && revision.workspaceSchemaRevision > workspace.revision) {
    issue({ code: "schema_revision_mismatch", message: `Compiled Rule Workspace Schema revision ${revision.workspaceSchemaRevision} is newer than current revision ${workspace.revision}` });
  }
  const laneIds = new Set(workspace.lanes.map(({ id }) => id));
  const workflowStateIds = new Set(workspace.workflowStates.map(({ id }) => id));
  const contextTypeIds = new Set(workspace.contextTypes.map(({ id }) => id));
  const facetsById = new Map(workspace.facets.map((facet) => [facet.id, facet]));
  const collectionsById = new Map(workspace.collections.map((collection) => [collection.id, collection]));
  const contextsById = new Map(workspace.contexts.map((context) => [context.id, context]));

  const predicatesByName = new Map<string, { expression: OrcaCompiledPredicateExpression; index: number }>();
  for (const [predicateIndex, predicate] of revision.predicates.entries()) {
    if (predicate.name === null) continue;
    if (predicatesByName.has(predicate.name)) {
      issue({ code: "predicate_reference_invalid", predicateIndex, message: `Predicate name ${predicate.name} is defined more than once` });
    } else predicatesByName.set(predicate.name, { expression: predicate.expression, index: predicateIndex });
  }
  const referencedNames = (expression: OrcaCompiledPredicateExpression): string[] => {
    if (expression.kind === "reference" || expression.kind === "not") return [expression.predicate];
    if (expression.kind === "all" || expression.kind === "any") return expression.predicates;
    return [];
  };
  for (const [predicateIndex, { expression }] of revision.predicates.entries()) {
    for (const name of referencedNames(expression)) {
      if (!predicatesByName.has(name)) issue({ code: "predicate_reference_invalid", predicateIndex, message: `Predicate reference ${name} is not defined exactly once` });
    }
    if (!("field" in expression)) continue;
    const facetFieldId = expression.field.startsWith("facet:") ? expression.field.slice("facet:".length) : null;
    if (facetFieldId !== null || expression.facetId !== undefined) {
      if (!facetFieldId || !expression.facetId || facetFieldId !== expression.facetId) {
        issue({ code: "predicate_facet_mismatch", predicateIndex, message: `Predicate field ${expression.field} and Facet ID ${expression.facetId ?? "missing"} must identify the same Facet` });
        continue;
      }
      const facet = facetsById.get(expression.facetId);
      if (!facet) {
        issue({ code: "resource_not_found", predicateIndex, message: `Facet ${expression.facetId} is absent from the authoritative Workspace Schema` });
        continue;
      }
      if (facet.cardinality !== "single") {
        issue({ code: "facet_cardinality_mismatch", predicateIndex, message: `Facet ${facet.id} is not a single-value Facet supported by Orca v1 Predicates` });
      }
      if (expression.valueType !== facet.valueType.kind || expression.optional !== facet.optional) {
        issue({ code: "predicate_metadata_mismatch", predicateIndex, message: `Predicate metadata for Facet ${facet.id} does not match its authoritative type and optionality` });
      }
      if (expression.kind === "compare" && validateFacetScalarValue(facet.valueType, expression.value) !== null) {
        issue({ code: "predicate_value_invalid", predicateIndex, message: `Predicate literal is invalid for Facet ${facet.id}` });
      }
    } else {
      const field = orcaPredicateFieldSemantics[expression.field];
      if (!field) {
        issue({ code: "predicate_field_invalid", predicateIndex, message: `Predicate field ${expression.field} is not an authoritative Orca v1 field` });
        continue;
      }
      if (expression.valueType !== field.valueType || expression.optional !== field.optional) {
        issue({ code: "predicate_metadata_mismatch", predicateIndex, message: `Predicate metadata for field ${expression.field} does not match its authoritative type and optionality` });
      }
      if (expression.kind === "compare" && validateFacetScalarValue(field.scalarType, expression.value) !== null) {
        issue({ code: "predicate_value_invalid", predicateIndex, message: `Predicate literal is invalid for field ${expression.field}` });
      }
    }
    if (expression.kind === "missing" && !expression.optional) {
      issue({ code: "predicate_metadata_mismatch", predicateIndex, message: `Required field ${expression.field} cannot use a missing Predicate` });
    }
    if (expression.kind === "compare") {
      const permitted = expression.operator === "equals"
        || (expression.operator === "contains" && ["text", "email", "domain"].includes(expression.valueType))
        || ((expression.operator === "greater_than" || expression.operator === "less_than") && ["number", "datetime", "duration"].includes(expression.valueType));
      if (!permitted) issue({ code: "predicate_operator_invalid", predicateIndex, message: `Operator ${expression.operator} is not permitted for ${expression.valueType}` });
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    const predicate = predicatesByName.get(name);
    if (!predicate) return;
    if (visiting.has(name)) {
      issue({ code: "predicate_cycle", predicateIndex: predicate.index, message: `Predicate reference graph is recursive at ${name}` });
      return;
    }
    visiting.add(name);
    for (const target of referencedNames(predicate.expression)) visit(target);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of predicatesByName.keys()) visit(name);

  for (const [actionIndex, action] of revision.actions.entries()) {
    const missing = (family: string, id: string): void => {
      issue({ code: "resource_not_found", actionIndex, message: `${family} ${id} is absent from the authoritative Workspace Schema` });
    };
    if (action.kind === "route_lane") {
      if (!laneIds.has(action.laneId)) missing("Lane", action.laneId);
    } else if (action.kind === "set_workflow_state") {
      if (!workflowStateIds.has(action.stateId)) missing("Workflow State", action.stateId);
    } else if (action.kind === "set_facet" || action.kind === "unset_facet") {
      const facet = facetsById.get(action.facetId);
      if (!facet) { missing("Facet", action.facetId); continue; }
      if (facet.cardinality !== "single") {
        issue({ code: "facet_cardinality_mismatch", actionIndex, message: `Facet ${action.facetId} is not a single-value Facet supported by Orca v1 Actions` });
      }
      if (action.kind === "unset_facet" && !facet.optional) {
        issue({ code: "required_facet_unset", actionIndex, message: `Required Facet ${action.facetId} cannot be unset` });
      }
      if (action.kind === "set_facet") {
        const message = validateFacetScalarValue(facet.valueType, action.value);
        if (message) issue({ code: "facet_value_invalid", actionIndex, message: `Facet ${action.facetId} ${message}` });
      }
    } else if (action.kind === "add_collection" || action.kind === "remove_collection") {
      const collection = collectionsById.get(action.collectionId);
      if (!collection) missing("Collection", action.collectionId);
      else if (collection.accountId !== action.accountId) {
        issue({ code: "resource_family_mismatch", actionIndex, message: `Collection ${action.collectionId} is not in Account ${action.accountId}` });
      }
    } else if (action.kind === "link_context" || action.kind === "unlink_context") {
      if (!contextTypeIds.has(action.contextTypeId)) missing("Context Type", action.contextTypeId);
      const context = contextsById.get(action.contextId);
      if (!context) missing("Context", action.contextId);
      else if (context.contextTypeId !== action.contextTypeId) {
        issue({ code: "resource_family_mismatch", actionIndex, message: `Context ${action.contextId} does not belong to Context Type ${action.contextTypeId}` });
      }
    }
  }
  return issues;
}

export const orcaCompileInputSchema = z.object({
  source: z.string(),
  workspace: orcaWorkspaceSnapshotSchema,
}).strict();
export type OrcaCompileInput = z.infer<typeof orcaCompileInputSchema>;

export const orcaCompileSuccessSchema = z.object({
  ok: z.literal(true),
  revision: orcaCompiledRuleRevisionSchema,
  diagnostics: z.tuple([]),
  budget: orcaCompileBudgetSchema,
}).strict();
export const orcaCompileFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(orcaDiagnosticSchema).min(1),
  budget: orcaCompileBudgetSchema,
}).strict();
export const orcaCompileResultSchema = z.discriminatedUnion("ok", [orcaCompileSuccessSchema, orcaCompileFailureSchema]);
export type OrcaCompileResult = z.infer<typeof orcaCompileResultSchema>;
export type OrcaCompiler = (input: OrcaCompileInput) => OrcaCompileResult;

export const orcaRuleCompileRequestSchema = z.object({
  ruleId: identifierSchema.optional(),
  idempotencyKey: identifierSchema,
  expectedRuleRevision: z.number().int().positive().nullable(),
  workspaceSchemaRevision: z.number().int().positive(),
  source: sourceTextSchema,
}).strict().superRefine((request, context) => {
  if (request.expectedRuleRevision !== null && request.ruleId === undefined) {
    context.addIssue({ code: "custom", message: "Rule edits require a stable Rule ID and expected revision" });
  }
});
export type OrcaRuleCompileRequest = z.infer<typeof orcaRuleCompileRequestSchema>;

export const orcaRuleSchema = z.object({
  id: identifierSchema,
  workspaceId: identifierSchema,
  name: z.string().trim().min(1).max(200),
  latestRevision: z.number().int().positive(),
  activeRevisionId: identifierSchema.nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: false }),
  updatedAt: z.string().datetime({ offset: false }),
}).strict();
export type OrcaRule = z.infer<typeof orcaRuleSchema>;

const orcaRuleOrderItemSchema = z.object({
  id: identifierSchema,
  position: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const orcaRuleReorderRequestSchema = z.object({
  idempotencyKey: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  expectedRuleSetRevision: z.number().int().positive(),
  items: z.array(orcaRuleOrderItemSchema).min(1).max(10_000),
}).strict().superRefine((request, context) => {
  if (new Set(request.items.map(({ id }) => id)).size !== request.items.length) context.addIssue({ code: "custom", message: "Rule reorder IDs must be unique" });
  if (new Set(request.items.map(({ position }) => position)).size !== request.items.length) context.addIssue({ code: "custom", message: "Rule reorder positions must be unique" });
});
export type OrcaRuleReorderRequest = z.infer<typeof orcaRuleReorderRequestSchema>;

export const orcaRuleOrderResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  ruleSetRevision: z.number().int().positive(),
  orderDigest: z.string().regex(/^order-v1:[0-9a-f]{64}$/),
  ruleCount: z.number().int().nonnegative(),
  items: z.array(z.object({ id: identifierSchema, position: z.number().int().nonnegative(), revision: z.number().int().positive() }).strict()),
}).strict();
export type OrcaRuleOrderResponse = z.infer<typeof orcaRuleOrderResponseSchema>;

export const orcaRuleRevisionSchema = z.object({
  id: identifierSchema,
  ruleId: identifierSchema,
  workspaceId: identifierSchema,
  revision: z.number().int().positive(),
  source: sourceTextSchema,
  sourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  compiled: orcaCompiledRuleRevisionSchema,
  actor: organizationActorSchema,
  createdAt: z.string().datetime({ offset: false }),
}).strict();
export type OrcaRuleRevision = z.infer<typeof orcaRuleRevisionSchema>;

export const orcaRuleCompileSuccessSchema = z.object({
  ok: z.literal(true),
  rule: orcaRuleSchema,
  revision: orcaRuleRevisionSchema,
  diagnostics: z.tuple([]),
}).strict();
export const orcaRuleCompileFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(orcaDiagnosticSchema).min(1),
  budget: orcaCompileBudgetSchema,
}).strict();
export const orcaRuleCompileResponseSchema = z.discriminatedUnion("ok", [orcaRuleCompileSuccessSchema, orcaRuleCompileFailureSchema]);
export type OrcaRuleCompileResponse = z.infer<typeof orcaRuleCompileResponseSchema>;

export const orcaRuleRevisionPageDefaultLimit = 50;
export const orcaRuleRevisionPageMaximumLimit = 100;
export const orcaEvaluatorLimits = Object.freeze({
  maximumRuleRevisions: 100,
  maximumPredicateSteps: 2_000,
  maximumCandidates: 1_000,
  maximumPredicateDepth: 16,
});
export const orcaRuleRevisionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(orcaRuleRevisionPageMaximumLimit).default(orcaRuleRevisionPageDefaultLimit),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict();
export type OrcaRuleRevisionListQuery = z.input<typeof orcaRuleRevisionListQuerySchema>;

export const orcaRuleRevisionListSchema = z.object({
  rule: orcaRuleSchema,
  revisions: z.array(orcaRuleRevisionSchema).max(orcaRuleRevisionPageMaximumLimit),
  nextCursor: z.string().max(2_048).nullable(),
  limit: z.number().int().min(1).max(orcaRuleRevisionPageMaximumLimit),
}).strict();
export type OrcaRuleRevisionList = z.infer<typeof orcaRuleRevisionListSchema>;

export const orcaEvaluationEventKindSchema = z.enum([
  "message.received",
  "thread.updated",
  "schedule.reached",
  "user.corrected",
]);
export type OrcaEvaluationEventKind = z.infer<typeof orcaEvaluationEventKindSchema>;

const orcaEvaluationEventBaseSchema = z.object({
  id: identifierSchema,
  occurredAt: z.string().datetime({ offset: false }),
  workspaceId: identifierSchema,
  threadId: identifierSchema,
});

export const orcaEvaluationEventSchema = z.discriminatedUnion("kind", [
  orcaEvaluationEventBaseSchema.extend({
    kind: z.literal("message.received"),
    cause: z.literal("provider"),
    accountId: identifierSchema,
    messageId: identifierSchema,
  }).strict(),
  orcaEvaluationEventBaseSchema.extend({
    kind: z.literal("thread.updated"),
    cause: z.enum(["provider", "internal"]),
    accountId: identifierSchema,
    messageId: z.never().optional(),
  }).strict(),
  orcaEvaluationEventBaseSchema.extend({
    kind: z.literal("schedule.reached"),
    cause: z.literal("scheduler"),
    accountId: identifierSchema,
    messageId: z.never().optional(),
  }).strict(),
  orcaEvaluationEventBaseSchema.extend({
    kind: z.literal("user.corrected"),
    cause: z.literal("user"),
    accountId: identifierSchema,
    messageId: z.never().optional(),
  }).strict(),
]);
export type OrcaEvaluationEvent = z.infer<typeof orcaEvaluationEventSchema>;

export const orcaEvaluationPrecedenceSchema = z.enum([
  "safety_lock",
  "manual_override",
  "rule_revision",
  "lane_policy",
  "workspace_fallback",
]);
export type OrcaEvaluationPrecedence = z.infer<typeof orcaEvaluationPrecedenceSchema>;

const orcaObservedValueSchema = z.object({
  field: identifierSchema,
  present: z.boolean(),
  value: z.union([z.string(), z.number().finite(), z.boolean()]).optional(),
}).strict().superRefine((value, context) => {
  if (value.present !== (value.value !== undefined)) {
    context.addIssue({ code: "custom", message: "Observed values include a value exactly when the field is present" });
  }
});

const orcaPredicateResultSchema = z.object({
  revisionId: identifierSchema,
  predicate: identifierSchema,
  kind: z.enum(["reference", "all", "any", "not", "exists", "missing", "compare"]),
  result: z.boolean(),
  observedFields: z.array(identifierSchema),
}).strict();

const orcaEvaluationCandidateSchema = z.object({
  candidateId: identifierSchema,
  action: orcaCompiledActionSchema,
  slot: identifierSchema,
  precedence: orcaEvaluationPrecedenceSchema,
  ruleOrder: z.number().int().nonnegative(),
  actionOrder: z.number().int().nonnegative(),
  actor: organizationActorSchema,
  reason: z.string().trim().min(1).max(1_000),
  authorized: z.boolean(),
  authorityDenialCode: z.literal("account_denied").optional(),
  revisionId: identifierSchema.optional(),
  missingCapabilities: z.array(orcaRequiredCapabilitySchema).optional(),
}).strict();

const orcaEvaluationLoserSchema = orcaEvaluationCandidateSchema.extend({
  reason: z.enum([
    "higher_precedence_candidate",
    "capability_denied",
    "account_denied",
    "predicate_not_matched",
    "event_not_matched",
    "event_loop_blocked",
    "budget_exhausted",
  ]),
  candidateReason: z.string().trim().min(1).max(1_000),
  winnerCandidateId: identifierSchema.optional(),
}).strict();

const orcaConsideredRevisionSchema = z.object({
  ruleId: identifierSchema,
  revisionId: identifierSchema,
  revision: z.number().int().positive(),
  order: z.number().int().nonnegative(),
  eventMatched: z.boolean(),
  predicateMatched: z.boolean(),
  authorized: z.boolean(),
  reason: z.enum(["matched", "predicate_not_matched", "event_not_matched", "event_loop_blocked", "budget_exhausted"]),
}).strict();

export type OrcaEvaluationCandidate = {
  candidateId: string;
  action: OrcaCompiledAction;
  slot: string;
  precedence: OrcaEvaluationPrecedence;
  ruleOrder: number;
  actionOrder: number;
  actor: OrganizationActor;
  reason: string;
  authorized: boolean;
  authorityDenialCode?: "account_denied";
  revisionId?: string;
  missingCapabilities?: RequiredCapability[];
};
type RequiredCapability = z.infer<typeof orcaRequiredCapabilitySchema>;
export type OrcaEvaluationLoser = Omit<OrcaEvaluationCandidate, "reason"> & {
  reason: "higher_precedence_candidate" | "capability_denied" | "account_denied" | "predicate_not_matched" | "event_not_matched" | "event_loop_blocked" | "budget_exhausted";
  candidateReason: string;
  winnerCandidateId?: string;
};
export type OrcaLowerLanePlacement = {
  candidateId: string;
  laneId: string;
  placementSource: "rule_revision" | "lane_policy" | "workspace_fallback";
  sourceId: string;
  actor: OrganizationActor;
  reason: string;
};
export type OrcaEvaluationTrace = {
  id: string;
  event: OrcaEvaluationEvent;
  workspaceSchemaRevision: number;
  ruleSet: { id: string; revision: number; activeRevisionCount: number };
  logicalTime: string;
  actor: OrganizationActor;
  capabilities: OrganizationCapabilitySnapshot;
  consideredRevisions: Array<{
    ruleId: string;
    revisionId: string;
    revision: number;
    order: number;
    eventMatched: boolean;
    predicateMatched: boolean;
    authorized: boolean;
    reason: "matched" | "predicate_not_matched" | "event_not_matched" | "event_loop_blocked" | "budget_exhausted";
  }>;
  observedValues: Array<{ field: string; present: boolean; value?: string | number | boolean }>;
  predicateResults: Array<{
    revisionId: string;
    predicate: string;
    kind: "reference" | "all" | "any" | "not" | "exists" | "missing" | "compare";
    result: boolean;
    observedFields: string[];
  }>;
  candidates: OrcaEvaluationCandidate[];
  winners: OrcaEvaluationCandidate[];
  losers: OrcaEvaluationLoser[];
  lowerLanePlacement: OrcaLowerLanePlacement;
  reason: string;
  budget: {
    status: "complete" | "exhausted";
    maximumRuleRevisions: number;
    maximumPredicateSteps: number;
    maximumCandidates: number;
    maximumPredicateDepth: number;
    ruleRevisions: number;
    predicateSteps: number;
    candidates: number;
    exhausted: boolean;
  };
};

export const orcaEvaluationTraceSchema = z.object({
  id: identifierSchema,
  event: orcaEvaluationEventSchema,
  workspaceSchemaRevision: z.number().int().positive(),
  ruleSet: z.object({
    id: identifierSchema,
    revision: z.number().int().positive(),
    activeRevisionCount: z.number().int().nonnegative(),
  }).strict(),
  logicalTime: z.string().datetime({ offset: false }),
  actor: organizationActorSchema,
  capabilities: organizationCapabilitySnapshotSchema,
  consideredRevisions: z.array(orcaConsideredRevisionSchema),
  observedValues: z.array(orcaObservedValueSchema),
  predicateResults: z.array(orcaPredicateResultSchema),
  candidates: z.array(orcaEvaluationCandidateSchema),
  winners: z.array(orcaEvaluationCandidateSchema),
  losers: z.array(orcaEvaluationLoserSchema),
  lowerLanePlacement: z.object({
    candidateId: identifierSchema,
    laneId: identifierSchema,
    placementSource: z.enum(["rule_revision", "lane_policy", "workspace_fallback"]),
    sourceId: identifierSchema,
    actor: organizationActorSchema,
    reason: z.string().trim().min(1).max(1_000),
  }).strict(),
  reason: z.string().trim().min(1).max(1_000),
  budget: z.object({
    status: z.enum(["complete", "exhausted"]),
    maximumRuleRevisions: z.number().int().positive().max(orcaEvaluatorLimits.maximumRuleRevisions),
    maximumPredicateSteps: z.number().int().positive().max(orcaEvaluatorLimits.maximumPredicateSteps),
    maximumCandidates: z.number().int().positive().max(orcaEvaluatorLimits.maximumCandidates),
    maximumPredicateDepth: z.number().int().positive().max(orcaEvaluatorLimits.maximumPredicateDepth),
    ruleRevisions: z.number().int().nonnegative().max(orcaEvaluatorLimits.maximumRuleRevisions),
    predicateSteps: z.number().int().nonnegative().max(orcaEvaluatorLimits.maximumPredicateSteps),
    candidates: z.number().int().nonnegative().max(orcaEvaluatorLimits.maximumCandidates),
    exhausted: z.boolean(),
  }).strict().superRefine((budget, context) => {
    if ((budget.status === "exhausted") !== budget.exhausted) {
      context.addIssue({ code: "custom", message: "Evaluation budget status and exhausted flag must agree" });
    }
  }),
}).strict() as unknown as z.ZodType<OrcaEvaluationTrace>;

export const orcaEvaluationResultSchema = z.object({
  actions: z.array(orcaCompiledActionSchema),
  trace: orcaEvaluationTraceSchema,
}).strict() as unknown as z.ZodType<OrcaEvaluationResult>;
export type OrcaEvaluationResult = { actions: OrcaCompiledAction[]; trace: OrcaEvaluationTrace };
