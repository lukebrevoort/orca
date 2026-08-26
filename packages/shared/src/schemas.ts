import { z } from "zod";

const nonEmptyStringSchema = z.string().min(1);

const isoDateTimeStringSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
  {
    message: "Expected an ISO 8601 UTC timestamp",
  },
);

const labelListSchema = z.array(nonEmptyStringSchema);

export const mailProviderSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof mailProviderSchema>;

export const mailContactSchema = z
  .object({
    name: z.string().nullable(),
    email: z.string(),
  })
  .strict();
export type MailContact = z.infer<typeof mailContactSchema>;

export const mailCapabilitiesSchema = z.object({
  read: z.boolean(),
  draft: z.boolean(),
  send: z.boolean(),
}).strict();
export type MailCapabilities = z.infer<typeof mailCapabilitiesSchema>;

export const mailAccountSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    email: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
    avatarUrl: z.string().nullable().optional(),
    capabilities: mailCapabilitiesSchema,
  })
  .strict();
export type MailAccount = z.infer<typeof mailAccountSchema>;

export const meResponseSchema = mailAccountSchema;
export type MeResponse = z.infer<typeof meResponseSchema>;

export const userPreferencesSchema = z.object({
  signature: z.string().max(10_000),
  composeFormat: z.enum(["plain", "rich"]),
  replyBehavior: z.enum(["reply", "reply_all"]),
  notifyByDefault: z.boolean(),
}).strict();
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const updateUserPreferencesSchema = userPreferencesSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Expected at least one preference" },
);
export type UpdateUserPreferences = z.infer<typeof updateUserPreferencesSchema>;

export const syncStateSchema = z.enum(["idle", "syncing", "auth_needed", "error"]);
export type SyncState = z.infer<typeof syncStateSchema>;

/**
 * Human Signal is an explainable, bounded estimate. It is deliberately not an
 * authorship detector or a statement that a message is safe to act on.
 */
export const humanSignalScoreSchema = z.number().int().min(0).max(10).nullable();
export type HumanSignalScore = z.infer<typeof humanSignalScoreSchema>;

export const humanClassificationSchema = z.enum([
  "likely_human",
  "automated_or_bulk",
  "uncertain",
  "unclassified",
]);
export type HumanClassification = z.infer<typeof humanClassificationSchema>;

export const humanClassificationSourceSchema = z.enum([
  "automatic_heuristic",
  "user_override",
]);
export type HumanClassificationSource = z.infer<typeof humanClassificationSourceSchema>;

export const humanClassificationOverrideScopeSchema = z.enum([
  "message",
  "sender_address",
  "sender_domain",
]);
export type HumanClassificationOverrideScope = z.infer<typeof humanClassificationOverrideScopeSchema>;

/**
 * These codes describe evidence, not an assertion about who authored a
 * message. Keep them stable: clients can render the codes as user-safe copy.
 */
export const humanClassificationReasonCodeSchema = z.enum([
  "sender_no_reply_pattern",
  "list_id_header",
  "list_unsubscribe_header",
  "bulk_precedence_header",
  "auto_submitted_header",
  "provider_bulk_signal",
  "provider_promotions_signal",
  "provider_transactional_signal",
  "reply_context",
  "direct_recipient",
  "conflicting_evidence",
  "insufficient_evidence",
  "user_message_override",
  "user_sender_address_override",
  "user_sender_domain_override",
]);
export type HumanClassificationReasonCode = z.infer<typeof humanClassificationReasonCodeSchema>;

export const humanClassificationAssessmentSchema = z.object({
  classification: humanClassificationSchema,
  score: humanSignalScoreSchema,
  reasonCodes: z.array(humanClassificationReasonCodeSchema).max(12),
  classifierVersion: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type HumanClassificationAssessment = z.infer<typeof humanClassificationAssessmentSchema>;

const humanClassificationOverrideValueSchema = z.string().trim().min(1).max(320);
const humanClassificationMessageIdSchema = z.string().trim().min(1).max(512);

export const humanClassificationOverrideTargetSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("message"),
    messageId: humanClassificationMessageIdSchema,
  }).strict(),
  z.object({
    scope: z.literal("sender_address"),
    address: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  }).strict(),
  z.object({
    scope: z.literal("sender_domain"),
    domain: humanClassificationOverrideValueSchema.transform((value) => value.toLowerCase()),
  }).strict(),
]).superRefine((target, context) => {
  if (target.scope === "sender_domain" && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(target.domain)) {
    context.addIssue({ code: "custom", path: ["domain"], message: "Expected a domain name for sender-domain overrides" });
  }
});
export type HumanClassificationOverrideTarget = z.infer<typeof humanClassificationOverrideTargetSchema>;

