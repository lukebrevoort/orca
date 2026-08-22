import { z } from "zod";
import {
  createReplyBriefAvailabilityContext,
  mailProviderSchema,
  replyBriefOutputSchema,
  type CalendarAvailabilityResponse,
  type ReplyBriefItem,
  type ReplyBriefOutput,
  type ReplyBriefSourceRef,
  type RequestedAvailabilityWindow,
  type ThreadDetail,
} from "@orca/shared";

const utcTimestamp = z.string().datetime({ offset: false });
const nonEmpty = z.string().trim().min(1);
const timeZone = nonEmpty.max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); return true; }
  catch { return false; }
}, { message: "Expected an IANA timezone" });
const staleAfterMs = 24 * 60 * 60 * 1_000;

export const replyBriefInvocationRequestSchema = z.object({
  trigger: z.literal("user_invoked"),
  accountId: nonEmpty,
  provider: mailProviderSchema,
  threadId: nonEmpty,
  selectedMessageIds: z.array(nonEmpty).min(1).max(25),
  requestedAt: utcTimestamp,
  userTimeZone: timeZone,
  calendarConnectionId: nonEmpty.nullable(),
  authorizedContext: z.array(z.literal("calendar_availability")).max(1),
}).strict().superRefine((request, context) => {
  if (request.calendarConnectionId && !request.authorizedContext.includes("calendar_availability")) {
    context.addIssue({ code: "custom", path: ["calendarConnectionId"], message: "Calendar connection selection requires authorized calendar context" });
  }
});
export type ReplyBriefInvocationRequest = z.infer<typeof replyBriefInvocationRequestSchema>;

export type ReplyBriefUnavailableRuntime = "model_unavailable" | "runtime_unavailable";

