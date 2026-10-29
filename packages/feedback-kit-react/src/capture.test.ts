import { describe, expect, it } from "bun:test";
import { collectRuntimeContext, toLegacyColors } from "./capture";

describe("toLegacyColors", () => {
  it("converts oklab values to rgb values", () => {
    const normalized = toLegacyColors("oklab(50% 0.1 -0.05 / 80%)");

    expect(normalized).not.toContain("oklab");
    expect(normalized).toMatch(/^rgba?\(/);
  });

  it("removes unsupported color functions from larger declarations", () => {
    const normalized = toLegacyColors(
      "linear-gradient(oklab(60% 0.1 0.05), color-mix(in srgb, white 20%, transparent))",
    );

    expect(normalized).not.toMatch(/oklab|color-mix/i);
  });
});

const serverRouteLimit = 2048;

describe("collectRuntimeContext", () => {
  const pathname = "/inbox";

  for (const [name, search, hash, expectedLength] of [
    ["short route", "?q=hello", "#message", pathname.length + "?q=hello#message".length],
    ["exact cap", "?" + "x".repeat(serverRouteLimit - pathname.length - 1), "", serverRouteLimit],
    ["one over cap", "?" + "x".repeat(serverRouteLimit - pathname.length), "", serverRouteLimit],
    ["huge query", "?" + "x".repeat(100_000), "#message", serverRouteLimit],
    ["surrogate boundary", "?" + "x".repeat(serverRouteLimit - pathname.length - 2) + "😀", "", serverRouteLimit - 1],
    ["empty query and hash", "", "", pathname.length],
    ["literal markup and malformed escape", "?q=<script>%ZZ", "#<tag>", pathname.length + "?q=<script>%ZZ#<tag>".length],
  ] as const) {
    it(`captures ${name} without changing other context fields`, () => {
      const route = pathname + search + hash;
      const href = "https://example.test" + route;
      const globals = {
        window: { location: { pathname, search, hash, href }, innerWidth: 1024, innerHeight: 768, devicePixelRatio: 2 },
        document: { title: "Feedback page" },
        navigator: { userAgent: "capture-test", language: "en-US" },
      };
      const descriptors = Object.fromEntries(
        Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
      );
      try {
        for (const [key, value] of Object.entries(globals)) {
          Object.defineProperty(globalThis, key, { configurable: true, value });
        }
        const before = Date.now();
        const context = collectRuntimeContext();
        expect(context.route).toHaveLength(expectedLength);
        expect(context.route).toBe(route.slice(0, expectedLength));
        expect(context.route?.startsWith(pathname)).toBe(true);
        expect(context.route).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(context).toEqual({
          url: href,
          route: route.slice(0, expectedLength),
          title: globals.document.title,
          userAgent: globals.navigator.userAgent,
          viewport: { width: 1024, height: 768, pixelRatio: 2 },
          locale: globals.navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          capturedAt: expect.any(String),
        });
        expect(Date.parse(context.capturedAt)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(context.capturedAt)).toBeLessThanOrEqual(Date.now());
      } finally {
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    });
  }
});
