import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { FirstViewGuidanceProvider, FirstViewInvitation, ViewGettingStarted, useViewGuidanceSelectionRequest } from "./first-view-guidance";
import { TopLayerProvider } from "./top-layer";
import { organizationViewsFixture } from "@orca/shared";
import { demoAccount, demoMessages } from "./demo-data";

const names = ["window", "document", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: Window; let root: Root; let writes: string[]; let completed: string | null; let empty: boolean; let listFails: boolean; let saveFails: boolean; let searches: number; let selections: number;
const preferences = () => ({ signature: "", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false, firstViewGuidanceCompletedAt: completed });
beforeEach(() => {
  browser = new Window({ url: "http://localhost/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : typeof (browser as any)[name] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(name) ? (browser as any)[name].bind(browser) : (browser as any)[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  writes = []; completed = null; empty = false; listFails = false; saveFails = false; searches = 0; selections = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(url); if (saveFails) return new Response("Unavailable", { status: 503 }); completed = "2026-09-06T12:00:00.000Z"; return Response.json(preferences()); }
    if (url === "/v1/preferences") return Response.json(preferences());
    if (url === "/v1/organization/views") return listFails ? new Response("Unavailable", { status: 503 }) : Response.json({ workspaceId: "owner", workspaceRevision: 1, items: [] });
    if (url.startsWith("/v1/inbox?")) return Response.json({ accounts: [demoAccount], messages: empty ? [] : demoMessages.slice(0, 1), nextCursor: null, counts: { attention: { normal: 0, focus: 0, quiet: 0, hidden: 0, all: 0 }, classification: { likely_human: 0, uncertain: 0, automated_or_bulk: 0, unclassified: 0, all: 0 } } });
    throw new Error(`Unexpected guidance request ${url}`);
  }) as typeof fetch;
  const container = browser.document.createElement("div"); browser.document.body.append(container); root = createRoot(container as unknown as Element);
});
afterEach(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; for (const name of names) { const d = originals.get(name); if (d) Object.defineProperty(globalThis, name, d); else delete (globalThis as any)[name]; } delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; await browser.close(); });
async function render() { await act(async () => { root.render(<TopLayerProvider><FirstViewGuidanceProvider onSearch={() => searches++} onSelect={() => selections++}><FirstViewInvitation/><ViewGettingStarted/></FirstViewGuidanceProvider></TopLayerProvider>); await new Promise(resolve => setTimeout(resolve, 20)); }); }
function button(label: string) { return [...browser.document.querySelectorAll("button")].find(x => x.textContent === label || x.querySelector("strong")?.textContent === label)!; }
async function click(label: string) { expect(button(label)).toBeDefined(); await act(async () => { button(label).click(); await new Promise(resolve => setTimeout(resolve, 20)); }); }