export function createOnDemandReplyBrief(input: {
  request: ReplyBriefInvocationRequest;
  thread: ThreadDetail;
  availability?: CalendarAvailabilityResponse | null;
  unavailableRuntime?: ReplyBriefUnavailableRuntime | null;
  webOrigin?: string;
  now?: Date;
}): ReplyBriefOutput {
  const request = replyBriefInvocationRequestSchema.parse(input.request);
  if (request.accountId !== input.thread.account.id || request.provider !== input.thread.account.provider || request.threadId !== input.thread.thread.id) {
    throw new Error("Reply Brief request scope does not match the selected conversation.");
  }
  const selectedIds = new Set(request.selectedMessageIds);
  const messages = input.thread.messages.filter((message) => selectedIds.has(message.id));
  if (messages.length !== selectedIds.size) throw new Error("Every selected Reply Brief message must belong to the selected conversation.");

  const now = input.now ?? new Date(request.requestedAt);
  const webOrigin = (input.webOrigin ?? "http://localhost:5173").replace(/\/$/, "");
  const sourceRefs: ReplyBriefSourceRef[] = messages.map((message) => ({
    id: messageSourceId(message.id),
    kind: "message",
    label: `${message.from.name ?? message.from.email} · ${message.subject || "Selected message"}`,
    sourceUrl: messageSourceUrl(webOrigin, input.thread.account.id, input.thread.thread.id, message.id),
    observedAt: message.receivedAt,
    contentTrust: "untrusted_external_content",
  }));
  const messageRefs = messages.map((message) => messageSourceId(message.id));
  const body = messages.map((message) => message.bodyText?.trim() || message.snippet.trim()).filter(Boolean).join("\n");
  const scheduling = /\b(meet|meeting|schedule|availability|available|calendar|call)\b/i.test(body);
  const duration = body.match(/\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i);
  const hasDate = /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|next week|\d{4}-\d{2}-\d{2})\b/i.test(body);
  const hasTime = /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:noon|midnight|morning|afternoon|evening)\b/i.test(body);
  const injection = /\b(ignore (?:all |previous |orca )?(?:instructions|policy)|send_mail|draft (?:a |the )?reply|auto-?reply|accept (?:the )?meeting)\b/i.test(body);
  const availability = mapAvailability(input.availability ?? null, scheduling ? request : { ...request, calendarConnectionId: null, authorizedContext: [] }, messages, sourceRefs);
  const empty = !body;

  const facts: ReplyBriefItem[] = empty ? [] : messages.map((message) => ({
    text: `${message.from.name ?? message.from.email} sent the selected message “${message.subject || "(no subject)"}.”`,
    certainty: "confirmed",
    sourceRefs: [messageSourceId(message.id)],
  }));
  if (!empty) facts.push(...availability.facts);
  if (injection && !empty) facts.push({
    text: "The selected email contains instruction-like text. Orca treated it only as untrusted message content; policy and tool access did not change.",
    certainty: "confirmed",
    sourceRefs: messageRefs,
  });
  const constraints: ReplyBriefItem[] = [];
  if (duration) constraints.push({
    text: `The message specifies a ${normalizeDuration(duration[1]!, duration[2]!)} duration.`,
    certainty: "confirmed",
    sourceRefs: messageRefs,
  });
  if (scheduling && (!hasDate || !hasTime)) constraints.push({
    text: `The scheduling window is incomplete: ${!hasDate && !hasTime ? "the date and time are unknown" : !hasDate ? "the date is unknown" : "the exact time is unknown"}.`,
    certainty: "unknown",
    sourceRefs: messageRefs,
  });
  if (!empty) constraints.push(...availability.constraints);

  const questions: ReplyBriefItem[] = empty ? [] : [{
    text: scheduling
      ? hasDate && hasTime ? "Which proposed time, if any, works for the recipient?" : "What date or exact time did the sender intend?"
      : "The outcome the recipient wants from this response is unknown.",
    certainty: scheduling && hasDate && hasTime ? "confirmed" : "unknown",
    sourceRefs: messageRefs,
  }, ...availability.questions];
  const considerations: ReplyBriefItem[] = empty ? [] : [
    { text: "Acknowledge the concrete request in your own words.", certainty: "confirmed", sourceRefs: messageRefs },
    { text: "Answer the open decision or identify what is still unknown.", certainty: "confirmed", sourceRefs: messageRefs },
  ];
  if (availability.freeSourceRefs.length) considerations.push({
    text: "Decide whether to offer one of the confirmed free windows.",
    certainty: "confirmed",
    sourceRefs: availability.freeSourceRefs,
  });

  const observedAt = [...messages.map((message) => message.receivedAt), ...availability.observedAt];
  const newestSourceAt = observedAt.reduce((newest, current) => Date.parse(current) > Date.parse(newest) ? current : newest, observedAt[0] ?? request.requestedAt);
  const staleAfter = new Date(Date.parse(newestSourceAt) + staleAfterMs).toISOString();
  const stale = now.getTime() > Date.parse(staleAfter) || availability.stale;
  const unavailableRuntime = input.unavailableRuntime ?? null;
  const status = empty ? "empty" : unavailableRuntime ? "unavailable" : availability.partial ? "partial" : "ready";

  return replyBriefOutputSchema.parse({
    contractVersion: "reply-brief.v1",
    status,
    unavailableReason: unavailableRuntime,
    statusDetail: empty
      ? "The selected message has no readable text to interpret."
      : unavailableRuntime
        ? "Interpretation is unavailable; safe source-derived facts remain visible."
        : availability.partial
          ? "Message guidance is available, but calendar availability could not be fully checked."
          : null,
    intent: empty || unavailableRuntime ? null : {
      summary: scheduling ? "The sender is asking to coordinate a meeting time." : "The sender is asking the recipient to review and respond to the selected message.",
      certainty: scheduling ? "confirmed" : "ambiguous",
      sourceRefs: messageRefs,
    },
    facts,
    constraints,
    questions,
    considerations: unavailableRuntime ? [] : considerations,
    sourceRefs,
    confidence: {
      level: empty ? "unknown" : scheduling && hasDate && hasTime ? "high" : scheduling ? "medium" : "low",
      rationale: empty ? "No readable message text was available." : "This private fallback uses deterministic extraction and does not infer unstated facts, preferences, or response wording.",
    },
    freshness: {
      generatedAt: now.toISOString(),
      newestSourceAt,
      staleAfter,
      status: stale ? "stale" : "current",
      statusDetail: stale ? "At least one selected source or free/busy result is stale. Re-check it before relying on this guidance." : null,
    },
    availabilityContext: availability.output,
    humanAuthorship: { owner: "human", guidanceOnly: true, composerMutation: "none", composerStartsBlank: true },
    capabilities: { mail: "read_only", context: "read_only", allowedTools: [], writeActions: [] },
  });
}