/** Use this before comparing an existing rule target with a proposed one. */
export function normalizeHumanClassificationOverrideTarget(target: unknown): HumanClassificationOverrideTarget {
  return humanClassificationOverrideTargetSchema.parse(target);
}

export const humanClassificationOverrideSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  target: humanClassificationOverrideTargetSchema,
  classification: humanClassificationSchema,
  source: z.literal("user_choice"),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type HumanClassificationOverride = z.infer<typeof humanClassificationOverrideSchema>;

export const createHumanClassificationOverrideSchema = z.object({
  accountId: nonEmptyStringSchema,
  target: humanClassificationOverrideTargetSchema,
  classification: humanClassificationSchema,
}).strict();
export type CreateHumanClassificationOverride = z.infer<typeof createHumanClassificationOverrideSchema>;

export const updateHumanClassificationOverrideSchema = z.object({
  classification: humanClassificationSchema,
}).strict();
export type UpdateHumanClassificationOverride = z.infer<typeof updateHumanClassificationOverrideSchema>;

export const listHumanClassificationOverridesSchema = z.object({
  accountId: nonEmptyStringSchema,
}).strict();
export type ListHumanClassificationOverrides = z.infer<typeof listHumanClassificationOverridesSchema>;

export const deleteHumanClassificationOverrideSchema = listHumanClassificationOverridesSchema;
export type DeleteHumanClassificationOverride = z.infer<typeof deleteHumanClassificationOverrideSchema>;

export const resolveHumanClassificationSchema = z.object({
  accountId: nonEmptyStringSchema,
  messageId: humanClassificationMessageIdSchema,
}).strict();
export type ResolveHumanClassification = z.infer<typeof resolveHumanClassificationSchema>;

/**
 * The automatic assessment is retained when a person corrects Orca. The
 * effective assessment is the one surfaces should use for filtering and copy.
 */
export const humanClassificationResultSchema = z.object({
  automatic: humanClassificationAssessmentSchema.nullable(),
  effective: humanClassificationAssessmentSchema.extend({
    source: humanClassificationSourceSchema,
    userOverride: humanClassificationOverrideSchema.nullable().default(null),
  }).strict(),
  userOverride: humanClassificationOverrideSchema.nullable().default(null),
}).strict();
export type HumanClassificationResult = z.infer<typeof humanClassificationResultSchema>;

export const humanClassificationHeaderSignalSchema = z.enum([
  "list_id",
  "list_unsubscribe",
  "precedence_bulk",
  "precedence_list",
  "auto_submitted",
  "x_auto_response_suppress",
]);
export type HumanClassificationHeaderSignal = z.infer<typeof humanClassificationHeaderSignalSchema>;

export const humanClassificationProviderSignalSchema = z.enum([
  "bulk_or_marketing_label",
  "promotions_label",
  "transactional_category",
  "automated_category",
]);
export type HumanClassificationProviderSignal = z.infer<typeof humanClassificationProviderSignalSchema>;

/**
 * The provider adapters reduce raw headers, labels, and categories to this
 * provider-neutral evidence before the deterministic classifier sees them.
 */
export const humanClassificationEvidenceSchema = z.object({
  sender: mailContactSchema,
  recipients: z.array(mailContactSchema),
  recipientRelationship: z.enum(["direct", "not_direct", "unknown"]),
  reply: z.object({
    hasInReplyTo: z.boolean(),
    referenceCount: z.number().int().nonnegative(),
  }).strict(),
  headerSignals: z.array(humanClassificationHeaderSignalSchema),
  providerSignals: z.array(humanClassificationProviderSignalSchema),
}).strict();
export type HumanClassificationEvidence = z.infer<typeof humanClassificationEvidenceSchema>;

export const syncStatusSchema = z
  .object({
    accounts: z.array(
      mailAccountSchema.extend({
        state: syncStateSchema,
        lastSyncedAt: isoDateTimeStringSchema.nullable(),
        error: z.string().nullable(),
      }).strict(),
    ),
  })
  .strict();
