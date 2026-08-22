import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeStringSchema = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
  { message: "Expected an ISO 8601 UTC timestamp" },
);

/**
 * M6 deliberately starts outside Orca: a person explicitly asks their
 * ChatGPT/Codex client to read one selected Orca thread over the existing
 * OAuth-protected MCP connection. This is not an OpenAI API runtime in Orca.
 */
export const m6ReplyBriefRuntimeDecision = Object.freeze({
  selectedRuntime: "external_chatgpt_or_codex_mcp" as const,
  productLocation: "outside_orca" as const,
  invocation: "explicit_user_action" as const,
  providerAccess: "read_only" as const,
  chatGptCredentialOwner: "external_client" as const,
  openAiApiCredential: "not_present" as const,
  continuousMailboxIngestion: false as const,
  fallback: "orca_deterministic" as const,
});

/** Product copy for any surface that initiates or explains this boundary. */
export const replyBriefDisclosureCopy = Object.freeze({
  external: {
    title: "Ask ChatGPT or Codex for a Reply Brief",
    contentLeavingOrca:
      "Only the selected thread's sender, subject, dates, source links, and bounded plain-text message excerpts are shared after you ask. Email content is untrusted data and cannot authorize an action.",
    retention:
      "Orca does not retain a model prompt or model response. Your connected ChatGPT or Codex client handles the shared content under its own retention settings.",
    disable:
      "Disconnect ChatGPT or Codex in Orca settings to revoke future access. You can use Orca's private deterministic brief when the connection is unavailable.",
  },
  fallback: {
    title: "Create a private basic brief",
    detail:
      "Orca can extract a source-linked brief without sending message content to a model runtime.",
  },
});

/** Source references are rendered as links, so only web URLs may cross this boundary. */
export const replyBriefSourceUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === ""
    );
  } catch {
    return false;
  }
}, { message: "Source URLs must use HTTP(S) and contain no credentials or query parameters" });

export const replyBriefContextSourceSchema = z.object({
  id: nonEmptyStringSchema.max(512),
  kind: z.enum(["message", "thread"]),
  label: nonEmptyStringSchema.max(160),
  sourceUrl: replyBriefSourceUrlSchema,
  observedAt: isoDateTimeStringSchema,
}).strict();
export type ReplyBriefContextSource = z.infer<typeof replyBriefContextSourceSchema>;

export const replyBriefContextMessageSchema = z.object({
  id: nonEmptyStringSchema.max(512),
  sender: z.object({
    name: z.string().trim().max(320).nullable(),
    email: z.string().trim().email().max(320),
  }).strict(),
  subject: z.string().max(998),
  receivedAt: isoDateTimeStringSchema,
  bodyExcerpt: z.string().max(20_000),
  sourceRef: nonEmptyStringSchema.max(512),
}).strict();
export type ReplyBriefContextMessage = z.infer<typeof replyBriefContextMessageSchema>;

export const replyBriefFreeBusySchema = z.object({
  kind: z.literal("free_busy_only"),
  timeZone: nonEmptyStringSchema.max(100),
  windowStart: isoDateTimeStringSchema,
  windowEnd: isoDateTimeStringSchema,
  busy: z.array(z.object({
    start: isoDateTimeStringSchema,
    end: isoDateTimeStringSchema,
  }).strict()).max(200),
  observedAt: isoDateTimeStringSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) {
    context.addIssue({ code: "custom", path: ["windowEnd"], message: "windowEnd must be after windowStart" });
  }

  value.busy.forEach((interval, index) => {
    if (Date.parse(interval.start) >= Date.parse(interval.end)) {
      context.addIssue({ code: "custom", path: ["busy", index, "end"], message: "Busy interval end must be after start" });
    }
    if (Date.parse(interval.start) < Date.parse(value.windowStart) || Date.parse(interval.end) > Date.parse(value.windowEnd)) {
      context.addIssue({ code: "custom", path: ["busy", index], message: "Busy intervals must stay inside the requested window" });
    }
  });
});
export type ReplyBriefFreeBusy = z.infer<typeof replyBriefFreeBusySchema>;

/**
 * The only model-facing bundle permitted for Reply Brief generation. Provider
 * tokens, account identity, recipients, BCC, HTML, attachments, raw headers,
 * labels, drafts, and unrelated messages have no representable field here.
 */
