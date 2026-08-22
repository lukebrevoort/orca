import { describe, expect, test } from "bun:test";

import { createGoogleCalendarClient, GoogleCalendarError } from "./google-client.ts";

describe("Google Calendar read-only client", () => {
  test("lists only allowlisted calendar metadata and paginates", async () => {
    const requests: URL[] = [];
    const client = createGoogleCalendarClient(async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      return Response.json(url.searchParams.has("pageToken") ? {
        items: [{ id: "focus@example.com", summaryOverride: "Focus", description: "must not leave provider boundary", timeZone: "America/Denver", selected: false, accessRole: "reader" }],
      } : {
        items: [{ id: "primary@example.com", summary: "Work", location: "private", timeZone: "America/Denver", primary: true, selected: true, accessRole: "owner" }],
        nextPageToken: "page-2",
      });
    });
    expect(await client.listCalendars("secret-token")).toEqual([
      { providerCalendarId: "primary@example.com", displayName: "Work", timeZone: "America/Denver", primary: true, providerSelected: true, accessRole: "owner" },
      { providerCalendarId: "focus@example.com", displayName: "Focus", timeZone: "America/Denver", primary: false, providerSelected: false, accessRole: "reader" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.searchParams.get("fields")).not.toContain("description");
    expect(requests[0]?.searchParams.get("fields")).not.toContain("location");
  });

  test("posts only calendar IDs and returns busy ranges without event content", async () => {
    let sentBody: unknown;
    const client = createGoogleCalendarClient(async (_input, init) => {
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ calendars: {
        "primary@example.com": { busy: [{ start: "2026-11-03T20:00:00-07:00", end: "2026-11-03T21:00:00-07:00", summary: "private title" }] },
        "focus@example.com": { errors: [{ reason: "notFound" }], busy: [] },
      } });
    });
    const result = await client.queryFreeBusy({
      accessToken: "secret-token",
      providerCalendarIds: ["primary@example.com", "focus@example.com"],
      start: "2026-11-03T19:00:00.000Z",
      end: "2026-11-04T00:00:00.000Z",
      timeZone: "America/Denver",
    });
    expect(sentBody).toEqual({
      timeMin: "2026-11-03T19:00:00.000Z",
      timeMax: "2026-11-04T00:00:00.000Z",
      timeZone: "America/Denver",
      calendarExpansionMax: 50,
      items: [{ id: "primary@example.com" }, { id: "focus@example.com" }],
    });
    expect(result).toEqual([
      { providerCalendarId: "primary@example.com", busy: [{ start: "2026-11-04T03:00:00.000Z", end: "2026-11-04T04:00:00.000Z" }], error: null },
      { providerCalendarId: "focus@example.com", busy: [], error: "notFound" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private title");
  });

  test("maps an expired grant without exposing provider response bodies", async () => {
    const client = createGoogleCalendarClient(async () => new Response("token details", { status: 401 }));
    await expect(client.listCalendars("expired-token")).rejects.toEqual(
      new GoogleCalendarError("Google Calendar authorization expired or was revoked.", "auth", 401),
    );
  });
});

