import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const identifierSchema = nonEmptyStringSchema.max(200);
const nameSchema = nonEmptyStringSchema.max(120);
const isoDateTimeSchema = z.string().datetime({ offset: false });
const uniqueIdentifiersSchema = z.array(identifierSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Values must be unique" });
});
const actorSchema = z.object({ id: identifierSchema, type: z.enum(["human", "agent", "system"]) }).strict();

export const organizationContextBounds = Object.freeze({
  maximumActionsPerChange: 100,
  maximumRelationshipsPerThread: 20,
  maximumRelationshipsPerContext: 2_000,
  maximumQueryResults: 100,
});

export const organizationContextRelationshipDirectionSchema = z.enum([
  "thread_to_context",
  "context_to_thread",
]);
export type OrganizationContextRelationshipDirection = z.infer<typeof organizationContextRelationshipDirectionSchema>;

export const organizationContextTypeSchema = z.object({
  id: identifierSchema,
  name: nameSchema,
  position: z.number().int().nonnegative(),
  retiredAt: isoDateTimeSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationContextType = z.infer<typeof organizationContextTypeSchema>;

export const organizationContextRelationshipTypeSchema = z.object({
  id: identifierSchema,
  contextTypeId: identifierSchema,
  name: nameSchema,
  inverseName: nameSchema,
  direction: organizationContextRelationshipDirectionSchema,
  position: z.number().int().nonnegative(),
  maximumPerThread: z.number().int().min(1).max(organizationContextBounds.maximumRelationshipsPerThread),
  retiredAt: isoDateTimeSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationContextRelationshipType = z.infer<typeof organizationContextRelationshipTypeSchema>;

export const organizationContextSchema = z.object({
  id: identifierSchema,
  contextTypeId: identifierSchema,
  name: nameSchema,
  retiredAt: isoDateTimeSchema.nullable(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationContext = z.infer<typeof organizationContextSchema>;

export const organizationContextRefSchema = z.object({
  contextTypeId: identifierSchema,
  contextId: identifierSchema,
}).strict();
export type OrganizationContextRef = z.infer<typeof organizationContextRefSchema>;

export const organizationThreadContextRelationshipSchema = z.object({
  id: identifierSchema,
  accountId: identifierSchema,
  threadId: identifierSchema,
  contextTypeId: identifierSchema,
  contextId: identifierSchema,
  relationshipTypeId: identifierSchema,
  direction: organizationContextRelationshipDirectionSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationThreadContextRelationship = z.infer<typeof organizationThreadContextRelationshipSchema>;

export const organizationThreadContextRelationshipRefSchema = z.object({
  relationshipId: identifierSchema,
  relationshipTypeId: identifierSchema,
  direction: organizationContextRelationshipDirectionSchema,
  context: organizationContextRefSchema,
}).strict();
export type OrganizationThreadContextRelationshipRef = z.infer<typeof organizationThreadContextRelationshipRefSchema>;

export const organizationContextFilterSchema = z.object({
  context: organizationContextRefSchema,
  relationshipTypeId: identifierSchema,
  direction: organizationContextRelationshipDirectionSchema.optional(),
}).strict();
export type OrganizationContextFilter = z.infer<typeof organizationContextFilterSchema>;

export const organizationContextThreadRevisionSchema = z.object({
  accountId: identifierSchema,
  threadId: identifierSchema,
  revision: z.number().int().positive(),
}).strict();
export type OrganizationContextThreadRevision = z.infer<typeof organizationContextThreadRevisionSchema>;

export const organizationContextScopeSchema = z.object({
  actor: actorSchema,
  workspaceId: identifierSchema,
  accountIds: uniqueIdentifiersSchema,
}).strict();
export type OrganizationContextScope = z.infer<typeof organizationContextScopeSchema>;

export const organizationContextQuerySchema = z.object({
  accountIds: uniqueIdentifiersSchema.min(1).optional(),
  threadId: identifierSchema.optional(),
  contextTypeId: identifierSchema.optional(),
  contextRef: organizationContextRefSchema.optional(),
  relationshipTypeId: identifierSchema.optional(),
  includeRetired: z.boolean().default(false),
  limit: z.number().int().min(1).max(organizationContextBounds.maximumQueryResults).default(organizationContextBounds.maximumQueryResults),
}).strict().superRefine((query, context) => {
  if (query.contextTypeId && query.contextRef && query.contextTypeId !== query.contextRef.contextTypeId) {
    context.addIssue({ code: "custom", path: ["contextRef", "contextTypeId"], message: "Context type filters must identify the same stable Context Type" });
  }
});
export type OrganizationContextQuery = z.infer<typeof organizationContextQuerySchema>;

export const organizationContextQueryResponseSchema = z.object({
  workspaceId: identifierSchema,
  accountIds: uniqueIdentifiersSchema,
  workspaceRevision: z.number().int().positive(),
  contextTypes: z.array(organizationContextTypeSchema),
  relationshipTypes: z.array(organizationContextRelationshipTypeSchema),
  contexts: z.array(organizationContextSchema),
  relationships: z.array(organizationThreadContextRelationshipSchema),
  threadRevisions: z.array(organizationContextThreadRevisionSchema),
}).strict();
export type OrganizationContextQueryResponse = z.infer<typeof organizationContextQueryResponseSchema>;

const createContextTypeActionSchema = z.object({
  kind: z.literal("create_context_type"),
  name: nameSchema,
  position: z.number().int().nonnegative(),
}).strict();
const updateContextTypeActionSchema = z.object({
  kind: z.literal("update_context_type"),
  contextTypeId: identifierSchema,
  patch: z.object({
    name: nameSchema.optional(),
    position: z.number().int().nonnegative().optional(),
    retired: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one Context Type field"),
  expectedRevision: z.number().int().positive(),
}).strict();
const createRelationshipTypeActionSchema = z.object({
  kind: z.literal("create_relationship_type"),
  contextTypeId: identifierSchema,
  name: nameSchema,
  inverseName: nameSchema,
  direction: organizationContextRelationshipDirectionSchema,
  position: z.number().int().nonnegative(),
  maximumPerThread: z.number().int().min(1).max(organizationContextBounds.maximumRelationshipsPerThread),
}).strict();
const updateRelationshipTypeActionSchema = z.object({
  kind: z.literal("update_relationship_type"),
  relationshipTypeId: identifierSchema,
  patch: z.object({
    name: nameSchema.optional(),
    inverseName: nameSchema.optional(),
    position: z.number().int().nonnegative().optional(),
    maximumPerThread: z.number().int().min(1).max(organizationContextBounds.maximumRelationshipsPerThread).optional(),
    retired: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one Relationship Type field"),
  expectedRevision: z.number().int().positive(),
}).strict();
const createContextActionSchema = z.object({
  kind: z.literal("create_context"),
  contextTypeId: identifierSchema,
  name: nameSchema,
}).strict();
const updateContextActionSchema = z.object({
  kind: z.literal("update_context"),
  contextId: identifierSchema,
  patch: z.object({
    name: nameSchema.optional(),
    retired: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one Context field"),
  expectedRevision: z.number().int().positive(),
}).strict();
const linkThreadContextActionSchema = z.object({
  kind: z.literal("link_thread_context"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  contextId: identifierSchema,
  relationshipTypeId: identifierSchema,
  expectedThreadRevision: z.number().int().positive().nullable(),
}).strict();
const unlinkThreadContextActionSchema = z.object({
  kind: z.literal("unlink_thread_context"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  relationshipId: identifierSchema,
  expectedRelationshipRevision: z.number().int().positive(),
  expectedThreadRevision: z.number().int().positive(),
}).strict();

export const organizationContextActionSchema = z.union([
  createContextTypeActionSchema,
  updateContextTypeActionSchema,
  createRelationshipTypeActionSchema,
  updateRelationshipTypeActionSchema,
  createContextActionSchema,
  updateContextActionSchema,
  linkThreadContextActionSchema,
  unlinkThreadContextActionSchema,
]);
export type OrganizationContextAction = z.infer<typeof organizationContextActionSchema>;

export const organizationContextActionKindSchema = z.enum([
  "create_context_type",
  "update_context_type",
  "create_relationship_type",
  "update_relationship_type",
  "create_context",
  "update_context",
  "link_thread_context",
  "unlink_thread_context",
]);
export type OrganizationContextActionKind = z.infer<typeof organizationContextActionKindSchema>;

export const organizationContextApplyRequestSchema = z.object({
  idempotencyKey: nonEmptyStringSchema.max(200),
  expectedWorkspaceRevision: z.number().int().positive(),
  actions: z.array(organizationContextActionSchema).min(1).max(organizationContextBounds.maximumActionsPerChange),
}).strict();
export type OrganizationContextApplyRequest = z.infer<typeof organizationContextApplyRequestSchema>;

export const organizationContextRevertRequestSchema = z.object({
  idempotencyKey: nonEmptyStringSchema.max(200),
  changeId: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
}).strict();
export type OrganizationContextRevertRequest = z.infer<typeof organizationContextRevertRequestSchema>;

export const organizationContextChangeSummarySchema = z.object({
  id: identifierSchema,
  workspaceId: identifierSchema,
  actor: actorSchema,
  operation: z.enum(["apply", "revert"]),
  actionKinds: z.array(organizationContextActionKindSchema).min(1),
  reason: nonEmptyStringSchema,
  revertsChangeId: identifierSchema.nullable(),
  revertedByChangeId: identifierSchema.nullable(),
  workspaceRevisionBefore: z.number().int().positive(),
  workspaceRevisionAfter: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
}).strict();
export type OrganizationContextChangeSummary = z.infer<typeof organizationContextChangeSummarySchema>;

export const organizationContextMutationResponseSchema = z.object({
  change: organizationContextChangeSummarySchema,
  state: organizationContextQueryResponseSchema,
}).strict();
export type OrganizationContextMutationResponse = z.infer<typeof organizationContextMutationResponseSchema>;

export const organizationContextDescribeResponseSchema = z.object({
  workspaceId: identifierSchema,
  accountIds: uniqueIdentifiersSchema,
  semantics: z.object({
    stableIdentity: z.literal(true),
    arbitraryFields: z.literal(false),
    contextEdges: z.literal("thread_context_only"),
  }).strict(),
  bounds: z.object({
    maximumActionsPerChange: z.literal(organizationContextBounds.maximumActionsPerChange),
    maximumRelationshipsPerThread: z.literal(organizationContextBounds.maximumRelationshipsPerThread),
    maximumRelationshipsPerContext: z.literal(organizationContextBounds.maximumRelationshipsPerContext),
  }).strict(),
  operations: z.object({ describe: z.literal(true), query: z.literal(true), apply: z.literal(true), revert: z.literal(true), simulate: z.literal(false) }).strict(),
  authority: z.object({ sendMail: z.literal(false), deleteProviderMail: z.literal(false) }).strict(),
  contextTypes: z.array(organizationContextTypeSchema),
  relationshipTypes: z.array(organizationContextRelationshipTypeSchema),
}).strict();
export type OrganizationContextDescribeResponse = z.infer<typeof organizationContextDescribeResponseSchema>;