function mapAvailability(
  response: CalendarAvailabilityResponse | null,
  request: ReplyBriefInvocationRequest,
  messages: ThreadDetail["messages"],
  sourceRefs: ReplyBriefSourceRef[],
) {
  const requested = request.authorizedContext.includes("calendar_availability");
  if (!requested) return emptyAvailability("not_requested", false);
  if (!response) return emptyAvailability("unavailable", true);

  const compactAvailability = createReplyBriefAvailabilityContext(response, request.requestedAt);
  const compactFreeBusy = compactAvailability.kind === "free_busy_only" ? compactAvailability : null;
  const checkedResults = response.results.filter((result) => result.status !== "unknown" && result.freshness === "fresh");
  const reliable = Boolean(compactFreeBusy && checkedResults.length > 0);
  const incomplete = response.results.some((result) => result.status === "unknown" || result.freshness !== "fresh");
  const availabilityRef = reliable ? "availability:free-busy" : null;
  if (availabilityRef) sourceRefs.push({
    id: availabilityRef,
    kind: "availability",
    label: "Authorized calendar free/busy",
    sourceUrl: null,
    observedAt: compactAvailability.observedAt,
    contentTrust: "authorized_read_only_context",
  });
  const messageIdSet = new Set(messages.map((message) => message.id));
  const fallbackRef = messageSourceId(messages[0]!.id);
  const constraints: ReplyBriefItem[] = response.request.requestedWindows.map((window) => ({
    text: `The sender's requested window was interpreted as: ${window.sourceText}`,
    certainty: window.interpretation === "exact" ? "confirmed" : "ambiguous",
    sourceRefs: [messageIdSet.has(window.messageId) ? messageSourceId(window.messageId) : fallbackRef],
  }));
  const questions: ReplyBriefItem[] = response.results.filter((result) => result.status === "unknown").map((result) => {
    const window = response.request.requestedWindows.find((item) => item.id === result.windowId);
    return {
      text: `Availability for “${window?.sourceText ?? "the requested window"}” is unknown. ${result.explanation}`,
      certainty: "unknown" as const,
      sourceRefs: [window && messageIdSet.has(window.messageId) ? messageSourceId(window.messageId) : fallbackRef],
    };
  });
  const facts: ReplyBriefItem[] = reliable ? checkedResults.map((result) => {
    const window = response.request.requestedWindows.find((item) => item.id === result.windowId);
    const messageRef = window && messageIdSet.has(window.messageId) ? messageSourceId(window.messageId) : fallbackRef;
    return {
      text: result.status === "free"
        ? `“${window?.sourceText ?? "The requested window"}” is free on the selected calendars.`
        : `“${window?.sourceText ?? "The requested window"}” overlaps busy time on a selected calendar.`,
      certainty: "confirmed" as const,
      sourceRefs: [messageRef, availabilityRef!],
    };
  }) : [];
  const freeResult = reliable ? checkedResults.find((result) => result.status === "free") : null;
  const freeWindow = freeResult ? response.request.requestedWindows.find((window) => window.id === freeResult.windowId) : null;
  return {
    output: reliable ? {
      status: "free_busy_only" as const,
      timeZone: compactFreeBusy!.timeZone,
      windowStart: compactFreeBusy!.windowStart,
      windowEnd: compactFreeBusy!.windowEnd,
      busy: compactFreeBusy!.busy,
      sourceRefs: [availabilityRef!],
    } : {
      status: "unavailable" as const,
      timeZone: response.request.userTimeZone,
      windowStart: null,
      windowEnd: null,
      busy: [],
      sourceRefs: [],
    },
    constraints,
    facts,
    questions,
    freeSourceRefs: freeResult && freeWindow ? [messageIdSet.has(freeWindow.messageId) ? messageSourceId(freeWindow.messageId) : fallbackRef, availabilityRef!] : [],
    observedAt: [compactAvailability.observedAt],
    stale: response.results.some((result) => result.freshness === "stale"),
    partial: !reliable || incomplete,
  };
}

