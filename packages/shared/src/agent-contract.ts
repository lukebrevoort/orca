import { z } from "zod";

import {
  humanClassificationReasonCodeSchema,
  humanClassificationSchema,
  humanClassificationSourceSchema,
  humanSignalScoreSchema,
  mailContactSchema,
  mailProviderSchema,
} from "./schemas.ts";

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeStringSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
  { message: "Expected an ISO 8601 UTC timestamp" },
);

const stableSourceUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    context.addIssue({ code: "custom", message: "Source URLs must use HTTP or HTTPS" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: "custom", message: "Source URLs must not contain credentials" });
  }
});

/**
 * Agent importance answers whether an event merits propagation. It is not a
 * Human Signal classification, a safety judgment, or an attention setting.
 */
export const agentImportanceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type AgentImportance = z.infer<typeof agentImportanceSchema>;

export const agentRelevanceSchema = z.enum(["matched", "not_matched", "uncertain"]);
export type AgentRelevance = z.infer<typeof agentRelevanceSchema>;

export const agentEventKindSchema = z.enum([
  "release_available",
  "ci_or_deploy_failure",
  "security_or_account_alert",
  "receipt_or_renewal",
  "travel_or_booking_change",
  "marketing_or_newsletter",
  "other",
]);
export type AgentEventKind = z.infer<typeof agentEventKindSchema>;

export const agentPropagationDestinationSchema = z.enum([
  "timeline",
  "focus",
  "notify",
  "agent_view",
  "none",
]);
export type AgentPropagationDestination = z.infer<typeof agentPropagationDestinationSchema>;

export const agentPropagationReasonCodeSchema = z.enum([
  "release_became_available",
  "workflow_failed",
  "security_change_detected",
  "payment_or_renewal_detected",
  "itinerary_changed",
  "routine_bulk_content",
  "human_correspondence",
  "insufficient_evidence",
  "user_policy_disabled",
  "sender_muted",
  "category_muted",
  "duplicate_source",
]);
export type AgentPropagationReasonCode = z.infer<typeof agentPropagationReasonCodeSchema>;

export const agentPropagationTriggerSchema = z.enum(["sync", "push", "manual_request"]);
export type AgentPropagationTrigger = z.infer<typeof agentPropagationTriggerSchema>;

export const agentExecutionModeSchema = z.enum(["deterministic", "model_assisted"]);
export type AgentExecutionMode = z.infer<typeof agentExecutionModeSchema>;

/**
 * SHA-256 of the canonical UTF-8 JSON tuple documented in the BRE-263
 * contract. The value is opaque on external agent surfaces.
 */
export const agentDeduplicationKeySchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type AgentDeduplicationKey = z.infer<typeof agentDeduplicationKeySchema>;

/** A source reference is local to one Orca user and connected account. */
export const agentEventSourceSchema = z.object({
  ownerUserId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  provider: mailProviderSchema,
  messageId: nonEmptyStringSchema,
  providerMessageId: nonEmptyStringSchema.max(512),
  threadId: nonEmptyStringSchema,
  sender: mailContactSchema,
  subject: z.string().max(998),
  receivedAt: isoDateTimeStringSchema,
  sourceUrl: stableSourceUrlSchema,
}).strict();
export type AgentEventSource = z.infer<typeof agentEventSourceSchema>;

export const agentProvenanceSchema = z.object({
  trigger: agentPropagationTriggerSchema,
  policyVersion: nonEmptyStringSchema.max(100),
  agentId: nonEmptyStringSchema.max(100),
  agentVersion: nonEmptyStringSchema.max(100),
  executionMode: agentExecutionModeSchema,
}).strict();
export type AgentProvenance = z.infer<typeof agentProvenanceSchema>;

/** Snapshot the effective M5 result without making it an agent decision. */
export const agentHumanClassificationSnapshotSchema = z.object({
  classification: humanClassificationSchema,
  score: humanSignalScoreSchema,
  reasonCodes: z.array(humanClassificationReasonCodeSchema).max(12),
  classifierVersion: z.string().trim().min(1).max(100).nullable(),
  source: humanClassificationSourceSchema,
}).strict();
export type AgentHumanClassificationSnapshot = z.infer<typeof agentHumanClassificationSnapshotSchema>;

/**
 * This assessment is the provider-neutral seam shared by deterministic and
 * future model-assisted agents. A destination of `none` is a suppression, not
 * a persisted timeline event.
 */
