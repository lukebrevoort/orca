import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { organizationLaneConfigurationFixture, organizationViewsFixture } from "@orca/shared";
import { SavedViewDeletion } from "./saved-view-deletion";
const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/dev/inbox?destination=organization" });
  const values: Record<string, unknown> = {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
    Element: browserWindow.Element, Node: browserWindow.Node, Event: browserWindow.Event, InputEvent: browserWindow.InputEvent,
    MouseEvent: browserWindow.MouseEvent, KeyboardEvent: browserWindow.KeyboardEvent,
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  globalThis.fetch = originalFetch;
  for (const name of browserGlobals) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browserWindow.close();
});

function button(container: unknown, label: string) {
  const found = [...(container as HTMLElement).querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  return found as unknown as HTMLButtonElement;
}

async function click(target: HTMLButtonElement) {
  await act(async () => { target.click(); await Promise.resolve(); });
}

function describeResponse(workspaceRevision: number) {
  return {
    workspaceId: "workspace-demo",
    accountIds: ["account-demo"],
    workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
    capabilities: {
      operations: { describe: true, query: true, simulate: true, apply: true, revert: true },
      surfaces: {
        rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true },
        mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false },
      },
      authority: { sendMail: false, deleteProviderMail: false },
    },
    workspaceRevision,
    facetDefinitions: [],
    workflowStates: [],
    laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision },
  };
}

const view = { ...organizationViewsFixture[0]!, skipInbox: true, revision: 3 };
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function renderDeletion(options: { demoMode?: boolean; onCancel?: () => void; onDeleted?: (id: string) => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<SavedViewDeletion viewId={view.id} label={view.name} demoView={view} demoMode={options.demoMode} onCancel={options.onCancel ?? (() => {})} onDeleted={options.onDeleted ?? (() => {})} onBusyChange={options.onBusyChange ?? (() => {})}/>));
  await flush(); await flush();
  return container as unknown as HTMLElement;
}
function fakeFetch(handle: (url: string, method: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handle(String(input), init?.method ?? "GET"))) as unknown as typeof fetch;
}
function listed(revision = 7, item = view) { return Response.json({ workspaceId: "workspace-demo", workspaceRevision: revision, items: [item] }); }

test("Cancel performs no mutation; confirmation explains Inbox exclusion and never email deletion", async () => {
  const requests: string[] = []; let cancelled = false;
  fakeFetch((url, method) => { requests.push(`${method} ${url}`); return url.endsWith("describe") ? Response.json(describeResponse(7)) : listed(); });
  const container = await renderDeletion({ onCancel: () => { cancelled = true; } });
  expect(container.textContent).toContain("Inbox exclusion policy");
  expect(container.textContent).toContain("Matching mail may return to Inbox. No email is deleted.");
  expect(container.textContent).toContain("currently skips Inbox");
  expect(button(container, "Delete view").disabled).toBe(false);
  await click(button(container, "Cancel"));
  expect(cancelled).toBe(true);
  expect(requests.every(item => item.startsWith("GET "))).toBe(true);
});

test("confirmed deletion binds canonical revisions and blocks duplicate clicks and cancel while pending", async () => {
  const mutations: string[] = []; const deleted: string[] = []; const busy: boolean[] = [];
  let finish!: (response: Response) => void;
  fakeFetch((url, method) => {
    if (method === "DELETE") { mutations.push(url); return new Promise(resolve => { finish = resolve; }); }
    return url.endsWith("describe") ? Response.json(describeResponse(7)) : listed();
  });
  const container = await renderDeletion({ onDeleted: id => deleted.push(id), onBusyChange: value => busy.push(value) });
  const confirm = button(container, "Delete view");
  await act(async () => { confirm.click(); confirm.click(); });
  expect(mutations).toHaveLength(1);
  const request = new URL(mutations[0]!, "https://orca.test");
  expect(request.pathname).toBe(`/v1/organization/views/${view.id}`);
  expect(request.searchParams.get("expectedRevision")).toBe("3");
  expect(request.searchParams.get("expectedWorkspaceRevision")).toBe("7");
  expect(request.searchParams.get("idempotencyKey")).toBeTruthy();
  expect(button(container, "Cancel").disabled).toBe(true);
  expect(button(container, "Deleting…").disabled).toBe(true);
  expect(deleted).toEqual([]);
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(deleted).toEqual([view.id]);
  expect(busy).toEqual([true, false]);
});

