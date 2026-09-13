import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { AttentionPage } from "./attention-page";
const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: Window;
let root: Root;
let container: HTMLElement;
const accounts = ["a", "b"].map(id => ({ id, provider: "gmail", email: `${id}@example.com`, displayName: id, capabilities: { read: true, draft: false, send: false } }));
const state = (accountId = "a") => ({ accountId, revision: 1, defaultChoice: "quiet", delivery: "proposal_only", senders: [{ address: `${accountId}@sender.com`, choice: "notify" }] });
beforeEach(() => {
  browser = new Window({ url: "http://localhost/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: browser[name as keyof Window] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  for (const name of names) { const original = originals.get(name); if (original) Object.defineProperty(globalThis, name, original); else delete (globalThis as Record<string, unknown>)[name]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  await browser.happyDOM.close();
});
async function render() { await act(async () => { root.render(<AttentionPage onAdvanced={() => {}} />); }); }
function mock(handler: (path: string, init?: RequestInit) => Promise<Response>) { globalThis.fetch = ((path: string | URL | Request, init?: RequestInit) => handler(String(path), init)) as typeof fetch; }
function button(text: string) { return Array.from(container.querySelectorAll("button")).find(item => item.textContent === text)!; }
test("failed save keeps previous choice, requires reload, and never announces saved", async () => {
  let puts = 0;
  mock(async (path, init) => {
    if (path === "/v1/accounts") return Response.json({ items: accounts, nextCursor: null });
    if (init?.method === "PUT") { puts++; return Response.json({ error: { message: "Changed elsewhere" } }, { status: 409 }); }
    return Response.json(state());
  });
  await render();
  const toggle = container.querySelector<HTMLInputElement>('[role="switch"]')!;
  expect(toggle.checked).toBe(true);
  await act(async () => toggle.click());
  expect(puts).toBe(1);
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(true);
  expect(container.textContent).toContain("Showing your last loaded choices");
  expect(container.textContent).not.toContain("Choices saved.");
  await act(async () => button("Reload choices").click());
  expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(false);
});
test("account switch ignores late response from previous account", async () => {
  let resolveFirst: (response: Response) => void = () => {};
  mock(async path => {
    if (path === "/v1/accounts") return Response.json({ items: accounts, nextCursor: null });
    if (path.endsWith("accountId=a")) return new Promise<Response>(resolve => { resolveFirst = resolve; });
    return Response.json(state("b"));
  });
  await render();
  await act(async () => { const select = container.querySelector<HTMLSelectElement>('[aria-label="Attention account"]')!; select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("b@sender.com");
  await act(async () => resolveFirst(Response.json(state("a"))));
  expect(container.textContent).not.toContain("a@sender.com");
  expect(container.textContent).toContain("b@sender.com");
});
test("offline disables edits while filters remain available; empty account has recovery", async () => {
  mock(async path => Response.json(path === "/v1/accounts" ? { items: accounts, nextCursor: null } : state()));
  await render();
  await act(async () => { Object.defineProperty(browser.navigator, "onLine", { configurable: true, value: false }); window.dispatchEvent(new Event("offline")); });
  expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true);
  expect(button("All senders").disabled).toBe(false);
  expect(container.textContent).toContain("You’re offline");
});
test("no connected account disables save controls", async () => {
  mock(async () => Response.json({ items: [], nextCursor: null }));
  await render();
  expect(container.textContent).toContain("Connect an account");
  expect(button("+ Add sender").disabled).toBe(true);
});

test("failed reload retains last loaded choices read-only until recovery", async () => {
  let failReload = false;
  mock(async (path, init) => {
    if (path === "/v1/accounts") return Response.json({ items: accounts, nextCursor: null });
    if (init?.method === "PUT") { failReload = true; return Response.json({ error: { message: "Save interrupted" } }, { status: 503 }); }
    if (failReload) return Response.json({ error: { message: "Access expired" } }, { status: 403 });
    return Response.json(state());
  });
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  await act(async () => button("Reload choices").click());
  const retained = container.querySelector<HTMLInputElement>('[role="switch"]')!;
  expect(retained.checked).toBe(true);
  expect(retained.disabled).toBe(true);
  expect(container.textContent).toContain("Read-only.");
  failReload = false;
  await act(async () => button("Reload choices").click());
  expect(container.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(false);
  expect(container.textContent).not.toContain("Read-only.");
});
