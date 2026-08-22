import {
  calendarAvailabilityResponseSchema,
  type AvailabilityCalendar,
  type CalendarAvailabilityRequest,
  type CalendarAvailabilityResponse,
  type CalendarBusyInterval,
  type CalendarConnection,
  type CalendarGrantState,
  type CalendarScopedResult,
} from "@orca/shared";

export const defaultAvailabilityStaleAfterMinutes = 15;

export type ProviderCalendarResult = {
  calendarId: string;
  busy: CalendarBusyInterval[];
  error: string | null;
};

export function compareCalendarAvailability(input: {
  request: CalendarAvailabilityRequest;
  connection: CalendarConnection | null;
  calendars: AvailabilityCalendar[];
  providerResults?: ProviderCalendarResult[];
  checkedAt?: Date | null;
  now?: Date;
  staleAfterMinutes?: number;
}): CalendarAvailabilityResponse {
  const now = input.now ?? new Date();
  const checkedAt = input.checkedAt ?? null;
  const staleAfterMinutes = input.staleAfterMinutes ?? defaultAvailabilityStaleAfterMinutes;
  const selectedCalendars = input.calendars.filter((calendar) => calendar.selected);
  const providerResults = new Map((input.providerResults ?? []).map((result) => [result.calendarId, result]));
  const freshness = checkedAt === null
    ? "unchecked" as const
    : now.getTime() - checkedAt.getTime() > staleAfterMinutes * 60_000
      ? "stale" as const
      : "fresh" as const;

  const results = input.request.requestedWindows.map((window) => {
    const messageSource = {
      kind: "message" as const,
      messageId: window.messageId,
      url: window.sourceUrl,
      sourceText: window.sourceText,
    };
    if (window.interpretation === "ambiguous" || !window.start || !window.end) {
      return {
        windowId: window.id,
        status: "unknown" as const,
        freshness: "unchecked" as const,
        unknownReason: "ambiguous_request" as const,
        checkedAt: null,
        calendarResults: [],
        sources: [messageSource],
        explanation: "The sender's proposed window is ambiguous. A person must resolve it before availability can be asserted.",
      };
    }

    const grantUnknown = unknownReasonForGrant(input.connection?.state ?? "not_connected");
    if (grantUnknown) {
      return {
        windowId: window.id,
        status: "unknown" as const,
        freshness: "unchecked" as const,
        unknownReason: grantUnknown,
        checkedAt: null,
        calendarResults: [],
        sources: [messageSource],
        explanation: grantExplanation(input.connection?.state ?? "not_connected"),
      };
    }

    if (selectedCalendars.length === 0) {
      return {
        windowId: window.id,
        status: "unknown" as const,
        freshness: "unchecked" as const,
        unknownReason: "no_calendars_selected" as const,
        checkedAt: null,
        calendarResults: [],
        sources: [messageSource],
        explanation: "No calendars are selected, so Orca cannot check this window.",
      };
    }

    const calendarResults: CalendarScopedResult[] = selectedCalendars.map((calendar) => {
      const providerResult = providerResults.get(calendar.id);
      if (!providerResult || providerResult.error) {
        return {
          calendarId: calendar.id,
          status: "unknown",
          busy: [],
          error: providerResult?.error ?? "No free/busy result was returned for this calendar.",
        };
      }
      const overlappingBusy = providerResult.busy.filter((interval) => overlaps(window.start!, window.end!, interval));
      return {
        calendarId: calendar.id,
        status: overlappingBusy.length > 0 ? "busy" : "free",
        busy: overlappingBusy,
        error: null,
      };
    });
    const sources = [
      messageSource,
      ...(checkedAt ? calendarResults.map((result) => ({
        kind: "calendar_freebusy" as const,
        calendarId: result.calendarId,
        checkedAt: checkedAt.toISOString(),
      })) : []),
    ];

    if (freshness === "stale") {
      return {
        windowId: window.id,
        status: "unknown" as const,
        freshness,
        unknownReason: "stale_data" as const,
        checkedAt: checkedAt?.toISOString() ?? null,
        calendarResults,
        sources,
        explanation: "The last free/busy check is stale. Orca will not turn old calendar data into a recommendation.",
      };
    }
    if (calendarResults.some((result) => result.status === "unknown")) {
      return {
        windowId: window.id,
        status: "unknown" as const,
        freshness,
        unknownReason: "calendar_error" as const,
        checkedAt: checkedAt?.toISOString() ?? null,
        calendarResults,
        sources,
        explanation: "At least one selected calendar could not be checked, so this window is not known to be free.",
      };
    }
    const busy = calendarResults.some((result) => result.status === "busy");
    return {
      windowId: window.id,
      status: busy ? "busy" as const : "free" as const,
      freshness,
      unknownReason: null,
      checkedAt: checkedAt?.toISOString() ?? null,
      calendarResults,
      sources,
      explanation: busy
        ? "This window overlaps busy time on at least one selected calendar."
        : "No busy time overlaps this window on the selected calendars.",
    };
  });

  return calendarAvailabilityResponseSchema.parse({
    request: input.request,
    connection: input.connection,
    calendars: input.calendars,
    results,
    checkedAt: checkedAt?.toISOString() ?? null,
    staleAfterMinutes,
    limitations: [
      "Orca checks only free/busy ranges from the calendars shown here; it does not read event titles, descriptions, attendees, locations, or notes.",
      "Availability does not schedule, hold, accept, decline, or send anything.",
      "The person writing the response must resolve ambiguity and confirm the final time.",
    ],
    humanConfirmationRequired: true,
  });
}

export function formatAvailabilityInstant(instant: string, timeZone: string, locale = "en-US") {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid availability timestamp");
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function overlaps(windowStart: string, windowEnd: string, interval: CalendarBusyInterval) {
  return Date.parse(interval.start) < Date.parse(windowEnd) && Date.parse(interval.end) > Date.parse(windowStart);
}

function unknownReasonForGrant(state: CalendarGrantState) {
  if (state === "connected") return null;
  if (state === "expired") return "grant_expired" as const;
  if (state === "revoked") return "grant_revoked" as const;
  if (state === "error") return "provider_error" as const;
  return "calendar_not_connected" as const;
}

function grantExplanation(state: CalendarGrantState) {
  if (state === "expired") return "The calendar grant expired. Reconnect before relying on availability.";
  if (state === "revoked") return "Calendar access was revoked. Orca cannot check availability.";
  if (state === "error") return "The calendar provider could not be checked. Orca will not guess availability.";
  return "No calendar is connected. The interpreted request remains visible, but availability is unavailable.";
}

