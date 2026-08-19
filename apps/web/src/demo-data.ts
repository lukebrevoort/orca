import type { HumanClassification, HumanClassificationResult, InboxMessage, MailAccount } from "@orca/shared";

export const demoAccount: MailAccount = {
  id: "acct_demo",
  provider: "gmail",
  email: "luke@example.com",
  displayName: "Luke Brevoort",
  avatarUrl: "/profile-avatar.svg",
  capabilities: { read: true, draft: true, send: true },
};

function automaticClassification(
  classification: HumanClassification,
  score: number | null,
  reasonCodes: HumanClassificationResult["effective"]["reasonCodes"],
): HumanClassificationResult {
  const assessment = {
    classification,
    score,
    reasonCodes,
    classifierVersion: "m5-v1",
  } as const;
  return {
    automatic: assessment,
    effective: { ...assessment, source: "automatic_heuristic", userOverride: null },
    userOverride: null,
  };
}

function overriddenClassification(
  messageId: string,
  classification: HumanClassification,
  automatic: ReturnType<typeof automaticClassification>,
): HumanClassificationResult {
  const now = "2026-07-08T00:00:00.000Z";
  const override = {
    id: `classification-override:demo:${messageId}`,
    accountId: demoAccount.id,
    target: { scope: "message" as const, messageId },
    classification,
    source: "user_choice" as const,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...automatic,
    effective: {
      classification,
      score: null,
      reasonCodes: ["user_message_override"],
      classifierVersion: null,
      source: "user_override",
      userOverride: override,
    },
    userOverride: override,
  };
}

