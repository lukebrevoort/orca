import { z } from "zod";

import {
  attentionBehaviorSchema,
  humanClassificationAssessmentSchema,
  humanClassificationSchema,
  humanClassificationSourceSchema,
  humanSignalScoreSchema,
  mailContactSchema,
  mailProviderSchema,
  syncStateSchema,
} from "./schemas.ts";
import {
  agentEventKindSchema,
  agentEventLifecycleSchema,
  agentEventLifecycleStateSchema,
  agentHumanClassificationSnapshotSchema,
  agentImportanceSchema,
  agentPropagationDestinationSchema,
  agentPropagationReasonCodeSchema,
  agentProvenanceSchema,
  agentRelevanceSchema,
} from "./agent-contract.ts";
import {
  organizationDescribeResponseSchema,
  organizationQueryResponseSchema,
} from "./organization-workspace.ts";
import { organizationContextFilterSchema } from "./organization-contexts.ts";

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeStringSchema = z.string().datetime({ offset: false });

export const mcpDescribeOrganizationInputSchema = z.object({
  accountId: nonEmptyStringSchema.optional(),
}).strict();
export type McpDescribeOrganizationInput = z.infer<typeof mcpDescribeOrganizationInputSchema>;

export const mcpDescribeOrganizationOutputSchema = organizationDescribeResponseSchema;
export type McpDescribeOrganizationOutput = z.infer<typeof mcpDescribeOrganizationOutputSchema>;

export const mcpQueryOrganizationInputSchema = z.object({
  accountId: nonEmptyStringSchema.optional(),
  threadId: nonEmptyStringSchema.optional(),
  attention: z.enum(["focus", "normal", "quiet", "hidden", "all"]).optional(),
  classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
  text: z.string().trim().max(200).optional(),
  sender: z.string().trim().max(320).optional(),
  receivedAfter: isoDateTimeStringSchema.optional(),
  receivedBefore: isoDateTimeStringSchema.optional(),
  contextFilters: z.array(organizationContextFilterSchema).min(1).max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.receivedAfter && value.receivedBefore && Date.parse(value.receivedAfter) > Date.parse(value.receivedBefore)) {
    context.addIssue({ code: "custom", path: ["receivedAfter"], message: "receivedAfter must not be later than receivedBefore" });
  }
});
export type McpQueryOrganizationInput = z.infer<typeof mcpQueryOrganizationInputSchema>;

export const mcpQueryOrganizationOutputSchema = organizationQueryResponseSchema;
export type McpQueryOrganizationOutput = z.infer<typeof mcpQueryOrganizationOutputSchema>;

const mcpHumanClassificationOverrideSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  target: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("message"), messageId: z.string() }).strict(),
    z.object({ scope: z.literal("sender_address"), address: z.string() }).strict(),
    z.object({ scope: z.literal("sender_domain"), domain: z.string() }).strict(),
  ]),
  classification: humanClassificationSchema,
  source: z.literal("user_choice"),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();

export const mcpHumanClassificationResultSchema = z.object({
  automatic: humanClassificationAssessmentSchema.nullable(),
  effective: humanClassificationAssessmentSchema.extend({
    source: humanClassificationSourceSchema,
    userOverride: mcpHumanClassificationOverrideSchema.nullable(),
  }).strict(),
  userOverride: mcpHumanClassificationOverrideSchema.nullable(),
}).strict();

export const mcpContentSafetySchema = z.object({
  contentTrust: z.literal("untrusted_external_content"),
  redactionsApplied: z.boolean(),
  truncatedFields: z.array(z.string()),
}).strict();

export const mcpSearchMailInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  accountId: nonEmptyStringSchema.optional(),
  sender: z.string().trim().max(320).optional(),
  receivedAfter: isoDateTimeStringSchema.optional(),
  receivedBefore: isoDateTimeStringSchema.optional(),
  attention: z.enum(["focus", "normal", "quiet", "hidden", "all"]).optional(),
  classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.receivedAfter && value.receivedBefore && Date.parse(value.receivedAfter) > Date.parse(value.receivedBefore)) {
    context.addIssue({ code: "custom", path: ["receivedAfter"], message: "receivedAfter must not be later than receivedBefore" });
  }
});
export type McpSearchMailInput = z.infer<typeof mcpSearchMailInputSchema>;

export const mcpMailMessageSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  provider: mailProviderSchema,
  threadId: nonEmptyStringSchema,
  from: mailContactSchema,
  subject: z.string(),
  snippet: z.string(),
  receivedAt: isoDateTimeStringSchema,
  unread: z.boolean(),
  labels: z.array(z.string()),
  attentionBehavior: attentionBehaviorSchema.nullable(),
  humanSignal: humanSignalScoreSchema,
  humanClassification: mcpHumanClassificationResultSchema.nullable(),
  sourceUrl: z.string().url(),
  safety: mcpContentSafetySchema,
}).strict();
export type McpMailMessage = z.infer<typeof mcpMailMessageSchema>;