test("first invitation waits for canonical reads, dismisses durably and reopens without creating a View", async () => {
  await render();
  expect(browser.document.body.textContent).toContain("Keep useful mail together");
  expect(browser.document.activeElement).toBe(browser.document.body);
  await click("Skip for now");
  expect(writes).toEqual(["/v1/preferences"]);
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  await click("Getting started");
  expect(browser.document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(browser.document.body.textContent).toContain("Keep useful mail together");
  await click("Search mail");
  expect(searches).toBe(1); expect(writes).toHaveLength(1);
});

test("a failed View list never becomes an invitation or empty-mail sample", async () => {
  listFails = true; await render();
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  await click("Getting started");
  expect(browser.document.body.textContent).toContain("Could not check your mail and saved Views");
  expect(browser.document.querySelector('[data-provenance="tutorial"]')).toBeNull();
  listFails = false; await click("Retry guidance");
  expect(browser.document.body.textContent).toContain("Keep useful mail together");
  expect(writes).toHaveLength(0);
});
test("empty mail offers only a noninteractive example and skipping never prepares or saves a View", async () => {
  empty = true; await render();
  expect(browser.document.querySelector('[data-provenance="tutorial"]')).not.toBeNull();
  expect(button("Search mail")).toBeUndefined(); expect(button("Use selected mail")).toBeUndefined();
  await click("Return when mail arrives");
  expect(writes).toEqual(["/v1/preferences"]); expect(searches + selections).toBe(0);
});
test("selected mail starts production selection without writing preferences or a View", async () => {
  await render(); await click("Use selected mail");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(selections).toBe(1); expect(searches).toBe(0); expect(writes).toHaveLength(0);
});
test("a dismissed user gets manual help without resetting their stored preference", async () => {
  completed = "2026-09-06T12:00:00.000Z"; await render();
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  await click("Getting started"); await click("Skip for now");
  expect(completed).toBe("2026-09-06T12:00:00.000Z"); expect(writes).toHaveLength(0);
});
test("failed dismissal stays locally hidden and explicitly retries persistence", async () => {
  saveFails = true; await render(); await click("Skip for now");
  expect(browser.document.body.textContent).toContain("Hidden for this visit");
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  saveFails = false; await click("Retry saving choice");
  expect(writes).toHaveLength(2); expect(completed).not.toBeNull();
});

test("manual help owns Escape and restores focus to Getting started", async () => {
  completed = "2026-09-06T12:00:00.000Z"; await render();
  button("Getting started").focus(); await click("Getting started");
  expect(browser.document.activeElement?.textContent).toBe("Keep useful mail together");
  await act(async () => { browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(browser.document.querySelector('[role="dialog"]')).toBeNull();
  expect(browser.document.activeElement).toBe(button("Getting started"));
  expect(writes).toHaveLength(0);
});

test("no invitation flashes while the canonical View list is still pending", async () => {
  const fetchBoundary = globalThis.fetch;
  let resolveList!: (value: Response) => void;
  globalThis.fetch = (async (url: string, init?: RequestInit) => url === "/v1/organization/views" ? new Promise<Response>(resolve => { resolveList = resolve; }) : fetchBoundary(url, init)) as typeof fetch;
  await render();
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  await act(async () => { resolveList(Response.json({ workspaceId: "owner", workspaceRevision: 1, items: organizationViewsFixture })); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(browser.document.body.textContent).not.toContain("Keep useful mail together");
  expect(writes).toHaveLength(0);
  await click("Getting started");
  expect(browser.document.body.textContent).toContain("Checking your saved Views and mail");
  await act(async () => { resolveList(Response.json({ workspaceId: "owner", workspaceRevision: 1, items: organizationViewsFixture })); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(browser.document.body.textContent).toContain("Keep useful mail together");
});

test("a selected-mail invitation is consumed once instead of reselecting after later navigation", async () => {
  let starts = 0;
  function Inbox() { const request = useViewGuidanceSelectionRequest(); useEffect(() => { if (request) starts++; }, [request]); return null; }
  function Navigation() { const [visible, setVisible] = useState(true); return <><button onClick={() => setVisible(value => !value)}>Switch destination</button>{visible ? <Inbox/> : null}</>; }
  await act(async () => { root.render(<TopLayerProvider><FirstViewGuidanceProvider onSearch={() => {}} onSelect={() => {}}><FirstViewInvitation/><Navigation/></FirstViewGuidanceProvider></TopLayerProvider>); await new Promise(resolve => setTimeout(resolve, 20)); });
  await click("Use selected mail");
  expect(starts).toBe(1);
  await click("Switch destination"); await click("Switch destination");
  expect(starts).toBe(1);
});

test("manual reopen refreshes empty mail readiness after real mail arrives", async () => {
  empty = true; await render(); await click("Skip for now");
  empty = false; await click("Getting started");
  expect(button("Search mail")).toBeDefined();
  expect(browser.document.querySelector('[data-provenance="tutorial"]')).toBeNull();
  expect(writes).toHaveLength(1);
});
