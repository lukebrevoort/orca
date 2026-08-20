import { useEffect, useRef, useState } from "react";
import {
  calendarConnectionPageSchema,
  replyBriefOutputSchema,
  schedulingReplyBriefFixture,
  type CalendarConnection,
  type ReplyBriefItem,
  type ReplyBriefOutput,
  type ReplyBriefSourceRef,
  type ThreadDetail,
} from "@orca/shared";

type ReplyBriefPanelState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "choose_calendar"; connections: CalendarConnection[] }
  | { state: "ready"; brief: ReplyBriefOutput }
  | { state: "error"; message: string };

export type ReplyBriefLoader = (input: {
  accountId: string;
  provider: ThreadDetail["account"]["provider"];
  threadId: string;
  selectedMessageId: string;
  calendarConnectionId: string | null;
  signal: AbortSignal;
}) => Promise<ReplyBriefOutput>;

export type CalendarConnectionLoader = (input: { signal: AbortSignal }) => Promise<CalendarConnection[]>;

const demoCalendarConnections: CalendarConnection[] = [
  { id: "demo-calendar-work", provider: "google", accountLabel: "Work calendar", state: "connected", grantedScopes: ["calendar.freebusy"], connectedAt: "2026-08-19T16:00:00.000Z", error: null },
  { id: "demo-calendar-personal", provider: "google", accountLabel: "Personal calendar", state: "connected", grantedScopes: ["calendar.freebusy"], connectedAt: "2026-08-19T16:00:00.000Z", error: null },
];

export async function loadCalendarConnections({ signal }: { signal: AbortSignal }) {
  const response = await fetch("/v1/calendar/connections", { credentials: "include", signal });
  if (!response.ok) throw new Error(`Calendar connections could not be loaded (${response.status}).`);
  return calendarConnectionPageSchema.parse(await response.json()).items.filter((connection) => connection.state === "connected");
}

