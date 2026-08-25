import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const identifierSchema = z.string().trim().min(1).max(200);
const positionSchema = z.number().int().nonnegative();
const retiredAtSchema = z.string().datetime({ offset: true }).nullable();

const enumOptionSchema = z.object({
  id: identifierSchema,
  label: nonEmptyStringSchema.max(120),
  position: positionSchema,
  retiredAt: retiredAtSchema,
}).strict();
export type FacetEnumOption = z.infer<typeof enumOptionSchema>;

const uniqueEnumOptionsSchema = z.array(enumOptionSchema).min(1).max(100).superRefine((options, context) => {
  for (const field of ["id", "label", "position"] as const) {
    const values = options.map((option) => field === "label" ? option.label.toLocaleLowerCase() : option[field]);
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `Enum option ${field}s must be unique` });
    }
  }
});

export const facetValueTypeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), maxLength: z.number().int().min(1).max(10_000) }).strict(),
  z.object({
    kind: z.literal("number"),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    integer: z.boolean(),
  }).strict().superRefine((value, context) => {
    if (value.minimum !== undefined && value.maximum !== undefined && value.minimum > value.maximum) {
      context.addIssue({ code: "custom", path: ["minimum"], message: "minimum must not exceed maximum" });
    }
  }),
  z.object({ kind: z.literal("boolean") }).strict(),
  z.object({ kind: z.literal("datetime") }).strict(),
  z.object({ kind: z.literal("duration") }).strict(),
  z.object({ kind: z.literal("email"), allowDisplayName: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("domain") }).strict(),
  z.object({ kind: z.literal("enum"), options: uniqueEnumOptionsSchema }).strict(),
]);
export type FacetValueType = z.infer<typeof facetValueTypeSchema>;

export const facetCardinalitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single") }).strict(),
  z.object({ kind: z.literal("multi"), maxItems: z.number().int().min(1).max(50) }).strict(),
]);
export type FacetCardinality = z.infer<typeof facetCardinalitySchema>;

export const facetScalarValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
export type FacetScalarValue = z.infer<typeof facetScalarValueSchema>;

const facetStoredValueSchema = z.union([
  facetScalarValueSchema,
  z.array(facetScalarValueSchema).min(1).max(50),
]);

export const facetDefinitionSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
  valueType: facetValueTypeSchema,
  cardinality: facetCardinalitySchema,
  isOptional: z.boolean(),
  defaultValue: facetStoredValueSchema.nullable(),
  retiredAt: retiredAtSchema,
  revision: z.number().int().positive(),
}).strict().superRefine((definition, context) => {
  if (definition.isOptional && definition.defaultValue !== null) {
    context.addIssue({ code: "custom", path: ["defaultValue"], message: "Optional Facets use absence for missing values and cannot declare a default" });
  }
  if (!definition.isOptional && definition.defaultValue === null) {
    context.addIssue({ code: "custom", path: ["defaultValue"], message: "Required Facets must declare a typed default for existing and future Threads" });
  }
});
export type FacetDefinition = z.infer<typeof facetDefinitionSchema>;

export const workflowStateDefinitionSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
  retiredAt: retiredAtSchema,
  revision: z.number().int().positive(),
}).strict();
export type WorkflowStateDefinition = z.infer<typeof workflowStateDefinitionSchema>;