export type SyncStatus = z.infer<typeof syncStatusSchema>;

export const inboxMessageSchema = z
  .object({
    id: nonEmptyStringSchema,
    accountId: nonEmptyStringSchema,
    provider: mailProviderSchema,
    providerMessageId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    from: mailContactSchema,
    subject: z.string(),
    snippet: z.string(),
    receivedAt: isoDateTimeStringSchema,
    unread: z.boolean(),
    labels: labelListSchema,
    attentionBehavior: z.enum(["notify", "focus", "normal", "quiet", "hidden"]),
    humanSignal: humanSignalScoreSchema,
    humanClassification: humanClassificationResultSchema.nullable().default(null),
  })
  .strict();
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

export const normalizedLabelSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    providerLabelId: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    type: z.enum(["system", "user"]),
  })
  .strict();
export type NormalizedLabel = z.infer<typeof normalizedLabelSchema>;

export const normalizedThreadSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    providerThreadId: nonEmptyStringSchema,
    subject: z.string(),
    latestReceivedAt: isoDateTimeStringSchema,
    messageCount: z.number().int().nonnegative(),
    labels: labelListSchema,
  })
  .strict();
export type NormalizedThread = z.infer<typeof normalizedThreadSchema>;

export const normalizedMessageRawSchema = z
  .object({
    provider: mailProviderSchema,
    accountId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    labelIds: labelListSchema,
  })
  .strict();
export type NormalizedMessageRaw = z.infer<typeof normalizedMessageRawSchema>;

export const normalizedMessageSchema = inboxMessageSchema
  .omit({ attentionBehavior: true, humanSignal: true, humanClassification: true })
  .extend({
    to: z.array(mailContactSchema),
    cc: z.array(mailContactSchema),
    bcc: z.array(mailContactSchema),
    bodyText: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    internetMessageId: z.string().nullable(),
    references: z.array(z.string()),
    classificationEvidence: humanClassificationEvidenceSchema.optional(),
    raw: normalizedMessageRawSchema,
  })
  .strict();
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

export const mailAttachmentSchema = z.object({
  id: nonEmptyStringSchema,
  filename: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema,
  size: z.number().int().nonnegative(),
}).strict();
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

const outboundRecipientSchema = z.object({
  name: z.string().trim().min(1).max(200).nullable(),
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
}).strict();
export type OutboundRecipient = z.infer<typeof outboundRecipientSchema>;

const outboundBodySchema = z.object({
  text: z.string().max(100_000),
  html: z.string().max(200_000).nullable(),
}).strict();
export type OutboundBody = z.infer<typeof outboundBodySchema>;

const outboundContextSchema = z.object({
  kind: z.enum(["reply", "reply_all", "forward"]),
  threadId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  providerMessageId: nonEmptyStringSchema,
  providerThreadId: nonEmptyStringSchema,
  inReplyTo: z.string().regex(/^<[^<>\s\r\n]+>$/).nullable(),
  references: z.array(z.string().regex(/^<[^<>\s\r\n]+>$/)).max(100),
}).strict();
export type OutboundContext = z.infer<typeof outboundContextSchema>;

export const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function canonicalBase64DecodedByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const isCanonicalCharacter = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!isCanonicalCharacter) return null;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  return (value.length / 4) * 3 - padding;
}

const outboundAttachmentSchema = z.object({
  id: nonEmptyStringSchema,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(255).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
  size: z.number().int().positive().max(MAX_OUTBOUND_ATTACHMENT_BYTES),
  contentBase64: z.string().max(36 * 1024 * 1024).nullable().default(null),
}).strict().superRefine((attachment, context) => {
  if (attachment.contentBase64 === null) return;
  const decodedBytes = canonicalBase64DecodedByteLength(attachment.contentBase64);
  if (decodedBytes === null) {
    context.addIssue({ code: "custom", path: ["contentBase64"], message: "Attachment content must be canonical Base64" });
    return;
  }
  if (decodedBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    context.addIssue({ code: "custom", path: ["contentBase64"], message: "Attachment exceeds the 25 MB delivery limit" });
  }
  if (decodedBytes !== attachment.size) {
    context.addIssue({ code: "custom", path: ["size"], message: "Attachment size must match its decoded content" });
  }
});
export type OutboundAttachment = z.infer<typeof outboundAttachmentSchema>;