export async function loadReplyBrief(input: Parameters<ReplyBriefLoader>[0]) {
  const response = await fetch(
    `/v1/threads/${encodeURIComponent(input.threadId)}/reply-brief?accountId=${encodeURIComponent(input.accountId)}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      signal: input.signal,
      body: JSON.stringify({
        trigger: "user_invoked",
        accountId: input.accountId,
        provider: input.provider,
        threadId: input.threadId,
        selectedMessageIds: [input.selectedMessageId],
        requestedAt: new Date().toISOString(),
        userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        calendarConnectionId: input.calendarConnectionId,
        authorizedContext: ["calendar_availability"],
      }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    const message = typeof payload?.error?.message === "string"
      ? payload.error.message
      : `Reply guidance could not be loaded (${response.status}).`;
    throw new Error(message);
  }
  return replyBriefOutputSchema.parse(await response.json());
}

export function ReplyBriefPanel({
  detail,
  demoMode = false,
  loader = loadReplyBrief,
  connectionLoader = loadCalendarConnections,
}: {
  detail: ThreadDetail;
  demoMode?: boolean;
  loader?: ReplyBriefLoader;
  connectionLoader?: CalendarConnectionLoader;
}) {
  const [panel, setPanel] = useState<ReplyBriefPanelState>({ state: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const selectedMessage = detail.messages[detail.messages.length - 1];

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPanel({ state: "idle" });
    return () => controllerRef.current?.abort();
  }, [detail.account.id, detail.thread.id, selectedMessage?.id]);

  if (!selectedMessage) return null;

  const finishRequest = async (calendarConnectionId: string | null, controller: AbortController) => {
    setPanel({ state: "loading" });
    try {
      const brief = demoMode
        ? createDemoReplyBrief(detail, selectedMessage.id)
        : await loader({
            accountId: detail.account.id,
            provider: detail.account.provider,
            threadId: detail.thread.id,
            selectedMessageId: selectedMessage.id,
            calendarConnectionId,
            signal: controller.signal,
          });
      if (!controller.signal.aborted) setPanel({ state: "ready", brief });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPanel({ state: "error", message: error instanceof Error ? error.message : "Reply guidance could not be loaded." });
    }
  };

  const request = async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPanel({ state: "loading" });
    try {
      const connections = demoMode ? demoCalendarConnections : await connectionLoader({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (connections.length > 1) {
        setPanel({ state: "choose_calendar", connections });
        return;
      }
      await finishRequest(connections[0]?.id ?? null, controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      setPanel({
        state: "error",
        message: error instanceof Error ? error.message : "Reply guidance could not be loaded.",
      });
    }
  };

  const dismiss = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setPanel({ state: "idle" });
  };

  const chooseCalendar = (calendarConnectionId: string | null) => {
    const controller = controllerRef.current;
    if (controller && !controller.signal.aborted) void finishRequest(calendarConnectionId, controller);
  };

  if (panel.state === "idle") {
    return (
      <section className="reply-brief-invitation" aria-label="Reply guidance">
        <div>
          <p>Human-owned guidance</p>
          <h2>Understand the reply before you write it.</h2>
          <span>Orca can surface the ask, constraints, open questions, and authorized read-only context. It never writes in the composer.</span>
        </div>
        <button onClick={() => void request()} type="button">Get reply guidance</button>
      </section>
    );
  }

  if (panel.state === "loading") {
    return (
      <section aria-busy="true" aria-live="polite" className="reply-brief reply-brief-loading">
        <ReplyBriefHeader onDismiss={dismiss} />
        <p className="reply-brief-status-copy">Reading only this conversation and authorized context…</p>
        <div className="reply-brief-loading-line" />
        <div className="reply-brief-loading-line reply-brief-loading-line-short" />
      </section>
    );
  }

  if (panel.state === "choose_calendar") {
    return (
      <section className="reply-brief reply-brief-calendar-choice" aria-label="Choose calendar for Reply Brief">
        <ReplyBriefHeader onDismiss={dismiss} />
        <div className="reply-brief-state-copy">
          <p>Authorized context</p>
          <h3>Which calendar account should this brief check?</h3>
          <span>Orca checks only the connection you choose and sends only free/busy context into the brief.</span>
        </div>
        <div aria-label="Calendar connections" className="reply-brief-calendar-choices" role="group">
          {panel.connections.map((connection) => (
            <button key={connection.id} onClick={() => chooseCalendar(connection.id)} type="button">
              <strong>{connection.accountLabel}</strong><span>{connection.provider} · read-only free/busy</span>
            </button>
          ))}
          <button onClick={() => chooseCalendar(null)} type="button"><strong>Continue without calendar</strong><span>Availability will remain unavailable</span></button>
        </div>
      </section>
    );
  }

  if (panel.state === "error") {
    return (
      <section className="reply-brief reply-brief-error" role="alert">
        <ReplyBriefHeader onDismiss={dismiss} />
        <div className="reply-brief-state-copy">
          <p>Guidance unavailable</p>
          <h3>Orca couldn’t check this message.</h3>
          <span>{panel.message} Nothing was added to your composer.</span>
        </div>
        <button className="reply-brief-retry" onClick={() => void request()} type="button">Try again</button>
      </section>
    );
  }

  return <ReplyBriefResult brief={panel.brief} onDismiss={dismiss} onRefresh={() => void request()} />;
}

function ReplyBriefResult({ brief, onDismiss, onRefresh }: {
  brief: ReplyBriefOutput;
  onDismiss: () => void;
  onRefresh: () => void;
}) {
  const sourceById = new Map(brief.sourceRefs.map((source) => [source.id, source]));
  const unavailable = brief.status === "unavailable";
  const empty = brief.status === "empty";
  return (
    <section className={`reply-brief${unavailable ? " reply-brief-unavailable" : ""}${brief.freshness.status === "stale" ? " reply-brief-stale" : ""}`} aria-label="Reply Brief">
      <ReplyBriefHeader onDismiss={onDismiss} onRefresh={onRefresh} />

      {unavailable ? (
        <div className="reply-brief-state-copy" role="status">
          <p>Interpretation unavailable</p>
          <h3>Source-derived facts are still here.</h3>
          <span>{brief.statusDetail ?? "Orca could not run interpretation and will not guess."}</span>
        </div>
      ) : null}
      {empty ? (
        <div className="reply-brief-state-copy" role="status">
          <p>Not enough to brief</p>
          <h3>This message doesn’t contain a clear request.</h3>
          <span>{brief.statusDetail ?? "Review the selected message directly before deciding whether to respond."}</span>
        </div>
      ) : null}

      <div className="reply-brief-meta" aria-label="Guidance quality">
        <span data-tone={brief.confidence.level}>Confidence · {brief.confidence.level}</span>
        <span data-tone={brief.freshness.status}>Freshness · {brief.freshness.status}</span>
        <small>{brief.confidence.rationale}</small>
        {brief.freshness.statusDetail ? <small>{brief.freshness.statusDetail}</small> : null}
      </div>

      {brief.intent ? (
        <ReplyBriefSection title="The ask">
          <ReplyBriefClaims claims={[{ text: brief.intent.summary, certainty: brief.intent.certainty, sourceRefs: brief.intent.sourceRefs }]} sources={sourceById} />
        </ReplyBriefSection>
      ) : null}
      {brief.facts.length ? (
        <ReplyBriefSection title="Facts">
          <ReplyBriefClaims claims={brief.facts} sources={sourceById} />
        </ReplyBriefSection>
      ) : null}
      {brief.constraints.length ? (
        <ReplyBriefSection title="Constraints">
          <ReplyBriefClaims claims={brief.constraints} sources={sourceById} />
        </ReplyBriefSection>
      ) : null}
      {brief.questions.length ? (
        <ReplyBriefSection title="Questions for you">
          <ReplyBriefClaims claims={brief.questions} sources={sourceById} />
        </ReplyBriefSection>
      ) : null}

      <ReplyBriefAvailability context={brief.availabilityContext} sources={sourceById} />

      {brief.considerations.length ? (
        <ReplyBriefSection title="Consider as you write">
          <ReplyBriefConsiderations items={brief.considerations} sources={sourceById} />
        </ReplyBriefSection>
      ) : null}

      <details className="reply-brief-sources">
        <summary>Context used · {brief.sourceRefs.length} {brief.sourceRefs.length === 1 ? "source" : "sources"}</summary>
        <ul>{brief.sourceRefs.map((source) => <li key={source.id}><SourceLink source={source} /><small>{source.kind === "availability" ? "Authorized free/busy only" : "Selected conversation"} · observed {formatBriefTime(source.observedAt)}</small></li>)}</ul>
      </details>

      <footer className="reply-brief-boundary">
        <span aria-hidden="true">✦</span>
        <p><strong>Your words stay yours.</strong> This guidance cannot create a draft, choose recipients, send mail, or change a calendar. Open Reply when you’re ready and write an independent response.</p>
      </footer>
    </section>
  );
}

function ReplyBriefHeader({ onDismiss, onRefresh }: { onDismiss: () => void; onRefresh?: () => void }) {
  return (
    <header className="reply-brief-header">
      <div><p>Guidance, not a draft</p><h2>Reply Brief</h2></div>
      <div>
        {onRefresh ? <button onClick={onRefresh} type="button">Refresh</button> : null}
        <button aria-label="Dismiss Reply Brief" onClick={onDismiss} type="button">Dismiss</button>
      </div>
    </header>
  );
}

function ReplyBriefSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="reply-brief-section"><h3>{title}</h3>{children}</section>;
}

function ReplyBriefClaims({ claims, sources }: {
  claims: ReplyBriefItem[];
  sources: Map<string, ReplyBriefSourceRef>;
}) {
  return (
    <ul className="reply-brief-claims">
      {claims.map((claim, index) => (
        <li key={`${claim.text}:${index}`}>
          <div><span aria-hidden="true">{claim.certainty === "confirmed" ? "•" : "?"}</span><p>{claim.text}</p></div>
          <div className="reply-brief-claim-meta"><span>{claim.certainty}</span>{claim.sourceRefs.map((sourceId) => {
            const source = sources.get(sourceId);
            return source ? <SourceLink compact key={sourceId} source={source} /> : null;
          })}</div>
        </li>
      ))}
    </ul>
  );
}

function ReplyBriefConsiderations({ items, sources }: {
  items: ReplyBriefItem[];
  sources: Map<string, ReplyBriefSourceRef>;
}) {
  return <ul className="reply-brief-considerations">{items.map((item, index) => <li key={`${item.text}:${index}`}><p>{item.text}</p><div>{item.sourceRefs.map((sourceId) => { const source = sources.get(sourceId); return source ? <SourceLink compact key={sourceId} source={source} /> : null; })}</div></li>)}</ul>;
}

function ReplyBriefAvailability({ context, sources }: {
  context: ReplyBriefOutput["availabilityContext"];
  sources: Map<string, ReplyBriefSourceRef>;
}) {
  const sourceClaims = context.sourceRefs.map((sourceId) => sources.get(sourceId)).filter((source): source is ReplyBriefSourceRef => Boolean(source));
  return (
    <section className="reply-brief-section reply-brief-availability">
      <h3>Availability</h3>
      <div className="reply-brief-availability-state" data-status={context.status}>
        <div><strong>Read-only calendar</strong><span>{availabilityLabel(context.status)}</span></div>
        {context.status === "free_busy_only" ? <p>{context.busy.length ? `${context.busy.length} busy ${context.busy.length === 1 ? "interval" : "intervals"} overlap the interpreted window.` : "No busy intervals were returned inside the interpreted window."}</p> : <p>Availability was not available to check. Orca will not guess or recommend a time.</p>}
        {context.windowStart && context.windowEnd ? <p>{formatBriefTime(context.windowStart)} – {formatBriefTime(context.windowEnd)} · {context.timeZone}</p> : null}
        {context.busy.length ? <ul className="reply-brief-busy">{context.busy.map((interval) => <li key={`${interval.start}:${interval.end}`}>{formatBriefTime(interval.start)} – {formatBriefTime(interval.end)}</li>)}</ul> : null}
        {sourceClaims.length ? <div className="reply-brief-availability-sources">{sourceClaims.map((source) => <SourceLink compact key={source.id} source={source} />)}</div> : null}
        <small>{context.status === "free_busy_only" ? "Free/busy only · no event titles, attendees, notes, or calendar writes" : "No calendar facts were inferred"}</small>
      </div>
    </section>
  );
}

function SourceLink({ source, compact = false }: { source: ReplyBriefSourceRef; compact?: boolean }) {
  const label = compact ? (source.kind === "availability" ? "Calendar" : source.kind === "thread" ? "Thread" : "Message") : source.label;
  const sourceUrl = safeHttpSourceUrl(source.sourceUrl);
  return sourceUrl
    ? <a href={sourceUrl} rel="noreferrer">{label}<span aria-hidden="true"> ↗</span></a>
    : <span className="reply-brief-source-label">{label}</span>;
}

function safeHttpSourceUrl(value: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function availabilityLabel(status: ReplyBriefOutput["availabilityContext"]["status"]) {
  if (status === "free_busy_only") return "Free/busy checked";
  if (status === "not_requested") return "Not requested";
  return "Unavailable";
}

function formatBriefTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function createDemoReplyBrief(detail: ThreadDetail, selectedMessageId: string): ReplyBriefOutput {
  const selected = detail.messages.find((message) => message.id === selectedMessageId)!;
  const fixtureMessageId = schedulingReplyBriefFixture.sourceRefs.find((source) => source.kind === "message")!.id;
  const replaceSourceId = (sourceId: string) => sourceId === fixtureMessageId ? selected.id : sourceId;
  const patchClaim = (claim: ReplyBriefItem): ReplyBriefItem => ({
    ...claim,
    sourceRefs: claim.sourceRefs.map(replaceSourceId),
  });
  const sourceUrl = `${window.location.origin}${window.location.pathname}#message-${encodeURIComponent(selected.id)}`;
  return replyBriefOutputSchema.parse({
    ...schedulingReplyBriefFixture,
    freshness: { ...schedulingReplyBriefFixture.freshness, generatedAt: new Date().toISOString() },
    sourceRefs: schedulingReplyBriefFixture.sourceRefs.map((source) => source.kind === "message" ? {
      ...source,
      id: selected.id,
      label: `${selected.from.name ?? selected.from.email} · ${selected.subject || "Selected message"}`,
      observedAt: selected.receivedAt,
      sourceUrl,
    } : source),
    intent: schedulingReplyBriefFixture.intent ? { ...schedulingReplyBriefFixture.intent, sourceRefs: schedulingReplyBriefFixture.intent.sourceRefs.map(replaceSourceId) } : null,
    facts: schedulingReplyBriefFixture.facts.map(patchClaim),
    constraints: schedulingReplyBriefFixture.constraints.map(patchClaim),
    questions: schedulingReplyBriefFixture.questions.map(patchClaim),
    considerations: schedulingReplyBriefFixture.considerations.map(patchClaim),
  });
}
