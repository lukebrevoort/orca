import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { ThreadRecovery } from "./App";

test("recovery is opt-in, replaces pages and offers no compose actions", async () => {
  const browser = new Window({ url: "http://localhost/" });
  const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "getComputedStyle", "requestAnimationFrame"] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalFetch = globalThis.fetch;
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : name === "getComputedStyle" ? browser.getComputedStyle.bind(browser) : name === "requestAnimationFrame" ? browser.requestAnimationFrame.bind(browser) : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  let reads = 0;
  globalThis.fetch = (async input => {
    reads++;
    const cursor = new URL(String(input), "http://localhost").searchParams.get("cursor");
    return Response.json(cursor ? { entries: [{ kind: "unavailable", id: "too-large" }], earlier: null, newer: "newer" } : {
      entries: [{ kind: "message", id: "m", from: "Dana", subject: "First page", receivedAt: null, bodyText: "one", bodyHtml: '<p>one</p><span class="orca-mail-image-note">[Image blocked: Banner]</span>', htmlPresent: true }], earlier: "earlier", newer: null,
    });
  }) as typeof fetch;
  const button = (name: string) => [...browser.document.querySelectorAll("button")].find(b => b.textContent?.trim() === name)!;
  try {
    await act(async () => root.render(<ThreadRecovery accountId="a" threadId="t" />));
    expect(reads).toBe(0);
    await act(async () => button("Open in pages").click());
    expect(reads).toBe(1); expect(browser.document.body.textContent).toContain("First page");
    expect(button("Reply")).toBeUndefined(); expect(button("Forward")).toBeUndefined();
    expect(button("Load images")).toBeUndefined(); expect(button("Refresh message")).toBeUndefined();
    await act(async () => button("Earlier").click());
    expect(reads).toBe(2); expect(browser.document.body.textContent).not.toContain("First page");
    expect(browser.document.body.textContent).toContain("too large");
    expect(button("Earlier").disabled).toBe(true);
    await act(async () => button("Newer").click());
    expect(reads).toBe(3);
  } finally {
    await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
    for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  }
});
