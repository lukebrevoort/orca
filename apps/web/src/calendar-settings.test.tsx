import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CalendarSettingsPage, readApiError } from "./calendar-settings.tsx";

describe("CalendarSettingsPage", () => {
  test("fits Calendar scope into the human-owned, read-only settings flow", () => {
    const html = renderToStaticMarkup(<CalendarSettingsPage demoMode theme="light" setTheme={() => {}} />);

    expect(html).toContain("Your time,");
    expect(html).toContain("Availability access");
    expect(html).toContain("Free/busy only");
    expect(html).toContain("Choose the calendars");
    expect(html).toContain("Private by design");
    expect(html).toContain("No event titles, descriptions, attendees, locations, or notes are read");
    expect(html).toContain("Save calendar scope");
    expect(html).not.toMatch(/book now|accept invite|send reply/i);
  });

  test("surfaces the API's actionable consent setup error", () => {
    expect(readApiError({
      error: {
        code: "calendar_oauth_not_configured",
        message: "Calendar consent needs server setup. Missing: SESSION_SECRET.",
      },
    }, "Could not start Calendar consent.")).toBe("Calendar consent needs server setup. Missing: SESSION_SECRET.");
    expect(readApiError({}, "Could not start Calendar consent.")).toBe("Could not start Calendar consent.");

    const html = renderToStaticMarkup(<CalendarSettingsPage demoMode demoState="error" theme="light" setTheme={() => {}} />);
    expect(html).toContain("Calendar consent needs server setup");
    expect(html).toContain("Continue with Google");
  });
});
