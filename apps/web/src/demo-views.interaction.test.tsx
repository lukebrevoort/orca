import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { organizationViewPreparationInputSchema, type OrganizationViewCommitResponse } from "@orca/shared";
import { OrganizationViewAuthoringWorkspace, SavedOrganizationViewWorkspace } from "./organization-views";
import { demoStore } from "./demo-store";
import { demoMessages } from "./demo-data";

const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalFetch = globalThis.fetch;
let browser: Window;
let root: Root;
let container: HTMLElement;
let requests: string[];
beforeEach(() => {
  demoStore.reset(); requests = [];
  browser = new Window({ url: "http://localhost/dev/inbox" });
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? browser : browser[key as keyof Window] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  globalThis.fetch = (async (input: RequestInfo | URL) => { requests.push(String(input)); throw new Error("Demo must not contact an API"); }) as unknown as typeof fetch;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); globalThis.fetch = originalFetch;
  for (const key of keys) { const descriptor = originals.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browser.close(); demoStore.reset();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label)!;
  expect(button).toBeDefined(); expect(button.disabled).toBe(false); await act(async () => button.click());
}
async function saved(id: string) {
  await act(async () => root.render(<SavedOrganizationViewWorkspace demoMode previewMode viewId={id} onManage={() => {}} onOpenThread={() => {}}/>));
}

test("Mom creates a truthful sample view, reopens and edits canonically, switches to empty and back without API writes", async () => {
  const mom = demoMessages.find(message => message.from.name === "Mom")!;
  const preparation = organizationViewPreparationInputSchema.parse({ kind: "selected_senders", source: { kind: "sender_selection", label: "Mom" }, identity: { name: "Family sample" }, references: [{ accountId: mom.accountId, threadId: mom.threadId, messageId: mom.id }] });
  let committed: OrganizationViewCommitResponse | undefined;
  await act(async () => root.render(<OrganizationViewAuthoringWorkspace demoMode compact entry={{ preparation, returnContext: "inbox" }} onCancel={() => {}} onCommitted={result => { committed = result; }}/>));
  expect(container.textContent).toContain(mom.from.email);
  expect(container.textContent).not.toContain("deploy@status.example.com");
  expect(container.querySelector('[aria-label="Matching sample mail"]')?.textContent).toContain(mom.subject);
  await click("Save");
  expect(committed).toBeDefined();
  const id = committed!.view.id;
  await saved(id);
  expect(container.querySelector("h2")?.textContent).toBe("Family sample");
  expect(container.querySelectorAll(".view-thread-row")).toHaveLength(demoStore.evaluate(id).count!);
  expect(container.textContent).toContain("until this page is refreshed");
  await click("Edit");
  const field = container.querySelector<HTMLInputElement>(".view-identity input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(field, "Family renamed");
    field.dispatchEvent(new browser.InputEvent("input", { bubbles: true }) as unknown as Event);
  });
  await click("Save changes");
  expect(container.querySelector("h2")?.textContent).toBe("Family renamed");
  expect(demoStore.getView(id)?.revision).toBe(2);
  const empty = demoStore.create({ name: "Empty sample", description: "", color: "#70867d", position: 9, skipInbox: false, definition: { revision: 1, sender: { addresses: ["absent@example.net"] } } });
  await saved(empty.id);
  expect(container.textContent).toContain("0 matches");
  expect(container.querySelectorAll(".view-thread-row")).toHaveLength(0);
  await saved(id);
  expect(container.querySelector("h2")?.textContent).toBe("Family renamed");
  expect(container.querySelector(".view-thread-list")?.textContent).toContain(mom.subject);
  await saved("view_weekly_production");
  expect(container.textContent).toContain("no Lane, Facet, Context, or Workflow evidence");
  expect(container.textContent).not.toContain("0 matches");
  expect(requests).toEqual([]);
});
