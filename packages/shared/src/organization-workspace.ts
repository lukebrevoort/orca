import { z } from "zod";

import {
  attentionBehaviorSchema,
  humanClassificationAssessmentSchema,
  humanClassificationSourceSchema,
  humanSignalScoreSchema,
  mailContactSchema,
  threadReadStateSchema,
} from "./schemas.ts";

const nonEmptyStringSchema = z.string().trim().min(1);
const uniqueStringsSchema = z.array(nonEmptyStringSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Account IDs must be unique" });
  }
});
const organizationClassificationOverrideSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  target: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("message"), messageId: nonEmptyStringSchema }).strict(),
    z.object({ scope: z.literal("sender_address"), address: nonEmptyStringSchema }).strict(),
    z.object({ scope: z.literal("sender_domain"), domain: nonEmptyStringSchema }).strict(),
  ]),
  classification: z.enum(["likely_human", "automated_or_bulk", "uncertain", "unclassified"]),
  source: z.literal("user_choice"),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const organizationReadScopeSchema = z.object({
  actor: z.object({
    id: nonEmptyStringSchema,
    type: z.enum(["human", "agent", "system"]),
  }).strict(),
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
}).strict();
export type OrganizationReadScope = z.infer<typeof organizationReadScopeSchema>;

export const workspaceSchemaSchema = z.object({
  revision: z.literal(1),
  aggregate: z.literal("thread"),
  resources: z.tuple([z.literal("account"), z.literal("thread")]),
  filters: z.tuple([
    z.literal("account"),
    z.literal("thread"),
    z.literal("attention"),
    z.literal("classification"),
    z.literal("sender"),
    z.literal("text"),
    z.literal("received_at"),
  ]),
}).strict();
export type WorkspaceSchema = z.infer<typeof workspaceSchemaSchema>;

export const organizationCapabilitiesSchema = z.object({
  operations: z.object({
    describe: z.literal(true),
    query: z.literal(true),
    simulate: z.literal(false),
    apply: z.literal(false),
    revert: z.literal(false),
  }).strict(),
  authority: z.object({
    sendMail: z.literal(false),
    deleteProviderMail: z.literal(false),
  }).strict(),
}).strict();
export type OrganizationCapabilities = z.infer<typeof organizationCapabilitiesSchema>;

export const organizationDescribeResponseSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
  workspaceSchema: workspaceSchemaSchema,
  capabilities: organizationCapabilitiesSchema,
}).strict();
export type OrganizationDescribeResponse = z.infer<typeof organizationDescribeResponseSchema>;

export const organizationQuerySchema = z.object({
  accountIds: uniqueStringsSchema.min(1).optional(),
  threadId: nonEmptyStringSchema.optional(),
  attention: z.enum(["focus", "normal", "quiet", "hidden", "all"]).optional(),
  classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
  text: z.string().trim().max(200).optional(),
  sender: z.string().trim().max(320).optional(),
  receivedAfter: z.string().datetime({ offset: false }).optional(),
  receivedBefore: z.string().datetime({ offset: false }).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.receivedAfter && value.receivedBefore && Date.parse(value.receivedAfter) > Date.parse(value.receivedBefore)) {
    context.addIssue({ code: "custom", path: ["receivedAfter"], message: "receivedAfter must not be later than receivedBefore" });
  }
});
export type OrganizationQuery = z.infer<typeof organizationQuerySchema>;

export const workspaceThreadMessageSchema = z.object({
  id: nonEmptyStringSchema,
  sourceId: nonEmptyStringSchema,
  from: mailContactSchema,
  subject: z.string(),
  snippet: z.string(),
  receivedAt: z.string().datetime({ offset: false }),
  unread: z.boolean(),
  labels: z.array(z.string()),
  humanSignal: humanSignalScoreSchema,
  humanClassification: z.object({
    automatic: humanClassificationAssessmentSchema.nullable(),
    effective: humanClassificationAssessmentSchema.extend({
      source: humanClassificationSourceSchema,
      userOverride: organizationClassificationOverrideSchema.nullable(),
    }).strict(),
    userOverride: organizationClassificationOverrideSchema.nullable(),
  }).strict().nullable(),
}).strict();
export type WorkspaceThreadMessage = z.infer<typeof workspaceThreadMessageSchema>;

export const workspaceThreadSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  subject: z.string(),
  latestReceivedAt: z.string().datetime({ offset: false }),
  messageCount: z.number().int().nonnegative(),
  readState: threadReadStateSchema,
  organization: z.object({
    attentionBehavior: attentionBehaviorSchema,
    humanSignal: humanSignalScoreSchema,
    humanClassification: z.object({
      automatic: humanClassificationAssessmentSchema.nullable(),
      effective: humanClassificationAssessmentSchema.extend({
        source: humanClassificationSourceSchema,
        userOverride: organizationClassificationOverrideSchema.nullable(),
      }).strict(),
      userOverride: organizationClassificationOverrideSchema.nullable(),
    }).strict().nullable(),
  }).strict(),
  messages: z.array(workspaceThreadMessageSchema),
}).strict();
export type WorkspaceThread = z.infer<typeof workspaceThreadSchema>;

export const organizationQueryResponseSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
  threads: z.array(workspaceThreadSchema),
  counts: z.object({
    threads: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  }).strict(),
  nextCursor: z.string().nullable(),
}).strict();
export type OrganizationQueryResponse = z.infer<typeof organizationQueryResponseSchema>;
