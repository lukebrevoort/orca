import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { schedulingAvailabilityFixture } from "@orca/shared";

import { CalendarAvailabilityPanel } from "./calendar-availability-panel.tsx";

describe("CalendarAvailabilityPanel", () => {
  test("shows source-linked free, busy, unknown, scope, freshness, and human ownership", () => {
    const html = renderToStaticMarkup(<CalendarAvailabilityPanel availability={schedulingAvailabilityFixture} defaultOpen />);
    expect(html).toContain("Calendar availability");
    expect(html).toContain("Work");
    expect(html).toContain("Focus blocks");
    expect(html).toContain("Free");
    expect(html).toContain("Busy");
    expect(html).toContain("Unknown");
    expect(html).toContain("Source message");
    expect(html).toContain("Original timezone not stated");
    expect(html).toContain("No event titles, attendees, locations, descriptions, or notes");
    expect(html).toContain("You write the response and confirm the final time");
    expect(html).not.toMatch(/accept|decline|book now|send reply/i);
  });

  test("keeps interpreted requests visible without a calendar grant", () => {
    const unavailable = {
      ...schedulingAvailabilityFixture,
      connection: null,
      calendars: [],
      checkedAt: null,
      results: schedulingAvailabilityFixture.request.requestedWindows.map((window) => ({
        windowId: window.id,
        status: "unknown" as const,
        freshness: "unchecked" as const,
        unknownReason: "calendar_not_connected" as const,
        checkedAt: null,
        calendarResults: [],
        sources: [{ kind: "message" as const, messageId: window.messageId, url: window.sourceUrl, sourceText: window.sourceText }],
        explanation: "No calendar is connected. The interpreted request remains visible, but availability is unavailable.",
      })),
    };
    const html = renderToStaticMarkup(<CalendarAvailabilityPanel availability={unavailable} defaultOpen />);
    expect(html).toContain("Unavailable to check");
    expect(html).toContain("Tuesday, November 3 from 1:00–1:30 PM Mountain");
    expect(html.match(/Unknown/g)?.length).toBe(3);
  });
});