export const demoMessages: InboxMessage[] = [
  {
    id: "msg_1",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_1",
    threadId: "thread_1",
    from: { name: "Maya Chen", email: "maya@example.com" },
    subject: "Launch notes for Orca Mail",
    snippet: "Here are the launch notes — let me know what you think about the pinned people flow.",
    receivedAt: "2026-07-03T16:20:00.000Z",
    unread: true,
    labels: ["INBOX"],
    attentionBehavior: "focus",
    humanSignal: 9,
    humanClassification: automaticClassification("likely_human", 9, ["direct_recipient"]),
  },
  {
    id: "msg_1_reply",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_1_reply",
    threadId: "thread_1",
    from: { name: "Luke Brevoort", email: "luke@example.com" },
    subject: "Re: Launch notes for Orca Mail",
    snippet: "I like the pinned people direction. Let's keep the first version read-only.",
    receivedAt: "2026-07-03T17:12:00.000Z",
    unread: false,
    labels: ["SENT"],
    attentionBehavior: "normal",
    humanSignal: 10,
    humanClassification: automaticClassification("likely_human", 10, ["reply_context"]),
  },
  {
    id: "msg_2",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_2",
    threadId: "thread_2",
    from: { name: "Harbor Bank", email: "alerts@harborbank.example" },
    subject: "Your monthly statement is ready",
    snippet: "Your June statement is now available. No action is required.",
    receivedAt: "2026-07-02T11:05:00.000Z",
    unread: false,
    labels: ["INBOX"],
    attentionBehavior: "focus",
    humanSignal: 0,
    humanClassification: automaticClassification("automated_or_bulk", 2, ["provider_transactional_signal"]),
  },
  {
    id: "msg_3",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_3",
    threadId: "thread_3",
    from: { name: "Mom", email: "family@example.com" },
    subject: "Dinner on Sunday?",
    snippet: "Your sister is visiting. Can you make it over around six?",
    receivedAt: "2026-07-01T09:40:00.000Z",
    unread: true,
    labels: ["INBOX"],
    attentionBehavior: "notify",
    humanSignal: null,
    humanClassification: overriddenClassification("msg_3", "likely_human", automaticClassification("likely_human", 10, ["direct_recipient"])),
  },
  {
    id: "msg_4",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_4",
    threadId: "thread_4",
    from: { name: "Anika Lee", email: "anika@example.com" },
    subject: "Design direction",
    snippet: "Orca palette should stay monochrome — white or black with just a whisper of color.",
    receivedAt: "2026-06-30T18:15:00.000Z",
    unread: false,
    labels: ["INBOX"],
    attentionBehavior: "normal",
    humanSignal: 8,
    humanClassification: automaticClassification("uncertain", null, ["conflicting_evidence"]),
  },
  {
    id: "msg_5",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_5",
    threadId: "thread_5",
    from: { name: "Dana Brooks", email: "dana@example.com" },
    subject: "Sprint planning",
    snippet: "Maya mentioned you might join the inbox filtering discussion.",
    receivedAt: "2026-06-29T14:00:00.000Z",
    unread: false,
    labels: ["INBOX"],
    attentionBehavior: "quiet",
    humanSignal: 7,
    humanClassification: automaticClassification("likely_human", 7, ["direct_recipient"]),
  },
  {
    id: "msg_6",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_6",
    threadId: "thread_6",
    from: { name: "Product Dispatch", email: "digest@dispatch.example" },
    subject: "This week in product",
    snippet: "Seven stories from the product community, saved outside your default views.",
    receivedAt: "2026-06-28T08:30:00.000Z",
    unread: false,
    labels: ["INBOX"],
    attentionBehavior: "hidden",
    humanSignal: 9,
    humanClassification: automaticClassification("automated_or_bulk", 1, ["provider_bulk_signal", "list_id_header"]),
  },
  {
    id: "msg_7_mixed_automated",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_7_mixed_automated",
    threadId: "thread_7",
    from: { name: "Events Weekly", email: "digest@events.example" },
    subject: "Re: Team offsite planning",
    snippet: "A calendar digest was added to this conversation before the personal reply.",
    receivedAt: "2026-07-07T08:30:00.000Z",
    unread: false,
    labels: ["INBOX"],
    attentionBehavior: "normal",
    humanSignal: 2,
    humanClassification: automaticClassification("automated_or_bulk", 2, ["list_id_header"]),
  },
  {
    id: "msg_7_mixed_human",
    accountId: "acct_demo",
    provider: "gmail",
    providerMessageId: "gmail_7_mixed_human",
    threadId: "thread_7",
    from: { name: "Jordan Bell", email: "jordan@example.com" },
    subject: "Re: Team offsite planning",
    snippet: "I can make Thursday afternoon. I’ll bring the venue notes and a short agenda.",
    receivedAt: "2026-07-08T09:10:00.000Z",
    unread: true,
    labels: ["INBOX"],
    attentionBehavior: "focus",
    humanSignal: 8,
    humanClassification: automaticClassification("likely_human", 8, ["reply_context", "direct_recipient"]),
  },
];

