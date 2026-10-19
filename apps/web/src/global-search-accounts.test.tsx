import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { inboxFixture, type MailAccount, type OrganizationCollection } from "@orca/shared";
import { demoAccount } from "./demo-data";
import { GlobalMailSearch, openMailSearch, openMailSearchFilter } from "./global-search";
import { TopLayerProvider } from "./top-layer";

const globals = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "InputEvent", "KeyboardEvent", "Location"] as const;
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
const first = { ...demoAccount, id: "first", email: "first@example.com" };
const second = { ...demoAccount, id: "second", email: "second@example.com" };
const space: OrganizationCollection = { id: "first-space", accountId: first.id, name: "First space", color: "#123456", position: 0, threadIds: [], revision: 1, createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z" };
let browser: InstanceType<typeof Window>;
let root: Root;
type Pending = { url: string; signal: AbortSignal; resolve: (response: Response) => void };
let pending: Pending[];
beforeEach(() => {
  browser = new Window({ url: "http://localhost/?destination=inbox" });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : name === "document" ? browser.document : name === "navigator" ? browser.navigator : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  pending = [];
  // Deliberately allow responses after abort: the component must reject stale metadata.
  globalThis.fetch = ((input, init) => new Promise<Response>(resolve => pending.push({ url: String(input), signal: init!.signal!, resolve }))) as typeof fetch;
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as Element);
});
afterEach(async () => {
  await act(async () => root.unmount()); globalThis.fetch = originalFetch;
  for (const name of globals) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT; browser.close();
});
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
async function mount(accountId: string | null = null) {
  openMailSearchFilter({ mailbox: "all", attention: "all", classification: "all", person: null, query: "conversation", accountId, collectionId: null, dataSource: "stored_mail" });
  await act(async () => root.render(<TopLayerProvider><GlobalMailSearch returnFocusRef={{ current: null }} /></TopLayerProvider>)); await flush();
}
function take(path: string) { const i = pending.findIndex(r => r.url.startsWith(path)); expect(i, `missing request ${path}`).toBeGreaterThanOrEqual(0); return pending.splice(i, 1)[0]!; }
async function respond(request: Pending, body: unknown, status = 200) { await act(async () => request.resolve(Response.json(body, { status }))); await flush(); }
function result(accounts: MailAccount[]) {
  const messages = accounts.map(account => ({ ...inboxFixture[0]!, id: `message-${account.id}`, threadId: `thread-${account.id}`, accountId: account.id, subject: `${account.id} conversation` }));
  return { accounts, messages, nextCursor: null, counts: { attention: { focus: 0, normal: messages.length, quiet: 0, hidden: 0, all: messages.length }, classification: { likely_human: messages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: messages.length } } };
}
function options(index = 2) { return [...browser.document.querySelectorAll(".global-mail-search-filters select")[index]!.querySelectorAll("option")].map(o => o.value); }
async function selectAccount(value: string) { const select = browser.document.querySelectorAll(".global-mail-search-filters select")[2]!; await act(async () => { select.value = value; select.dispatchEvent(new browser.Event("change", { bubbles: true })); }); await flush(); }
const collectionResponse = { workspaceId: "workspace", accountIds: [first.id, second.id], collections: [space], pins: [], queries: [] };

for (const order of ["accounts-first", "search-first"]) test(`full account choices survive scoped results in ${order} response order`, async () => {
  await mount(first.id);
  const accounts = take("/v1/accounts"), search = take("/v1/inbox?");
  expect(search.url).toBe("/v1/inbox?limit=100&classification=all&view=all&query=conversation&accountId=first");
  if (order === "accounts-first") await respond(accounts, { items: [first, second], nextCursor: null });
  await respond(search, result([first]));
  if (order === "search-first") await respond(accounts, { items: [first, second], nextCursor: null });
  await respond(take("/v1/organization/collections-pins/query"), collectionResponse);
  expect(options()).toEqual(["", first.id, second.id]);
  expect(browser.document.querySelector(".global-mail-result-list")?.textContent).toContain("first conversation");
  await selectAccount(second.id);
  const next = take("/v1/inbox?"); expect(next.url).toBe("/v1/inbox?limit=100&classification=all&view=all&query=conversation&accountId=second");
  await respond(next, result([second]));
  expect(options()).toEqual(["", first.id, second.id]);
  expect(browser.document.querySelector(".global-mail-result-list")?.textContent).toContain("second conversation");
  expect(browser.document.querySelector(".global-mail-result-list")?.textContent).not.toContain("first conversation");
});

