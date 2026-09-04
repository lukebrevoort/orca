import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { organizationViewsFixture } from "@orca/shared";
import { OrganizationViewsWorkspace } from "./organization-views";
import { OrganizationAuthorityProvider } from "./organization-authority";

const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/dev/inbox?destination=organization" });
  const values: Record<string, unknown> = {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, HTMLInputElement: browserWindow.HTMLInputElement, HTMLButtonElement: browserWindow.HTMLButtonElement,
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

async function renderWorkspace(demoMode = true) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<OrganizationAuthorityProvider previewMode><OrganizationViewsWorkspace demoMode={demoMode} /></OrganizationAuthorityProvider>));
  return container as unknown as HTMLElement;
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  return found as unknown as HTMLButtonElement;
}

function input(container: HTMLElement, label: string) {
  const field = [...container.querySelectorAll("label")].find((candidate) => candidate.querySelector("span")?.textContent === label)?.querySelector("input");
  expect(field, `input ${label}`).toBeDefined();
  return field as unknown as HTMLInputElement;
}

async function change(field: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browserWindow.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new browserWindow.InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }) as unknown as Event);
    field.dispatchEvent(new browserWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
}

async function click(target: HTMLButtonElement) {
  await act(async () => { target.click(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function orderedNames(container: HTMLElement) {
  return [...container.querySelectorAll(".view-chip strong")].map((item) => item.textContent);
}

describe("BRE-378 Organization Views lifecycle interactions", () => {
  test("edits the selected definition and display metadata", async () => {
    const container = await renderWorkspace();
    await click(button(container, "Edit definition"));
    expect(container.textContent).toContain("Edit live perspective");
    expect(input(container, "View name").value).toBe("Weekly production review");
    expect(input(container, "Subject contains").value).toBe("production failure");
    await change(input(container, "View name"), "Release blocker review");
    await change(input(container, "Subject contains"), "release blocker");
    await click(button(container, "Save changes"));
    expect(container.textContent).not.toContain("Edit live perspective");
    expect(container.querySelector(".view-results h3")?.textContent).toBe("Release blocker review");
    expect(orderedNames(container)[0]).toBe("Release blocker review");
  });

  test("starts with a readable default, suggests a name, and adds, edits, and removes named clauses", async () => {
    const container = await renderWorkspace();
    await click(button(container, "+ New View"));
    expect(container.textContent).toContain("Show messages from any account in any lane.");
    expect(input(container, "View name").value).toBe("All messages");
    expect(container.textContent).toContain("Any message can match.");

    await click(button(container, "Add filter ＋"));
    await click(button(container, "Read stateShow read or unread Threads"));
    await flush();
    expect(container.querySelector('[data-clause="read"]')).not.toBeNull();
    expect(input(container, "View name").value).toBe("Unread messages");

    await click(button(container, "Add filter ＋"));
    await click(button(container, "LaneChoose where Threads are primarily placed"));
    await flush();
    expect(container.querySelector('[data-clause="lane"]')).not.toBeNull();
    expect(input(container, "View name").value).toBe("Unread Focus messages");
    await click(button(container, "Everything else"));
    await click(button(container, "Focus"));
    await flush();
    expect(container.textContent).toContain("in Everything else");

    await click(container.querySelector('[aria-label="Remove read state filter"]') as unknown as HTMLButtonElement);
    await flush();
    expect(container.querySelector('[data-clause="read"]')).toBeNull();
    expect(browserWindow.document.activeElement?.textContent).toContain("Add filter");
  });

  test("operates the Add filter menu with Arrow keys, Enter, and Escape", async () => {
    const container = await renderWorkspace();
    await click(button(container, "+ New View"));
    const trigger = button(container, "Add filter ＋");
    trigger.focus();
    await act(async () => trigger.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
    await flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(browserWindow.document.activeElement?.textContent).toContain("Account");
    await act(async () => browserWindow.document.activeElement?.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(browserWindow.document.activeElement?.textContent).toContain("Lane");
    await act(async () => browserWindow.document.activeElement?.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await flush();
    expect(container.querySelector('[data-clause="lane"]')).not.toBeNull();

    trigger.focus();
    await act(async () => trigger.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
    await flush();
    await act(async () => browserWindow.document.activeElement?.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(browserWindow.document.activeElement as unknown).toBe(trigger as unknown);
  });

  test("keeps every predicate family reachable while progressively disclosing infrequent filters", async () => {
    const container = await renderWorkspace();
    await click(button(container, "+ New View"));
    await click(button(container, "Add filter ＋"));
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.textContent).toContain("Account");
    expect(menu.textContent).toContain("Lane");
    expect(menu.textContent).toContain("Human Signal");
    expect(menu.textContent).toContain("Sender");
    expect(menu.textContent).toContain("Subject");
    expect(menu.textContent).not.toContain("Date range");
    await click(button(menu, "More filtersWorkflow, Facet, Context, and date +"));
    expect(menu.textContent).toContain("Workflow");
    expect(menu.textContent).toContain("Facet");
    expect(menu.textContent).toContain("Context");
    expect(menu.textContent).toContain("Date range");
    expect(container.querySelector(".view-composer")?.textContent).not.toContain("account_gmail");
    expect(container.querySelector(".view-composer")?.textContent).not.toContain("lane_focus");
  });

  test("creates the exact existing wire envelope and labels validation and draft preview honestly", async () => {
    let createPayload: Record<string, unknown> | null = null;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views" && method === "GET") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: organizationViewsFixture });
      if (path.includes("/results")) return Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/views" && method === "POST") {
        createPayload = JSON.parse(String(init?.body));
        const payload = createPayload as { name: string; description: string; color: string; position: number; definition: unknown };
        return Response.json({ id: "view_created", workspaceId: "workspace_demo", name: payload.name, description: payload.description, color: payload.color, position: payload.position, definition: payload.definition, revision: 1, createdAt: "2026-09-04T17:00:00.000Z", updatedAt: "2026-09-04T17:00:00.000Z" });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "+ New View"));
    await click(button(container, "Add filter ＋"));
    await click(button(container, "SubjectMatch words in the Thread subject"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter words to match in the subject.");
    expect((button(container, "Save View") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("No live query has run for this draft.");
    await change(input(container, "Subject contains"), "release blocker");
    await flush();
    expect(input(container, "Subject contains").value).toBe("release blocker");
    expect(container.querySelector('[role="alert"]')?.textContent ?? "no alert").toBe("no alert");
    expect((button(container, "Save View") as HTMLButtonElement).disabled).toBe(false);
    await click(button(container, "Save View"));
    await flush();
    expect(Object.keys(createPayload ?? {}).sort()).toEqual(["color", "definition", "description", "expectedWorkspaceRevision", "idempotencyKey", "name", "position"].sort());
    expect(createPayload).toMatchObject({
      expectedWorkspaceRevision: 4,
      name: "release blocker messages",
      description: "",
      color: "#70867d",
      position: 3,
      definition: { revision: 1, thread: { subjectContains: "release blocker" } },
    });
    const savedPayload = createPayload as Record<string, unknown> | null;
    expect(typeof savedPayload?.idempotencyKey).toBe("string");
  });

  test("reorders Views deterministically while preserving selection", async () => {
    const container = await renderWorkspace();
    const selected = container.querySelector('.view-chip[aria-pressed="true"]')?.textContent;
    await click(container.querySelector('[aria-label="Move Weekly production review down"]') as unknown as HTMLButtonElement);
    expect(orderedNames(container)).toEqual(["Urgent humans", "Weekly production review", "Orca launch context"]);
    expect(container.querySelector('.view-chip[aria-pressed="true"]')?.textContent).toBe(selected);
  });

  test("requires explicit destructive confirmation and selects a safe neighbor after removal", async () => {
    const container = await renderWorkspace();
    await click(button(container, "Remove View"));
    expect(button(container, "Confirm remove").classList.contains("view-confirm")).toBe(true);
    expect(orderedNames(container)).toContain("Weekly production review");
    await click(button(container, "Confirm remove"));
    expect(orderedNames(container)).not.toContain("Weekly production review");
    expect(container.querySelector('.view-chip[aria-pressed="true"] strong')?.textContent).toBe("Urgent humans");
  });

  test("reloads canonical positions and shifted revisions after an authorized removal", async () => {
    let listReads = 0;
    let reorderRequest: { expectedWorkspaceRevision: number; items: Array<{ id: string; expectedRevision: number }> } | null = null;
    const canonicalRemaining = [
      { ...organizationViewsFixture[1]!, position: 0, revision: 2 },
      { ...organizationViewsFixture[2]!, position: 1, revision: 2 },
    ];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views" && method === "GET") {
        listReads += 1;
        return Response.json({ workspaceId: "workspace_demo", workspaceRevision: listReads === 1 ? 1 : 2, items: listReads === 1 ? organizationViewsFixture : canonicalRemaining });
      }
      if (path.includes("/results")) {
        const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? "view_weekly_production";
        const view = [...organizationViewsFixture, ...canonicalRemaining].find((candidate) => candidate.id === viewId)!;
        return Response.json({ viewId, viewRevision: view.revision, accountIds: [], items: [], nextCursor: null, limit: 25 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/v1/organization/views/reorder") {
        reorderRequest = JSON.parse(String(init?.body));
        return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 3, items: [...canonicalRemaining].reverse().map((view, position) => ({ ...view, position, revision: 3 })) });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Remove View"));
    await click(button(container, "Confirm remove"));
    await flush(); await flush();
    expect(listReads).toBe(2);
    expect(orderedNames(container)).toEqual(["Urgent humans", "Orca launch context"]);
    await click(container.querySelector('[aria-label="Move Urgent humans down"]') as unknown as HTMLButtonElement);
    await flush();
    expect(reorderRequest).toMatchObject({ expectedWorkspaceRevision: 2, items: [{ id: "view_urgent_humans", expectedRevision: 2 }, { id: "view_orca_context", expectedRevision: 2 }] });
  });

  test("keeps state unchanged and suppresses every later mutation after authority is denied", async () => {
    let submittedDefinition: unknown;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views" && method === "GET") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 1, items: organizationViewsFixture });
      if (path.includes("/results")) {
        const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? "view_weekly_production";
        const view = organizationViewsFixture.find((candidate) => candidate.id === viewId);
        return Response.json({ viewId, viewRevision: view?.revision ?? 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      }
      if (method === "PATCH") {
        submittedDefinition = JSON.parse(String(init?.body)).patch.definition;
        return Response.json({ error: { code: "resource_denied", message: "A referenced resource belongs to another Workspace" } }, { status: 403 });
      }
      if (path === "/v1/organization/views/reorder") return Response.json({ error: { code: "revision_conflict", message: "The View order changed" } }, { status: 409 });
      if (method === "DELETE") return Response.json({ error: { code: "account_denied", message: "Only a human can remove this View" } }, { status: 403 });
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    expect(orderedNames(container)).toEqual(["Weekly production review", "Urgent humans", "Orca launch context"]);

    await click([...container.querySelectorAll("button.view-chip")].find((candidate) => candidate.textContent?.includes("Urgent humans")) as unknown as HTMLButtonElement);
    await click(button(container, "Edit definition"));
    await change(input(container, "View name"), "Unauthorized rename");
    await click(button(container, "Save changes")); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("another Workspace");
    expect(orderedNames(container)[1]).toBe("Urgent humans");
    expect(submittedDefinition).toMatchObject({ humanSignal: { minimumScore: 7, classifications: ["likely_human"] } });

    expect((container.querySelector('[aria-label="Move Weekly production review down"]') as HTMLButtonElement).disabled).toBe(true);
    expect((button(container, "Remove View") as HTMLButtonElement).disabled).toBe(true);
    expect(orderedNames(container)).toEqual(["Weekly production review", "Urgent humans", "Orca launch context"]);
  });

  test("refetches and renders the edited View revision without a selection switch", async () => {
    const firstItem = organizationViewsFixture.length ? {
      accountId: "account_a", accountEmail: "a@example.com", provider: "gmail", threadId: "thread_before", subject: "Before edit",
      latestReceivedAt: "2026-08-25T18:00:00.000Z", messageCount: 1, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Before", email: "before@example.com" }, humanSignal: 7, humanClassification: "likely_human",
    } : null;
    const refreshedItem = { ...firstItem!, threadId: "thread_after", subject: "Live refreshed result" };
    let resultReads = 0;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views" && method === "GET") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 1, items: organizationViewsFixture });
      if (path.includes("/results")) {
        resultReads += 1;
        return Response.json({ viewId: "view_weekly_production", viewRevision: resultReads === 1 ? 1 : 2, accountIds: ["account_a"], items: [resultReads === 1 ? firstItem : refreshedItem], nextCursor: null, limit: 25 });
      }
      if (method === "PATCH") return Response.json({ ...organizationViewsFixture[0]!, name: "Edited live", revision: 2 });
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    expect(container.textContent).toContain("Before edit");
    await click(button(container, "Edit definition"));
    await change(input(container, "View name"), "Edited live");
    await click(button(container, "Save changes"));
    await flush(); await flush();
    expect(resultReads).toBe(2);
    expect(container.textContent).toContain("Live refreshed result");
    expect(container.textContent).not.toContain("Before edit");
  });

  test("loads continuation pages, appends without duplicates, and exposes the terminal disabled state", async () => {
    const item = (threadId: string, subject: string) => ({
      accountId: "account_a", accountEmail: "a@example.com", provider: "gmail", threadId, subject,
      latestReceivedAt: "2026-08-25T18:00:00.000Z", messageCount: 1, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Ari", email: "ari@example.com" }, humanSignal: 8, humanClassification: "likely_human",
    });
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 1, items: organizationViewsFixture });
      if (path.includes("cursor=cursor_1")) return Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: ["account_a"], items: [item("thread_one", "First page"), item("thread_two", "Second page")], nextCursor: null, limit: 25 });
      if (path.includes("/results")) return Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: ["account_a"], items: [item("thread_one", "First page")], nextCursor: "cursor_1", limit: 25 });
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Load more"));
    await flush(); await flush();
    expect(container.textContent?.match(/First page/g)?.length).toBe(1);
    expect(container.textContent).toContain("Second page");
    const end = button(container, "All matching Threads loaded");
    expect(end.disabled).toBe(true);
  });

  test("keeps a pending continuation disabled and discards it after the selection changes", async () => {
    const item = (threadId: string, subject: string) => ({
      accountId: "account_a", accountEmail: "a@example.com", provider: "gmail", threadId, subject,
      latestReceivedAt: "2026-08-25T18:00:00.000Z", messageCount: 1, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Ari", email: "ari@example.com" }, humanSignal: 8, humanClassification: "likely_human",
    });
    let resolveMore!: (response: Response) => void;
    const pendingMore = new Promise<Response>((resolve) => { resolveMore = resolve; });
    globalThis.fetch = (async (request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 1, items: organizationViewsFixture });
      if (path.includes("cursor=pending")) return pendingMore;
      const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? "view_weekly_production";
      const view = organizationViewsFixture.find((candidate) => candidate.id === viewId)!;
      return Response.json({ viewId, viewRevision: view.revision, accountIds: ["account_a"], items: [item(`thread_${viewId}`, view.name)], nextCursor: viewId === "view_weekly_production" ? "pending" : null, limit: 25 });
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Load more"));
    expect(button(container, "Loading more Threads…").disabled).toBe(true);
    await click([...container.querySelectorAll("button.view-chip")].find((candidate) => candidate.textContent?.includes("Urgent humans")) as unknown as HTMLButtonElement);
    await flush(); await flush();
    await act(async () => resolveMore(Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: ["account_a"], items: [item("thread_stale", "Stale continuation")], nextCursor: null, limit: 25 })));
    await flush();
    expect(container.textContent).toContain("Urgent humans");
    expect(container.textContent).not.toContain("Stale continuation");
  });

  test("keeps Load more retryable after a continuation error", async () => {
    const first = {
      accountId: "account_a", accountEmail: "a@example.com", provider: "gmail", threadId: "thread_one", subject: "First page",
      latestReceivedAt: "2026-08-25T18:00:00.000Z", messageCount: 1, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Ari", email: "ari@example.com" }, humanSignal: 8, humanClassification: "likely_human",
    };
    globalThis.fetch = (async (request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 1, items: organizationViewsFixture });
      if (path.includes("cursor=retry")) return Response.json({ error: { message: "Network tide changed" } }, { status: 503 });
      return Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: ["account_a"], items: [first], nextCursor: "retry", limit: 25 });
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Load more"));
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network tide changed");
    expect(button(container, "Load more").disabled).toBe(false);
  });
});
