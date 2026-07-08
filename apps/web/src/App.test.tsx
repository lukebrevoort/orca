import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

describe("App", () => {
  test("renders the foundational inbox shell", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Orca");
    expect(html).toContain("Compose");
    expect(html).toContain("Inbox");
    expect(html).toContain("Loading inbox");
    expect(html).toContain("Connecting to the read-only API");
    expect(html).toContain("Connecting account...");
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

      expect(html).toContain("Connect your Gmail inbox");
      expect(html).toContain("Continue with Google");
      expect(html).toContain("Google setup checklist");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
