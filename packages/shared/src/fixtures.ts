import { z } from "zod";
import {
  authSessionSchema,
  humanClassificationAssessmentSchema,
  humanClassificationOverrideSchema,
  inboxMessageSchema,
  mailAccountSchema,
  normalizedMessageSchema,
} from "./schemas.ts";
import type {
  HumanClassification,
  HumanClassificationAssessment,
  HumanClassificationEvidence,
  HumanClassificationReasonCode,
  InboxMessage,
  MailContact,
  NormalizedMessage,
} from "./schemas.ts";

export const accountFixture = mailAccountSchema.parse({
  id: "acct_local_gmail",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
  capabilities: { read: true, draft: false, send: false },
});

export const authSessionFixture = authSessionSchema.parse({
  isAuthenticated: true,
  user: {
    id: "user_local_luke",
    email: accountFixture.email,
    name: accountFixture.displayName,
  },
  expiresAt: null,
  onboardingCompletedAt: null,
});

export const inboxFixture = z.array(inboxMessageSchema).parse([
  {
    id: "msg_local_1",
    accountId: accountFixture.id,
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
    attentionBehavior: "normal",
    humanSignal: 9,
    humanClassification: {
      automatic: {
        classification: "likely_human",
        score: 9,
        reasonCodes: ["direct_recipient"],
        classifierVersion: "m5-v1",
      },
      effective: {
        classification: "likely_human",
        score: 9,
        reasonCodes: ["direct_recipient"],
        classifierVersion: "m5-v1",
        source: "automatic_heuristic",
        userOverride: null,
      },
      userOverride: null,
    },
  },
]);

/**
 * M5's provider-neutral demo matrix. The cases deliberately use the same
 * normalized shape for Gmail and Outlook so classifier and API tests cannot
 * accidentally depend on a provider-specific field.
 */
export const m5FixtureAccounts = z.array(mailAccountSchema).parse([
  {
    id: "acct_m5_gmail",
    provider: "gmail",
    email: "luke@gmail.com",
    displayName: "Luke Gmail",
    capabilities: { read: true, draft: false, send: false },
  },
  {
    id: "acct_m5_outlook",
    provider: "outlook",
    email: "luke@outlook.com",
    displayName: "Luke Outlook",
    capabilities: { read: true, draft: false, send: false },
  },
]);

const m5AccountEmail: Record<string, string> = Object.fromEntries(
  m5FixtureAccounts.map((account) => [account.id, account.email]),
);

function m5Evidence(input: {
  sender: MailContact;
  recipients: MailContact[];
  recipientRelationship: HumanClassificationEvidence["recipientRelationship"];
  reply?: HumanClassificationEvidence["reply"];
  headerSignals?: HumanClassificationEvidence["headerSignals"];
  providerSignals?: HumanClassificationEvidence["providerSignals"];
}): HumanClassificationEvidence {
  return {
    sender: input.sender,
    recipients: input.recipients,
    recipientRelationship: input.recipientRelationship,
    reply: input.reply ?? { hasInReplyTo: false, referenceCount: 0 },
    headerSignals: input.headerSignals ?? [],
    providerSignals: input.providerSignals ?? [],
  };
}

function m5NormalizedMessage(input: {
  id: string;
  accountId: string;
  provider: "gmail" | "outlook";
  providerMessageId: string;
  threadId: string;
  providerThreadId: string;
  from: MailContact;
  to: MailContact[];
  subject: string;
  snippet: string;
  receivedAt: string;
  labels: string[];
  classificationEvidence: HumanClassificationEvidence;
  unread?: boolean;
}): NormalizedMessage {
  return normalizedMessageSchema.parse({
    id: input.id,
    accountId: input.accountId,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    threadId: input.threadId,
    from: input.from,
    to: input.to,
    cc: [],
    bcc: [],
    subject: input.subject,
    snippet: input.snippet,
    receivedAt: input.receivedAt,
    unread: input.unread ?? false,
    labels: input.labels,
    bodyText: input.snippet,
    bodyHtml: null,
    internetMessageId: `<${input.providerMessageId}@m5.example>`,
    references: input.classificationEvidence.reply.referenceCount > 0 ? ["<previous@m5.example>"] : [],
    classificationEvidence: input.classificationEvidence,
    raw: {
      provider: input.provider,
      accountId: input.accountId,
      messageId: input.providerMessageId,
      threadId: input.providerThreadId,
      labelIds: input.labels,
    },
  });
}

const gmailAccountId = "acct_m5_gmail";
const outlookAccountId = "acct_m5_outlook";
const lukeGmail: MailContact = { name: "Luke Gmail", email: m5AccountEmail[gmailAccountId]! };
const lukeOutlook: MailContact = { name: "Luke Outlook", email: m5AccountEmail[outlookAccountId]! };

