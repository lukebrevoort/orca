import type { CalendarBusyInterval } from "@orca/shared";

const calendarApiBase = "https://www.googleapis.com/calendar/v3";

export type CalendarFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GoogleCalendarSummary = {
  providerCalendarId: string;
  displayName: string;
  timeZone: string | null;
  primary: boolean;
  providerSelected: boolean;
  accessRole: string;
};

export type GoogleFreeBusyResult = {
  providerCalendarId: string;
  busy: CalendarBusyInterval[];
  error: string | null;
};

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "provider" | "invalid_response",
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

export function createGoogleCalendarClient(fetchImpl: CalendarFetch = fetch) {
  return {
    async listCalendars(accessToken: string): Promise<GoogleCalendarSummary[]> {
      const calendars: GoogleCalendarSummary[] = [];
      let pageToken: string | null = null;
      do {
        const url = new URL(`${calendarApiBase}/users/me/calendarList`);
        url.searchParams.set("maxResults", "250");
        url.searchParams.set("minAccessRole", "freeBusyReader");
        // Allowlist avoids bringing event-adjacent calendar description or
        // location fields into Orca's availability boundary.
        url.searchParams.set("fields", "items(id,summary,summaryOverride,timeZone,primary,selected,accessRole),nextPageToken");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
        await requireGoogleResponse(response, "Google could not list calendars.");
        const body = await readObject(response);
        const items = Array.isArray(body.items) ? body.items : [];
        for (const value of items) {
          if (!isObject(value) || typeof value.id !== "string" || !value.id.trim()) continue;
          const summary = typeof value.summaryOverride === "string" && value.summaryOverride.trim()
            ? value.summaryOverride
            : typeof value.summary === "string" && value.summary.trim()
              ? value.summary
              : "Calendar";
          calendars.push({
            providerCalendarId: value.id,
            displayName: summary.slice(0, 500),
            timeZone: typeof value.timeZone === "string" && value.timeZone ? value.timeZone : null,
            primary: value.primary === true,
            providerSelected: value.selected === true,
            accessRole: typeof value.accessRole === "string" ? value.accessRole : "freeBusyReader",
          });
        }
        pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      } while (pageToken);
      return calendars;
    },

    async queryFreeBusy(input: {
      accessToken: string;
      providerCalendarIds: string[];
      start: string;
      end: string;
      timeZone: string;
    }): Promise<GoogleFreeBusyResult[]> {
      if (input.providerCalendarIds.length === 0) return [];
      if (input.providerCalendarIds.length > 50) throw new GoogleCalendarError("Google free/busy accepts at most 50 calendars.", "provider", 400);
      const response = await fetchImpl(`${calendarApiBase}/freeBusy`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          timeMin: input.start,
          timeMax: input.end,
          timeZone: input.timeZone,
          calendarExpansionMax: 50,
          items: input.providerCalendarIds.map((id) => ({ id })),
        }),
      });
      await requireGoogleResponse(response, "Google could not check calendar free/busy.");
      const body = await readObject(response);
      const calendars = isObject(body.calendars) ? body.calendars : {};
      return input.providerCalendarIds.map((providerCalendarId) => {
        const raw = calendars[providerCalendarId];
        if (!isObject(raw)) return { providerCalendarId, busy: [], error: "missingResult" };
        const providerErrors = Array.isArray(raw.errors)
          ? raw.errors.filter(isObject).map((error) => typeof error.reason === "string" ? error.reason : "providerError")
          : [];
        const busy = Array.isArray(raw.busy)
          ? raw.busy.flatMap((interval): CalendarBusyInterval[] => {
            if (!isObject(interval) || typeof interval.start !== "string" || typeof interval.end !== "string") return [];
            const start = new Date(interval.start);
            const end = new Date(interval.end);
            if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) return [];
            return [{ start: start.toISOString(), end: end.toISOString() }];
          })
          : [];
        return { providerCalendarId, busy, error: providerErrors[0] ?? null };
      });
    },
  };
}

async function requireGoogleResponse(response: Response, message: string) {
  if (response.ok) return;
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) {
    throw new GoogleCalendarError("Google Calendar authorization expired or was revoked.", "auth", response.status);
  }
  throw new GoogleCalendarError(message, "provider", response.status);
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (isObject(body)) return body;
  } catch {
    // Fall through to a stable privacy-safe error.
  }
  throw new GoogleCalendarError("Google returned an invalid Calendar response.", "invalid_response", 502);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

