import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MailAccount } from "@orca/shared";
import { invalidateWritingPreferences, useWritingPreferences } from "./use-writing-preferences";
import { initializeWritingDraft, type WritingPreferenceState } from "./writing-preferences";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let state: WritingPreferenceState;
let requests: { path: string; init?: RequestInit; resolve: (response: Response) => void }[];
const account: MailAccount = { id: "a", email: "a@example.com", displayName: "A", provider: "gmail", capabilities: { read: true, draft: true, send: true } };
const preferences = { signature: "A signature", composeFormat: "rich", replyBehavior: "reply_all", notifyByDefault: false };
function Harness({ selected, demo = false }: { selected: MailAccount | null; demo?: boolean }) { state = useWritingPreferences(selected, demo); return null; }
async function render(selected: MailAccount | null = account, demo = false) { await act(async () => root.render(<Harness selected={selected} demo={demo} />)); }
async function respond(index: number, value: unknown = preferences, status = 200) { await act(async () => requests[index]!.resolve(Response.json(value, { status }))); }

beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  requests = [];
  globalThis.fetch = ((path: string, init?: RequestInit) => new Promise<Response>(resolve => requests.push({ path, init, resolve }))) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root.unmount());
  browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test("no authenticated account or demo mode never reads personal preferences", async () => {
  await render(null); await render(account, true);
  expect(requests).toHaveLength(0);
  expect(state.status).toBe("unavailable");
  expect(state.preferences.signature).toBe("");
});

test("loads user preferences using credentials without inventing an account query contract", async () => {
  await render();
  expect(requests[0]).toMatchObject({ path: "/v1/preferences", init: { credentials: "include", cache: "no-store" } });
  await respond(0);
  expect(state).toMatchObject({ accountId: "a", status: "ready", preferences: { signature: "A signature" } });
});

test("account switch aborts previous request and rejects a late response even if fetch ignores abort", async () => {
  await render();
  await render({ ...account, id: "b" });
  expect(requests[0]!.init!.signal!.aborted).toBe(true);
  expect(state).toMatchObject({ accountId: "b", status: "loading", preferences: { signature: "" } });
  await respond(1, { ...preferences, signature: "B signature" });
  await respond(0);
  expect(state).toMatchObject({ accountId: "b", status: "ready", preferences: { signature: "B signature" } });
  await render(null);
  expect(state.preferences.signature).toBe("");
});

test("save invalidation discards stale reads and applies refreshed values to next draft only", async () => {
  await render(); await respond(0);
  const lifecycle = { isNew: true, isHydrated: true, hasEdits: false };
  const first = initializeWritingDraft({ accountId: "a", body: "" }, state, lifecycle);
  await act(async () => invalidateWritingPreferences());
  expect(state.status).toBe("loading");
  await act(async () => invalidateWritingPreferences());
  await respond(2, { ...preferences, signature: "New signature", composeFormat: "plain" });
  await respond(1, { ...preferences, signature: "Stale signature" });
  expect(initializeWritingDraft(first, state, lifecycle)).toBe(first);
  expect(initializeWritingDraft({ accountId: "a", body: "" }, state, lifecycle)).toMatchObject({ body: "\n\nNew signature", composeFormat: "plain" });
});

test("late successful preference arrival never changes writing started during loading", async () => {
  await render();
  const typed = { accountId: "a", body: "Already typing" };
  await respond(0);
  expect(initializeWritingDraft(typed, state, { isNew: true, isHydrated: true, hasEdits: true })).toBe(typed);
});

for (const status of [401, 403, 500]) test(`${status} errors clear previous personal values and provide safe defaults`, async () => {
  await render(); await respond(0);
  await act(async () => invalidateWritingPreferences());
  await respond(1, { error: "unavailable" }, status);
  expect(state).toMatchObject({ accountId: "a", status: "unavailable", preferences: { signature: "", composeFormat: "plain", replyBehavior: "reply" } });
});

test("malformed response fails closed; disabling then re-enabling refetches", async () => {
  await render(); await respond(0, { signature: "Only partial" });
  expect(state.status).toBe("unavailable");
  await render(account, true); await render(account);
  expect(state.status).toBe("loading");
  expect(requests).toHaveLength(2);
});