const outboundContentShape = {
  to: z.array(outboundRecipientSchema).max(100).default([]),
  cc: z.array(outboundRecipientSchema).max(100).default([]),
  bcc: z.array(outboundRecipientSchema).max(100).default([]),
  subject: z.string().max(998).default(""),
  body: outboundBodySchema.optional(),
  context: outboundContextSchema.nullable().default(null),
  attachments: z.array(outboundAttachmentSchema).max(25).default([]),
};

function attachmentBytes(attachment: { size: number; contentBase64?: string | null }) {
  return attachment.contentBase64 === null || attachment.contentBase64 === undefined
    ? attachment.size
    : canonicalBase64DecodedByteLength(attachment.contentBase64) ?? attachment.size;
}

function addAttachmentLimitIssue(value: { attachments?: Array<{ size: number; contentBase64?: string | null }> }, context: z.RefinementCtx) {
  if ((value.attachments ?? []).reduce((total, attachment) => total + attachmentBytes(attachment), 0) > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Attachments exceed the 25 MB delivery limit" });
  }
}

const outboundContentSchema = z.object(outboundContentShape).strict();

export const draftDeliveryStatusSchema = z.enum(["draft", "queued", "sending", "sent", "rejected", "ambiguous"]);
export type DraftDeliveryStatus = z.infer<typeof draftDeliveryStatusSchema>;

export const draftProviderSyncStatusSchema = z.enum(["not_applicable", "pending", "synced", "failed"]);
export type DraftProviderSyncStatus = z.infer<typeof draftProviderSyncStatusSchema>;

export const outboundErrorCodeSchema = z.enum([
  "validation_error",
  "stale_draft",
  "missing_capability",
  "provider_rejected",
  "ambiguous_delivery",
  "attachment_limit",
]);
export type OutboundErrorCode = z.infer<typeof outboundErrorCodeSchema>;

export const outboundErrorSchema = z.object({
  code: outboundErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
}).strict();
export type OutboundError = z.infer<typeof outboundErrorSchema>;

export const messageDraftSchema = outboundContentSchema.extend({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  body: outboundBodySchema,
  revision: z.number().int().nonnegative(),
  deliveryStatus: draftDeliveryStatusSchema,
  providerSyncStatus: draftProviderSyncStatusSchema,
  providerSyncError: z.string().nullable(),
  providerDraftId: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict().superRefine(addAttachmentLimitIssue);
export type MessageDraft = z.infer<typeof messageDraftSchema>;

export const createMessageDraftSchema = outboundContentSchema.extend({
  body: outboundBodySchema.default({ text: "", html: null }),
}).strict().superRefine(addAttachmentLimitIssue);
export type CreateMessageDraft = z.infer<typeof createMessageDraftSchema>;

export const updateMessageDraftSchema = z.object({
  revision: z.number().int().nonnegative(),
  to: z.array(outboundRecipientSchema).max(100).optional(),
  cc: z.array(outboundRecipientSchema).max(100).optional(),
  bcc: z.array(outboundRecipientSchema).max(100).optional(),
  subject: z.string().max(998).optional(),
  body: outboundBodySchema.optional(),
  context: outboundContextSchema.nullable().optional(),
  attachments: z.array(outboundAttachmentSchema).max(25).optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length === 1) {
    context.addIssue({ code: "custom", message: "Expected at least one draft field to update" });
  }
  if (value.attachments && value.attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0) > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Attachments exceed the 25 MB delivery limit" });
  }
});
export type UpdateMessageDraft = z.infer<typeof updateMessageDraftSchema>;

export const sendMessageDraftSchema = z.object({
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(16).max(255),
}).strict();
export type SendMessageDraft = z.infer<typeof sendMessageDraftSchema>;

export const deliveryResultSchema = z.object({
  draftId: nonEmptyStringSchema,
  status: draftDeliveryStatusSchema,
  providerMessageId: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  error: outboundErrorSchema.nullable(),
}).strict();
export type DeliveryResult = z.infer<typeof deliveryResultSchema>;

export const threadReadStateSchema = z.enum(["read", "unread"]);
export type ThreadReadState = z.infer<typeof threadReadStateSchema>;

