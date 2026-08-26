import { z } from "zod";

import { organizationActorSchema } from "./organization-contract.ts";

const identifierSchema = z.string().trim().min(1).max(200);
const sourceTextSchema = z.string().min(1).max(64 * 1024);
const sourcePositionSchema = z.object({
  offset: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).strict();

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
  resourceAction("add_collection", "collectionId"),
  resourceAction("remove_collection", "collectionId"),
  z.object({ kind: z.enum(["link_context", "unlink_context"]), contextTypeId: identifierSchema, contextId: identifierSchema }).strict(),
  z.object({ kind: z.literal("notify"), urgency: z.enum(["immediate", "digest"]) }).strict(),
  z.object({ kind: z.literal("suppress_interruption") }).strict(),
  z.object({ kind: z.literal("schedule_review"), duration: z.string().regex(/^P/) }).strict(),
  z.object({ kind: z.literal("propose_retention"), mode: z.enum(["keep", "review_after"]), days: z.number().int().min(1).max(3_650).nullable() }).strict(),
  z.object({ kind: z.literal("propose_provider_deletion") }).strict(),
]);
export type OrcaCompiledAction = z.infer<typeof orcaCompiledActionSchema>;

export const orcaEventKindSchema = z.enum(["message.received", "schedule.reached", "user.corrected"]);
export const orcaRequiredCapabilitySchema = z.enum(["organization_attention", "organization_thread", "provider_delete"]);

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
  risk: z.enum(["low", "medium", "high", "destructive"]),
}).strict();
export type OrcaCompiledRuleRevision = z.infer<typeof orcaCompiledRuleRevisionSchema>;

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

export const orcaRuleRevisionListSchema = z.object({
  rule: orcaRuleSchema,
  revisions: z.array(orcaRuleRevisionSchema),
}).strict();
export type OrcaRuleRevisionList = z.infer<typeof orcaRuleRevisionListSchema>;
