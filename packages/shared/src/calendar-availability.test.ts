import { describe, expect, test } from "bun:test";

import {
  calendarAvailabilityRequestSchema,
  calendarAvailabilityResponseSchema,
} from "./calendar-availability.ts";

const exactWindow = {
  id: "window-1",
  messageId: "message-1",
  sourceText: "Tuesday from 2–2:30 PM Mountain",
  sourceUrl: "http://localhost:5173/?thread=thread-1&message=message-1",
  originalTimeZone: "America/Denver",
  userTimeZone: "America/New_York",
  start: "2026-11-03T21:00:00.000Z",
  end: "2026-11-03T21:30:00.000Z",
  durationMinutes: 30,
  interpretation: "exact" as const,
  ambiguities: [],
};

describe("calendar availability contract", () => {
  test("accepts a provider-neutral multi-calendar request", () => {
    expect(calendarAvailabilityRequestSchema.parse({
      connectionId: "calendar-connection-1",
      requestedWindows: [exactWindow],
      userTimeZone: "America/New_York",
      workingHours: {
        timeZone: "America/New_York",
        days: [{ day: 2, startLocal: "09:00", endLocal: "17:00" }],
      },
    }).requestedWindows[0]?.start).toBe(exactWindow.start);
  });

  test("requires ambiguity to stay explicit rather than guessing a time", () => {
    expect(() => calendarAvailabilityRequestSchema.parse({
      connectionId: "calendar-connection-1",
      requestedWindows: [{ ...exactWindow, interpretation: "ambiguous", ambiguities: [] }],
      userTimeZone: "America/New_York",
      workingHours: null,
    })).toThrow();
  });

  test("distinguishes unknown stale availability from free", () => {
    const request = calendarAvailabilityRequestSchema.parse({
      connectionId: "calendar-connection-1",
      requestedWindows: [exactWindow],
      userTimeZone: "America/New_York",
      workingHours: null,
    });
    const parsed = calendarAvailabilityResponseSchema.parse({
      request,
      connection: null,
      calendars: [],
      results: [{
        windowId: exactWindow.id,
        status: "unknown",
        freshness: "stale",
        unknownReason: "stale_data",
        checkedAt: "2026-11-03T20:00:00.000Z",
        calendarResults: [],
        sources: [{ kind: "message", messageId: exactWindow.messageId, url: exactWindow.sourceUrl, sourceText: exactWindow.sourceText }],
        explanation: "The last check is stale.",
      }],
      checkedAt: "2026-11-03T20:00:00.000Z",
      staleAfterMinutes: 15,
      limitations: ["Availability is informational only."],
      humanConfirmationRequired: true,
    });
    expect(parsed.results[0]?.status).toBe("unknown");
    expect(parsed.results[0]?.freshness).toBe("stale");
  });
});

