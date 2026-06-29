export type MailProvider = "gmail" | "outlook";

export type MailContact = {
  name: string | null;
  email: string;
};

export type MailAccount = {
  id: string;
  provider: MailProvider;
  email: string;
  displayName: string;
};

export type InboxMessage = {
  id: string;
  provider: MailProvider;
  providerMessageId: string;
  threadId: string;
  from: MailContact;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  labels: string[];
};

export type NormalizedLabel = {
  id: string;
  provider: MailProvider;
  providerLabelId: string;
  name: string;
  type: "system" | "user";
};

export type NormalizedThread = {
  id: string;
  provider: MailProvider;
  providerThreadId: string;
  subject: string;
  latestReceivedAt: string;
  messageCount: number;
  labels: string[];
};

export type NormalizedMessage = InboxMessage & {
  to: MailContact[];
  cc: MailContact[];
  bcc: MailContact[];
  bodyText: string | null;
  bodyHtml: string | null;
  raw: {
    provider: MailProvider;
    accountId: string;
    messageId: string;
    threadId: string;
    labelIds: string[];
  };
};

export type ProviderPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type MailProviderClient = {
  provider: MailProvider;
  listInboxMessages(cursor?: string | null): Promise<ProviderPage<NormalizedMessage>>;
};

export const accountFixture: MailAccount = {
  id: "acct_local_gmail",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
};

export const inboxFixture: InboxMessage[] = [
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
];
