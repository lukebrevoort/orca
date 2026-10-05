import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxApp } from "./App";
import { demoMessages } from "./demo-data";
import { createReceivedAtFormatter, formatReceivedAt } from "./received-at";

const originalDateTimeFormat = Intl.DateTimeFormat;
const now = new Date("2026-10-05T12:00:00.000Z");
const today = "2026-10-05T11:10:00.000Z";
const yesterday = "2026-10-04T11:10:00.000Z";

// Original App.tsx implementation: the label-equivalence oracle for this change.
function legacyFormatReceivedAt(receivedAt: string) {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = date.toDateString() === now.toDateString()
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function observeFormatters(defaultLocale?: string) {
  const calls: Array<{ locales: Intl.LocalesArgument; options: Intl.DateTimeFormatOptions | undefined }> = [];
  Intl.DateTimeFormat = new Proxy(originalDateTimeFormat, {
    construct(target, args) {
      const [locales, options] = args as [Intl.LocalesArgument, Intl.DateTimeFormatOptions | undefined];
      calls.push({ locales, options });
      return new target(locales ?? defaultLocale, options);
    },
  });
  return calls;
}

afterEach(() => {
  Intl.DateTimeFormat = originalDateTimeFormat;
  setSystemTime();
});

describe("render-scoped received-at labels", () => {
  test("constructs nothing for unused or invalid-only renders and lazily reuses each format", () => {
    setSystemTime(now);
    const calls = observeFormatters();
    const format = createReceivedAtFormatter();
    expect(calls).toHaveLength(0);
    for (const invalid of ["", "not-a-date", "2026-99-99", "Infinity"]) expect(format(invalid)).toBe("");
    expect(calls).toHaveLength(0);
    format(today);
    format(today);
    expect(calls).toHaveLength(1);
    format(yesterday);
    format(yesterday);
    expect(calls).toEqual([
      { locales: undefined, options: { hour: "numeric", minute: "2-digit" } },
      { locales: undefined, options: { month: "short", day: "numeric" } },
    ]);
  });

  test("matches legacy output across locale/calendar defaults and edge dates", () => {
    const dates = [today, yesterday, "2026-10-05T00:00:00Z", "2026-10-04T23:59:59Z",
      "2026-10-06T00:00:00Z", "2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z",
      "2026-11-01T08:59:59Z", "2026-11-01T09:00:00Z", "2024-02-29T12:00:00Z",
      "2025-12-31T23:59:59-05:00", "2026-10-05", "2026-10-05T11:10:00+14:00",
      "", "invalid", "+275760-09-13T00:00:00.000Z"];
    for (const locale of ["en-US", "en-GB", "ar-EG", "th-TH-u-ca-buddhist", "ja-JP-u-ca-japanese"]) {
      observeFormatters(locale);
      for (const instant of [now, new Date("2026-03-08T10:00:00Z"), new Date("2026-11-01T09:00:00Z")]) {
        setSystemTime(instant);
        const format = createReceivedAtFormatter();
        expect(dates.map(format)).toEqual(dates.map(legacyFormatReceivedAt));
      }
    }
  });

  test("checks the current local day on each call, including midnight rollover", () => {
    const localMidnight = new Date(2026, 9, 6);
    const receivedAt = new Date(localMidnight.getTime() - 60_000).toISOString();
    const format = createReceivedAtFormatter();
    setSystemTime(new Date(localMidnight.getTime() - 1));
    expect(format(receivedAt)).toBe(legacyFormatReceivedAt(receivedAt));
    setSystemTime(localMidnight);
    expect(format(receivedAt)).toBe(legacyFormatReceivedAt(receivedAt));
  });

  test("resolves defaults afresh for later renders and standalone labels", () => {
    setSystemTime(now);
    for (const locale of ["en-US", "en-GB", "ar-EG"]) {
      const calls = observeFormatters(locale);
      const format = createReceivedAtFormatter();
      const labels = [format(today), format(yesterday)];
      expect(calls).toHaveLength(2);
      expect(labels).toEqual([legacyFormatReceivedAt(today), legacyFormatReceivedAt(yesterday)]);
      expect(formatReceivedAt(today)).toBe(labels[0]);
      expect(formatReceivedAt(yesterday)).toBe(labels[1]);
    }
  });

  test("picks up system timezone changes between renders", () => {
    setSystemTime(now);
    const originalTimezone = process.env.TZ;
    try {
      const labels = [];
      for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
        process.env.TZ = timezone;
        const format = createReceivedAtFormatter();
        const label = format(today);
        labels.push(label);
        expect(label).toBe(legacyFormatReceivedAt(today));
        expect(format(yesterday)).toBe(legacyFormatReceivedAt(yesterday));
        expect(formatReceivedAt(today)).toBe(label);
      }
      expect(new Set(labels).size).toBe(3);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  for (const size of [50, 500]) {
    test(`${size} synthetic rows preserve labels with two constructors instead of ${size}`, () => {
      setSystemTime(now);
      const dates = Array.from({ length: size }, (_, index) => index % 2 ? yesterday : today);
      const calls = observeFormatters();
      const expected = dates.map(legacyFormatReceivedAt);
      expect(calls).toHaveLength(size);
      calls.length = 0;
      expect(dates.map(createReceivedAtFormatter())).toEqual(expected);
      expect(calls).toHaveLength(2);
    });

    test(`${size}-row InboxApp render uses only two row-date formatters, in both themes`, () => {
      setSystemTime(now);
      const messages = Array.from({ length: size }, (_, index) => ({
        ...demoMessages[0]!, id: `date-perf-${index}`, threadId: `date-perf-thread-${index}`,
        providerMessageId: `date-perf-provider-${index}`, subject: `Date fixture ${index}`,
        receivedAt: index % 2 ? yesterday : today,
      }));
      const calls = observeFormatters();
      for (const theme of ["light", "dark"] as const) {
        calls.length = 0;
        const html = renderToStaticMarkup(<InboxApp demoMode initialDemoMessages={messages} theme={theme} setTheme={() => {}} />);
        expect(html.match(/class="message-row(?:\s|")/g)).toHaveLength(size);
        const rowFormats = calls.filter(({ options }) => options?.hour === "numeric" || options?.month === "short");
        expect(rowFormats).toHaveLength(2);
        expect(rowFormats.every(({ locales, options }) => locales === undefined && options?.timeZone === undefined)).toBe(true);
      }
    });
  }
});
