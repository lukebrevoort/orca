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

export function CalendarSettingsPage({ demoMode = false, theme, setTheme }: {
  demoMode?: boolean;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}) {
  const [connections, setConnections] = useState<CalendarConnection[]>(demoMode && schedulingAvailabilityFixture.connection ? [schedulingAvailabilityFixture.connection] : []);
  const [calendars, setCalendars] = useState<CalendarWithConnection[]>(demoMode && schedulingAvailabilityFixture.connection
    ? schedulingAvailabilityFixture.calendars.map((calendar) => ({ ...calendar, connection: schedulingAvailabilityFixture.connection! }))
    : []);
  const [preferences, setPreferences] = useState<CalendarPreferences>(demoMode ? {
    userTimeZone: schedulingAvailabilityFixture.request.userTimeZone,
    workingHours: schedulingAvailabilityFixture.request.workingHours,
    staleAfterMinutes: schedulingAvailabilityFixture.staleAfterMinutes,
  } : defaultPreferences);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">(demoMode ? "ready" : "loading");
  const [message, setMessage] = useState<string | null>(null);
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
      setStatus("ready");
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
      if (!response.ok || typeof body.authUrl !== "string") throw new Error("Could not start Calendar consent.");
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

  return <main className="calendar-settings-page">
    <header className="attention-settings-topbar"><a className="settings-brand" href="/"><span aria-hidden="true">◒</span> Orca</a><div className="settings-topbar-actions"><a className="settings-back-link" href="/settings">← Settings</a><button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button></div></header>
    <section className="calendar-settings-shell" aria-labelledby="calendar-settings-title">
      <header className="calendar-settings-intro"><p className="settings-eyebrow">Settings / Calendar availability</p><h1 id="calendar-settings-title">Your time,<br /><em>still yours.</em></h1><p>Connect Calendar separately from Gmail. Orca sees only free/busy ranges from calendars you select.</p></header>
      <section className="calendar-settings-card">
        <div className="calendar-connection-heading"><div><span>Dedicated read-only connection</span><strong>{activeConnection?.accountLabel ?? "No calendar connected"}</strong><small>{activeConnection?.state === "connected" ? "Free/busy access active" : activeConnection ? `Access ${activeConnection.state}` : "Mail permission does not include Calendar"}</small></div><span className="calendar-readonly-badge">Free/busy only</span></div>
        {!activeConnection || activeConnection.state !== "connected" ? <button className="calendar-primary-action" disabled={status === "saving"} onClick={() => void connect()} type="button">{status === "saving" ? "Opening Google…" : "Connect Google Calendar"}</button> : <>
          <fieldset className="calendar-selection"><legend>Calendars that participate</legend><p>Only selected calendars affect Free, Busy, or Unknown. Names are shown so the scope stays visible.</p>{calendars.map((calendar) => <label key={calendar.id}><input checked={selectedIds.has(calendar.id)} disabled={status === "saving"} onChange={() => setSelectedIds((current) => { const next = new Set(current); if (next.has(calendar.id)) next.delete(calendar.id); else next.add(calendar.id); return next; })} type="checkbox" /><span><strong>{calendar.displayName}</strong><small>{calendar.primary ? "Primary calendar" : calendar.timeZone ?? "Calendar timezone unavailable"}</small></span></label>)}</fieldset>
          <fieldset className="calendar-working-hours"><legend>Working-hours context</legend><label className="calendar-timezone-field"><span>Your timezone</span><input onChange={(event) => setPreferences((current) => ({ ...current, userTimeZone: event.target.value, workingHours: current.workingHours ? { ...current.workingHours, timeZone: event.target.value } : null }))} value={preferences.userTimeZone} /></label><div aria-label="Working days" className="calendar-day-choices">{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]].map(([day,label]) => <button aria-pressed={workingDays.has(day as number)} key={label} onClick={() => toggleWorkingDay(day as number)} type="button">{label}</button>)}</div><div className="calendar-hours-row"><label><span>From</span><input onChange={(event) => setPreferences((current) => ({ ...current, workingHours: { timeZone: current.userTimeZone, days: [...workingDays].sort().map((day) => ({ day, startLocal: event.target.value, endLocal: workingEnd })) } }))} type="time" value={workingStart} /></label><label><span>To</span><input onChange={(event) => setPreferences((current) => ({ ...current, workingHours: { timeZone: current.userTimeZone, days: [...workingDays].sort().map((day) => ({ day, startLocal: workingStart, endLocal: event.target.value })) } }))} type="time" value={workingEnd} /></label></div></fieldset>
          <div className="calendar-settings-actions"><button className="calendar-secondary-action" disabled={status === "saving"} onClick={() => void revoke()} type="button">Revoke access</button><button className="calendar-primary-action" disabled={status === "saving"} onClick={() => void save()} type="button">{status === "saving" ? "Saving…" : "Save calendar scope"}</button></div>
        </>}
        {message ? <p className={`calendar-settings-message${status === "error" ? " calendar-settings-message-error" : ""}`} role={status === "error" ? "alert" : "status"}>{message}</p> : null}
      </section>
      <aside className="calendar-privacy-note"><strong>What Orca cannot do</strong><p>No event titles, descriptions, attendees, locations, or notes are read. There is no create, update, invite, accept, decline, or booking action.</p></aside>
    </section>
  </main>;
}

async function loadCalendarSettings(signal: AbortSignal) {
  const [connectionResponse, preferenceResponse] = await Promise.all([
    fetch("/v1/calendar/connections", { credentials: "include", signal }),
    fetch("/v1/calendar/preferences", { credentials: "include", signal }),
  ]);
  if (!connectionResponse.ok || !preferenceResponse.ok) throw new Error("Calendar settings could not be loaded.");
  const connections = calendarConnectionPageSchema.parse(await connectionResponse.json()).items;
  const preferences = calendarPreferencesSchema.parse(await preferenceResponse.json());
  const pages = await Promise.all(connections.map(async (connection) => {
    const response = await fetch(`/v1/calendar/calendars?${new URLSearchParams({ connectionId: connection.id })}`, { credentials: "include", signal });
    const body = await readObject(response);
    const page = availabilityCalendarPageSchema.parse({ connection: body.connection, calendars: body.calendars });
    return page.calendars.map((calendar) => ({ ...calendar, connection: page.connection }));
  }));
  return { connections, preferences, calendars: pages.flat() };
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  try { const value: unknown = await response.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}