export const threadAttentionSchema = z.object({
  hasUnread: z.boolean(),
  hasStarred: z.boolean(),
  hasDraft: z.boolean(),
  // Legacy aggregate for the reader chrome only. Per-message classification is
  // authoritative and must never be inferred from this aggregate.
  humanSignal: humanSignalScoreSchema,
}).strict();
export type ThreadAttention = z.infer<typeof threadAttentionSchema>;

export const threadDetailMessageSchema = normalizedMessageSchema
  .omit({ threadId: true, raw: true })
  .extend({
    humanSignal: humanSignalScoreSchema,
    humanClassification: humanClassificationResultSchema.nullable().default(null),
    attachments: z.array(mailAttachmentSchema),
  })
  .strict();
export type ThreadDetailMessage = z.infer<typeof threadDetailMessageSchema>;

export const threadDetailSchema = z.object({
  account: mailAccountSchema,
  thread: normalizedThreadSchema.extend({
    participants: z.array(mailContactSchema),
    readState: threadReadStateSchema,
    attention: threadAttentionSchema,
  }).strict(),
  messages: z.array(threadDetailMessageSchema),
}).strict();
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const authUserSchema = z
  .object({
    id: nonEmptyStringSchema,
    email: nonEmptyStringSchema,
    name: z.string().nullable(),
  })
  .strict();
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z
  .object({
    isAuthenticated: z.boolean(),
    user: authUserSchema.nullable(),
    expiresAt: isoDateTimeStringSchema.nullable(),
    onboardingCompletedAt: isoDateTimeStringSchema.nullable().default(null),
  })
  .strict()
  .refine((session) => !session.isAuthenticated || session.user !== null, {
    message: "Authenticated sessions must include a user",
    path: ["user"],
  });
export type AuthSession = z.infer<typeof authSessionSchema>;

export const mcpOAuthScopes = ["mail:read", "agent_events:read"] as const;
export const mcpOAuthScopeSchema = z.enum(mcpOAuthScopes);
export type McpOAuthScope = z.infer<typeof mcpOAuthScopeSchema>;

export const mcpConnectionAccountSchema = z.object({
  id: nonEmptyStringSchema,
  email: nonEmptyStringSchema,
  provider: mailProviderSchema,
}).strict();
export type McpConnectionAccount = z.infer<typeof mcpConnectionAccountSchema>;

export const mcpConnectionSchema = z.object({
  id: nonEmptyStringSchema,
  clientName: nonEmptyStringSchema,
  scopes: z.array(mcpOAuthScopeSchema),
  accounts: z.array(mcpConnectionAccountSchema),
  createdAt: isoDateTimeStringSchema,
  lastUsedAt: isoDateTimeStringSchema.nullable(),
  revokedAt: isoDateTimeStringSchema.nullable(),
}).strict();
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

export const mcpConnectionPageSchema = z.object({
  items: z.array(mcpConnectionSchema),
}).strict();
export type McpConnectionPage = z.infer<typeof mcpConnectionPageSchema>;

export const inboxQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    view: z.enum(["focus", "normal", "quiet", "hidden", "all"]).optional(),
    // This is deliberately independent from `view`: attention answers where a
    // message belongs in a person's workflow, while classification answers how
    // Orca currently estimates the message was produced.
    classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const threadQuerySchema = z.object({ accountId: nonEmptyStringSchema }).strict();
export type ThreadQuery = z.infer<typeof threadQuerySchema>;

export const attentionBehaviorSchema = z.enum(["notify", "focus", "normal", "quiet", "hidden"]);
export type AttentionBehavior = z.infer<typeof attentionBehaviorSchema>;

export const senderRuleScopeSchema = z.enum(["address", "domain"]);
export type SenderRuleScope = z.infer<typeof senderRuleScopeSchema>;

export const senderRuleSourceSchema = z.enum(["user_choice", "imported_label", "suggestion_accepted"]);
export type SenderRuleSource = z.infer<typeof senderRuleSourceSchema>;

const senderRuleValueSchema = z.string().trim().min(1).max(320);

export const senderAttentionRuleSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  scope: senderRuleScopeSchema,
  value: senderRuleValueSchema,
  behavior: attentionBehaviorSchema,
  source: senderRuleSourceSchema,
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type SenderAttentionRule = z.infer<typeof senderAttentionRuleSchema>;

const senderAttentionRuleInputSchema = senderAttentionRuleSchema.pick({
  scope: true,
  value: true,
  behavior: true,
  source: true,
}).strict();

