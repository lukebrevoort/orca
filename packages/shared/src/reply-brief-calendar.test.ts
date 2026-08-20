import { describe, expect, test } from "bun:test";

import { schedulingAvailabilityFixture } from "./fixtures.ts";
import { redactedSchedulingReplyBriefFixture } from "./reply-brief.fixture.ts";
import {
  createDeterministicReplyBrief,
  createReplyBriefAvailabilityContext,
  replyBriefAvailabilitySchema,
} from "./reply-brief.ts";

describe("Calendar availability -> Reply Brief privacy adapter", () => {
  test("passes only flattened free/busy intervals into the model-facing envelope", () => {
    const context = createReplyBriefAvailabilityContext(schedulingAvailabilityFixture, "2026-11-03T19:56:00.000Z");
    expect(context).toEqual({
      kind: "free_busy_only",
      timeZone: "America/Denver",
      windowStart: "2026-11-03T20:00:00.000Z",
      windowEnd: "2026-11-03T21:30:00.000Z",
      busy: [{ start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:30:00.000Z" }],
      observedAt: "2026-11-03T19:56:00.000Z",
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("luke@example.com");
    expect(serialized).not.toContain("Work");
    expect(serialized).not.toContain("calendar-work");
    expect(serialized).not.toContain("Tuesday, November");
  });

  test("preserves unavailable as unavailable when no grant exists", () => {
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
    const context = replyBriefAvailabilitySchema.parse(createReplyBriefAvailabilityContext(unavailable, "2026-11-03T19:56:00.000Z"));
    expect(context).toMatchObject({ kind: "unavailable", reason: "calendar_not_connected" });
    const brief = createDeterministicReplyBrief({ ...redactedSchedulingReplyBriefFixture, availability: context });
    expect(brief.availabilityContext.status).toBe("unavailable");
    expect(brief.considerations[0]?.text).toContain("Do not treat missing calendar context as a recommendation");
  });
});
