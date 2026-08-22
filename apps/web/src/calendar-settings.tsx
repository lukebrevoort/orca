import { useEffect, useMemo, useState } from "react";
import {
  availabilityCalendarPageSchema,
  calendarConnectionPageSchema,
  calendarPreferencesSchema,
  schedulingAvailabilityFixture,
  type AvailabilityCalendar,
  type CalendarConnection,
  type CalendarPreferences,
} from "@orca/shared";

type CalendarWithConnection = AvailabilityCalendar & { connection: CalendarConnection };
const defaultPreferences: CalendarPreferences = {
  userTimeZone: "UTC",
  workingHours: null,
  staleAfterMinutes: 15,
};

export function CalendarSettingsPage({ demoMode = false, demoState = "connected", theme, setTheme }: {
  demoMode?: boolean;
  demoState?: "connected" | "disconnected" | "error";
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}) {
  const demoConnected = demoMode && demoState === "connected";
  const [connections, setConnections] = useState<CalendarConnection[]>(demoConnected && schedulingAvailabilityFixture.connection ? [schedulingAvailabilityFixture.connection] : []);
  const [calendars, setCalendars] = useState<CalendarWithConnection[]>(demoConnected && schedulingAvailabilityFixture.connection
    ? schedulingAvailabilityFixture.calendars.map((calendar) => ({ ...calendar, connection: schedulingAvailabilityFixture.connection! }))
    : []);
  const [preferences, setPreferences] = useState<CalendarPreferences>(demoMode ? {
    userTimeZone: schedulingAvailabilityFixture.request.userTimeZone,
    workingHours: schedulingAvailabilityFixture.request.workingHours,
    staleAfterMinutes: schedulingAvailabilityFixture.staleAfterMinutes,
  } : defaultPreferences);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">(demoMode ? (demoState === "error" ? "error" : "ready") : "loading");
  const [message, setMessage] = useState<string | null>(demoState === "error" ? "Calendar consent needs server setup. Reuse the Google OAuth client and add the Calendar callback URL." : null);
  const [selectedIds, setSelectedIds] = useState(() => new Set(calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id)));
  const activeConnection = connections.find((connection) => connection.state === "connected") ?? connections[0] ?? null;
  const workingDays = useMemo(() => new Set(preferences.workingHours?.days.map((day) => day.day) ?? []), [preferences.workingHours]);
  const workingStart = preferences.workingHours?.days[0]?.startLocal ?? "09:00";
  const workingEnd = preferences.workingHours?.days[0]?.endLocal ?? "17:00";

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    void loadCalendarSettings(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setConnections(loaded.connections);
      setCalendars(loaded.calendars);
      setSelectedIds(new Set(loaded.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id)));
      setPreferences(loaded.preferences);
      const callbackNotice = getCalendarCallbackNotice();
      const notice = loaded.error ? { error: true, message: loaded.error } : callbackNotice;
      setStatus(notice?.error ? "error" : "ready");
      setMessage(notice?.message ?? null);
    }).catch((error) => {
      if (!controller.signal.aborted) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Calendar settings could not be loaded."); }
    });
    return () => controller.abort();
  }, [demoMode]);

  async function connect() {
    setStatus("saving"); setMessage(null);
    if (demoMode) { setStatus("ready"); setMessage("Demo preview keeps the example Calendar connection in place."); return; }
    try {
      const returnTo = `${window.location.origin}/settings/integrations/calendar`;
      const response = await fetch(`/v1/auth/calendar/google/connect?${new URLSearchParams({ returnTo })}`, { credentials: "include" });
      const body = await readObject(response);
      if (!response.ok || typeof body.authUrl !== "string") throw new Error(readApiError(body, "Could not start Calendar consent."));
      window.location.assign(body.authUrl);
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Could not start Calendar consent."); }
  }

  async function save() {
    if (!activeConnection) return;
    setStatus("saving"); setMessage(null);
    const days = [...workingDays].sort().map((day) => ({ day, startLocal: workingStart, endLocal: workingEnd }));
    const nextPreferences: CalendarPreferences = {
      ...preferences,
      workingHours: days.length ? { timeZone: preferences.userTimeZone, days } : null,
    };
    if (demoMode) { setPreferences(nextPreferences); setStatus("ready"); setMessage("Calendar scope saved in this preview."); return; }
    try {
      const [selectionResponse, preferenceResponse] = await Promise.all([
        fetch("/v1/calendar/calendars/selection", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: activeConnection.id, selectedCalendarIds: [...selectedIds] }) }),
        fetch("/v1/calendar/preferences", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(nextPreferences) }),
      ]);
      if (!selectionResponse.ok || !preferenceResponse.ok) throw new Error("Calendar choices were not saved.");
      setPreferences(calendarPreferencesSchema.parse(await preferenceResponse.json()));
      setCalendars((current) => current.map((calendar) => ({ ...calendar, selected: selectedIds.has(calendar.id) })));
      setStatus("ready"); setMessage("Calendar scope saved.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Calendar choices were not saved."); }
  }

  async function revoke() {
    if (!activeConnection || !window.confirm(`Revoke free/busy access for ${activeConnection.accountLabel}?`)) return;
    if (demoMode) { setConnections((current) => current.map((connection) => ({ ...connection, state: "revoked", error: null }))); setStatus("ready"); setMessage("Calendar access revoked in this preview."); return; }
    setStatus("saving"); setMessage(null);
    try {
      const response = await fetch(`/v1/calendar/connections/${encodeURIComponent(activeConnection.id)}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error("Calendar access could not be revoked.");
      setConnections((current) => current.map((connection) => connection.id === activeConnection.id ? { ...connection, state: "revoked", error: null } : connection));
      setStatus("ready"); setMessage("Calendar access revoked. Orca can no longer check availability.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Calendar access could not be revoked."); }
  }

  function toggleWorkingDay(day: number) {
    const next = new Set(workingDays);
    if (next.has(day)) next.delete(day); else next.add(day);
    setPreferences((current) => ({ ...current, workingHours: next.size ? { timeZone: current.userTimeZone, days: [...next].sort().map((value) => ({ day: value, startLocal: workingStart, endLocal: workingEnd })) } : null }));
  }

  const connected = activeConnection?.state === "connected";

  return <main className="calendar-settings-page">
    <header className="attention-settings-topbar calendar-settings-topbar">
      <a className="settings-brand" href="/"><span aria-hidden="true">◒</span> Orca</a>
      <div className="settings-topbar-actions">
        <a className="settings-back-link" href="/settings">← Settings</a>
        <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
      </div>
    </header>
    <section className="calendar-settings-shell" aria-labelledby="calendar-settings-title">
      <aside className="calendar-settings-intro">
        <p className="settings-eyebrow">Settings / Calendar availability</p>
        <h1 id="calendar-settings-title">Your time,<br /><em>still yours.</em></h1>
        <p>Let Orca answer one narrow question: are you free? Your calendar stays private, and every final plan stays yours.</p>
        <div aria-hidden="true" className="calendar-orbit">
          <span className="calendar-orbit-ring" />
          <span className="calendar-orbit-day">14</span>
          <span className="calendar-orbit-dot" />
        </div>
        <ol className="calendar-scope-points">
          <li><span>01</span><div><strong>Choose the calendars</strong><small>Only calendars you select participate.</small></div></li>
          <li><span>02</span><div><strong>Share free or busy</strong><small>No event content crosses the boundary.</small></div></li>
          <li><span>03</span><div><strong>Keep the final say</strong><small>Orca never books, replies, or accepts.</small></div></li>
        </ol>
      </aside>

      <div className="calendar-settings-workspace">
        <header className="calendar-workspace-heading">
          <div><span>Google Calendar</span><h2>Availability access</h2></div>
          <span className="calendar-readonly-badge"><i aria-hidden="true" /> Free/busy only</span>
        </header>

        <section aria-busy={status === "loading" || status === "saving"} className="calendar-settings-card">
          <div className="calendar-connection-heading">
            <div className="calendar-provider-mark" aria-hidden="true"><span>31</span></div>
            <div className="calendar-connection-copy">
              <span>Dedicated read-only connection</span>
              <strong>{activeConnection?.accountLabel ?? "Google Calendar"}</strong>
              <small>{connected ? "Connected · availability checks are active" : activeConnection ? `Access ${activeConnection.state}` : "Not connected yet"}</small>
            </div>
            <span className="calendar-status-indicator" data-state={connected ? "connected" : "disconnected"}>{connected ? "Connected" : "Not connected"}</span>
          </div>

          {status === "loading" ? <div className="calendar-loading" role="status"><span aria-hidden="true" /><p><strong>Loading calendar scope</strong><small>Checking your private connection…</small></p></div> : !connected ? <div className="calendar-consent-panel">
            <div>
              <strong>Connect with a separate consent</strong>
              <p>Your Gmail permission does not silently include Calendar. Google will show the exact free/busy and calendar-list scopes first.</p>
            </div>
            <button className="calendar-primary-action" disabled={status === "saving"} onClick={() => void connect()} type="button">
              <span>{status === "saving" ? "Opening Google…" : "Continue with Google"}</span><span aria-hidden="true">→</span>
            </button>
          </div> : <div className="calendar-connected-settings">
            <fieldset className="calendar-selection">
              <legend>Calendars that participate</legend>
              <p>Selected calendars contribute only a Free, Busy, or Unknown result.</p>
              <div className="calendar-selection-list">{calendars.map((calendar) => <label data-selected={selectedIds.has(calendar.id)} key={calendar.id}>
                <input checked={selectedIds.has(calendar.id)} disabled={status === "saving"} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(calendar.id)) next.delete(calendar.id); else next.add(calendar.id); return next; })} type="checkbox" />
                <span className="calendar-check" aria-hidden="true">✓</span>
                <span><strong>{calendar.displayName}</strong><small>{calendar.primary ? "Primary calendar" : calendar.timeZone ?? "Calendar timezone unavailable"}</small></span>
                <small>{selectedIds.has(calendar.id) ? "Included" : "Ignored"}</small>
              </label>)}</div>
            </fieldset>
            <fieldset className="calendar-working-hours">
              <legend>Working-hours context</legend>
              <p>Used only to explain timing—not to decline or move anything.</p>
              <label className="calendar-timezone-field"><span>Your timezone</span><input onChange={(event) => setPreferences((current) => ({ ...current, userTimeZone: event.target.value, workingHours: current.workingHours ? { ...current.workingHours, timeZone: event.target.value } : null }))} value={preferences.userTimeZone} /></label>
              <div aria-label="Working days" className="calendar-day-choices">{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]].map(([day,label]) => <button aria-pressed={workingDays.has(day as number)} key={label} onClick={() => toggleWorkingDay(day as number)} type="button">{label}</button>)}</div>
              <div className="calendar-hours-row"><label><span>From</span><input onChange={(event) => setPreferences((current) => ({ ...current, workingHours: { timeZone: current.userTimeZone, days: [...workingDays].sort().map((day) => ({ day, startLocal: event.target.value, endLocal: workingEnd })) } }))} type="time" value={workingStart} /></label><label><span>To</span><input onChange={(event) => setPreferences((current) => ({ ...current, workingHours: { timeZone: current.userTimeZone, days: [...workingDays].sort().map((day) => ({ day, startLocal: workingStart, endLocal: event.target.value })) } }))} type="time" value={workingEnd} /></label></div>
            </fieldset>
            <div className="calendar-settings-actions"><button className="calendar-secondary-action" disabled={status === "saving"} onClick={() => void revoke()} type="button">Revoke access</button><button className="calendar-primary-action" disabled={status === "saving"} onClick={() => void save()} type="button"><span>{status === "saving" ? "Saving…" : "Save calendar scope"}</span><span aria-hidden="true">→</span></button></div>
          </div>}

          {message ? <div className={`calendar-settings-message${status === "error" ? " calendar-settings-message-error" : ""}`} role={status === "error" ? "alert" : "status"}><span aria-hidden="true">{status === "error" ? "!" : "✓"}</span><p>{message}</p></div> : null}
        </section>

        <aside className="calendar-privacy-note"><span aria-hidden="true">◇</span><div><strong>Private by design</strong><p>No event titles, descriptions, attendees, locations, or notes are read. There is no create, update, invite, accept, decline, or booking action.</p></div></aside>
      </div>
    </section>
  </main>;
}

async function loadCalendarSettings(signal: AbortSignal) {
  const [connectionResponse, preferenceResponse] = await Promise.all([
    fetch("/v1/calendar/connections", { credentials: "include", signal }),
    fetch("/v1/calendar/preferences", { credentials: "include", signal }),
  ]);
  if (!connectionResponse.ok) throw new Error(readApiError(await readObject(connectionResponse), "Calendar settings could not be loaded."));
  if (!preferenceResponse.ok) throw new Error(readApiError(await readObject(preferenceResponse), "Calendar settings could not be loaded."));
  const connections = calendarConnectionPageSchema.parse(await connectionResponse.json()).items;
  const preferences = calendarPreferencesSchema.parse(await preferenceResponse.json());
  const pages = await Promise.all(connections.map(async (connection) => {
    const response = await fetch(`/v1/calendar/calendars?${new URLSearchParams({ connectionId: connection.id })}`, { credentials: "include", signal });
    const body = await readObject(response);
    const page = availabilityCalendarPageSchema.parse({ connection: body.connection, calendars: body.calendars });
    return {
      calendars: page.calendars.map((calendar) => ({ ...calendar, connection: page.connection })),
      error: response.ok ? null : readApiError(body, "Google Calendar could not be loaded. Try reconnecting."),
    };
  }));
  return {
    connections,
    preferences,
    calendars: pages.flatMap((page) => page.calendars),
    error: pages.find((page) => page.error)?.error ?? null,
  };
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

export function readApiError(body: Record<string, unknown>, fallback: string) {
  const nested = body.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function getCalendarCallbackNotice() {
  if (typeof window === "undefined") return null;
  const status = new URLSearchParams(window.location.search).get("calendar");
  if (!status) return null;
  if (status === "success") return { error: false, message: "Calendar connected. Choose which calendars can contribute availability." };
  const messages: Record<string, string> = {
    provider_error: "Google did not grant Calendar access. Nothing was connected.",
    token_exchange_failed: "Google Calendar authorization could not be completed. Check the authorized Calendar callback URL and try again.",
    scope_not_granted: "Google did not grant both free/busy and calendar-list access. Try again and approve the displayed scopes.",
    identity_failed: "Google could not confirm the Calendar account. Please try again.",
    persistence_failed: "Orca could not safely store the Calendar grant. Please try again.",
  };
  return { error: true, message: messages[status] ?? "Calendar authorization did not finish. Please try again." };
}
