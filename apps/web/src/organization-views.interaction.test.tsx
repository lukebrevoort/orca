import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { organizationLaneConfigurationFixture, organizationViewsFixture, type FacetDefinition, type FacetFilter, type OrganizationView } from "@orca/shared";
import { OrganizationViewsWorkspace, SavedOrganizationViewWorkspace } from "./organization-views";
import { OrganizationAuthorityProvider } from "./organization-authority";

const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/dev/inbox?destination=organization" });
  const values: Record<string, unknown> = {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, HTMLInputElement: browserWindow.HTMLInputElement, HTMLSelectElement: browserWindow.HTMLSelectElement, HTMLButtonElement: browserWindow.HTMLButtonElement,
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

async function renderWorkspace(demoMode = true, previewMode = true) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<OrganizationAuthorityProvider previewMode={previewMode}><OrganizationViewsWorkspace demoMode={demoMode} /></OrganizationAuthorityProvider>));
  return container as unknown as HTMLElement;
}

function selectField(container: HTMLElement, label: string) {
  const field = container.querySelector(`select[aria-label="${label}"]`);
  expect(field, `select ${label}`).toBeDefined();
  return field as unknown as HTMLSelectElement;
}

async function choose(field: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browserWindow.HTMLSelectElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new browserWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
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

function testDigest(value: unknown) {
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `sha256:${(hash >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}

function previewResponse(init?: RequestInit, options: { state?: "matches" | "zero"; items?: unknown[] } = {}) {
  const request = JSON.parse(String(init?.body)) as { draft: Record<string, unknown>; page: { limit: number } };
  const definition = request.draft.definition as Record<string, unknown>;
  const digest = testDigest(definition);
  const items = options.items ?? [];
  const zero = options.state === "zero";
  return Response.json({
    workspaceId: "workspace_demo", workspaceRevision: 4,
    draft: {
      ...request.draft,
      definitionDigest: digest,
      definitionKind: Object.keys(definition).some((key) => key !== "revision") ? "filtered" : "match_all",
      effectiveAccountIds: ["account_gmail"],
      summary: { text: "Test definition", clauses: ["test filter"] },
      saveEligibility: { allowed: Object.keys(definition).some((key) => key !== "revision"), code: Object.keys(definition).some((key) => key !== "revision") ? null : "blank_definition", detail: "Reviewed in test" },
    },
    results: {
      accountIds: ["account_gmail"], items, nextCursor: zero ? null : "more_test_results", limit: request.page.limit,
      count: zero ? { kind: "exact", value: 0 } : { kind: "shown", value: Math.max(1, items.length) },
      state: zero ? "zero" : "matches",
      provenance: { source: "stored_mail", definitionDigest: digest, authorizedScopeDigest: `sha256:${"a".repeat(64)}`, evaluatedAt: "2026-09-06T18:00:00.000Z" },
    },
  });
}

function committedResponse(init?: RequestInit, viewId = "view_committed") {
  const request = JSON.parse(String(init?.body)) as { draft: { identity: OrganizationView["definition"] & { name: string; description: string; color: string; position: number }; definition: OrganizationView["definition"] } };
  return Response.json({
    workspaceId: "workspace_demo", workspaceRevision: 5,
    view: { id: viewId, workspaceId: "workspace_demo", ...request.draft.identity, definition: request.draft.definition, revision: 1, createdAt: "2026-09-06T18:00:00.000Z", updatedAt: "2026-09-06T18:00:00.000Z" },
    navigation: { destination: `view:${viewId}`, href: `/?destination=view%3A${viewId}` },
  });
}

const contextQueryFixture = {
  workspaceId: "workspace_demo", accountIds: [], workspaceRevision: 4,
  contextTypes: [
    { id: "context_type_project", name: "Project", position: 0, retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "context_type_customer", name: "Customer", position: 1, retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
  ],
  relationshipTypes: [
    { id: "relationship_concerns", contextTypeId: "context_type_project", name: "Concerns", inverseName: "Concerned by", direction: "thread_to_context", position: 0, maximumPerThread: 20, retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "relationship_supports", contextTypeId: "context_type_customer", name: "Supports", inverseName: "Supported by", direction: "thread_to_context", position: 1, maximumPerThread: 20, retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
  ],
  contexts: [
    { id: "context_orca", contextTypeId: "context_type_project", name: "Orca launch", retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "context_acme", contextTypeId: "context_type_customer", name: "Acme", retiredAt: null, revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
  ],
  relationships: [], threadRevisions: [],
};

function installFacetWorkspace(facetDefinitions: FacetDefinition[], facetFilter: FacetFilter) {
  const facetView: OrganizationView = {
    ...organizationViewsFixture[0]!,
    definition: { revision: 1, facetFilters: [facetFilter] },
  };
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
    if (path === "/v1/organization/describe") return Response.json({
      workspaceId: "workspace_demo", accountIds: ["account_gmail"],
      workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
      capabilities: { operations: { describe: true, query: true, simulate: true, apply: true, revert: true }, surfaces: { rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true }, mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false } }, authority: { sendMail: false, deleteProviderMail: false } },
      workspaceRevision: 4, facetDefinitions, workflowStates: [], laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision: 4 },
    });
    if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: [facetView] });
    if (path === "/v1/organization/views/preview") return previewResponse(init);
    if (path.includes("/results")) return Response.json({ viewId: facetView.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
}

describe("BRE-378 Organization Views lifecycle interactions", () => {
  test("reloads a durable saved View and opens a composite account/thread target", async () => {
    const selected = organizationViewsFixture[0]!;
    const target = {
      accountId: "account_gmail", accountEmail: "work@example.com", provider: "gmail", threadId: "thread_reloaded", subject: "Reload-safe result",
      latestReceivedAt: "2026-09-06T18:00:00.000Z", messageCount: 2, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Maya", email: "maya@example.com" }, humanSignal: 9, humanClassification: "likely_human",
    };
    globalThis.fetch = (async (request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      if (path === "/v1/organization/describe") return Response.json({
        workspaceId: "workspace_demo", accountIds: ["account_gmail"], workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "view"], filters: ["thread"] },
        capabilities: { operations: { describe: true, query: true, simulate: true, apply: true, revert: true }, surfaces: { rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true }, mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false } }, authority: { sendMail: false, deleteProviderMail: false } },
        workspaceRevision: 4, facetDefinitions: [], workflowStates: [], laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision: 4 },
      });
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: organizationViewsFixture });
      if (path.includes(`/views/${selected.id}/results`)) return Response.json({ viewId: selected.id, viewRevision: selected.revision, accountIds: [target.accountId], items: [target], nextCursor: null, limit: 25 });
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const opened: Array<{ accountId: string; threadId: string }> = [];
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<SavedOrganizationViewWorkspace onManage={() => {}} onOpenThread={(value) => { opened.push(value); }} previewMode viewId={selected.id}/>));
    await flush(); await flush(); await flush();
    expect(container.textContent).toContain("Reload-safe result");
    await click(container.querySelector(".view-thread-open") as unknown as HTMLButtonElement);
    expect(opened[0]).toEqual({ accountId: "account_gmail", threadId: "thread_reloaded" });
  });

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

  test("round-trips every preserved revision-1 constraint and derives the draft summary from the complete definition", async () => {
    const preservedDefinition: OrganizationView["definition"] = {
      revision: 1,
      facetFilters: [
        { facetId: "facet_urgency", operator: "equals", value: "urgent" },
        { facetId: "facet_service", operator: "contains", value: "payments" },
      ],
      contextFilters: [
        { context: { contextTypeId: "context_type_project", contextId: "context_orca" }, relationshipTypeId: "relationship_concerns" },
        { context: { contextTypeId: "context_type_customer", contextId: "context_acme" }, relationshipTypeId: "relationship_supports" },
      ],
      humanSignal: { classifications: ["likely_human"], evidenceReasonCodes: ["direct_recipient"] },
      date: { receivedBefore: "2026-08-26T14:37:22.123Z" },
      thread: { ids: ["thread_alpha", "thread_beta"] },
    };
    const preservedView: OrganizationView = { ...organizationViewsFixture[0]!, id: "view_preserved", name: "Preserved review", definition: preservedDefinition };
    let submittedDefinition: unknown;
    let contextReads = 0;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path === "/v1/organization/views" && method === "GET") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: [preservedView] });
      if (path.includes("/results")) return Response.json({ viewId: preservedView.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/contexts/query?limit=100") {
        contextReads += 1;
        return Response.json(contextQueryFixture);
      }
      if (path === "/v1/organization/views/commit") {
        submittedDefinition = (JSON.parse(String(init?.body)) as { draft: { definition: unknown } }).draft.definition;
        return committedResponse(init, preservedView.id);
      }
      if (method === "PATCH") {
        submittedDefinition = JSON.parse(String(init?.body)).patch.definition;
        return Response.json({ ...preservedView, name: "Metadata only", definition: submittedDefinition, revision: 2 });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;

    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Edit definition"));
    await flush(); await flush();
    expect(contextReads).toBe(1);
    expect(selectField(container, "Minimum Human Signal").value).toBe("");
    expect(container.querySelector(".view-draft-preview")?.textContent).toContain("5 predicate families · combined with AND");
    expect(container.querySelector(".view-preserved-constraints")?.textContent).toContain("2 exact Threads");
    expect(container.querySelector(".view-preserved-constraints")?.textContent).toContain("1 additional Facet filter");
    expect(container.querySelector(".view-preserved-constraints")?.textContent).toContain("1 additional Context filter");
    expect(container.querySelector(".view-preserved-constraints")?.textContent).toContain("Likely human");
    expect(selectField(container, "Named Context").textContent).toContain("Orca launch");
    await change(input(container, "View name"), "Metadata only");
    await flush(); await flush();
    await click(button(container, "Save changes"));
    await flush();
    expect(submittedDefinition).toEqual(preservedDefinition);
  });

  test("exposes named Context loading failure and retry without losing the saved selection", async () => {
    const contextView = organizationViewsFixture[2]!;
    let contextReads = 0;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: [contextView] });
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path.includes("/results")) return Response.json({ viewId: contextView.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/contexts/query?limit=100") {
        contextReads += 1;
        return contextReads === 1 ? Response.json({ error: { message: "Context tide unavailable" } }, { status: 503 }) : Response.json(contextQueryFixture);
      }
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;

    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Edit definition"));
    await flush(); await flush();
    expect(container.querySelector(".view-context-error")?.textContent).toContain("Saved IDs remain preserved");
    expect(selectField(container, "Named Context").value).toBe("context_orca");
    await click(button(container, "Retry Contexts"));
    await flush(); await flush();
    expect(contextReads).toBe(2);
    expect(container.querySelector(".view-context-error")).toBeNull();
    expect(selectField(container, "Named Context").textContent).toContain("Orca launch");
  });

  test("restricts Facet conditions and editors by value type, validates with shared rules, and names enum values", async () => {
    const facetView: OrganizationView = {
      ...organizationViewsFixture[0]!,
      definition: { revision: 1, facetFilters: [{ facetId: "facet_urgency", operator: "equals", value: "urgent" }] },
    };
    const facetDefinitions = [
      { id: "facet_urgency", name: "Urgency", position: 0, valueType: { kind: "enum", options: [{ id: "urgent", label: "Urgent", position: 0, retiredAt: null }] }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null, retiredAt: null, revision: 1 },
      { id: "facet_score", name: "Score", position: 1, valueType: { kind: "number", minimum: 0, maximum: 10, integer: true }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null, retiredAt: null, revision: 1 },
    ];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      if (path === "/v1/organization/describe") return Response.json({
        workspaceId: "workspace_demo", accountIds: ["account_gmail"],
        workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
        capabilities: { operations: { describe: true, query: true, simulate: true, apply: true, revert: true }, surfaces: { rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true }, mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false } }, authority: { sendMail: false, deleteProviderMail: false } },
        workspaceRevision: 4, facetDefinitions, workflowStates: [], laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision: 4 },
      });
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: [facetView] });
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path.includes("/results")) return Response.json({ viewId: facetView.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;

    const container = await renderWorkspace(false, false);
    await flush(); await flush(); await flush();
    await click(button(container, "Edit definition"));
    expect(container.querySelector(".view-scope-sentence")?.textContent).toContain("Urgency is Urgent");
    expect(selectField(container, "Facet condition").textContent).not.toContain("Contains");
    await choose(selectField(container, "Facet"), "facet_score");
    expect(selectField(container, "Facet condition").textContent).not.toContain("Contains");
    const score = input(container, "Value");
    expect(score.type).toBe("number");
    await change(score, "11");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("must be at most 10");
    expect(button(container, "Save changes").disabled).toBe(true);
  });

  test("does not materialize or preview an incomplete numeric Facet predicate as equals zero", async () => {
    installFacetWorkspace([{
      id: "facet_score", name: "Score", position: 0,
      valueType: { kind: "number", minimum: 0, maximum: 10, integer: true },
      cardinality: { kind: "single" }, isOptional: true, defaultValue: null, retiredAt: null, revision: 1,
    }], { facetId: "facet_score", operator: "equals", value: 5 });

    const container = await renderWorkspace(false, false);
    await flush(); await flush(); await flush();
    await click(button(container, "Edit definition"));
    const score = input(container, "Value");
    await change(score, "");

    expect(container.querySelector(".view-scope-sentence")?.textContent).not.toContain("Score is 0");
    expect(container.querySelector(".view-draft-preview")?.textContent).toContain("All current and future messages");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Finish choosing the Facet condition.");
    expect(button(container, "Save changes").disabled).toBe(true);
  });

  test("uses native input semantics compatible with display-name-enabled email Facets", async () => {
    installFacetWorkspace([{
      id: "facet_contact", name: "Contact", position: 0,
      valueType: { kind: "email", allowDisplayName: true },
      cardinality: { kind: "single" }, isOptional: true, defaultValue: null, retiredAt: null, revision: 1,
    }], { facetId: "facet_contact", operator: "equals", value: "Maya Chen <maya@example.com>" });

    const container = await renderWorkspace(false, false);
    await flush(); await flush(); await flush();
    await click(button(container, "Edit definition"));
    const contact = input(container, "Value");

    expect(contact.type).toBe("text");
    expect(contact.inputMode).toBe("email");
    expect(contact.checkValidity()).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await flush(); await flush();
    expect(button(container, "Save changes").disabled).toBe(false);
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
    expect(browserWindow.document.activeElement?.textContent).toBe("Focus");
    expect(browserWindow.document.activeElement?.classList.contains("view-clause-remove")).toBe(false);
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

  test("uses roving menu focus and closes Add filter on Tab, focus-out, and outside click", async () => {
    const container = await renderWorkspace();
    await click(button(container, "+ New View"));
    const trigger = button(container, "Add filter ＋");
    await click(trigger);
    await flush();
    let menu = container.querySelector('[role="menu"]') as HTMLElement;
    let enabledItems = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    expect(enabledItems.map((item) => item.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);

    enabledItems[0]!.focus();
    await act(async () => enabledItems[0]!.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
    expect(browserWindow.document.activeElement as unknown).toBe(enabledItems[1] as unknown);
    expect(enabledItems.map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1]);
    await act(async () => enabledItems[1]!.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }) as unknown as Event));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);
    await flush();
    menu = container.querySelector('[role="menu"]') as HTMLElement;
    const nameField = input(container, "View name");
    await act(async () => menu.dispatchEvent(new browserWindow.FocusEvent("focusout", { bubbles: true, relatedTarget: nameField as unknown as never }) as unknown as Event));
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await click(trigger);
    await flush();
    const outside = browserWindow.document.createElement("button");
    browserWindow.document.body.append(outside);
    await act(async () => { outside.dispatchEvent(new browserWindow.MouseEvent("mousedown", { bubbles: true })); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  test("keeps the full changing scope out of aria-live while preserving concise save status", async () => {
    const container = await renderWorkspace();
    await click(button(container, "+ New View"));
    const scope = container.querySelector(".view-scope-sentence") as HTMLElement;
    const validation = container.querySelector(".view-validation") as HTMLElement;

    expect(scope.hasAttribute("aria-live")).toBe(false);
    expect(validation.getAttribute("aria-live")).toBe("polite");
    expect(validation.getAttribute("role")).toBe("status");
    expect(validation.textContent).toBe("Ready to save this perspective.");
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
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path.includes("/results")) return Response.json({ viewId: "view_weekly_production", viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/views/commit" && method === "POST") {
        createPayload = JSON.parse(String(init?.body));
        return committedResponse(init, "view_created");
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "+ New View"));
    await click(button(container, "Add filter ＋"));
    await click(button(container, "SubjectMatch words in the Thread subject"));
    await flush();
    expect(browserWindow.document.activeElement as unknown).toBe(input(container, "Subject contains") as unknown);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter words to match in the subject.");
    expect((button(container, "Save View") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain("Edit a complete filter to preview it.");
    await change(input(container, "Subject contains"), "release blocker");
    await flush(); await flush();
    expect(input(container, "Subject contains").value).toBe("release blocker");
    expect(container.querySelector('[role="alert"]')?.textContent ?? "no alert").toBe("no alert");
    expect((button(container, "Save View") as HTMLButtonElement).disabled).toBe(false);
    await click(button(container, "Save View"));
    await flush();
    expect(Object.keys(createPayload ?? {}).sort()).toEqual(["confirmedZeroMatchDigest", "draft", "expectedRevisions", "retryKey"].sort());
    expect(createPayload).toMatchObject({
      expectedRevisions: { workspace: 4, view: null },
      draft: { identity: { name: "release blocker messages", description: "", color: "#70867d", position: 3 }, definition: { revision: 1, thread: { subjectContains: "release blocker" } } },
    });
    const savedPayload = createPayload as Record<string, unknown> | null;
    expect(typeof savedPayload?.retryKey).toBe("string");
  });

  test("discards stale preview responses and only enables Save for the current draft generation", async () => {
    const pending: Array<{ init?: RequestInit; resolve: (response: Response) => void }> = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: organizationViewsFixture });
      if (path.includes("/results")) return Response.json({ viewId: organizationViewsFixture[0]!.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/views/preview") return new Promise<Response>((resolve) => pending.push({ init, resolve }));
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Edit definition"));
    await flush();
    expect(pending.length).toBe(1);
    await change(input(container, "Subject contains"), "first generation");
    await flush();
    await change(input(container, "Subject contains"), "current generation");
    await flush();
    expect(pending.length).toBe(3);
    pending[2]!.resolve(previewResponse(pending[2]!.init, { items: [{
      accountId: "account_gmail", accountEmail: "work@example.com", provider: "gmail", threadId: "thread_current", subject: "Current preview",
      latestReceivedAt: "2026-09-06T18:00:00.000Z", messageCount: 1, readState: "unread", primaryLaneId: "lane_focus",
      sender: { name: "Maya", email: "maya@example.com" }, humanSignal: 9, humanClassification: "likely_human",
    }] }));
    await flush(); await flush();
    expect(container.textContent).toContain("Current preview");
    expect(button(container, "Save changes").disabled).toBe(false);
    pending[1]!.resolve(previewResponse(pending[1]!.init, { items: [] }));
    pending[0]!.resolve(previewResponse(pending[0]!.init, { items: [] }));
    await flush(); await flush();
    expect(container.textContent).toContain("Current preview");
    expect(button(container, "Save changes").disabled).toBe(false);
  });

  test("reuses one retry key after a commit failure", async () => {
    const retryKeys: string[] = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: organizationViewsFixture });
      if (path.includes("/results")) return Response.json({ viewId: organizationViewsFixture[0]!.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path === "/v1/organization/views/commit") {
        retryKeys.push((JSON.parse(String(init?.body)) as { retryKey: string }).retryKey);
        return retryKeys.length === 1
          ? Response.json({ error: { code: "revision_conflict", message: "Temporary conflict" } }, { status: 409 })
          : committedResponse(init, organizationViewsFixture[0]!.id);
      }
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Edit definition"));
    await change(input(container, "View name"), "Retry-safe edit");
    await flush(); await flush();
    await click(button(container, "Save changes")); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Temporary conflict");
    await click(button(container, "Save changes")); await flush();
    expect(retryKeys).toHaveLength(2);
    expect(retryKeys[1]).toBe(retryKeys[0]);
  });

  test("requires a second digest-bound confirmation before committing an exact zero preview", async () => {
    let commit: Record<string, unknown> | null = null;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname;
      if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: organizationViewsFixture });
      if (path.includes("/results")) return Response.json({ viewId: organizationViewsFixture[0]!.id, viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      if (path === "/v1/organization/views/preview") return previewResponse(init, { state: "zero" });
      if (path === "/v1/organization/views/commit") { commit = JSON.parse(String(init?.body)); return committedResponse(init, organizationViewsFixture[0]!.id); }
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    await click(button(container, "Edit definition")); await flush(); await flush();
    await click(button(container, "Review zero matches"));
    expect(commit).toBeNull();
    expect(container.textContent).toContain("Zero matches confirmed for this exact definition");
    await click(button(container, "Confirm zero-match save")); await flush();
    expect(commit).not.toBeNull();
    if (!commit) throw new Error("Expected a commit request");
    const committedRequest = commit as { confirmedZeroMatchDigest: string; draft: { definitionDigest: string } };
    expect(committedRequest.confirmedZeroMatchDigest).toBe(committedRequest.draft.definitionDigest);
  });

  test("clears stale demo results after save and persistently names the unevaluated preview state", async () => {
    const container = await renderWorkspace();
    expect(container.textContent).toContain("Unresolved production failure");
    await click(button(container, "Edit definition"));
    expect(container.querySelector(".view-draft-preview")?.textContent).toContain("Local preview does not evaluate sample mail");
    await change(input(container, "View name"), "Locally revised review");
    await click(button(container, "Save changes"));
    expect(container.querySelector(".view-thread-list")).toBeNull();
    expect(container.querySelector(".view-results")?.textContent).toContain("Sample results have not been evaluated for this saved local definition");
    expect(container.querySelector(".view-results")?.textContent).not.toContain("No Threads match right now");
    await click([...container.querySelectorAll("button.view-chip")].find((candidate) => candidate.textContent?.includes("Urgent humans")) as unknown as HTMLButtonElement);
    await click([...container.querySelectorAll("button.view-chip")].find((candidate) => candidate.textContent?.includes("Locally revised review")) as unknown as HTMLButtonElement);
    expect(container.querySelector(".view-thread-list")).toBeNull();
    expect(container.querySelector(".view-results")?.textContent).toContain("Sample results have not been evaluated for this saved local definition");
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

  test("does not restore canned results when deletion selects an unevaluated demo neighbor", async () => {
    const container = await renderWorkspace();
    await click(button(container, "Edit definition"));
    await change(input(container, "View name"), "Locally revised review");
    await click(button(container, "Save changes"));
    await click(container.querySelector('[aria-label="Move Locally revised review down"]') as unknown as HTMLButtonElement);
    await click([...container.querySelectorAll("button.view-chip")].find((candidate) => candidate.textContent?.includes("Urgent humans")) as unknown as HTMLButtonElement);
    await click(button(container, "Remove View"));
    await click(button(container, "Confirm remove"));

    expect(container.querySelector('.view-chip[aria-pressed="true"] strong')?.textContent).toBe("Locally revised review");
    expect(container.querySelector(".view-results")?.textContent).toContain("Sample results have not been evaluated for this saved local definition");
    expect(container.querySelector(".view-thread-list")).toBeNull();
    expect(container.querySelector(".view-thread-row strong")?.textContent).not.toBe("Unresolved production failure");
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
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path.includes("/results")) {
        const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? "view_weekly_production";
        const view = organizationViewsFixture.find((candidate) => candidate.id === viewId);
        return Response.json({ viewId, viewRevision: view?.revision ?? 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      }
      if (path === "/v1/organization/views/commit") {
        submittedDefinition = (JSON.parse(String(init?.body)) as { draft: { definition: unknown } }).draft.definition;
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
    await flush(); await flush();
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
      if (path === "/v1/organization/views/preview") return previewResponse(init);
      if (path.includes("/results")) {
        resultReads += 1;
        return Response.json({ viewId: "view_weekly_production", viewRevision: resultReads === 1 ? 1 : 2, accountIds: ["account_a"], items: [resultReads === 1 ? firstItem : refreshedItem], nextCursor: null, limit: 25 });
      }
      if (path === "/v1/organization/views/commit") return committedResponse(init, organizationViewsFixture[0]!.id);
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;
    const container = await renderWorkspace(false);
    await flush(); await flush();
    expect(container.textContent).toContain("Before edit");
    await click(button(container, "Edit definition"));
    await change(input(container, "View name"), "Edited live");
    await flush(); await flush();
    await click(button(container, "Save changes"));
    await flush(); await flush();
    expect(resultReads).toBe(1);
    expect(browserWindow.location.search).toBe(`?destination=view%3A${organizationViewsFixture[0]!.id}`);
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
