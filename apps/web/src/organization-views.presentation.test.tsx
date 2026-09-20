import { demoStore } from "./demo-store";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { organizationViewsFixture } from "@orca/shared";
import { OrganizationAuthorityProvider } from "./organization-authority";
import { OrganizationViewsWorkspace, SavedOrganizationViewWorkspace } from "./organization-views";

const keys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let browser: Window;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  demoStore.reset();
  browser = new Window({ url: "http://localhost/dev/inbox?destination=organization-studio&section=views" });
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "window" ? browser : browser[key as keyof Window] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of keys) { const descriptor = originals.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browser.close();
});
async function renderEditor(id?: string) {
  await act(async () => root.render(<OrganizationAuthorityProvider previewMode><OrganizationViewsWorkspace demoMode initialEditViewId={id}/></OrganizationAuthorityProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label)!;
  expect(button).toBeDefined(); await act(async () => button.click());
}
async function rename(value: string) {
  const field = container.querySelector<HTMLInputElement>(".view-identity input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: value }) as unknown as Event);
  });
}

test("BRE-414 editor has one task heading, ordered groups, and plain mail separation", async () => {
  await renderEditor(organizationViewsFixture[0]!.id);
  expect(container.querySelector("h2")?.textContent).toBe("Edit Weekly production review");
  expect(container.textContent).not.toContain("Perspective builder");
  expect(container.textContent).not.toContain("predicate families");
  expect(container.textContent).toContain("same conversation can appear in more than one view");
  expect(container.textContent).toContain("existing and future matching mail");
  expect(container.textContent).toContain("Hiding a sidebar shortcut only hides the shortcut");
  const form = container.querySelector("form")!;
  const groups = [...form.querySelectorAll(".view-identity, .view-scope-sentence, .view-clause-list, .view-inbox-section, .view-builder-footer, .view-save-bar")].map(item => item.className);
  expect(groups).toEqual(["view-identity", "view-scope-sentence", "view-clause-list", "view-inbox-section", "view-builder-footer", "view-save-bar"]);
});

test("BRE-417 consumes exact edit ID once and protects a dirty draft from replacement", async () => {
  await renderEditor(organizationViewsFixture[1]!.id);
  expect(container.querySelector<HTMLInputElement>(".view-identity input")?.value).toBe("Urgent humans");
  await rename("My unsaved name");
  await renderEditor(organizationViewsFixture[1]!.id);
  expect(container.querySelector<HTMLInputElement>(".view-identity input")?.value).toBe("My unsaved name");
  await renderEditor(organizationViewsFixture[0]!.id);
  expect(container.querySelector("dialog")?.textContent).toContain("Discard changes");
  await click("Keep editing");
  expect(container.querySelector<HTMLInputElement>(".view-identity input")?.value).toBe("My unsaved name");
  await renderEditor(undefined);
  await renderEditor(organizationViewsFixture[0]!.id);
  await click("Discard draft");
  expect(container.querySelector<HTMLInputElement>(".view-identity input")?.value).toBe("Weekly production review");
  await rename("Second unsaved draft");
  await click("Cancel");
  expect(container.querySelector("dialog")?.textContent).toContain("Discard changes");
});

test("BRE-417 missing edit ID offers recovery without editing a different view", async () => {
  await renderEditor("view_removed");
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain("This view is no longer available");
  await click("Browse views");
  expect(document.activeElement?.className).toBe("view-chip");
});

test("BRE-414 saved empty view shows rules and Inbox policy with a working edit action", async () => {
  const empty = demoStore.create({ name: "Empty sample", description: "", color: "#70867d", position: 3, skipInbox: false, definition: { revision: 1, accountIds: ["acct_demo"], sender: { addresses: ["absent@example.net"] } } });
  await act(async () => root.render(<SavedOrganizationViewWorkspace demoMode previewMode viewId={empty.id} onManage={() => {}} onOpenThread={() => {}}/>));
  expect(container.querySelector('[aria-label="Saved view rules"]')?.textContent).toContain("Inbox behavior");
  expect(container.textContent).toContain("All Mail");
  expect(container.textContent).toContain("No sample conversations match these filters");
  await click("Edit matching rules");
  expect(container.querySelector("h2")?.textContent).toBe("Edit Empty sample");
});
