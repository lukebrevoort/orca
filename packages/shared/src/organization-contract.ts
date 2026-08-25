import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const uniqueNonEmptyStringsSchema = z.array(nonEmptyStringSchema).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Values must be unique" });
  }
});

export const organizationOperationSchema = z.enum([
  "describe",
  "query",
  "simulate",
  "apply",
  "revert",
]);
export type OrganizationOperation = z.infer<typeof organizationOperationSchema>;

export const organizationActorTypeSchema = z.enum(["human", "agent", "system"]);
export type OrganizationActorType = z.infer<typeof organizationActorTypeSchema>;

export const organizationActorSchema = z.object({
  id: nonEmptyStringSchema,
  type: organizationActorTypeSchema,
}).strict();
export type OrganizationActor = z.infer<typeof organizationActorSchema>;

export const organizationResourceFamilySchema = z.enum([
  "workspace_schema",
  "mail",
  "thread",
  "lane",
  "view",
  "collection",
  "shortcut",
  "saved_query",
  "facet",
  "context",
  "workflow_state",
  "rule",
  "change_set",
  "trace",
  "audit",
]);
export type OrganizationResourceFamily = z.infer<typeof organizationResourceFamilySchema>;

export const organizationActionFamilySchema = z.enum([
  "organization_read",
  "organization_structure",
  "organization_thread",
  "organization_attention",
  "mail_send",
  "provider_delete",
]);
export type OrganizationActionFamily = z.infer<typeof organizationActionFamilySchema>;

export const organizationRiskSchema = z.enum([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
]);
export type OrganizationRisk = z.infer<typeof organizationRiskSchema>;

export const organizationScopeSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueNonEmptyStringsSchema,
}).strict();
export type OrganizationScope = z.infer<typeof organizationScopeSchema>;

export const organizationExpectedRevisionsSchema = z.object({
  workspace: z.number().int().positive().nullable(),
  resources: z.record(nonEmptyStringSchema, z.number().int().positive()),
}).strict();
export type OrganizationExpectedRevisions = z.infer<typeof organizationExpectedRevisionsSchema>;

/** Immutable capability identity evaluated by the authority gate. */
export const organizationCapabilitySnapshotSchema = z.object({
  id: nonEmptyStringSchema,
  revision: z.number().int().positive(),
  actor: organizationActorSchema,
  scope: organizationScopeSchema,
  operations: z.array(organizationOperationSchema).min(1),
  resourceFamilies: z.array(organizationResourceFamilySchema).min(1),
  actionFamilies: z.array(organizationActionFamilySchema).min(1),
}).strict();
export type OrganizationCapabilitySnapshot = z.infer<typeof organizationCapabilitySnapshotSchema>;

const organizationIntentKindSchema = z.enum([
  "describe_workspace",
  "query_mail",
  "query_trace",
  "query_audit",
  "mutate_lane",
  "mutate_view",
  "mutate_collection",
  "mutate_shortcut",
  "mutate_saved_query",
  "mutate_facet",
  "mutate_context",
  "mutate_workflow_state",
  "mutate_rule",
  "organize_thread",
  "change_attention",
  "send_mail",
  "delete_provider_mail",
]);
export type OrganizationIntentKind = z.infer<typeof organizationIntentKindSchema>;

const organizationMutationKinds = new Set<OrganizationIntentKind>([
  "mutate_lane",
  "mutate_view",
  "mutate_collection",
  "mutate_shortcut",
  "mutate_saved_query",
  "mutate_facet",
  "mutate_context",
  "mutate_workflow_state",
  "mutate_rule",
  "organize_thread",
  "change_attention",
  "send_mail",
  "delete_provider_mail",
]);

const organizationMutationValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const organizationCommandIntentSchema = z.object({
  kind: organizationIntentKindSchema,
  resourceId: nonEmptyStringSchema,
  mutation: z.enum(["create", "update"]).nullable(),
  changes: z.record(nonEmptyStringSchema, organizationMutationValueSchema).nullable(),
}).strict().superRefine((intent, context) => {
  const mutates = organizationMutationKinds.has(intent.kind);
  if (mutates && (!intent.mutation || !intent.changes || Object.keys(intent.changes).length === 0)) {
    context.addIssue({ code: "custom", message: "Mutation intents require an explicit lifecycle and non-empty typed changes" });
  }
  if (!mutates && (intent.mutation !== null || intent.changes !== null)) {
    context.addIssue({ code: "custom", message: "Read intents cannot carry mutation contents" });
  }
});
export type OrganizationCommandIntent = z.infer<typeof organizationCommandIntentSchema>;