test("collection failure does not discard successful full account choices", async () => {
  await mount(); await respond(take("/v1/accounts"), { items: [first, second], nextCursor: null });
  await respond(take("/v1/organization/collections-pins/query"), {}, 503);
  await respond(take("/v1/inbox?"), result([first]));
  expect(options()).toEqual(["", first.id, second.id]); expect(options(3)).toEqual([""]);
});

test("account failure preserves collections and uses only the latest search fallback", async () => {
  await mount(); await respond(take("/v1/accounts"), {}, 503);
  await respond(take("/v1/organization/collections-pins/query"), collectionResponse);
  await respond(take("/v1/inbox?"), result([first]));
  expect(options()).toEqual(["", first.id]); expect(options(3)).toEqual(["", space.id]);
  await act(async () => openMailSearch("second")); await flush();
  await respond(take("/v1/inbox?"), result([second]));
  expect(options()).toEqual(["", second.id]); expect(options(3)).toEqual(["", space.id]);
});

test("a successful empty full account list is authoritative over scoped metadata", async () => {
  await mount(); await respond(take("/v1/accounts"), { items: [], nextCursor: null });
  await respond(take("/v1/organization/collections-pins/query"), collectionResponse);
  await respond(take("/v1/inbox?"), result([first]));
  expect(options()).toEqual([""]);
});

test("closing and reopening clears old lists and ignores aborted account and collection responses", async () => {
  await mount(); const oldAccounts = take("/v1/accounts"), oldCollections = take("/v1/organization/collections-pins/query"), oldSearch = take("/v1/inbox?");
  await respond(oldSearch, result([first]));
  await act(async () => (browser.document.querySelector('.global-mail-search-heading > button') as unknown as HTMLButtonElement).click()); await flush();
  expect(oldAccounts.signal.aborted).toBe(true); expect(oldCollections.signal.aborted).toBe(true);
  await act(async () => openMailSearch("second")); await flush();
  expect(options()).toEqual([""]); expect(options(3)).toEqual([""]);
  await respond(take("/v1/accounts"), {}, 503); await respond(take("/v1/organization/collections-pins/query"), {}, 503);
  await respond(take("/v1/inbox?"), result([second]));
  await respond(oldAccounts, { items: [first], nextCursor: null }); await respond(oldCollections, collectionResponse);
  expect(options()).toEqual(["", second.id]); expect(options(3)).toEqual([""]);
});

test("reopening with failed metadata cannot retain a previous successful full list", async () => {
  await mount(); await respond(take("/v1/accounts"), { items: [first, second], nextCursor: null }); await respond(take("/v1/organization/collections-pins/query"), collectionResponse); await respond(take("/v1/inbox?"), result([first]));
  await act(async () => (browser.document.querySelector('.global-mail-search-heading > button') as unknown as HTMLButtonElement).click()); await flush();
  await act(async () => openMailSearch("second")); await flush();
  await respond(take("/v1/accounts"), {}, 503); await respond(take("/v1/organization/collections-pins/query"), {}, 503); await respond(take("/v1/inbox?"), result([second]));
  expect(options()).toEqual(["", second.id]); expect(options(3)).toEqual([""]);
});

test("late scoped search metadata cannot overwrite the current fallback after account metadata fails", async () => {
  await mount(); await respond(take("/v1/accounts"), {}, 503);
  const stale = take("/v1/inbox?");
  await act(async () => openMailSearch("second")); await flush(); expect(stale.signal.aborted).toBe(true);
  await respond(take("/v1/inbox?"), result([second])); await respond(stale, result([first]));
  expect(options()).toEqual(["", second.id]);
  expect(browser.document.querySelector(".global-mail-result-list")?.textContent).toContain("second conversation");
  expect(browser.document.querySelector(".global-mail-result-list")?.textContent).not.toContain("first conversation");
});

test("invalid account metadata falls back without discarding valid collections", async () => {
  await mount(); await respond(take("/v1/accounts"), { items: [{ id: "invalid" }], nextCursor: null });
  await respond(take("/v1/organization/collections-pins/query"), collectionResponse);
  await respond(take("/v1/inbox?"), result([first]));
  expect(options()).toEqual(["", first.id]); expect(options(3)).toEqual(["", space.id]);
});
