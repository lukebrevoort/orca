import { z } from "zod";

export const mailProviderSchema = z.enum(["gmail", "outlook"]);
export type MailProvider = z.infer<typeof mailProviderSchema>;

export const mailContactSchema = z.object({
  name: z.string().trim().min(1).nullable(),
  email: z.string().email(),
});
export type MailContact = z.infer<typeof mailContactSchema>;

export const mailAccountSchema = z.object({
  id: z.string().min(1),
  provider: mailProviderSchema,
  email: z.string().email(),
  displayName: z.string().trim().min(1),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

export const inboxMessageSchema = z.object({
  id: z.string().min(1),
  provider: mailProviderSchema,
  providerMessageId: z.string().min(1),
  threadId: z.string().min(1),
  from: mailContactSchema,
  subject: z.string(),
  snippet: z.string(),
  receivedAt: z.string().datetime(),
  unread: z.boolean(),
  labels: z.array(z.string()),
});
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

export const normalizedLabelSchema = z.object({
  id: z.string().min(1),
  provider: mailProviderSchema,
  providerLabelId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["system", "user"]),
});
export type NormalizedLabel = z.infer<typeof normalizedLabelSchema>;

export const normalizedThreadSchema = z.object({
  id: z.string().min(1),
  provider: mailProviderSchema,
  providerThreadId: z.string().min(1),
  subject: z.string(),
  latestReceivedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  labels: z.array(z.string()),
});
export type NormalizedThread = z.infer<typeof normalizedThreadSchema>;

export const normalizedMessageSchema = inboxMessageSchema.extend({
  to: z.array(mailContactSchema),
  cc: z.array(mailContactSchema),
  bcc: z.array(mailContactSchema),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  raw: z.object({
    provider: mailProviderSchema,
    accountId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    labelIds: z.array(z.string()),
  }),
});
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().trim().min(1).nullable(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const authSessionSchema = z
  .object({
    isAuthenticated: z.boolean(),
    user: authUserSchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
  })
  .refine((session) => !session.isAuthenticated || session.user !== null, {
    message: "Authenticated sessions must include a user",
    path: ["user"],
  });
export type AuthSession = z.infer<typeof authSessionSchema>;

export const inboxQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const inboxResponseSchema = z.object({
  account: mailAccountSchema,
  messages: z.array(inboxMessageSchema),
  nextCursor: z.string().trim().min(1).nullable(),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export const providerPageSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().trim().min(1).nullable(),
  });
export type ProviderPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type MailProviderClient = {
  provider: MailProvider;
  listInboxMessages(cursor?: string | null): Promise<ProviderPage<NormalizedMessage>>;
};

export const accountFixture = mailAccountSchema.parse({
  id: "acct_local_gmail",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
});

export const authSessionFixture = authSessionSchema.parse({
  isAuthenticated: true,
  user: {
    id: "user_local_luke",
    email: accountFixture.email,
    name: accountFixture.displayName,
  },
  expiresAt: null,
});

export const inboxFixture = z.array(inboxMessageSchema).parse([
  {
    id: "msg_local_1",
    provider: "gmail",
    providerMessageId: "gmail_msg_local_1",
    threadId: "thread_local_1",
    from: {
      name: "Maya Chen",
      email: "maya@example.com",
    },
    subject: "First Orca preview",
    snippet: "A quiet shell for human messages is ready for real inbox data.",
    receivedAt: "2026-06-28T17:30:00.000Z",
    unread: true,
    labels: ["INBOX"],
  },
]);
