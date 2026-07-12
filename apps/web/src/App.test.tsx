import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App, applySenderAttention, getMessagesForMailbox, isDevPreviewPath } from "./App";
import { demoMessages } from "./demo-data";

describe("App", () => {
  test("checks for a session before rendering the inbox", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Orca");
    expect(html).toContain("Checking your key.");
    expect(html).not.toContain("Compose");
  });

  test("renders the Gmail OAuth login page on auth routes", () => {
    const originalWindow = globalThis.window;
    const localStorage = new Map<string, string>();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          assign() {},
          href: "http://localhost:5173/login",
          origin: "http://localhost:5173",
          pathname: "/login",
          search: "",
        },
        localStorage: {
          getItem(key: string) {
            return localStorage.get(key) ?? null;
          },
          setItem(key: string, value: string) {
            localStorage.set(key, value);
          },
          removeItem(key: string) {
            localStorage.delete(key);
          },
          clear() {
            localStorage.clear();
          },
        },
      },
    });

    try {
      const html = renderToStaticMarkup(<App />);

      expect(html).toContain("Make room for the people.");
      expect(html).toContain("Continue with Google");
      expect(html).toContain("What happens next");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  test("separates attention treatments into recoverable inbox views", () => {
    expect(getMessagesForMailbox(demoMessages, "focus")).toHaveLength(3);
    expect(getMessagesForMailbox(demoMessages, "normal")).toHaveLength(2);
    expect(getMessagesForMailbox(demoMessages, "quiet")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "hidden")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "all")).toHaveLength(7);
  });

  test("only exposes the fake inbox preview route during development", () => {
    expect(isDevPreviewPath("/dev/inbox", true)).toBe(true);
    expect(isDevPreviewPath("/dev/inbox", false)).toBe(false);
    expect(isDevPreviewPath("/", true)).toBe(false);
  });

  test("applies sender attention to historical and newly synced messages", () => {
    const historical = demoMessages.filter((message) => message.from.email === "maya@example.com");
    const future = { ...historical[0], id: "future", providerMessageId: "future" };
    const all = [...demoMessages, future];

    expect(applySenderAttention(all, { "maya@example.com": "hidden" }).some((message) => message.from.email === "maya@example.com")).toBe(false);
    const quiet = applySenderAttention(all, { "maya@example.com": "quiet" });
    expect(quiet.filter((message) => message.from.email === "maya@example.com").map((message) => message.receivedAt))
      .toEqual([...historical, future].map((message) => message.receivedAt).sort().reverse());
    const priority = applySenderAttention(all, { "maya@example.com": "focus" });
    const lastMaya = priority.map((message) => message.from.email).lastIndexOf("maya@example.com");
    const firstNormal = priority.findIndex((message) => message.attentionBehavior === "normal");
    expect(lastMaya).toBeLessThan(firstNormal);
  });
});
