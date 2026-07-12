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

export const mailAccountSchema = z
  .object({
    id: nonEmptyStringSchema,
    provider: mailProviderSchema,
    email: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
  })
  .strict();
export type MailAccount = z.infer<typeof mailAccountSchema>;

export const meResponseSchema = mailAccountSchema;
export type MeResponse = z.infer<typeof meResponseSchema>;

export const syncStateSchema = z.enum(["idle", "syncing", "auth_needed", "error"]);
export type SyncState = z.infer<typeof syncStateSchema>;

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
    provider: mailProviderSchema,
    providerMessageId: nonEmptyStringSchema,
    threadId: nonEmptyStringSchema,
    from: mailContactSchema,
    subject: z.string(),
    snippet: z.string(),
    receivedAt: isoDateTimeStringSchema,
    unread: z.boolean(),
    labels: labelListSchema,
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
  .extend({
    to: z.array(mailContactSchema),
    cc: z.array(mailContactSchema),
    bcc: z.array(mailContactSchema),
    bodyText: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    raw: normalizedMessageRawSchema,
  })
  .strict();
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

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
  })
  .strict()
  .refine((session) => !session.isAuthenticated || session.user !== null, {
    message: "Authenticated sessions must include a user",
    path: ["user"],
  });
export type AuthSession = z.infer<typeof authSessionSchema>;

export const inboxQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
  })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

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

export const inboxResponseSchema = z
  .object({
    account: mailAccountSchema,
    messages: z.array(inboxMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export type MailProviderClient = {
  provider: MailProvider;
  listInboxMessages(cursor?: string | null): Promise<ProviderPage<NormalizedMessage>>;
};