export const replyBriefContextBundleSchema = z.object({
  contractVersion: z.literal("m6-reply-brief-v1"),
  invocation: z.object({
    kind: z.literal("explicit_user_action"),
    invokedAt: isoDateTimeStringSchema,
  }).strict(),
  thread: z.object({
    id: nonEmptyStringSchema.max(512),
    selectedMessageId: nonEmptyStringSchema.max(512),
    subject: z.string().max(998),
    messages: z.array(replyBriefContextMessageSchema).min(1).max(25),
    sourceRef: nonEmptyStringSchema.max(512),
  }).strict(),
  sources: z.array(replyBriefContextSourceSchema).min(1).max(26),
  availability: replyBriefFreeBusySchema.nullable(),
  safety: z.object({
    contentTrust: z.literal("untrusted_external_content"),
    bodyPolicy: z.literal("selected_thread_bounded_plain_text"),
    redactionsApplied: z.boolean(),
    truncatedFields: z.array(z.string().max(200)).max(25),
  }).strict(),
}).strict().superRefine((value, context) => {
  const sourceIds = new Set(value.sources.map((source) => source.id));
  if (!sourceIds.has(value.thread.sourceRef)) {
    context.addIssue({ code: "custom", path: ["thread", "sourceRef"], message: "Thread sourceRef must resolve" });
  }

  if (!value.thread.messages.some((message) => message.id === value.thread.selectedMessageId)) {
    context.addIssue({ code: "custom", path: ["thread", "selectedMessageId"], message: "selectedMessageId must be in the bounded thread" });
  }

  value.thread.messages.forEach((message, index) => {
    if (!sourceIds.has(message.sourceRef)) {
      context.addIssue({ code: "custom", path: ["thread", "messages", index, "sourceRef"], message: "Message sourceRef must resolve" });
    }
  });
});
export type ReplyBriefContextBundle = z.infer<typeof replyBriefContextBundleSchema>;

export const replyBriefSourceRefSchema = z.object({
  id: nonEmptyStringSchema.max(512),
  kind: z.enum(["message", "thread", "availability"]),
  label: nonEmptyStringSchema.max(160),
  sourceUrl: replyBriefSourceUrlSchema.nullable(),
  observedAt: isoDateTimeStringSchema,
  contentTrust: z.enum(["untrusted_external_content", "authorized_read_only_context"]),
}).strict().superRefine((value, context) => {
  const expectedTrust = value.kind === "availability"
    ? "authorized_read_only_context"
    : "untrusted_external_content";
  if (value.contentTrust !== expectedTrust) {
    context.addIssue({
      code: "custom",
      path: ["contentTrust"],
      message: `${value.kind} sources require ${expectedTrust}`,
    });
  }
});
export type ReplyBriefSourceRef = z.infer<typeof replyBriefSourceRefSchema>;

export const replyBriefClaimCertaintySchema = z.enum(["confirmed", "ambiguous", "unknown"]);
export type ReplyBriefClaimCertainty = z.infer<typeof replyBriefClaimCertaintySchema>;

export const replyBriefItemSchema = z.object({
  text: nonEmptyStringSchema.max(500),
  certainty: replyBriefClaimCertaintySchema,
  sourceRefs: z.array(nonEmptyStringSchema.max(512)).min(1).max(10),
}).strict();
export type ReplyBriefItem = z.infer<typeof replyBriefItemSchema>;

export const replyBriefStatusSchema = z.enum(["ready", "partial", "unavailable", "empty"]);
export type ReplyBriefStatus = z.infer<typeof replyBriefStatusSchema>;

export const replyBriefUnavailableReasonSchema = z.enum([
  "model_unavailable",
  "runtime_unavailable",
  "source_unavailable",
  "not_authorized",
]);
export type ReplyBriefUnavailableReason = z.infer<typeof replyBriefUnavailableReasonSchema>;

export const replyBriefContractVersion = "reply-brief.v1" as const;

