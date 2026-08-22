import { schedulingAvailabilityFixture, schedulingReplyBriefFixture, type CalendarAvailabilityResponse, type CalendarWindowResult, type RequestedAvailabilityWindow } from "@orca/shared";

export function CalendarAvailabilityPanel({ availability, defaultOpen = false }: {
  availability: CalendarAvailabilityResponse;
  defaultOpen?: boolean;
}) {
  const calendarNames = new Map(availability.calendars.map((calendar) => [calendar.id, calendar.displayName]));
  return (
    <details className="reply-availability" open={defaultOpen}>
      <summary>
        <span aria-hidden="true" className="reply-availability-disclosure">›</span>
        <span><strong>Calendar availability</strong><small>{scopeLabel(availability)}</small></span>
      </summary>
      <div className="reply-availability-body">
        <div className="reply-availability-scope">
          <span>Using</span>
          {availability.calendars.filter((calendar) => calendar.selected).map((calendar) => (
            <span className="reply-availability-calendar" key={calendar.id}>{calendar.displayName}</span>
          ))}
          {availability.calendars.every((calendar) => !calendar.selected) ? <span className="reply-availability-calendar">No calendars selected</span> : null}
        </div>
        <div className="reply-availability-windows">
          {availability.request.requestedWindows.map((window) => (
            <AvailabilityWindow
              calendarNames={calendarNames}
              key={window.id}
              result={availability.results.find((candidate) => candidate.windowId === window.id)}
              window={window}
            />
          ))}
        </div>
        <p className="reply-availability-privacy">Free/busy only · No event titles, attendees, locations, descriptions, or notes.</p>
        <p className="reply-availability-human">You write the response and confirm the final time. Orca has not booked or held anything.</p>
      </div>
    </details>
  );
}

export function SchedulingAvailabilityPreviewPage({ theme, setTheme }: {
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}) {
  return <main className="availability-preview-page">
    <header className="attention-settings-topbar"><a className="settings-brand" href="/"><span aria-hidden="true">◒</span> Orca</a><div className="settings-topbar-actions"><span className="availability-preview-fixture">Scheduling fixture</span><button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button></div></header>
    <div className="availability-preview-layout">
      <section className="availability-preview-message" id="message-msg_schedule">
        <p className="settings-eyebrow">Message from Maya Chen</p>
        <h1>Time to review the proposal</h1>
        <p>Could we meet Tuesday, November 3 from 1:00–1:30 PM Mountain, 2:00–2:30 PM Mountain, or Thursday afternoon? I need 30 minutes to review the proposal.</p>
        <small>Received Nov 2 · Human Signal is independent from calendar availability</small>
      </section>
      <aside className="availability-preview-brief" aria-labelledby="availability-brief-title">
        <header><div><p className="settings-eyebrow">Reply Brief</p><h2 id="availability-brief-title">What needs your reply</h2></div><span>Guidance only</span></header>
        <p className="availability-preview-intent">{schedulingReplyBriefFixture.intent?.summary}</p>
        <CalendarAvailabilityPanel availability={schedulingAvailabilityFixture} defaultOpen />
        <div className="availability-preview-human-space"><strong>Your response stays yours.</strong><p>Use this context when you write. Orca has not drafted, sent, held, or booked anything.</p></div>
      </aside>
    </div>
  </main>;
}

function AvailabilityWindow({ calendarNames, result, window }: {
  calendarNames: Map<string, string>;
  result?: CalendarWindowResult;
  window: RequestedAvailabilityWindow;
}) {
  const status = result?.status ?? "unknown";
  const messageSource = result?.sources.find((source) => source.kind === "message");
  return (
    <article className={`reply-availability-window reply-availability-window-${status}`}>
      <div className="reply-availability-window-heading">
        <div>
          <p className="reply-availability-request">“{window.sourceText}”</p>
          <p className="reply-availability-time">{formatWindow(window)}</p>
          <p className="reply-availability-original">{originalTimeZoneLabel(window)}</p>
        </div>
        <span className={`reply-availability-status reply-availability-status-${status}`}>{statusLabel(status)}</span>
      </div>
      {window.ambiguities.length > 0 ? (
        <ul className="reply-availability-ambiguities">
          {window.ambiguities.map((ambiguity) => <li key={`${ambiguity.code}:${ambiguity.sourceText}`}>{ambiguity.message}</li>)}
        </ul>
      ) : null}
      <p className="reply-availability-explanation">{result?.explanation ?? "Availability was not checked."}</p>
      <div className="reply-availability-sources">
        {messageSource?.kind === "message" ? <a href={messageSource.url}>Source message ↗</a> : null}
        {result?.checkedAt ? <span>Checked {formatInstant(result.checkedAt, window.userTimeZone)}</span> : <span>Not checked</span>}
        {result?.freshness === "stale" ? <span className="reply-availability-stale">Stale</span> : null}
        {result?.calendarResults.map((calendar) => (
          <span key={calendar.calendarId}>{calendarNames.get(calendar.calendarId) ?? "Selected calendar"}: {statusLabel(calendar.status)}</span>
        ))}
      </div>
    </article>
  );
}

function formatWindow(window: RequestedAvailabilityWindow) {
  if (!window.start || !window.end) return "Needs your interpretation";
  const start = new Date(window.start);
  const end = new Date(window.end);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: window.userTimeZone, weekday: "short", month: "short", day: "numeric" }).format(start);
  const startTime = new Intl.DateTimeFormat("en-US", { timeZone: window.userTimeZone, hour: "numeric", minute: "2-digit" }).format(start);
  const endTime = new Intl.DateTimeFormat("en-US", { timeZone: window.userTimeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(end);
  return `${date} · ${startTime}–${endTime}`;
}

function formatInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(value));
}

function originalTimeZoneLabel(window: RequestedAvailabilityWindow) {
  if (!window.originalTimeZone) return "Original timezone not stated";
  return window.originalTimeZone === window.userTimeZone
    ? `Shown in your timezone · ${window.userTimeZone}`
    : `Shown in your timezone · original ${window.originalTimeZone}`;
}

function statusLabel(status: CalendarWindowResult["status"]) {
  if (status === "free") return "Free";
  if (status === "busy") return "Busy";
  return "Unknown";
}

function scopeLabel(availability: CalendarAvailabilityResponse) {
  const selected = availability.calendars.filter((calendar) => calendar.selected).length;
  if (!availability.connection || availability.connection.state !== "connected") return "Unavailable to check";
  return `${selected} selected calendar${selected === 1 ? "" : "s"} · free/busy only`;
}