export const mcpInboxCountsSchema = z.object({
  attention: z.object({
    focus: z.number().int().nonnegative(),
    normal: z.number().int().nonnegative(),
    quiet: z.number().int().nonnegative(),
    hidden: z.number().int().nonnegative(),
    all: z.number().int().nonnegative(),
  }).strict(),
  classification: z.object({
    likely_human: z.number().int().nonnegative(),
    automated_or_bulk: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
    unclassified: z.number().int().nonnegative(),
    all: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const mcpSearchMailOutputSchema = z.object({
  messages: z.array(mcpMailMessageSchema),
  counts: mcpInboxCountsSchema,
  nextCursor: z.string().nullable(),
}).strict();
export type McpSearchMailOutput = z.infer<typeof mcpSearchMailOutputSchema>;

export const mcpGetThreadInputSchema = z.object({
  accountId: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
}).strict();
export type McpGetThreadInput = z.infer<typeof mcpGetThreadInputSchema>;

export const mcpThreadMessageSchema = mcpMailMessageSchema.extend({
  to: z.array(mailContactSchema),
  cc: z.array(mailContactSchema),
  bodyExcerpt: z.string().nullable(),
}).strict();

export const mcpGetThreadOutputSchema = z.object({
  account: z.object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    email: z.string(),
    displayName: z.string(),
  }).strict(),
  thread: z.object({
    id: nonEmptyStringSchema,
    subject: z.string(),
    latestReceivedAt: isoDateTimeStringSchema,
    messageCount: z.number().int().nonnegative(),
    readState: z.enum(["read", "unread"]),
    sourceUrl: z.string().url(),
  }).strict(),
  messages: z.array(mcpThreadMessageSchema),
}).strict();
export type McpGetThreadOutput = z.infer<typeof mcpGetThreadOutputSchema>;

export const mcpListAgentEventsInputSchema = z.object({
  accountId: nonEmptyStringSchema.optional(),
  states: z.array(agentEventLifecycleStateSchema).max(7).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();
export type McpListAgentEventsInput = z.infer<typeof mcpListAgentEventsInputSchema>;

export const mcpAgentEventSchema = z.object({
  id: nonEmptyStringSchema,
  source: z.object({
    accountId: nonEmptyStringSchema,
    provider: mailProviderSchema,
    messageId: nonEmptyStringSchema,
    providerMessageId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    sender: mailContactSchema,
    subject: z.string(),
    receivedAt: isoDateTimeStringSchema,
    sourceUrl: z.string().url(),
  }).strict(),
  provenance: agentProvenanceSchema,
  eventKind: agentEventKindSchema,
  importance: agentImportanceSchema,
  relevance: agentRelevanceSchema,
  destination: agentPropagationDestinationSchema,
  reasonCodes: z.array(agentPropagationReasonCodeSchema),
  title: z.string(),
  summary: z.string(),
  whyThisMatters: z.string(),
  suggestedNextStep: z.string().nullable(),
  humanClassification: agentHumanClassificationSnapshotSchema.nullable(),
  evaluatedAt: isoDateTimeStringSchema,
  lifecycle: agentEventLifecycleSchema,
  safety: mcpContentSafetySchema,
}).strict();

export const mcpListAgentEventsOutputSchema = z.object({
  events: z.array(mcpAgentEventSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type McpListAgentEventsOutput = z.infer<typeof mcpListAgentEventsOutputSchema>;

export const mcpGetConnectionStatusInputSchema = z.object({
  accountId: nonEmptyStringSchema.optional(),
}).strict();
export type McpGetConnectionStatusInput = z.infer<typeof mcpGetConnectionStatusInputSchema>;

export const mcpGetConnectionStatusOutputSchema = z.object({
  accounts: z.array(z.object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    email: z.string(),
    displayName: z.string(),
    connectedForRead: z.boolean(),
    agentAccess: z.literal("read_only"),
    syncState: syncStateSchema,
    ready: z.boolean(),
    lastSyncedAt: isoDateTimeStringSchema.nullable(),
  }).strict()),
}).strict();
export type McpGetConnectionStatusOutput = z.infer<typeof mcpGetConnectionStatusOutputSchema>;

export const mcpToolErrorCodeSchema = z.enum([
  "account_denied",
  "integration_disabled",
  "invalid_cursor",
  "invalid_token",
  "not_found",
  "unauthorized",
  "insufficient_scope",
  "internal_error",
]);
export type McpToolErrorCode = z.infer<typeof mcpToolErrorCodeSchema>;

export const mcpToolErrorSchema = z.object({
  error: z.object({
    code: mcpToolErrorCodeSchema,
    message: z.string(),
  }).strict(),
}).strict();
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;
