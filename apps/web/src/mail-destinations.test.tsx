import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { DestinationManager, refreshDestinations } from "./mail-destinations";
import { TopLayerProvider } from "./top-layer";

const globals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"] as const;
const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalFetch = globalThis.fetch;
let browser: Window;
let root: Root;
let closed: number;
let writes: { url: string; body: Record<string, unknown> }[];
let fail: string;
let finish: ((value: Response) => void) | undefined;
let hold: boolean;
const space = (id: string, name: string, isFallback = false) => ({ id, name, isFallback, color: "#789b84", position: 0, retiredAt: null as string | null, revision: 1, notificationPreference: "quiet", delivery: "proposal_only", counts: { total: 0, unread: 0 } });
let state: { revision: number; fallbackDestinationId: string; legacyDestinationIds: { normal: string; quiet: string }; destinations: ReturnType<typeof space>[] };

beforeEach(async () => {
  browser = new Window({ url: "http://localhost/" });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? browser : key === "document" ? browser.document : key === "navigator" ? browser.navigator : browser[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  closed = 0; writes = []; fail = ""; hold = false; finish = undefined;
  state = { revision: 1, fallbackDestinationId: "inbox", legacyDestinationIds: { normal: "inbox", quiet: "quiet" }, destinations: [space("inbox", "Inbox", true), space("clients", "Clients"), space("quiet", "Quiet")] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(state);
    const body = JSON.parse(String(init.body)); writes.push({ url: String(input), body });
    if (hold) return new Promise<Response>(resolve => { finish = resolve; });
    if (fail) return Response.json({ error: { message: fail } }, { status: 409 });
    const id = String(input).split("/")[3] ?? "new";
    state = { ...state, revision: state.revision + 1, destinations: init.method === "PATCH" ? state.destinations.map(item => item.id === id ? { ...item, name: body.name, color: body.color } : item) : String(input).endsWith("retire") ? state.destinations.map(item => item.id === id ? { ...item, retiredAt: "2026-09-20" } : item) : [...state.destinations, space("new", body.name)] };
    return Response.json({ state, destinationId: id });
  }) as typeof fetch;
  await refreshDestinations();
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(<TopLayerProvider><DestinationManager onClose={() => { closed++; }} onCreated={() => {}} /></TopLayerProvider>));
});
afterEach(async () => {
  await act(async () => root.unmount()); globalThis.fetch = originalFetch;
  browser.close();
  for (const key of globals) { const descriptor = original.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});
const active = () => document.querySelector('[data-top-layer="active"] [role="dialog"]')!;
function button(label: string, container: ParentNode = active()) { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.replace("✓", "").trim() === label || item.getAttribute("aria-label") === label); expect(found).toBeDefined(); return found!; }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function input(value: string, label = "Name for Clients") { await act(async () => { const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function escape() { await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); }
function editor(name: string) { return [...document.querySelectorAll("details")].find(item => item.querySelector("summary")!.textContent!.includes(name))!; }

test("removal names exact space and default, cancel and Escape cause no writes", async () => {
  await click(button("Remove Clients"));
  expect(active().textContent).toContain('Remove “Clients”?'); expect(active().textContent).toContain("No mail is deleted"); expect(active().textContent).toContain("Inbox");
  expect(active().querySelectorAll("nav a")).toHaveLength(3);
  await click(button("Cancel")); expect(writes).toHaveLength(0);
  await click(button("Remove Clients")); await escape(); expect(writes).toHaveLength(0);
});

test("confirmed removal uses current revision/default, blocks duplicate writes, and announces success", async () => {
  await click(button("Remove Clients")); hold = true;
  const confirm = button("Remove space"); await act(async () => { confirm.click(); confirm.click(); });
  expect(writes).toEqual([{ url: "/v1/destinations/clients/retire", body: { expectedRevision: 1, reassignToDestinationId: "inbox" } }]);
  expect(button("Cancel").disabled).toBe(true); expect(button("Removing…").disabled).toBe(true);
  await escape(); expect(active().textContent).toContain('Remove “Clients”?');
  await act(async () => finish!(Response.json({ state: { ...state, revision: 2, destinations: state.destinations.filter(item => item.id !== "clients") }, destinationId: "clients" })));
  expect(active().textContent).toContain('Removed “Clients”. No mail was deleted.');
});

test("default and legacy spaces cannot be removed", () => {
  expect(button("Remove Inbox").disabled).toBe(true); expect(button("Remove Quiet").disabled).toBe(true);
  expect(editor("Inbox").textContent).toContain("default space cannot be removed");
  expect(editor("Quiet").textContent).toContain("Legacy choices"); expect(writes).toHaveLength(0);
});

for (const dismissal of ["Done", "backdrop", "Escape"]) test(`dirty ${dismissal} asks before discard and preserves editing`, async () => {
  await input("Customers");
  if (dismissal === "Escape") await escape();
  else await click(dismissal === "Done" ? button("Done") : document.querySelector<HTMLButtonElement>('[aria-label="Close space manager"]')!);
  expect(active().getAttribute("aria-label")).toBe("Unsaved space changes"); expect(closed).toBe(0);
  await click(button("Keep editing")); expect(document.querySelector<HTMLInputElement>('[aria-label="Name for Clients"]')!.value).toBe("Customers");
  await click(button("Done")); await click(button("Discard changes")); expect(closed).toBe(1); expect(writes).toHaveLength(0);
});

test("switching and collapsing editors preserves drafts; save clears dirty state and announces update", async () => {
  await input(" Customers "); await click(editor("Clients").querySelector("summary")!); await click(editor("Inbox").querySelector("summary")!);
  expect(document.querySelector<HTMLInputElement>('[aria-label="Name for Clients"]')!.value).toBe(" Customers ");
  await click(button("Save changes", editor("Clients"))); expect(writes[0]!.body.name).toBe("Customers");
  expect(active().textContent).toContain('Saved “Customers”.'); await click(button("Done")); expect(closed).toBe(1);
});

test("failed rename retains name and color for retry", async () => {
  await input("Customers"); await click(button("Blue", editor("Clients"))); fail = "Connection interrupted";
  await click(button("Save changes", editor("Clients")));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Name for Clients"]')!.value).toBe("Customers"); expect(button("Blue", editor("Clients")).getAttribute("aria-pressed")).toBe("true");
  expect(active().textContent).toContain("Your edits are kept"); fail = "";
  await click(button("Save changes", editor("Clients"))); expect(active().textContent).toContain('Saved “Customers”.');
});

test("blocked removal offers existing recovery routes and an explicit retry", async () => {
  await click(button("Remove Clients")); fail = "Advanced rules reference this destination. Update them in Organization first.";
  await click(button("Remove space")); expect(active().textContent).toContain("The space was not removed");
  expect(active().querySelector('a[href="/?destination=organization-studio"]')).not.toBeNull();
  expect(button("Retry removal").disabled).toBe(false); fail = ""; await click(button("Retry removal")); expect(writes).toHaveLength(2);
});

test("create and rename reject whitespace, and new-space color changes are guarded", async () => {
  await input("   "); expect(button("Save changes", editor("Clients")).disabled).toBe(true);
  const field = document.querySelector<HTMLInputElement>("form input")!;
  await act(async () => { field.value = "   "; field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(button("Create space").disabled).toBe(true);
  await click(button("Done")); expect(active().getAttribute("aria-label")).toBe("Unsaved space changes"); expect(writes).toHaveLength(0);
});

test("creating a space keeps another editor's draft until an explicit guarded navigation", async () => {
  await input("Customers");
  const field = document.querySelector<HTMLInputElement>("form input")!;
  await act(async () => { field.value = " Projects "; field.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button("Create space"));
  expect(writes[0]!.body.name).toBe("Projects"); expect(closed).toBe(0);
  expect(document.querySelector<HTMLInputElement>('[aria-label="Name for Clients"]')!.value).toBe("Customers");
  expect(active().textContent).toContain('Created “Projects”.');
  await click(button("Open created space")); expect(active().getAttribute("aria-label")).toBe("Unsaved space changes");
  await click(button("Keep editing")); expect(closed).toBe(0);
});

test("color-only changes guard dismissal and Keep editing retains selection", async () => {
  await click(button("Blue", document.querySelector("form")!));
  await escape(); expect(active().getAttribute("aria-label")).toBe("Unsaved space changes");
  await click(button("Keep editing")); expect(button("Blue", document.querySelector("form")!).getAttribute("aria-pressed")).toBe("true");
});