export const agentPropagationAssessmentSchema = z.object({
  source: agentEventSourceSchema,
  provenance: agentProvenanceSchema,
  eventKind: agentEventKindSchema,
  importance: agentImportanceSchema,
  relevance: agentRelevanceSchema,
  destination: agentPropagationDestinationSchema,
  reasonCodes: z.array(agentPropagationReasonCodeSchema).min(1).max(12),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  whyThisMatters: z.string().trim().min(1).max(500),
  suggestedNextStep: z.string().trim().min(1).max(300).nullable(),
  humanClassification: agentHumanClassificationSnapshotSchema.nullable(),
  deduplicationKey: agentDeduplicationKeySchema,
  evaluatedAt: isoDateTimeStringSchema,
}).strict();
export type AgentPropagationAssessment = z.infer<typeof agentPropagationAssessmentSchema>;

export const agentEventLifecycleStateSchema = z.enum([
  "new",
  "seen",
  "dismissed",
  "snoozed",
  "muted",
  "false_positive",
  "retracted",
]);
export type AgentEventLifecycleState = z.infer<typeof agentEventLifecycleStateSchema>;

/** Created/updated are transitions; the remaining values are dispositions. */
export const agentEventLifecycleTransitionSchema = z.enum([
  "created",
  "updated",
  "seen",
  "dismissed",
  "snoozed",
  "muted",
  "false_positive",
  "retracted",
  "restored",
]);
export type AgentEventLifecycleTransition = z.infer<typeof agentEventLifecycleTransitionSchema>;

export const agentEventLifecycleSchema = z.object({
  state: agentEventLifecycleStateSchema,
  lastTransition: agentEventLifecycleTransitionSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
  lastTransitionAt: isoDateTimeStringSchema,
  seenAt: isoDateTimeStringSchema.nullable(),
  snoozedUntil: isoDateTimeStringSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "snoozed" && value.snoozedUntil === null) {
    context.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Snoozed events require snoozedUntil" });
  }
  if (value.state !== "snoozed" && value.snoozedUntil !== null) {
    context.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Only snoozed events may have snoozedUntil" });
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede createdAt" });
  }
  if (value.lastTransitionAt !== value.updatedAt) {
    context.addIssue({ code: "custom", path: ["lastTransitionAt"], message: "lastTransitionAt must equal updatedAt" });
  }
  if (value.lastTransition === "created" && value.revision !== 1) {
    context.addIssue({ code: "custom", path: ["revision"], message: "Created events begin at revision 1" });
  }
});
export type AgentEventLifecycle = z.infer<typeof agentEventLifecycleSchema>;

export const propagatedAgentEventSchema = agentPropagationAssessmentSchema.extend({
  id: nonEmptyStringSchema,
  lifecycle: agentEventLifecycleSchema,
}).strict().superRefine((value, context) => {
  if (value.destination === "none") {
    context.addIssue({
      code: "custom",
      path: ["destination"],
      message: "Suppressed assessments are not persisted agent events",
    });
  }
});
export type PropagatedAgentEvent = z.infer<typeof propagatedAgentEventSchema>;

export const agentEventListPageSchema = z.object({
  events: z.array(propagatedAgentEventSchema),
  nextCursor: z.string().trim().min(1).nullable(),
}).strict();
export type AgentEventListPage = z.infer<typeof agentEventListPageSchema>;

export const agentPropagationMuteTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("sender_address"), value: z.string().trim().email().transform((value) => value.toLowerCase()) }).strict(),
  z.object({ scope: z.literal("sender_domain"), value: z.string().trim().min(1).max(253).transform((value) => value.toLowerCase()) }).strict(),
  z.object({ scope: z.literal("event_kind"), value: agentEventKindSchema }).strict(),
]);
export type AgentPropagationMuteTarget = z.infer<typeof agentPropagationMuteTargetSchema>;

export const updateAgentEventLifecycleSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_seen"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("dismiss"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("restore"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("snooze"), expectedRevision: z.number().int().positive(), until: isoDateTimeStringSchema }).strict(),
  z.object({ action: z.literal("mute"), expectedRevision: z.number().int().positive(), target: agentPropagationMuteTargetSchema }).strict(),
  z.object({ action: z.literal("mark_false_positive"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("retract"), expectedRevision: z.number().int().positive() }).strict(),
]);
export type UpdateAgentEventLifecycle = z.infer<typeof updateAgentEventLifecycleSchema>;

export const agentPropagationPolicyCategorySchema = agentEventKindSchema;
export type AgentPropagationPolicyCategory = z.infer<typeof agentPropagationPolicyCategorySchema>;

export const agentPropagationPolicyOverrideSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  category: agentPropagationPolicyCategorySchema,
  enabled: z.boolean(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type AgentPropagationPolicyOverride = z.infer<typeof agentPropagationPolicyOverrideSchema>;

export const agentPropagationMuteRuleSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  target: agentPropagationMuteTargetSchema,
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type AgentPropagationMuteRule = z.infer<typeof agentPropagationMuteRuleSchema>;

export const createAgentPropagationMuteSchema = z.object({
  accountId: nonEmptyStringSchema,
  target: agentPropagationMuteTargetSchema,
}).strict();
export type CreateAgentPropagationMute = z.infer<typeof createAgentPropagationMuteSchema>;

export const deleteAgentPropagationMuteSchema = z.object({
  accountId: nonEmptyStringSchema,
  muteId: nonEmptyStringSchema,
}).strict();
export type DeleteAgentPropagationMute = z.infer<typeof deleteAgentPropagationMuteSchema>;

export const agentPropagationPolicySchema = z.object({
  releaseAvailable: z.boolean(),
  ciOrDeployFailure: z.boolean(),
  securityOrAccountAlert: z.boolean(),
  receiptOrRenewal: z.boolean(),
  travelOrBookingChange: z.boolean(),
  marketingOrNewsletter: z.boolean(),
  other: z.boolean(),
}).strict();
export type AgentPropagationPolicy = z.infer<typeof agentPropagationPolicySchema>;

export const conservativeAgentPropagationPolicy: AgentPropagationPolicy = Object.freeze({
  releaseAvailable: true,
  ciOrDeployFailure: true,
  securityOrAccountAlert: true,
  receiptOrRenewal: true,
  travelOrBookingChange: true,
  marketingOrNewsletter: false,
  other: false,
});

export const orcaMcpScopeSchema = z.enum([
  "orca:mail.metadata:read",
  "orca:mail.content:read",
  "orca:agent-events:read",
  "orca:connection-status:read",
  "orca:organization:control",
]);
export type OrcaMcpScope = z.infer<typeof orcaMcpScopeSchema>;

export const orcaAgentActionSchema = z.enum([
  "organization.describe",
  "organization.query",
  "organization.simulate",
  "organization.apply",
  "organization.revert",
  "mail.list",
  "mail.read",
  "agent_events.list",
  "connection_status.read",
]);
export type OrcaAgentAction = z.infer<typeof orcaAgentActionSchema>;

export const orcaAgentExposureSchema = z.enum([
  "organization_schema",
  "thread_organization",
  "organization_simulation",
  "organization_mutation",
  "mail_metadata",
  "mail_content",
  "agent_event",
  "connection_status",
]);
export type OrcaAgentExposure = z.infer<typeof orcaAgentExposureSchema>;

export const orcaMcpToolNameSchema = z.enum([
  "describe_organization",
  "query_organization",
  "simulate_organization",
  "apply_organization",
  "revert_organization",
  "search_mail",
  "get_thread",
  "list_agent_events",
  "get_connection_status",
]);
export type OrcaMcpToolName = z.infer<typeof orcaMcpToolNameSchema>;

export const orcaMcpTools = Object.freeze([
  {
    name: "describe_organization",
    action: "organization.describe",
    exposure: "organization_schema",
    requiredScopes: ["orca:mail.metadata:read", "orca:organization:control"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "query_organization",
    action: "organization.query",
    exposure: "thread_organization",
    requiredScopes: ["orca:mail.metadata:read", "orca:organization:control"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "simulate_organization",
    action: "organization.simulate",
    exposure: "organization_simulation",
    requiredScopes: ["orca:organization:control"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "apply_organization",
    action: "organization.apply",
    exposure: "organization_mutation",
    requiredScopes: ["orca:organization:control"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "revert_organization",
    action: "organization.revert",
    exposure: "organization_mutation",
    requiredScopes: ["orca:organization:control"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_mail",
    action: "mail.list",
    exposure: "mail_metadata",
    requiredScopes: ["orca:mail.metadata:read"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_thread",
    action: "mail.read",
    exposure: "mail_content",
    requiredScopes: ["orca:mail.content:read"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_agent_events",
    action: "agent_events.list",
    exposure: "agent_event",
    requiredScopes: ["orca:agent-events:read"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_connection_status",
    action: "connection_status.read",
    exposure: "connection_status",
    requiredScopes: ["orca:connection-status:read"],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] satisfies ReadonlyArray<{
  name: OrcaMcpToolName;
  action: OrcaAgentAction;
  exposure: OrcaAgentExposure;
  requiredScopes: readonly OrcaMcpScope[];
  annotations: { readOnlyHint: boolean; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}>);

/** Legacy/read-audit surface: this list is intentionally and provably read-only. */
export const orcaMcpReadOnlyTools = Object.freeze(orcaMcpTools.filter((tool) => tool.annotations.readOnlyHint));
