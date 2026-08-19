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

/** A source reference is local to one Orca user and connected account. */
export const agentEventSourceSchema = z.object({
  ownerUserId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  provider: mailProviderSchema,
  messageId: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
  sender: mailContactSchema,
  subject: z.string().max(998),
  receivedAt: isoDateTimeStringSchema,
  sourceUrl: z.string().url(),
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
  deduplicationKey: nonEmptyStringSchema.max(255),
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

export const agentEventLifecycleSchema = z.object({
  state: agentEventLifecycleStateSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
  seenAt: isoDateTimeStringSchema.nullable(),
  snoozedUntil: isoDateTimeStringSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "snoozed" && value.snoozedUntil === null) {
    context.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Snoozed events require snoozedUntil" });
  }
});
export type AgentEventLifecycle = z.infer<typeof agentEventLifecycleSchema>;

export const propagatedAgentEventSchema = agentPropagationAssessmentSchema.extend({
  id: nonEmptyStringSchema,
  lifecycle: agentEventLifecycleSchema,
}).strict();
export type PropagatedAgentEvent = z.infer<typeof propagatedAgentEventSchema>;

export const agentEventListPageSchema = z.object({
  events: z.array(propagatedAgentEventSchema),
  nextCursor: z.string().trim().min(1).nullable(),
}).strict();
export type AgentEventListPage = z.infer<typeof agentEventListPageSchema>;

export const updateAgentEventLifecycleSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark_seen") }).strict(),
  z.object({ action: z.literal("dismiss") }).strict(),
  z.object({ action: z.literal("restore") }).strict(),
  z.object({ action: z.literal("snooze"), until: isoDateTimeStringSchema }).strict(),
  z.object({ action: z.literal("mute") }).strict(),
  z.object({ action: z.literal("mark_false_positive") }).strict(),
  z.object({ action: z.literal("retract") }).strict(),
]);
export type UpdateAgentEventLifecycle = z.infer<typeof updateAgentEventLifecycleSchema>;

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
]);
export type OrcaMcpScope = z.infer<typeof orcaMcpScopeSchema>;

export const orcaAgentActionSchema = z.enum([
  "mail.list",
  "mail.read",
  "agent_events.list",
  "connection_status.read",
]);
export type OrcaAgentAction = z.infer<typeof orcaAgentActionSchema>;

export const orcaAgentExposureSchema = z.enum([
  "mail_metadata",
  "mail_content",
  "agent_event",
  "connection_status",
]);
export type OrcaAgentExposure = z.infer<typeof orcaAgentExposureSchema>;

export const orcaMcpToolNameSchema = z.enum([
  "search_mail",
  "get_thread",
  "list_agent_events",
  "get_connection_status",
]);
export type OrcaMcpToolName = z.infer<typeof orcaMcpToolNameSchema>;

export const orcaMcpReadOnlyTools = Object.freeze([
  {
    name: "search_mail",
    action: "mail.list",
    exposure: "mail_metadata",
    requiredScope: "orca:mail.metadata:read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_thread",
    action: "mail.read",
    exposure: "mail_content",
    requiredScope: "orca:mail.content:read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_agent_events",
    action: "agent_events.list",
    exposure: "agent_event",
    requiredScope: "orca:agent-events:read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_connection_status",
    action: "connection_status.read",
    exposure: "connection_status",
    requiredScope: "orca:connection-status:read",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
] satisfies ReadonlyArray<{
  name: OrcaMcpToolName;
  action: OrcaAgentAction;
  exposure: OrcaAgentExposure;
  requiredScope: OrcaMcpScope;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
}>);
