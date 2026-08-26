import { z } from "zod";

import {
  organizationActorSchema,
  organizationCapabilitySnapshotSchema,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
} from "./organization-contract.ts";
import { facetValueTypeSchema } from "./organization-facets.ts";

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
}).strict();
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

export const orcaCompileInputSchema = z.object({
  source: z.string(),
  workspace: orcaWorkspaceSnapshotSchema,
}).strict();
export type OrcaCompileInput = z.infer<typeof orcaCompileInputSchema>;

export const orcaCompileSuccessSchema = z.object({
  ok: z.literal(true),
  revision: orcaCompiledRuleRevisionSchema,
  diagnostics: z.tuple([]),
}).strict();
export const orcaCompileFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(orcaDiagnosticSchema).min(1),
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
  createdAt: z.string().datetime({ offset: false }),
  updatedAt: z.string().datetime({ offset: false }),
}).strict();
export type OrcaRule = z.infer<typeof orcaRuleSchema>;

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
}).strict();
export const orcaRuleCompileResponseSchema = z.discriminatedUnion("ok", [orcaRuleCompileSuccessSchema, orcaRuleCompileFailureSchema]);
export type OrcaRuleCompileResponse = z.infer<typeof orcaRuleCompileResponseSchema>;

export const orcaRuleRevisionPageDefaultLimit = 50;
export const orcaRuleRevisionPageMaximumLimit = 100;
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
  event: {
    id: string;
    kind: OrcaEvaluationEventKind;
    cause: "provider" | "internal" | "scheduler" | "user" | "evaluator";
    occurredAt: string;
    workspaceId: string;
    accountId?: string;
    threadId: string;
    messageId?: string;
  };
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
  event: z.object({
    id: identifierSchema,
    kind: orcaEvaluationEventKindSchema,
    cause: z.enum(["provider", "internal", "scheduler", "user", "evaluator"]),
    occurredAt: z.string().datetime({ offset: false }),
    workspaceId: identifierSchema,
    accountId: identifierSchema.optional(),
    threadId: identifierSchema,
    messageId: identifierSchema.optional(),
  }).strict(),
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
    maximumRuleRevisions: z.number().int().positive(),
    maximumPredicateSteps: z.number().int().positive(),
    maximumCandidates: z.number().int().positive(),
    maximumPredicateDepth: z.number().int().positive(),
    ruleRevisions: z.number().int().nonnegative(),
    predicateSteps: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }).strict(),
}).strict() as unknown as z.ZodType<OrcaEvaluationTrace>;

export const orcaEvaluationResultSchema = z.object({
  actions: z.array(orcaCompiledActionSchema),
  trace: orcaEvaluationTraceSchema,
}).strict() as unknown as z.ZodType<OrcaEvaluationResult>;
export type OrcaEvaluationResult = { actions: OrcaCompiledAction[]; trace: OrcaEvaluationTrace };