/** Exact semantic payload authorized and later executed by the Organization module. */
export const organizationCommandSchema = z.object({
  id: nonEmptyStringSchema,
  intents: z.array(organizationCommandIntentSchema).min(1).max(100),
}).strict().superRefine((command, context) => {
  const mutationTargets = command.intents
    .filter((intent) => intent.mutation !== null)
    .map((intent) => intent.resourceId);
  if (new Set(mutationTargets).size !== mutationTargets.length) {
    context.addIssue({ code: "custom", message: "A command can mutate each resource only once" });
  }
});
export type OrganizationCommand = z.infer<typeof organizationCommandSchema>;

export const organizationTraceWinnerSchema = z.object({
  source: z.enum([
    "authority_gate",
    "safety_lock",
    "manual_override",
    "rule_revision",
    "lane_policy",
    "workspace_fallback",
    "none",
  ]),
  sourceId: nonEmptyStringSchema.nullable(),
}).strict();
export type OrganizationTraceWinner = z.infer<typeof organizationTraceWinnerSchema>;

export const organizationAuthorityDenialCodeSchema = z.enum([
  "invalid_request",
  "invalid_live_authority",
  "actor_operation_denied",
  "actor_mismatch",
  "workspace_denied",
  "account_denied",
  "capability_revoked",
  "capability_stale",
  "missing_operation_capability",
  "operation_intent_mismatch",
  "resource_family_denied",
  "action_family_denied",
  "send_delete_forbidden",
  "destructive_risk_forbidden",
  "expected_revision_required",
  "revision_conflict",
  "idempotency_key_required",
  "duplicate_idempotency_key",
]);
export type OrganizationAuthorityDenialCode = z.infer<typeof organizationAuthorityDenialCodeSchema>;

export const organizationBoundCommandSchema = z.object({
  id: nonEmptyStringSchema,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type OrganizationBoundCommand = z.infer<typeof organizationBoundCommandSchema>;

/** Minimum immutable explanation required for every validated Organization decision. */
export const organizationAuthorityTraceSchema = z.object({
  actor: organizationActorSchema,
  capabilitySnapshot: organizationCapabilitySnapshotSchema,
  operation: organizationOperationSchema,
  scope: organizationScopeSchema,
  command: organizationBoundCommandSchema,
  requestedResourceFamilies: z.array(organizationResourceFamilySchema).min(1),
  requestedActionFamilies: z.array(organizationActionFamilySchema).min(1),
  requestedResourceIds: uniqueNonEmptyStringsSchema,
  expectedRevisions: organizationExpectedRevisionsSchema,
  risk: organizationRiskSchema,
  winner: organizationTraceWinnerSchema,
  reason: nonEmptyStringSchema,
  decision: z.enum(["allowed", "denied"]),
  denialCode: organizationAuthorityDenialCodeSchema.nullable(),
}).strict();
export type OrganizationAuthorityTrace = z.infer<typeof organizationAuthorityTraceSchema>;

export const organizationOperationRequestSchema = z.object({
  actor: organizationActorSchema,
  capabilitySnapshot: organizationCapabilitySnapshotSchema,
  operation: organizationOperationSchema,
  scope: organizationScopeSchema,
  command: organizationCommandSchema,
  expectedRevisions: organizationExpectedRevisionsSchema,
  idempotencyKey: nonEmptyStringSchema.nullable(),
}).strict();
export type OrganizationOperationRequest = z.infer<typeof organizationOperationRequestSchema>;

/** Trusted current state supplied by an adapter backed by the local registry/database. */
export const organizationLiveAuthorityStateSchema = z.object({
  scope: organizationScopeSchema,
  capability: z.object({
    snapshot: organizationCapabilitySnapshotSchema,
    revokedAt: nonEmptyStringSchema.nullable(),
  }).strict(),
  workspaceRevision: z.number().int().positive(),
  resourceRevisions: z.record(nonEmptyStringSchema, z.number().int().positive()),
  reservedIdempotencyKeys: z.array(nonEmptyStringSchema),
}).strict();
export type OrganizationLiveAuthorityState = z.infer<typeof organizationLiveAuthorityStateSchema>;

export const organizationExecutionContextSchema = z.object({
  actor: organizationActorSchema,
  command: organizationBoundCommandSchema,
  operation: organizationOperationSchema,
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueNonEmptyStringsSchema,
  capabilityId: nonEmptyStringSchema,
  capabilityRevision: z.number().int().positive(),
  expectedRevisions: organizationExpectedRevisionsSchema,
  idempotencyKey: nonEmptyStringSchema.nullable(),
  requiresAtomicIdempotencyReservation: z.boolean(),
}).strict();
export type OrganizationExecutionContext = z.infer<typeof organizationExecutionContextSchema>;

/** Canonical complete authority evidence passed across a transactional adapter seam. */
export const organizationAuthorizationEnvelopeSchema = z.object({
  executionContext: organizationExecutionContextSchema,
  trace: organizationAuthorityTraceSchema,
}).strict();
export type OrganizationAuthorizationEnvelope = z.infer<typeof organizationAuthorizationEnvelopeSchema>;