export const createSenderAttentionRuleSchema = senderAttentionRuleInputSchema.superRefine((rule, context) => {
  if (rule.scope === "address" && !z.string().email().safeParse(rule.value).success) {
    context.addIssue({ code: "custom", path: ["value"], message: "Expected an email address for address rules" });
  }
  if (rule.scope === "domain" && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(rule.value)) {
    context.addIssue({ code: "custom", path: ["value"], message: "Expected a domain name for domain rules" });
  }
});
export type CreateSenderAttentionRule = z.infer<typeof createSenderAttentionRuleSchema>;

export const updateSenderAttentionRuleSchema = senderAttentionRuleInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Expected at least one field to update",
);
export type UpdateSenderAttentionRule = z.infer<typeof updateSenderAttentionRuleSchema>;

export const resolveSenderAttentionSchema = z.object({
  address: z.string().trim().email().max(320),
}).strict();
export type ResolveSenderAttention = z.infer<typeof resolveSenderAttentionSchema>;

export const resolvedSenderAttentionSchema = z.object({
  behavior: attentionBehaviorSchema,
  rule: senderAttentionRuleSchema.nullable(),
}).strict();
export type ResolvedSenderAttention = z.infer<typeof resolvedSenderAttentionSchema>;

export const attentionViewSettingSchema = z.object({
  behavior: attentionBehaviorSchema,
  displayName: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().min(0).max(4),
}).strict();
export type AttentionViewSetting = z.infer<typeof attentionViewSettingSchema>;

export const updateAttentionViewSettingSchema = attentionViewSettingSchema.pick({
  displayName: true,
  icon: true,
  color: true,
  position: true,
}).partial().refine(
  (value) => Object.keys(value).length > 0,
  "Expected at least one field to update",
);
export type UpdateAttentionViewSetting = z.infer<typeof updateAttentionViewSettingSchema>;

export const collectionSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().nonnegative(),
  threadIds: z.array(nonEmptyStringSchema),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type Collection = z.infer<typeof collectionSchema>;

export const createCollectionSchema = collectionSchema.pick({ name: true, color: true }).partial({ color: true }).strict();
export type CreateCollection = z.infer<typeof createCollectionSchema>;

export const gmailLabelMigrationLabelSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  threadCount: z.number().int().nonnegative(),
  imported: z.boolean(),
}).strict();
export type GmailLabelMigrationLabel = z.infer<typeof gmailLabelMigrationLabelSchema>;

export const gmailLabelMigrationSchema = z.object({
  status: z.enum(["pending", "skipped", "completed"]),
  ready: z.boolean(),
  labels: z.array(gmailLabelMigrationLabelSchema),
  completedAt: isoDateTimeStringSchema.nullable(),
}).strict();
export type GmailLabelMigration = z.infer<typeof gmailLabelMigrationSchema>;

export const importGmailLabelsSchema = z.object({
  labelIds: z.array(nonEmptyStringSchema),
}).strict();
export type ImportGmailLabels = z.infer<typeof importGmailLabelsSchema>;

export const updateCollectionSchema = collectionSchema.pick({
  name: true,
  color: true,
  position: true,
}).partial().refine((value) => Object.keys(value).length > 0, "Expected at least one field to update");
export type UpdateCollection = z.infer<typeof updateCollectionSchema>;

export const pinKindSchema = z.enum(["sender", "thread", "view", "filter"]);
export type PinKind = z.infer<typeof pinKindSchema>;

export const pinIconSchema = z.enum(["person", "thread", "search", "grid", "star", "bolt", "heart", "bookmark"]);
export type PinIcon = z.infer<typeof pinIconSchema>;

export const pinColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/);

export const pinFilterSchema = z.object({
  mailbox: z.enum(["inbox", "focus", "quiet", "hidden", "all"]),
  attention: z.enum(["all", "notify", "focus", "normal"]),
  classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
  person: z.string().trim().max(500).nullable(),
  query: z.string().trim().max(200),
}).strict();
export type PinFilter = z.infer<typeof pinFilterSchema>;