export const m5NormalizedFixtureMessages = [
  m5NormalizedMessage({
    id: "m5_gmail_human",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-human",
    threadId: "gmail:acct_m5_gmail:human-thread",
    providerThreadId: "human-thread",
    from: { name: "Maya Chen", email: "maya@m5.example" },
    to: [lukeGmail],
    subject: "A note from Maya",
    snippet: "Can you review the new inbox notes when you have a minute?",
    receivedAt: "2026-08-10T09:00:00.000Z",
    labels: ["INBOX"],
    unread: true,
    classificationEvidence: m5Evidence({
      sender: { name: "Maya Chen", email: "maya@m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_reply",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-reply",
    threadId: "gmail:acct_m5_gmail:human-thread",
    providerThreadId: "human-thread",
    from: { name: "Maya Chen", email: "maya@m5.example" },
    to: [lukeGmail],
    subject: "Re: A note from Maya",
    snippet: "I added the examples and left the original thread intact.",
    receivedAt: "2026-08-10T10:00:00.000Z",
    labels: ["INBOX"],
    classificationEvidence: m5Evidence({
      sender: { name: "Maya Chen", email: "maya@m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
      reply: { hasInReplyTo: true, referenceCount: 1 },
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_transactional",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-transactional",
    threadId: "gmail:acct_m5_gmail:transactional-thread",
    providerThreadId: "transactional-thread",
    from: { name: "Harbor Billing", email: "no-reply@billing.m5.example" },
    to: [lukeGmail],
    subject: "Your receipt is ready",
    snippet: "Your receipt is available in the billing portal.",
    receivedAt: "2026-08-10T08:30:00.000Z",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    classificationEvidence: m5Evidence({
      sender: { name: "Harbor Billing", email: "no-reply@billing.m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
      providerSignals: ["transactional_category"],
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_newsletter",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-newsletter",
    threadId: "gmail:acct_m5_gmail:newsletter-thread",
    providerThreadId: "newsletter-thread",
    from: { name: "The Weekly List", email: "digest@weekly.m5.example" },
    to: [lukeGmail],
    subject: "This week in product",
    snippet: "Five links from the product community.",
    receivedAt: "2026-08-10T07:30:00.000Z",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    classificationEvidence: m5Evidence({
      sender: { name: "The Weekly List", email: "digest@weekly.m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "not_direct",
      headerSignals: ["list_id", "list_unsubscribe"],
      providerSignals: ["promotions_label"],
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_ambiguous",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-ambiguous",
    threadId: "gmail:acct_m5_gmail:review-thread",
    providerThreadId: "review-thread",
    from: { name: "Community Reply", email: "community@m5.example" },
    to: [lukeGmail],
    subject: "Re: Community discussion",
    snippet: "A personal reply arrived with list headers still attached.",
    receivedAt: "2026-08-10T07:00:00.000Z",
    labels: ["INBOX"],
    classificationEvidence: m5Evidence({
      sender: { name: "Community Reply", email: "community@m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
      reply: { hasInReplyTo: true, referenceCount: 1 },
      headerSignals: ["list_id"],
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_mixed_bulk",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-mixed-bulk",
    threadId: "gmail:acct_m5_gmail:mixed-thread",
    providerThreadId: "mixed-thread",
    from: { name: "Events Digest", email: "digest@events.m5.example" },
    to: [lukeGmail],
    subject: "Re: Team offsite",
    snippet: "An automated digest was appended to the planning thread.",
    receivedAt: "2026-08-10T06:30:00.000Z",
    labels: ["INBOX"],
    classificationEvidence: m5Evidence({
      sender: { name: "Events Digest", email: "digest@events.m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "not_direct",
      headerSignals: ["list_id"],
      providerSignals: ["bulk_or_marketing_label"],
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_mixed_human",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-mixed-human",
    threadId: "gmail:acct_m5_gmail:mixed-thread",
    providerThreadId: "mixed-thread",
    from: { name: "Jordan Bell", email: "jordan@m5.example" },
    to: [lukeGmail],
    subject: "Re: Team offsite",
    snippet: "Thursday afternoon works for me. I will bring the venue notes.",
    receivedAt: "2026-08-10T06:45:00.000Z",
    labels: ["INBOX"],
    unread: true,
    classificationEvidence: m5Evidence({
      sender: { name: "Jordan Bell", email: "jordan@m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
      reply: { hasInReplyTo: true, referenceCount: 1 },
    }),
  }),
  m5NormalizedMessage({
    id: "m5_gmail_override",
    accountId: gmailAccountId,
    provider: "gmail",
    providerMessageId: "gmail-m5-override",
    threadId: "gmail:acct_m5_gmail:override-thread",
    providerThreadId: "override-thread",
    from: { name: "Account Alerts", email: "no-reply@alerts.m5.example" },
    to: [lukeGmail],
    subject: "Account alert",
    snippet: "This automated sender is intentionally kept in Human Inbox for review.",
    receivedAt: "2026-08-10T06:00:00.000Z",
    labels: ["INBOX", "CATEGORY_UPDATES"],
    classificationEvidence: m5Evidence({
      sender: { name: "Account Alerts", email: "no-reply@alerts.m5.example" },
      recipients: [lukeGmail],
      recipientRelationship: "direct",
      providerSignals: ["transactional_category"],
    }),
  }),
  m5NormalizedMessage({
    id: "m5_outlook_human",
    accountId: outlookAccountId,
    provider: "outlook",
    providerMessageId: "outlook-m5-human",
    threadId: "outlook:acct_m5_outlook:human-thread",
    providerThreadId: "human-thread",
    from: { name: "Ada Lovelace", email: "ada@m5.example" },
    to: [lukeOutlook],
    subject: "A note from Ada",
    snippet: "The Outlook-normalized path keeps the same direct-reply evidence.",
    receivedAt: "2026-08-10T05:30:00.000Z",
    labels: ["Focused"],
    classificationEvidence: m5Evidence({
      sender: { name: "Ada Lovelace", email: "ada@m5.example" },
      recipients: [lukeOutlook],
      recipientRelationship: "direct",
    }),
  }),
  m5NormalizedMessage({
    id: "m5_outlook_unknown",
    accountId: outlookAccountId,
    provider: "outlook",
    providerMessageId: "outlook-m5-unknown",
    threadId: "outlook:acct_m5_outlook:unknown-thread",
    providerThreadId: "unknown-thread",
    from: { name: null, email: "unknown@m5.example" },
    to: [],
    subject: "Legacy message without recipients",
    snippet: "The cached row has no usable recipient or provider evidence.",
    receivedAt: "2026-08-10T05:00:00.000Z",
    labels: ["Archive"],
    classificationEvidence: m5Evidence({
      sender: { name: null, email: "unknown@m5.example" },
      recipients: [],
      recipientRelationship: "unknown",
    }),
  }),
] satisfies NormalizedMessage[];

function m5Assessment(
  classification: HumanClassification,
  score: number | null,
  reasonCodes: HumanClassificationReasonCode[],
): HumanClassificationAssessment {
  return humanClassificationAssessmentSchema.parse({
    classification,
    score,
    reasonCodes,
    classifierVersion: "m5-v1",
  });
}

export const m5FixtureExpectedClassifications: Record<string, HumanClassificationAssessment> = {
  m5_gmail_human: m5Assessment("likely_human", 7, ["direct_recipient"]),
  m5_gmail_reply: m5Assessment("likely_human", 9, ["direct_recipient", "reply_context"]),
  m5_gmail_transactional: m5Assessment("automated_or_bulk", 0, ["direct_recipient", "sender_no_reply_pattern", "provider_transactional_signal"]),
  m5_gmail_newsletter: m5Assessment("automated_or_bulk", 0, ["list_id_header", "list_unsubscribe_header", "provider_promotions_signal"]),
  m5_gmail_ambiguous: m5Assessment("uncertain", 6, ["direct_recipient", "reply_context", "list_id_header", "conflicting_evidence"]),
  m5_gmail_mixed_bulk: m5Assessment("automated_or_bulk", 0, ["list_id_header", "provider_bulk_signal"]),
  m5_gmail_mixed_human: m5Assessment("likely_human", 9, ["direct_recipient", "reply_context"]),
  m5_gmail_override: m5Assessment("automated_or_bulk", 0, ["direct_recipient", "sender_no_reply_pattern", "provider_transactional_signal"]),
  m5_outlook_human: m5Assessment("likely_human", 7, ["direct_recipient"]),
  m5_outlook_unknown: m5Assessment("unclassified", null, ["insufficient_evidence"]),
};

export const m5FixtureOverride = humanClassificationOverrideSchema.parse({
  id: "m5-override-account-alerts",
  accountId: gmailAccountId,
  target: { scope: "message", messageId: "m5_gmail_override" },
  classification: "likely_human",
  source: "user_choice",
  createdAt: "2026-08-10T06:05:00.000Z",
  updatedAt: "2026-08-10T06:05:00.000Z",
});

const m5FixtureOverrideMessageId = m5FixtureOverride.target.scope === "message"
  ? m5FixtureOverride.target.messageId
  : null;

function inboxMessageFromM5Fixture(message: NormalizedMessage): InboxMessage {
  const automatic = m5FixtureExpectedClassifications[message.id];
  if (!automatic) throw new Error(`Missing M5 classification for ${message.id}`);
  const overridden = message.id === m5FixtureOverrideMessageId;
  const effective = overridden
    ? m5Assessment("likely_human", null, ["user_message_override"])
    : automatic;

  return inboxMessageSchema.parse({
    id: message.id,
    accountId: message.accountId,
    provider: message.provider,
    providerMessageId: message.providerMessageId,
    threadId: message.threadId,
    from: message.from,
    subject: message.subject,
    snippet: message.snippet,
    receivedAt: message.receivedAt,
    unread: message.unread,
    labels: message.labels,
    attentionBehavior: "normal",
    humanSignal: effective.score,
    humanClassification: {
      automatic,
      effective: {
        ...effective,
        classifierVersion: overridden ? null : effective.classifierVersion,
        source: overridden ? "user_override" : "automatic_heuristic",
        userOverride: overridden ? m5FixtureOverride : null,
      },
      userOverride: overridden ? m5FixtureOverride : null,
    },
  });
}

export const m5InboxFixture = z.array(inboxMessageSchema).parse(
  m5NormalizedFixtureMessages.map(inboxMessageFromM5Fixture),
);
