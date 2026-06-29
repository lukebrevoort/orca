import { z } from "zod";

export const mailProviderSchema = z.enum(["gmail", "outlook"]);

export const mailContactSchema = z
  .object({
    name: z.string().nullable(),
    email: z.string(),
  })
  .strict();

export const mailAccountSchema = z
  .object({
    id: z.string(),
    provider: mailProviderSchema,
    email: z.string(),
    displayName: z.string(),
  })
  .strict();

export const inboxMessageSchema = z
  .object({
    id: z.string(),
    provider: mailProviderSchema,
    providerMessageId: z.string(),
    threadId: z.string(),
    from: mailContactSchema,
    subject: z.string(),
    snippet: z.string(),
    receivedAt: z.string(),
    unread: z.boolean(),
    labels: z.array(z.string()),
  })
  .strict();

export const normalizedLabelSchema = z
  .object({
    id: z.string(),
    provider: mailProviderSchema,
    providerLabelId: z.string(),
    name: z.string(),
    type: z.enum(["system", "user"]),
  })
  .strict();

export const normalizedMessageRawSchema = z
  .object({
    provider: mailProviderSchema,
    accountId: z.string(),
    messageId: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()),
  })
  .strict();

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

export const normalizedThreadSchema = z
  .object({
    id: z.string(),
    provider: mailProviderSchema,
    providerThreadId: z.string(),
    subject: z.string(),
    latestReceivedAt: z.string(),
    messageCount: z.number().int().nonnegative(),
    labels: z.array(z.string()),
  })
  .strict();

export function createProviderPageSchema<TItemSchema extends z.ZodTypeAny>(itemSchema: TItemSchema) {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

export const inboxMessagePageSchema = createProviderPageSchema(inboxMessageSchema);
export const normalizedMessagePageSchema = createProviderPageSchema(normalizedMessageSchema);
export const normalizedThreadPageSchema = createProviderPageSchema(normalizedThreadSchema);
export const normalizedLabelPageSchema = createProviderPageSchema(normalizedLabelSchema);

export type MailProvider = z.infer<typeof mailProviderSchema>;
export type MailContact = z.infer<typeof mailContactSchema>;
export type MailAccount = z.infer<typeof mailAccountSchema>;
export type InboxMessage = z.infer<typeof inboxMessageSchema>;
export type NormalizedLabel = z.infer<typeof normalizedLabelSchema>;
export type NormalizedMessageRaw = z.infer<typeof normalizedMessageRawSchema>;
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;
export type NormalizedThread = z.infer<typeof normalizedThreadSchema>;
export type ProviderPage<TItem> = {
  items: TItem[];
  nextCursor: string | null;
};

export type MailProviderClient = {
  provider: MailProvider;
  listInboxMessages(cursor?: string | null): Promise<ProviderPage<NormalizedMessage>>;
};