export const pinSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  kind: pinKindSchema,
  targetId: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(120),
  icon: pinIconSchema,
  color: pinColorSchema,
  position: z.number().int().nonnegative(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type Pin = z.infer<typeof pinSchema>;

export const createPinSchema = pinSchema.pick({ kind: true, targetId: true, label: true }).extend({
  icon: pinIconSchema.optional(),
  color: pinColorSchema.optional(),
}).strict();
export type CreatePin = z.infer<typeof createPinSchema>;

export const updatePinSchema = pinSchema.pick({ label: true, icon: true, color: true, position: true }).partial()
  .refine((value) => Object.keys(value).length > 0, "Expected at least one field to update");
export type UpdatePin = z.infer<typeof updatePinSchema>;

export const reminderStatusSchema = z.enum(["scheduled", "resurfaced", "completed", "cancelled"]);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

export const reminderSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
  scheduledFor: isoDateTimeStringSchema,
  timezone: z.string().trim().min(1).max(100),
  notify: z.boolean(),
  status: reminderStatusSchema,
  resurfacedAt: isoDateTimeStringSchema.nullable(),
  completedAt: isoDateTimeStringSchema.nullable(),
  cancelledAt: isoDateTimeStringSchema.nullable(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema,
}).strict();
export type Reminder = z.infer<typeof reminderSchema>;

export const createReminderSchema = z.object({
  threadId: nonEmptyStringSchema,
  scheduledFor: isoDateTimeStringSchema,
  timezone: z.string().trim().min(1).max(100),
  notify: z.boolean().optional(),
}).strict();
export type CreateReminder = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = z.object({
  scheduledFor: isoDateTimeStringSchema.optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  notify: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one field to update");
export type UpdateReminder = z.infer<typeof updateReminderSchema>;

export const reminderViewSettingsSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
export type ReminderViewSettings = z.infer<typeof reminderViewSettingsSchema>;

const providerPageFields = {
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
} as const;

export const providerPageShapeSchema = z.object(providerPageFields).strict();

export function createProviderPageSchema<TSchema extends z.ZodTypeAny>(itemSchema: TSchema) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: providerPageFields.nextCursor,
    })
    .strict();
}

export type ProviderPage<TItem> = {
  items: TItem[];
  nextCursor: string | null;
};

export const mailAccountPageSchema = createProviderPageSchema(mailAccountSchema);
export type MailAccountPage = z.infer<typeof mailAccountPageSchema>;

export const inboxMessagePageSchema = createProviderPageSchema(inboxMessageSchema);
export type InboxMessagePage = z.infer<typeof inboxMessagePageSchema>;

export const normalizedMessagePageSchema = createProviderPageSchema(normalizedMessageSchema);
export type NormalizedMessagePage = z.infer<typeof normalizedMessagePageSchema>;

export const normalizedThreadPageSchema = createProviderPageSchema(normalizedThreadSchema);
export type NormalizedThreadPage = z.infer<typeof normalizedThreadPageSchema>;

export const normalizedLabelPageSchema = createProviderPageSchema(normalizedLabelSchema);
export type NormalizedLabelPage = z.infer<typeof normalizedLabelPageSchema>;

const inboxAttentionCountsSchema = z.object({
  focus: z.number().int().nonnegative(),
  normal: z.number().int().nonnegative(),
  quiet: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
}).strict();

const inboxClassificationCountsSchema = z.object({
  likely_human: z.number().int().nonnegative(),
  automated_or_bulk: z.number().int().nonnegative(),
  uncertain: z.number().int().nonnegative(),
  unclassified: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
}).strict();

const inboxResponseBaseSchema = z.object({
  accounts: z.array(mailAccountSchema),
  messages: z.array(inboxMessageSchema),
  nextCursor: z.string().nullable(),
}).strict();

/**
 * The legacy response remains valid when callers omit `classification`.
 * New clients opt into the richer count contract with classification=all (or
 * another classification view), so strict BRE-249 clients keep parsing old
 * responses during the rollout.
 */
export const inboxClassificationResponseSchema = inboxResponseBaseSchema.extend({
  counts: z.object({
    attention: inboxAttentionCountsSchema,
    classification: inboxClassificationCountsSchema,
  }).strict(),
}).strict();
export type InboxClassificationResponse = z.infer<typeof inboxClassificationResponseSchema>;

export const inboxResponseSchema = z.union([
  inboxResponseBaseSchema.extend({ counts: inboxAttentionCountsSchema }).strict(),
  inboxClassificationResponseSchema,
]);
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export type MailProviderClient = {
  provider: MailProvider;
  listInboxMessages(cursor?: string | null): Promise<ProviderPage<NormalizedMessage>>;
};
