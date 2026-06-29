export { accountFixture, inboxFixture } from "./fixtures";
export {
  createProviderPageSchema,
  inboxMessagePageSchema,
  inboxMessageSchema,
  mailAccountSchema,
  mailContactSchema,
  mailProviderSchema,
  normalizedLabelPageSchema,
  normalizedLabelSchema,
  normalizedMessagePageSchema,
  normalizedMessageRawSchema,
  normalizedMessageSchema,
  normalizedThreadPageSchema,
  normalizedThreadSchema,
} from "./schemas";

export type {
  InboxMessage,
  MailAccount,
  MailContact,
  MailProvider,
  MailProviderClient,
  NormalizedLabel,
  NormalizedMessage,
  NormalizedMessageRaw,
  NormalizedThread,
  ProviderPage,
} from "./schemas";