export const replyBriefAvailabilityContextSchema = z.object({
  status: z.enum(["not_requested", "free_busy_only", "unavailable"]),
  timeZone: z.string().trim().min(1).max(100).nullable(),
  windowStart: isoDateTimeStringSchema.nullable(),
  windowEnd: isoDateTimeStringSchema.nullable(),
  busy: z.array(z.object({
    start: isoDateTimeStringSchema,
    end: isoDateTimeStringSchema,
  }).strict()).max(200),
  sourceRefs: z.array(nonEmptyStringSchema.max(512)).max(10),
}).strict().superRefine((value, context) => {
  if (value.status === "not_requested") {
    if (value.timeZone !== null) {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "not_requested availability cannot include a time zone" });
    }
    if (value.windowStart !== null || value.windowEnd !== null) {
      context.addIssue({ code: "custom", path: ["windowStart"], message: "not_requested availability cannot include a window" });
    }
    if (value.busy.length > 0) {
      context.addIssue({ code: "custom", path: ["busy"], message: "not_requested availability cannot include busy intervals" });
    }
    if (value.sourceRefs.length > 0) {
      context.addIssue({ code: "custom", path: ["sourceRefs"], message: "not_requested availability cannot include source references" });
    }
    return;
  }

  if (value.status === "free_busy_only") {
    if (value.timeZone === null) {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "free_busy_only availability requires a time zone" });
    }
    if (value.windowStart === null || value.windowEnd === null) {
      context.addIssue({ code: "custom", path: ["windowStart"], message: "free_busy_only availability requires a complete window" });
    } else {
      if (Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) {
        context.addIssue({ code: "custom", path: ["windowEnd"], message: "Availability windowEnd must be after windowStart" });
      }
      value.busy.forEach((interval, index) => {
        if (Date.parse(interval.start) >= Date.parse(interval.end)) {
          context.addIssue({ code: "custom", path: ["busy", index, "end"], message: "Busy interval end must be after start" });
        }
        if (Date.parse(interval.start) < Date.parse(value.windowStart!) || Date.parse(interval.end) > Date.parse(value.windowEnd!)) {
          context.addIssue({ code: "custom", path: ["busy", index], message: "Busy intervals must stay inside the availability window" });
        }
      });
    }
    if (value.sourceRefs.length === 0) {
      context.addIssue({ code: "custom", path: ["sourceRefs"], message: "free_busy_only availability requires a source reference" });
    }
  }
});
export type ReplyBriefAvailabilityContext = z.infer<typeof replyBriefAvailabilityContextSchema>;

/**
 * Closed-world guidance only. Strict objects at every level make draftText,
 * replyBody, suggestedCopy, action, compose, and send payloads invalid.
 */
