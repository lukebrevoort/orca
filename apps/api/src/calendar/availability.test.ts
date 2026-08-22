import { describe, expect, test } from "bun:test";
import type { AvailabilityCalendar, CalendarAvailabilityRequest, CalendarConnection } from "@orca/shared";

import { compareCalendarAvailability, formatAvailabilityInstant } from "./availability.ts";

const connection: CalendarConnection = {
  id: "connection-1",
  provider: "google",
  accountLabel: "luke@example.com",
  state: "connected",
  grantedScopes: ["calendar.freebusy"],
  connectedAt: "2026-11-01T00:00:00.000Z",
  error: null,
};
const calendars: AvailabilityCalendar[] = [
  { id: "calendar-work", connectionId: connection.id, provider: "google", displayName: "Work", timeZone: "America/Denver", selected: true, primary: true },
  { id: "calendar-focus", connectionId: connection.id, provider: "google", displayName: "Focus", timeZone: "America/Denver", selected: true, primary: false },
];
const baseWindow = {
  id: "window-1",
  messageId: "message-1",
  sourceText: "Tuesday 1–2 PM Mountain",
  sourceUrl: "http://localhost:5173/?thread=thread-1&message=message-1",
  originalTimeZone: "America/Denver",
  userTimeZone: "America/New_York",
  start: "2026-11-03T20:00:00.000Z",
  end: "2026-11-03T21:00:00.000Z",
  durationMinutes: 60,
  interpretation: "exact" as const,
  ambiguities: [],
};
const request: CalendarAvailabilityRequest = { connectionId: connection.id, requestedWindows: [baseWindow], userTimeZone: "America/New_York", workingHours: null };

describe("deterministic calendar comparison", () => {
  test("marks a window busy when any selected calendar overlaps, including an all-day interval", () => {
    const result = compareCalendarAvailability({
      request,
      connection,
      calendars,
      providerResults: [
        { calendarId: "calendar-work", error: null, busy: [{ start: "2026-11-03T05:00:00.000Z", end: "2026-11-04T05:00:00.000Z" }] },
        { calendarId: "calendar-focus", error: null, busy: [] },
      ],
      checkedAt: new Date("2026-11-03T19:58:00.000Z"),
      now: new Date("2026-11-03T20:00:00.000Z"),
    });
    expect(result.results[0]?.status).toBe("busy");
    expect(result.results[0]?.calendarResults.map((item) => item.status)).toEqual(["busy", "free"]);
  });

  test("merges overlapping calendars conservatively and fails unknown on a calendar error", () => {
    const result = compareCalendarAvailability({
      request,
      connection,
      calendars,
      providerResults: [
        { calendarId: "calendar-work", error: null, busy: [] },
        { calendarId: "calendar-focus", error: "notFound", busy: [] },
      ],
      checkedAt: new Date("2026-11-03T19:58:00.000Z"),
      now: new Date("2026-11-03T20:00:00.000Z"),
    });
    expect(result.results[0]?.status).toBe("unknown");
    expect(result.results[0]?.unknownReason).toBe("calendar_error");
  });

  test("uses only selected calendars", () => {
    const result = compareCalendarAvailability({
      request,
      connection,
      calendars: calendars.map((calendar, index) => ({ ...calendar, selected: index === 0 })),
      providerResults: [
        { calendarId: "calendar-work", error: null, busy: [] },
        { calendarId: "calendar-focus", error: null, busy: [{ start: baseWindow.start, end: baseWindow.end }] },
      ],
      checkedAt: new Date("2026-11-03T19:58:00.000Z"),
      now: new Date("2026-11-03T20:00:00.000Z"),
    });
    expect(result.results[0]?.status).toBe("free");
    expect(result.results[0]?.calendarResults).toHaveLength(1);
  });

  test("never calls an ambiguous natural-language window free", () => {
    const result = compareCalendarAvailability({
      request: {
        ...request,
        requestedWindows: [{
          ...baseWindow,
          sourceText: "Could you do Thursday afternoon?",
          start: null,
          end: null,
          durationMinutes: null,
          interpretation: "ambiguous",
          ambiguities: [{ code: "approximate_time", message: "Afternoon has no exact boundary.", sourceText: "Thursday afternoon" }],
        }],
      },
      connection,
      calendars,
      providerResults: calendars.map((calendar) => ({ calendarId: calendar.id, error: null, busy: [] })),
      checkedAt: new Date("2026-11-03T19:58:00.000Z"),
    });
    expect(result.results[0]?.status).toBe("unknown");
    expect(result.results[0]?.unknownReason).toBe("ambiguous_request");
  });

  test("treats stale data and expired grants as unknown", () => {
    const stale = compareCalendarAvailability({
      request, connection, calendars,
      providerResults: calendars.map((calendar) => ({ calendarId: calendar.id, error: null, busy: [] })),
      checkedAt: new Date("2026-11-03T18:00:00.000Z"),
      now: new Date("2026-11-03T20:00:00.000Z"),
    });
    expect(stale.results[0]?.unknownReason).toBe("stale_data");

    const expired = compareCalendarAvailability({ request, connection: { ...connection, state: "expired" }, calendars });
    expect(expired.results[0]?.unknownReason).toBe("grant_expired");
  });

  test("formats timezones across daylight-saving transitions", () => {
    expect(formatAvailabilityInstant("2026-03-08T08:30:00.000Z", "America/Denver")).toContain("1:30 AM");
    expect(formatAvailabilityInstant("2026-03-08T09:30:00.000Z", "America/Denver")).toContain("3:30 AM");
    expect(formatAvailabilityInstant("2026-11-01T07:30:00.000Z", "America/Denver")).toContain("1:30 AM");
    expect(formatAvailabilityInstant("2026-11-01T08:30:00.000Z", "America/Denver")).toContain("1:30 AM");
  });
});