export const demoThreadHistoryExtras: InboxMessage[] = [
  { id: "msg_1_followup", accountId: "acct_demo", provider: "gmail", providerMessageId: "gmail_1_followup", threadId: "thread_1", from: { name: "Maya Chen", email: "maya@example.com" }, subject: "Re: Launch notes for Orca Mail", snippet: "Exactly. I tightened the reader notes around quoted replies and metadata.", receivedAt: "2026-07-04T15:02:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "focus", humanSignal: 9, humanClassification: automaticClassification("likely_human", 9, ["reply_context"]) },
  { id: "msg_1_reply_2", accountId: "acct_demo", provider: "gmail", providerMessageId: "gmail_1_reply_2", threadId: "thread_1", from: { name: "Luke Brevoort", email: "luke@example.com" }, subject: "Re: Launch notes for Orca Mail", snippet: "The calmer metadata treatment works. Can we make long threads easier to scan?", receivedAt: "2026-07-05T18:44:00.000Z", unread: false, labels: ["SENT"], attentionBehavior: "normal", humanSignal: 10, humanClassification: automaticClassification("likely_human", 10, ["reply_context"]) },
  { id: "msg_1_unread", accountId: "acct_demo", provider: "gmail", providerMessageId: "gmail_1_unread", threadId: "thread_1", from: { name: "Maya Chen", email: "maya@example.com" }, subject: "Re: Launch notes for Orca Mail", snippet: "I grouped the history by day and kept every quoted reply recoverable.", receivedAt: "2026-07-06T16:20:00.000Z", unread: true, labels: ["INBOX"], attentionBehavior: "focus", humanSignal: 9, humanClassification: automaticClassification("likely_human", 9, ["reply_context"]) },
  { id: "msg_1_latest", accountId: "acct_demo", provider: "gmail", providerMessageId: "gmail_1_latest", threadId: "thread_1", from: { name: "Anika Lee", email: "anika@example.com" }, subject: "Re: Launch notes for Orca Mail", snippet: "One last pass: the unread boundary should be unmistakable in either theme.", receivedAt: "2026-07-07T19:08:00.000Z", unread: true, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 8, humanClassification: automaticClassification("likely_human", 8, ["reply_context"]) },
];

export const messageBodies: Record<string, string> = {
  msg_1:
    "Hey Luke,\n\nHere are the launch notes for Orca Mail. The big shift is treating pinned people as filters, not shortcuts into a single thread.\n\nLet me know what you think.\n\n— Maya",
  msg_1_reply:
    "I like the pinned people direction. Let's keep the first version read-only and make sure the thread view never assumes HTML is safe to render.\n\n— Luke",
  msg_1_followup:
    "Exactly. I tightened the reader notes around quoted replies and metadata.\n\nOn Jul 3, 2026, at 10:12 AM, Luke Brevoort wrote:\n> I like the pinned people direction.\n> Let's keep the first version read-only.",
  msg_1_reply_2:
    "The calmer metadata treatment works. Can we make long threads easier to scan?\n\nOn Jul 4, 2026, at 8:02 AM, Maya Chen wrote:\n> I tightened the reader notes around quoted replies and metadata.",
  msg_1_unread:
    "I grouped the history by day and kept every quoted reply recoverable. The newest relevant message is now one action away.\n\nOn Jul 5, 2026, at 11:44 AM, Luke Brevoort wrote:\n> Can we make long threads easier to scan?",
  msg_1_latest:
    "One last pass: the unread boundary should be unmistakable in either theme. The text label does the work; color is only reinforcement.\n\nOn Jul 6, 2026, at 9:20 AM, Maya Chen wrote:\n> I grouped the history by day.\n> Every quoted reply remains recoverable.",
  msg_2: "Your June statement is ready to view. No action is required; this automated notice is kept in focus because you chose it.\n\n— Harbor Bank",
  msg_3:
    "Your sister is visiting this weekend. Can you make it over for dinner around six on Sunday?\n\nLove, Mom",
  msg_4: "Keeping the palette orca-simple: black or white surfaces, one accent at most.\n\n— Anika",
  msg_5: "Adding you to the thread about inbox filtering — Maya had great notes.\n\n— Dana",
  msg_6: "Seven stories from the product community, collected in your weekly digest.\n\n— Product Dispatch",
  msg_7_mixed_automated: "This digest was automatically added to the planning conversation.\n\n— Events Weekly",
  msg_7_mixed_human: "I can make Thursday afternoon. I’ll bring the venue notes and a short agenda.\n\n— Jordan",
};

export const messageHtmlBodies: Record<string, string> = {
  msg_1: `<p>Hey Luke,</p><p>Here are the <strong>launch notes</strong> for Orca Mail. The big shift is treating pinned people as filters, not shortcuts into a single thread.</p><h2>What changed</h2><ul><li>People stay visible across conversations.</li><li>The reading surface keeps the message hierarchy intact.</li><li>Links remain useful without inheriting sender styling.</li></ul><p>Review the <a href="https://example.com/orca-reader" rel="noopener noreferrer" target="_blank">reader notes</a> when you have a minute.</p><p>Let me know what you think.</p><p>— Maya</p>`,
};

export function messageIncludesPerson(message: InboxMessage, personName: string) {
  const needle = personName.toLowerCase();
  const fromName = message.from.name?.toLowerCase() ?? "";
  const fromEmail = message.from.email.toLowerCase();
  const haystack = `${fromName} ${fromEmail} ${message.subject} ${message.snippet}`.toLowerCase();
  return fromName.includes(needle) || fromEmail.includes(needle) || haystack.includes(needle);
}
