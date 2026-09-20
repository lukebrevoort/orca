import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { organizationViewsFixture } from "@orca/shared";
import { AppSidebar, ManageSpacesDialog, OrganizationStudio } from "./desktop-switch";
import { OrganizationViewGrowthWorkspace } from "./organization-view-growth";
import { selectedSenderPreparation } from "./App";
import { TopLayerProvider } from "./top-layer";
import type { WorkflowSpace } from "./navigation";

const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: InstanceType<typeof Window>;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  browser = new Window({ url: "http://localhost:5192/dev/inbox?destination=all&addSendersTo=view_weekly_production" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name as keyof typeof browser] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as Record<string, unknown>)[name]; }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browser.close();
});
const button = (label: string) => {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  expect(result, label).toBeDefined(); return result!;
};
async function click(label: string) { await act(async () => { button(label).click(); await Promise.resolve(); }); }

test("hidden views can be edited without restoring; restore retains mixed tool order", async () => {
  const edited: string[] = []; let managed = 0;
  function Harness() {
    const [spaces, setSpaces] = useState<WorkflowSpace[]>([
      { id: "collection", label: "Manual", description: "Collection", kind: "collection", custom: true },
      { id: "hidden", label: "Live matches", description: "Saved view", kind: "view", hidden: true },
      { id: "later", label: "Later", description: "Reminders", kind: "built_in" },
    ]);
    return <ManageSpacesDialog spaces={spaces} onClose={() => {}} onCreate={() => {}} onHide={() => {}} onRename={() => {}} onReorder={() => {}} onRestore={space => setSpaces(items => items.map(item => item.id === space.id ? { ...item, hidden: false } : item))} onEditView={id => edited.push(id)} onManageViews={() => { managed++; }}/>;
  }
  await act(async () => root.render(<TopLayerProvider><Harness/></TopLayerProvider>));
  button("Edit Live matches").focus(); expect(document.activeElement).toBe(button("Edit Live matches"));
  await click("Edit Live matches"); expect(edited).toEqual(["hidden"]);
  expect(document.querySelectorAll(".desktop-space-list article").length).toBe(2);
  await act(async () => document.querySelector<HTMLButtonElement>(".desktop-hidden-restore")!.click());
  expect([...document.querySelectorAll(".desktop-space-list article strong")].map(node => node.textContent)).toEqual(["Manual", "Live matches", "Later"]);
  await click("Manage saved views"); expect(managed).toBe(1);
});

test("saved-view semantics keep mixed order, active state and mobile management reachable", async () => {
  let managed = 0;
  await act(async () => root.render(<TopLayerProvider><AppSidebar theme="dark" onCompose={() => {}} onManageSpaces={() => {}} onManageTools={() => {}} onManageViews={() => { managed++; }} onNavigate={() => {}} projection={{ account: { displayName: "Owner", email: "owner@example.com", accountCount: 1, health: "synced" }, online: true, active: "view:live", spaces: [
    { id: "live", label: "Live matches", description: "Saved view", kind: "view", color: "#c7788c" },
    { id: "manual", label: "Manual", description: "Collection", kind: "collection" },
    { id: "later", label: "Later", description: "Reminders", kind: "built_in" },
  ] }}/></TopLayerProvider>));
  expect(button("Live matches, saved view").getAttribute("aria-current")).toBe("page");
  const view = button("Live matches, saved view");
  expect(view.textContent).toBe("Live matches");
  expect(view.querySelector("svg")).toBeNull();
  expect(view.querySelector<HTMLElement>(".desktop-space-mark")?.style.background).toBe("#c7788c");
  expect(button("Manual").querySelector("svg path")?.getAttribute("d")).toBe("M2 5h6l2 2h8v10H2z");
  expect(button("Later").querySelector("svg circle")).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>(".desktop-mobile-more")!.click());
  const menu = document.querySelector('[role="menu"]')!;
  const mobileView = menu.querySelector<HTMLButtonElement>('[aria-label="Live matches, saved view"]')!;
  expect(mobileView.textContent).toBe("Live matches");
  expect(mobileView.querySelector("svg")).toBeNull();
  expect(mobileView.querySelector<HTMLElement>(".desktop-space-mark")?.style.background).toBe("#c7788c");
  const manage = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Manage saved views")!;
  manage.focus(); expect(document.activeElement).toBe(manage);
  await act(async () => manage.click()); expect(managed).toBe(1); expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("management entry opens Views directly without requiring the overview tab", async () => {
  await act(async () => root.render(<TopLayerProvider><OrganizationStudio interactivePreview viewsRoute={{ section: "views", editViewId: null }}/></TopLayerProvider>));
  expect(document.querySelector("#organization-views")?.hasAttribute("hidden")).toBe(false);
  expect(button("Views").getAttribute("aria-current")).toBe("page");
});

test("blocked sender growth edits the selected saved view and returns with exact source selection", async () => {
  const context = { focus: "selected-mail", ids: ["m1"] };
  const preparation = selectedSenderPreparation([{ id: "m1", threadId: "t1", accountId: "account_gmail" }], "/dev/inbox?destination=all&q=maya");
  let returned: unknown;
  await act(async () => root.render(<OrganizationViewGrowthWorkspace demoMode compact entry={{ preparation, returnContext: context }} onCancel={value => { returned = value; }} onCommitted={() => { throw new Error("Editing must return to chooser"); }}/>));
  expect(button("Preview added senders").disabled).toBe(true);
  await click(`Edit ${organizationViewsFixture[0]!.name}`);
  expect(document.querySelector(".view-growth-return")?.textContent).toContain("does not add your selected senders");
  const field = [...document.querySelectorAll("label")].find(node => node.textContent?.startsWith("View name"))?.querySelector("input");
  expect(field?.value).toBe(organizationViewsFixture[0]!.name);
  await click("Return to selected senders");
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Saved View to grow"]')?.value).toBe(organizationViewsFixture[0]!.id);
  expect(document.querySelector(".view-growth-chooser")?.textContent).toContain("1 message");
  await click("Cancel"); expect(returned).toBe(context);
});