test("stale deletion requires refresh and explicit confirmation against new revisions", async () => {
  const mutations: string[] = []; let revision = 7;
  fakeFetch((url, method) => {
    if (method === "DELETE") { mutations.push(url); if (mutations.length === 1) { revision = 8; return Response.json({ error: { message: "stale revision" } }, { status: 409 }); } return new Response(null, { status: 204 }); }
    return url.endsWith("describe") ? Response.json(describeResponse(revision)) : listed(revision, { ...view, revision: revision - 4 });
  });
  const deleted: string[] = []; const container = await renderDeletion({ onDeleted: id => deleted.push(id) });
  await click(button(container, "Delete view")); await flush();
  expect(container.textContent).toContain("Refresh and review it again");
  expect(button(container, "Delete view").disabled).toBe(true);
  expect(deleted).toEqual([]);
  await click(button(container, "Refresh view")); await flush(); await flush();
  expect(mutations).toHaveLength(1);
  expect(button(container, "Delete view").disabled).toBe(false);
  await click(button(container, "Delete view"));
  const next = new URL(mutations[1]!, "https://orca.test");
  expect(next.searchParams.get("expectedWorkspaceRevision")).toBe("8");
  expect(next.searchParams.get("expectedRevision")).toBe("4");
  expect(next.searchParams.get("idempotencyKey")).not.toBe(new URL(mutations[0]!, "https://orca.test").searchParams.get("idempotencyKey"));
  expect(deleted).toEqual([view.id]);
});

test("ambiguous failure retains its retry envelope after authority recovery", async () => {
  const mutations: string[] = [];
  fakeFetch((url, method) => {
    if (method === "DELETE") { mutations.push(url); return mutations.length === 1 ? Response.json({ error: { message: "Temporary error" } }, { status: 503 }) : new Response(null, { status: 204 }); }
    return url.endsWith("describe") ? Response.json(describeResponse(7)) : listed();
  });
  const container = await renderDeletion();
  await click(button(container, "Delete view")); await flush();
  expect(container.textContent).toContain("Temporary error");
  await click(button(container, "Refresh view")); await flush(); await flush();
  await click(button(container, "Delete view"));
  expect(mutations).toHaveLength(2);
  expect(mutations[1]).toBe(mutations[0]);
});

test("read-only authority never permits deletion", async () => {
  const requests: string[] = [];
  fakeFetch((url, method) => {
    requests.push(`${method} ${url}`);
    const response = describeResponse(7); response.capabilities.surfaces.rest.apply = false;
    return url.endsWith("describe") ? Response.json(response) : listed();
  });
  const container = await renderDeletion();
  expect(button(container, "Delete view").disabled).toBe(true);
  await click(button(container, "Delete view"));
  expect(requests.every(item => item.startsWith("GET "))).toBe(true);
});

test("demo deletion is disabled so sample views cannot resurrect after a claimed permanent deletion", async () => {
  const deleted: string[] = [];
  fakeFetch(() => { throw new Error("Demo must not fetch"); });
  const container = await renderDeletion({ demoMode: true, onDeleted: id => deleted.push(id) });
  await click(button(container, "Delete view"));
  expect(deleted).toEqual([]);
  expect(button(container, "Delete view").disabled).toBe(true);
  expect(container.textContent).toContain("Sample views cannot be deleted");
});

test("canonical absence after lost response reconciles without a second delete", async () => {
  let deletedOnServer = false; const requests: string[] = []; const deleted: string[] = [];
  fakeFetch((url, method) => {
    requests.push(`${method} ${url}`);
    if (method === "DELETE") { deletedOnServer = true; return Response.json({ error: { message: "Response lost" } }, { status: 503 }); }
    if (url.endsWith("describe")) return Response.json(describeResponse(7));
    return deletedOnServer ? Response.json({ workspaceId: "workspace-demo", workspaceRevision: 8, items: [] }) : listed();
  });
  const container = await renderDeletion({ onDeleted: id => deleted.push(id) });
  await click(button(container, "Delete view")); await flush();
  await click(button(container, "Refresh view")); await flush(); await flush();
  expect(deleted).toEqual([view.id]);
  expect(requests.filter(item => item.startsWith("DELETE "))).toHaveLength(1);
});


test("partial view lists cannot authorize deletion or remove a shortcut", async () => {
  const deleted: string[] = [];
  fakeFetch(url => url.endsWith("describe") ? Response.json(describeResponse(7)) : Response.json({ workspaceId: "workspace-demo", workspaceRevision: 7, items: [] }, { status: 206 }));
  const container = await renderDeletion({ onDeleted: id => deleted.push(id) });
  expect(deleted).toEqual([]);
  expect(button(container, "Delete view").disabled).toBe(true);
  expect(container.textContent).toContain("complete view list is unavailable");
});