export const replyBriefOutputSchema = z.object({
  contractVersion: z.literal(replyBriefContractVersion),
  status: replyBriefStatusSchema,
  unavailableReason: replyBriefUnavailableReasonSchema.nullable(),
  statusDetail: nonEmptyStringSchema.max(300).nullable(),
  intent: z.object({
    summary: nonEmptyStringSchema.max(300),
    certainty: replyBriefClaimCertaintySchema,
    sourceRefs: z.array(nonEmptyStringSchema.max(512)).min(1).max(10),
  }).strict().nullable(),
  facts: z.array(replyBriefItemSchema).max(20),
  constraints: z.array(replyBriefItemSchema).max(20),
  questions: z.array(replyBriefItemSchema).max(20),
  considerations: z.array(replyBriefItemSchema).max(20),
  sourceRefs: z.array(replyBriefSourceRefSchema).min(1).max(30),
  confidence: z.object({
    level: z.enum(["high", "medium", "low", "unknown"]),
    rationale: nonEmptyStringSchema.max(300),
  }).strict(),
  freshness: z.object({
    generatedAt: isoDateTimeStringSchema,
    newestSourceAt: isoDateTimeStringSchema,
    staleAfter: isoDateTimeStringSchema,
    status: z.enum(["current", "stale", "unknown"]),
    statusDetail: nonEmptyStringSchema.max(240).nullable(),
  }).strict(),
  availabilityContext: replyBriefAvailabilityContextSchema,
  humanAuthorship: z.object({
    owner: z.literal("human"),
    guidanceOnly: z.literal(true),
    composerMutation: z.literal("none"),
    composerStartsBlank: z.literal(true),
  }).strict(),
  capabilities: z.object({
    mail: z.literal("read_only"),
    context: z.literal("read_only"),
    allowedTools: z.array(z.never()).max(0),
    writeActions: z.array(z.never()).max(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  const sourceIds = new Set(value.sourceRefs.map((source) => source.id));
  const referencedItems = [...(value.intent ? [value.intent] : []), ...value.facts, ...value.constraints, ...value.questions, ...value.considerations];
  referencedItems.forEach((item, itemIndex) => {
    item.sourceRefs.forEach((sourceRef) => {
      if (!sourceIds.has(sourceRef)) {
        context.addIssue({ code: "custom", path: ["sourceRefs", itemIndex], message: `Unresolved sourceRef: ${sourceRef}` });
      }
    });
  });

  value.availabilityContext.sourceRefs.forEach((sourceRef) => {
    if (!sourceIds.has(sourceRef)) {
      context.addIssue({ code: "custom", path: ["availabilityContext", "sourceRefs"], message: `Unresolved sourceRef: ${sourceRef}` });
    }
  });

  if (value.status === "ready" && value.intent === null) {
    context.addIssue({ code: "custom", path: ["intent"], message: "Ready briefs require a sourced intent" });
  }
  if (value.status === "unavailable" && value.unavailableReason === null) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable briefs require a reason" });
  }
  if (value.status !== "unavailable" && value.unavailableReason !== null) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Only unavailable briefs have an unavailable reason" });
  }
  if (value.freshness.status !== "current" && value.freshness.statusDetail === null) {
    context.addIssue({ code: "custom", path: ["freshness", "statusDetail"], message: "Stale or unknown freshness requires an explanation" });
  }
  if (value.status === "empty" && (value.intent || value.facts.length || value.constraints.length || value.questions.length || value.considerations.length)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Empty briefs cannot contain interpreted guidance" });
  }
});
export type ReplyBriefOutput = z.infer<typeof replyBriefOutputSchema>;

export const replyBriefViewStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }).strict(),
  z.object({ state: z.literal("loading"), requestedAt: isoDateTimeStringSchema }).strict(),
  z.object({ state: z.literal("ready"), brief: replyBriefOutputSchema }).strict(),
  z.object({ state: z.literal("unavailable"), brief: replyBriefOutputSchema }).strict(),
  z.object({ state: z.literal("empty"), brief: replyBriefOutputSchema }).strict(),
]).superRefine((value, context) => {
  if (value.state === "ready" && !["ready", "partial"].includes(value.brief.status)) {
    context.addIssue({ code: "custom", path: ["brief", "status"], message: "Ready view state requires ready or partial brief data" });
  }
  if (value.state === "unavailable" && value.brief.status !== "unavailable") {
    context.addIssue({ code: "custom", path: ["brief", "status"], message: "Unavailable view state requires unavailable brief data" });
  }
  if (value.state === "empty" && value.brief.status !== "empty") {
    context.addIssue({ code: "custom", path: ["brief", "status"], message: "Empty view state requires empty brief data" });
  }
});
export type ReplyBriefViewState = z.infer<typeof replyBriefViewStateSchema>;

export const replyBriefProhibitedOutputFields = Object.freeze([
  "draftText",
  "replyBody",
  "suggestedCopy",
  "draft",
  "generatedReply",
  "recipients",
  "sendAction",
  "saveDraftAction",
] as const);

export const humanOwnedReplyBriefPolicy = Object.freeze({
  invocation: "explicit_user_action" as const,
  contentTrust: "untrusted_external_content" as const,
  humanAuthorship: "required" as const,
  composerMutation: "forbidden" as const,
  mailAccess: "read_only" as const,
  contextAccess: "read_only" as const,
  allowedTools: Object.freeze([]) as readonly [],
});

export const replyBriefInterpretationEnvelopeSchema = z.object({
  policy: z.object({
    invocation: z.literal("explicit_user_action"),
    contentTrust: z.literal("untrusted_external_content"),
    humanAuthorship: z.literal("required"),
    composerMutation: z.literal("forbidden"),
    mailAccess: z.literal("read_only"),
    contextAccess: z.literal("read_only"),
    allowedTools: z.array(z.never()).max(0),
  }).strict(),
  context: replyBriefContextBundleSchema,
}).strict();
export type ReplyBriefInterpretationEnvelope = z.infer<typeof replyBriefInterpretationEnvelopeSchema>;

/** Email text is data inside this envelope; it never supplies policy or tools. */
export function createReplyBriefInterpretationEnvelope(context: unknown): ReplyBriefInterpretationEnvelope {
  return replyBriefInterpretationEnvelopeSchema.parse({
    policy: humanOwnedReplyBriefPolicy,
    context,
  });
}

function addHours(timestamp: string, hours: number): string {
  return new Date(Date.parse(timestamp) + hours * 60 * 60 * 1_000).toISOString();
}

/**
 * A no-model fallback for failure, opt-out, rate-limit, or cost-limit paths.
 * It performs bounded extraction only; it cannot draft or execute an action.
 */
