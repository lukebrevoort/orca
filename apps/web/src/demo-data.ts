import type { AgentPropagationAssessment, AgentPropagationMuteRule, HumanClassification, HumanClassificationResult, InboxMessage, MailAccount, PropagatedAgentEvent } from "@orca/shared";

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

const automatedAgentClassification = automaticClassification("automated_or_bulk", 1, ["auto_submitted_header", "provider_transactional_signal"]);

/** Source mail stays in All mail/Tideline even when Orca adds a signal to the default timeline. */
export const demoAgentMessages: InboxMessage[] = [
  { id: "msg_agent_release", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_release", threadId: "thread_agent_release", from: { name: "App Store Connect", email: "no_reply@email.apple.com" }, subject: "Orca 2.4 is ready to test", snippet: "Build 204 is now available to your TestFlight group.", receivedAt: "2026-08-19T15:45:00.000Z", unread: true, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_ci_initial", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_ci_initial", threadId: "thread_agent_ci", from: { name: "GitHub Actions", email: "notifications@github.com" }, subject: "Deploy failed on main", snippet: "The production deploy stopped during the migration check.", receivedAt: "2026-08-19T14:20:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_ci_followup", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_ci_followup", threadId: "thread_agent_ci", from: { name: "GitHub Actions", email: "notifications@github.com" }, subject: "Deploy failed again on main", snippet: "Retry 2 failed at the same migration check.", receivedAt: "2026-08-19T14:34:00.000Z", unread: true, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_security", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_security", threadId: "thread_agent_security", from: { name: "Harbor Security", email: "security@harbor.example" }, subject: "A new recovery key was added", snippet: "A recovery key was added from a new device.", receivedAt: "2026-08-19T13:05:00.000Z", unread: true, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_receipt", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_receipt", threadId: "thread_agent_receipt", from: { name: "Figma Billing", email: "receipts@figma.com" }, subject: "Your annual plan renews September 3", snippet: "Your workspace plan will renew for $144.", receivedAt: "2026-08-19T12:10:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_travel", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_travel", threadId: "thread_agent_travel", from: { name: "Northwind Air", email: "updates@northwind.example" }, subject: "Schedule note for DEN to SFO", snippet: "A routine gate reminder was mistaken for a meaningful itinerary change.", receivedAt: "2026-08-19T11:30:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
  { id: "msg_agent_newsletter", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_newsletter", threadId: "thread_agent_newsletter", from: { name: "Product Dispatch", email: "digest@dispatch.example" }, subject: "Seven product links for Wednesday", snippet: "A low-value newsletter stays in Tideline and creates no timeline signal.", receivedAt: "2026-08-19T10:00:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automaticClassification("automated_or_bulk", 1, ["list_id_header", "provider_bulk_signal"]) },
  { id: "msg_agent_muted", accountId: demoAccount.id, provider: "gmail", providerMessageId: "gmail_agent_muted", threadId: "thread_agent_muted", from: { name: "Routine Cloud", email: "alerts@routinecloud.example" }, subject: "Sign-in notice", snippet: "This sender was muted locally after repeated routine account notices.", receivedAt: "2026-08-19T09:15:00.000Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 1, humanClassification: automatedAgentClassification },
];

function demoAgentEvent(
  input: Pick<PropagatedAgentEvent, "id" | "eventKind" | "importance" | "reasonCodes" | "title" | "summary" | "whyThisMatters" | "suggestedNextStep"> & {
    message: InboxMessage;
    state?: PropagatedAgentEvent["lifecycle"]["state"];
    revision?: number;
    snoozedUntil?: string | null;
  },
): PropagatedAgentEvent {
  const updatedAt = input.message.receivedAt;
  const fixtureHashes: Record<string, string> = {
    event_demo_release: "2fa4585296b2ab2910991e6273a59c25f938ad6ca2d20d1c067ae43b7390e269",
    event_demo_ci: "b58e1365712f508232894052c8a3e730b4f0b626a5984783ba200bf4959e657f",
    event_demo_security: "d80aee7af10331ff41e254de9db3bd12790ebfd1f2f6a61fa8f9e73d0958d408",
    event_demo_receipt: "633531ec9eb299e04fcc64cb6eca212817e982f34cf9799fac51fdde2925ce9f",
    event_demo_false_positive: "f9e30c1d4b0c77a0c36fb46812d8a1cf6d20388afcca5ceb9faaffc31d5b41f5",
    event_demo_muted: "9cc341758da2971cf6c253debfb56f1e915a81763abccdf746697957954fbd98",
    suppressed_demo_newsletter: "8dc08c3dbd2832fd9eb8942061ec2f6edf462a7d72e3f4ff25e3ab17a8c61d2f",
  };
  return {
    id: input.id,
    source: {
      ownerUserId: "user_demo",
      accountId: input.message.accountId,
      provider: input.message.provider,
      messageId: input.message.id,
      providerMessageId: input.message.providerMessageId,
      threadId: input.message.threadId,
      sender: input.message.from,
      subject: input.message.subject,
      receivedAt: input.message.receivedAt,
      sourceUrl: `http://localhost:5173/dev/inbox?thread=${encodeURIComponent(input.message.threadId)}&accountId=${encodeURIComponent(input.message.accountId)}`,
    },
    provenance: { trigger: "sync", policyVersion: "m6-v0", agentId: "orca-deterministic-propagator", agentVersion: "0.1.0", executionMode: "deterministic" },
    eventKind: input.eventKind,
    importance: input.importance,
    relevance: "matched",
    destination: "timeline",
    reasonCodes: input.reasonCodes,
    title: input.title,
    summary: input.summary,
    whyThisMatters: input.whyThisMatters,
    suggestedNextStep: input.suggestedNextStep,
    humanClassification: { classification: "automated_or_bulk", score: 1, reasonCodes: ["auto_submitted_header", "provider_transactional_signal"], classifierVersion: "m5-v1", source: "automatic_heuristic" },
    deduplicationKey: `sha256:${fixtureHashes[input.id]!}`,
    evaluatedAt: updatedAt,
    lifecycle: {
      state: input.state ?? "new",
      lastTransition: input.state === "seen" ? "seen" : input.state === "dismissed" ? "dismissed" : input.state === "snoozed" ? "snoozed" : input.state === "muted" ? "muted" : input.state === "false_positive" ? "false_positive" : input.state === "retracted" ? "retracted" : "created",
      revision: input.revision ?? 1,
      createdAt: updatedAt,
      updatedAt,
      lastTransitionAt: updatedAt,
      seenAt: input.state && input.state !== "new" ? updatedAt : null,
      snoozedUntil: input.snoozedUntil ?? null,
    },
  };
}

export const demoAgentEvents: PropagatedAgentEvent[] = [
  demoAgentEvent({ id: "event_demo_release", message: demoAgentMessages[0]!, eventKind: "release_available", importance: "high", reasonCodes: ["release_became_available"], title: "Orca 2.4 is ready in TestFlight", summary: "Build 204 became available to testers.", whyThisMatters: "A release candidate is ready for the next human review step.", suggestedNextStep: "Open the source message and review the build." }),
  demoAgentEvent({ id: "event_demo_ci", message: demoAgentMessages[2]!, eventKind: "ci_or_deploy_failure", importance: "high", reasonCodes: ["workflow_failed"], title: "The production deploy failed again", summary: "The same migration check failed on retry 2.", whyThisMatters: "The production release is still blocked.", suggestedNextStep: "Open the failure details.", state: "seen", revision: 2 }),
  demoAgentEvent({ id: "event_demo_security", message: demoAgentMessages[3]!, eventKind: "security_or_account_alert", importance: "high", reasonCodes: ["security_change_detected"], title: "A recovery key was added", summary: "Harbor reported a new recovery key from an unfamiliar device.", whyThisMatters: "This account change may deserve your review; Orca is not judging whether it is safe.", suggestedNextStep: "Open the original alert and verify the device.", state: "snoozed", snoozedUntil: "2026-08-20T16:00:00.000Z" }),
  demoAgentEvent({ id: "event_demo_receipt", message: demoAgentMessages[4]!, eventKind: "receipt_or_renewal", importance: "medium", reasonCodes: ["payment_or_renewal_detected"], title: "Figma renews September 3", summary: "The workspace annual plan is scheduled to renew for $144.", whyThisMatters: "There is a dated renewal with a stated charge.", suggestedNextStep: "Open the renewal notice.", state: "dismissed" }),
  demoAgentEvent({ id: "event_demo_false_positive", message: demoAgentMessages[5]!, eventKind: "travel_or_booking_change", importance: "medium", reasonCodes: ["itinerary_changed"], title: "Possible itinerary change", summary: "Orca elevated a routine gate note as a schedule change.", whyThisMatters: "The deterministic rule found travel-change language, but you marked this estimate not useful.", suggestedNextStep: null, state: "false_positive" }),
  demoAgentEvent({ id: "event_demo_muted", message: demoAgentMessages[7]!, eventKind: "security_or_account_alert", importance: "medium", reasonCodes: ["security_change_detected"], title: "Routine Cloud sign-in notice", summary: "Routine Cloud sent another expected sign-in notice.", whyThisMatters: "This event is retained so the local sender mute can be reviewed and reversed.", suggestedNextStep: null, state: "muted" }),
];

export const demoAgentMutes: AgentPropagationMuteRule[] = [{
  id: "mute_demo_routine_cloud",
  accountId: demoAccount.id,
  target: { scope: "sender_address", value: "alerts@routinecloud.example" },
  createdAt: "2026-08-19T09:16:00.000Z",
  updatedAt: "2026-08-19T09:16:00.000Z",
}];

export const demoSuppressedAgentAssessment: AgentPropagationAssessment = (() => {
  const { id: _id, lifecycle: _lifecycle, ...assessment } = demoAgentEvent({ id: "suppressed_demo_newsletter", message: demoAgentMessages[6]!, eventKind: "marketing_or_newsletter", importance: "low", reasonCodes: ["routine_bulk_content"], title: "Routine product newsletter", summary: "Seven general product links.", whyThisMatters: "No concrete consequence was found.", suggestedNextStep: null });
  return {
    ...assessment,
    relevance: "not_matched",
    destination: "none",
    humanClassification: { classification: "automated_or_bulk", score: 1, reasonCodes: ["list_id_header", "provider_bulk_signal"], classifierVersion: "m5-v1", source: "automatic_heuristic" },
  };
})();

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
  msg_1: `<p>Hey Luke,</p><p>Here are the <strong>launch notes</strong> for Orca Mail. The big shift is treating pinned people as filters, not shortcuts into a single thread.</p><h2>What changed</h2><ul><li>People stay visible across conversations.</li><li>The reading surface keeps the message hierarchy intact.</li><li>Links remain useful without inheriting sender styling.</li></ul><p>Review the <a href="https://example.com/orca-reader" rel="noopener noreferrer" target="_blank">reader notes</a> when you have a minute.</p><img data-orca-remote-src="https://tracker.example/launch-preview.png" alt="Launch preview"><p>Let me know what you think.</p><p>— Maya</p>`,
};

export function messageIncludesPerson(message: InboxMessage, personName: string) {
  const needle = personName.toLowerCase();
  const fromName = message.from.name?.toLowerCase() ?? "";
  const fromEmail = message.from.email.toLowerCase();
  const haystack = `${fromName} ${fromEmail} ${message.subject} ${message.snippet}`.toLowerCase();
  return fromName.includes(needle) || fromEmail.includes(needle) || haystack.includes(needle);
}