export const threadFacetValueSchema = z.object({
  facetId: identifierSchema,
  value: z.union([facetScalarValueSchema, z.array(facetScalarValueSchema).min(1).max(50)]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ThreadFacetValue = z.infer<typeof threadFacetValueSchema>;

export const threadWorkflowStateSchema = z.object({
  stateId: identifierSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type ThreadWorkflowState = z.infer<typeof threadWorkflowStateSchema>;

const defineFacetActionSchema = z.object({
  kind: z.literal("define_facet"),
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
  valueType: facetValueTypeSchema,
  cardinality: facetCardinalitySchema,
  isOptional: z.boolean(),
  defaultValue: facetStoredValueSchema.nullable(),
}).strict().superRefine((action, context) => {
  if (action.isOptional && action.defaultValue !== null) {
    context.addIssue({ code: "custom", path: ["defaultValue"], message: "Optional Facets cannot declare a default" });
  }
  if (!action.isOptional && action.defaultValue === null) {
    context.addIssue({ code: "custom", path: ["defaultValue"], message: "Required Facets must declare a default" });
  }
});

const updateFacetActionSchema = z.object({
  kind: z.literal("update_facet"),
  facetId: identifierSchema,
  name: nonEmptyStringSchema.max(120).optional(),
  position: positionSchema.optional(),
  retired: z.boolean().optional(),
  expectedRevision: z.number().int().positive(),
}).strict().superRefine((action, context) => {
  if (action.name === undefined && action.position === undefined && action.retired === undefined) {
    context.addIssue({ code: "custom", message: "A Facet update must rename, reorder, or change retirement" });
  }
});

const defineWorkflowStateActionSchema = z.object({
  kind: z.literal("define_workflow_state"),
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
}).strict();

const updateWorkflowStateActionSchema = z.object({
  kind: z.literal("update_workflow_state"),
  stateId: identifierSchema,
  name: nonEmptyStringSchema.max(120).optional(),
  position: positionSchema.optional(),
  retired: z.boolean().optional(),
  expectedRevision: z.number().int().positive(),
}).strict().superRefine((action, context) => {
  if (action.name === undefined && action.position === undefined && action.retired === undefined) {
    context.addIssue({ code: "custom", message: "A Workflow State update must rename, reorder, or change retirement" });
  }
});

export const facetValueUpdateSchema = z.object({
  facetId: identifierSchema,
  value: z.union([
    z.null(),
    facetScalarValueSchema,
    z.array(facetScalarValueSchema).min(1).max(50),
  ]),
}).strict();
export type FacetValueUpdate = z.infer<typeof facetValueUpdateSchema>;

const setThreadFacetsActionSchema = z.object({
  kind: z.literal("set_thread_facets"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  values: z.array(facetValueUpdateSchema).min(1).max(50),
  expectedThreadRevision: z.number().int().positive().nullable(),
}).strict().superRefine((action, context) => {
  if (new Set(action.values.map((value) => value.facetId)).size !== action.values.length) {
    context.addIssue({ code: "custom", path: ["values"], message: "A command can set each Facet only once per Thread" });
  }
});

const setThreadWorkflowStateActionSchema = z.object({
  kind: z.literal("set_thread_workflow_state"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  stateId: identifierSchema.nullable(),
  expectedThreadRevision: z.number().int().positive().nullable(),
}).strict();

export const organizationFacetWorkflowActionSchema = z.union([
  defineFacetActionSchema,
  updateFacetActionSchema,
  defineWorkflowStateActionSchema,
  updateWorkflowStateActionSchema,
  setThreadFacetsActionSchema,
  setThreadWorkflowStateActionSchema,
]);
export type OrganizationFacetWorkflowAction = z.infer<typeof organizationFacetWorkflowActionSchema>;

export const organizationFacetWorkflowApplySchema = z.object({
  id: identifierSchema,
  idempotencyKey: nonEmptyStringSchema.max(200),
  expectedWorkspaceRevision: z.number().int().positive(),
  actions: z.array(organizationFacetWorkflowActionSchema).min(1).max(100),
}).strict();
export type OrganizationFacetWorkflowApply = z.infer<typeof organizationFacetWorkflowApplySchema>;

export const organizationFacetWorkflowApplyResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  appliedActions: z.number().int().positive(),
  facetDefinitions: z.array(facetDefinitionSchema),
  workflowStates: z.array(workflowStateDefinitionSchema),
}).strict();
export type OrganizationFacetWorkflowApplyResponse = z.infer<typeof organizationFacetWorkflowApplyResponseSchema>;

export const organizationFacetSupportSchema = z.object({
  valueTypes: z.tuple([
    z.literal("text"),
    z.literal("number"),
    z.literal("boolean"),
    z.literal("datetime"),
    z.literal("duration"),
    z.literal("email"),
    z.literal("domain"),
    z.literal("enum"),
  ]),
  cardinalities: z.tuple([z.literal("single"), z.literal("multi")]),
  missingValue: z.literal("absent_assignment"),
  clearRequest: z.null(),
  maximumListItems: z.literal(50),
  workflowStateIndependentOf: z.tuple([z.literal("lane"), z.literal("subject_matter")]),
  requiredValueLifecycle: z.literal("typed_default_for_all_threads"),
}).strict();
export type OrganizationFacetSupport = z.infer<typeof organizationFacetSupportSchema>;

export const facetFilterSchema = z.union([
  z.object({ facetId: identifierSchema, operator: z.enum(["missing", "present"]) }).strict(),
  z.object({ facetId: identifierSchema, operator: z.enum(["equals", "contains"]), value: facetScalarValueSchema }).strict(),
]);
export type FacetFilter = z.infer<typeof facetFilterSchema>;