function emptyAvailability(status: "not_requested" | "unavailable", partial: boolean) {
  return {
    output: { status, timeZone: null, windowStart: null, windowEnd: null, busy: [], sourceRefs: [] },
    constraints: [] as ReplyBriefItem[],
    facts: [] as ReplyBriefItem[],
    questions: [] as ReplyBriefItem[],
    freeSourceRefs: [] as string[],
    observedAt: [] as string[],
    stale: false,
    partial,
  };
}

function messageSourceId(messageId: string) {
  return `message:${messageId}`;
}

function messageSourceUrl(webOrigin: string, accountId: string, threadId: string, messageId: string) {
  return `${webOrigin}/accounts/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}#message-${encodeURIComponent(messageId)}`;
}

function normalizeDuration(countValue: string, unitValue: string) {
  const count = Number(countValue);
  const unit = unitValue.toLowerCase().startsWith("h") ? "hour" : "minute";
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function interpretRequestedAvailabilityWindows(input: {
  thread: ThreadDetail;
  selectedMessageIds: readonly string[];
  requestedAt: string;
  userTimeZone: string;
  webOrigin?: string;
}): RequestedAvailabilityWindow[] {
  const selected = new Set(input.selectedMessageIds);
  const requestedAt = new Date(input.requestedAt);
  const webOrigin = (input.webOrigin ?? "http://localhost:5173").replace(/\/$/, "");
  return input.thread.messages.filter((message) => selected.has(message.id)).flatMap((message, messageIndex) => {
    const body = (message.bodyText?.trim() || message.snippet.trim()).replace(/\s+/g, " ");
    const sourceText = selectSchedulingSentence(body).slice(0, 1_000) || "Scheduling details were not readable.";
    const durationMatch = sourceText.match(/\b(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i);
    const durationMinutes = durationMatch ? durationToMinutes(durationMatch[1]!, durationMatch[2]!) : null;
    const originalTimeZone = readTimeZone(sourceText);
    const timeRange = readTimeRange(sourceText);
    const dates = readRequestedDates(sourceText, requestedAt);
    const ambiguities: RequestedAvailabilityWindow["ambiguities"] = [];
    if (!dates.length) ambiguities.push({ code: "missing_date", message: "The requested date is not specific enough to check.", sourceText });
    if (!timeRange) ambiguities.push({ code: "missing_time", message: "The requested time is not specific enough to check.", sourceText });
    if (!originalTimeZone) ambiguities.push({ code: "missing_timezone", message: "The sender did not identify a timezone.", sourceText });
    if (timeRange && !/\b(?:a\.?m\.?|p\.?m\.?|noon|midnight)\b/i.test(sourceText)) ambiguities.push({ code: "multiple_interpretations", message: "The requested time could be AM or PM.", sourceText });
    if (/\b(around|about|roughly|morning|afternoon|evening)\b/i.test(sourceText) && !/\b(?:a\.?m\.?|p\.?m\.?|noon|midnight)\b/i.test(sourceText)) ambiguities.push({ code: "approximate_time", message: "The sender used an approximate time with no exact boundary.", sourceText });
    const sourceUrl = messageSourceUrl(webOrigin, input.thread.account.id, input.thread.thread.id, message.id);
    return (dates.length ? dates : [null]).map((date, dateIndex) => {
      const exact = Boolean(date && timeRange && originalTimeZone && ambiguities.length === 0);
      const start = exact ? zonedLocalToUtc(date!, timeRange!.startMinutes, originalTimeZone!).toISOString() : null;
      const rawEndMinutes = timeRange?.endMinutes ?? (timeRange ? timeRange.startMinutes + (durationMinutes ?? 60) : null);
      const endDate = exact && rawEndMinutes !== null && rawEndMinutes >= 24 * 60 ? addUtcDays(date!, 1) : date;
      const end = exact && rawEndMinutes !== null ? zonedLocalToUtc(endDate!, rawEndMinutes % (24 * 60), originalTimeZone!).toISOString() : null;
      return {
        id: `reply-window:${message.id}:${messageIndex + 1}:${dateIndex + 1}`,
        messageId: message.id,
        sourceText,
        sourceUrl,
        originalTimeZone,
        userTimeZone: input.userTimeZone,
        start,
        end,
        durationMinutes,
        interpretation: exact ? "exact" as const : "ambiguous" as const,
        ambiguities: exact ? [] : ambiguities.length ? ambiguities : [{ code: "multiple_interpretations" as const, message: "The requested window has more than one plausible interpretation.", sourceText }],
      };
    });
  });
}

function selectSchedulingSentence(body: string) {
  return body.split(/(?<=[.!?])\s+/).find((sentence) => /\b(meet|meeting|schedule|availability|available|calendar|call)\b/i.test(sentence)) ?? body;
}

function durationToMinutes(rawCount: string, rawUnit: string) {
  return rawUnit.toLowerCase().startsWith("h") ? Number(rawCount) * 60 : Number(rawCount);
}

function readTimeZone(value: string) {
  if (/\b(?:mountain(?: time)?|mt|mdt|mst)\b/i.test(value)) return "America/Denver";
  if (/\b(?:pacific(?: time)?|pt|pdt|pst)\b/i.test(value)) return "America/Los_Angeles";
  if (/\b(?:central(?: time)?|ct|cdt|cst)\b/i.test(value)) return "America/Chicago";
  if (/\b(?:eastern(?: time)?|et|edt|est)\b/i.test(value)) return "America/New_York";
  if (/\b(?:utc|gmt)\b/i.test(value)) return "UTC";
  return null;
}

function readTimeRange(value: string) {
  const between = value.match(/\bbetween\s+([^,;.?!]+?)\s+and\s+([^,;.?!]+?)(?=\s+(?:on|mountain|pacific|central|eastern|mt|pt|ct|et|for)\b|[,;.?!]|$)/i);
  if (between) {
    const start = parseClock(between[1]!, meridiemOf(between[2]));
    const end = parseClock(between[2]!);
    if (start !== null && end !== null) return { startMinutes: start, endMinutes: end <= start ? end + 12 * 60 : end };
  }
  const range = value.match(/\b((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)\s*(?:-|–|—|to)\s*((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)\b/i);
  if (range) {
    const start = parseClock(range[1]!, meridiemOf(range[2]));
    const end = parseClock(range[2]!);
    if (start !== null && end !== null) return { startMinutes: start, endMinutes: end <= start ? end + 12 * 60 : end };
  }
  const single = value.match(/\b(?:at|around)\s+((?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b/i);
  const start = single ? parseClock(single[1]!) : null;
  return start === null ? null : { startMinutes: start, endMinutes: null };
}

function meridiemOf(value: string | undefined) {
  return value?.match(/\b([ap])\.?m\.?\b/i)?.[1]?.toLowerCase() as "a" | "p" | undefined;
}

function parseClock(value: string, fallback?: "a" | "p") {
  const normalized = value.trim().toLowerCase();
  if (normalized === "noon") return 12 * 60;
  if (normalized === "midnight") return 0;
  const match = normalized.match(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])?\.?m?\.?\b/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = (match[3]?.toLowerCase() as "a" | "p" | undefined) ?? fallback;
  if (hour > 23 || (meridiem && hour > 12)) return null;
  if (meridiem === "p" && hour !== 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function readRequestedDates(value: string, requestedAt: Date) {
  const exact = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (exact) return [`${exact[1]}-${exact[2]}-${exact[3]}`];
  const weekdays = [...value.matchAll(/\b(?:(next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)];
  const indexes: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const unique = new Set<string>();
  for (const match of weekdays) {
    const target = indexes[match[2]!.toLowerCase()]!;
    let days = (target - requestedAt.getUTCDay() + 7) % 7;
    if (days === 0 || match[1]) days += 7;
    unique.add(addUtcDays(requestedAt.toISOString().slice(0, 10), days));
  }
  return [...unique];
}

function addUtcDays(date: string, days: number) {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function zonedLocalToUtc(date: string, minutes: number, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  let candidate = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const rendered = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
    const difference = Date.UTC(year, month - 1, day, hour, minute) - rendered;
    candidate += difference;
    if (difference === 0) break;
  }
  return new Date(candidate);
}
