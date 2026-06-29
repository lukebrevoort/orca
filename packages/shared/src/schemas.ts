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

const providerPageFields = {
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
} as const;

export const providerPageShapeSchema = z.object(providerPageFields).strict();

export function createProviderPageSchema<TSchema extends z.ZodType>(itemSchema: TSchema) {
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

export const meResponseSchema = mailAccountSchema;
export type MeResponse = z.infer<typeof meResponseSchema>;

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