export function createDeterministicReplyBrief(input: unknown): ReplyBriefOutput {
  const context = replyBriefContextBundleSchema.parse(input);
  const selectedMessage = context.thread.messages.find((message) => message.id === context.thread.selectedMessageId)!;
  const schedulingRequest = /\b(meet|meeting|schedule|availability|available|calendar)\b/i.test(selectedMessage.bodyExcerpt);
  const durationMatch = selectedMessage.bodyExcerpt.match(/\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i);
  const duration = durationMatch ? `${durationMatch[1]}-${durationMatch[2]!.replace(/s$/i, "")}` : null;
  const observedTimes = [
    ...context.sources.map((source) => source.observedAt),
    ...(context.availability ? [context.availability.observedAt] : []),
  ];
  const newestSourceAt = observedTimes.reduce(
    (newest, observedAt) => Date.parse(observedAt) > Date.parse(newest) ? observedAt : newest,
    observedTimes[0]!,
  );
  const staleAfter = addHours(newestSourceAt, 24);

  const sourceRefs: ReplyBriefSourceRef[] = context.sources.map((source) => ({
    ...source,
    sourceUrl: source.sourceUrl,
    contentTrust: "untrusted_external_content",
  }));

  if (context.availability) {
    sourceRefs.push({
      id: "availability:free-busy",
      kind: "availability",
      label: "Calendar free/busy window",
      sourceUrl: null,
      observedAt: context.availability.observedAt,
      contentTrust: "authorized_read_only_context",
    });
  }

  return replyBriefOutputSchema.parse({
    contractVersion: replyBriefContractVersion,
    status: "ready",
    unavailableReason: null,
    statusDetail: null,
    intent: {
      summary: schedulingRequest ? "Coordinate a meeting time with the sender." : "Understand and respond to the selected message.",
      certainty: schedulingRequest ? "confirmed" : "ambiguous",
      sourceRefs: [selectedMessage.sourceRef],
    },
    facts: [
      {
        text: `The selected message is from ${selectedMessage.sender.name ?? selectedMessage.sender.email} and is titled “${selectedMessage.subject}.”`,
        certainty: "confirmed",
        sourceRefs: [selectedMessage.sourceRef],
      },
    ],
    constraints: duration ? [{ text: `The request specifies a ${duration.toLowerCase()} duration.`, certainty: "confirmed", sourceRefs: [selectedMessage.sourceRef] }] : [],
    questions: schedulingRequest
      ? [{ text: "Which available time should the user choose?", certainty: "confirmed", sourceRefs: [selectedMessage.sourceRef] }]
      : [{ text: "The outcome the user wants from this response is unknown.", certainty: "unknown", sourceRefs: [selectedMessage.sourceRef] }],
    considerations: context.availability
      ? [{ text: "Compare the proposed times only with the supplied free/busy intervals; no calendar event details were shared.", certainty: "confirmed", sourceRefs: [selectedMessage.sourceRef, "availability:free-busy"] }]
      : [{ text: "Calendar availability was not requested or shared.", certainty: "confirmed", sourceRefs: [selectedMessage.sourceRef] }],
    sourceRefs,
    confidence: {
      level: schedulingRequest ? "medium" : "low",
      rationale: "This fallback uses bounded deterministic extraction and does not infer unstated preferences.",
    },
    freshness: {
      generatedAt: context.invocation.invokedAt,
      newestSourceAt,
      staleAfter,
      status: Date.parse(context.invocation.invokedAt) <= Date.parse(staleAfter) ? "current" : "stale",
      statusDetail: Date.parse(context.invocation.invokedAt) <= Date.parse(staleAfter) ? null : "The newest authorized source is older than the freshness window.",
    },
    availabilityContext: context.availability
      ? {
          status: "free_busy_only",
          timeZone: context.availability.timeZone,
          windowStart: context.availability.windowStart,
          windowEnd: context.availability.windowEnd,
          busy: context.availability.busy,
          sourceRefs: ["availability:free-busy"],
        }
      : {
          status: "not_requested",
          timeZone: null,
          windowStart: null,
          windowEnd: null,
          busy: [],
          sourceRefs: [],
        },
    humanAuthorship: {
      owner: "human",
      guidanceOnly: true,
      composerMutation: "none",
      composerStartsBlank: true,
    },
    capabilities: {
      mail: "read_only",
      context: "read_only",
      allowedTools: [],
      writeActions: [],
    },
  });
}
