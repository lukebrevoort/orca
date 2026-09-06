import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { inboxFixture, organizationLaneConfigurationFixture, summarizeOrganizationViewDefinition } from "@orca/shared";

import { demoAccount } from "./demo-data";
import { WorkspaceHeader } from "./desktop-switch";
import {
  mailSearchPinFilter,
  mailSearchReaderUrl,
  mailSearchRequest,
  mailSearchUrl,
  openMailSearchFilter,
  openMailSearch,
  readMailSearchState,
  safeInternalSearchReturn,
  type MailSearchState,
} from "./global-search";
import { SurfaceHistory, readSurfaceLocation } from "./surface-history";
import { TopLayerProvider } from "./top-layer";

const styles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "InputEvent", "KeyboardEvent", "Location"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ height: 768, width: 1024, url: "http://localhost:5173/?destination=organization" });
  for (const name of browserGlobals) {
    const value = name === "window" ? browserWindow : name === "document" ? browserWindow.document : name === "navigator" ? browserWindow.navigator : browserWindow[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
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

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function button(label: string) {
  const match = [...browserWindow.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(match, label).toBeDefined();
  return match as unknown as HTMLButtonElement;
}

function isSameNode(left: unknown, right: unknown) {
  return left === right;
}

function installSearchStyles() {
  const sheet = browserWindow.document.createElement("style");
  sheet.textContent = styles;
  browserWindow.document.head.append(sheet);
}

function searchResponse(messages = inboxFixture) {
  return new Response(JSON.stringify({
    accounts: [demoAccount],
    messages,
    nextCursor: null,
    counts: {
      attention: { focus: 0, normal: messages.length, quiet: 0, hidden: 0, all: messages.length },
      classification: { likely_human: messages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: messages.length },
    },
  }), { status: 200 });
}

const liveAuthorityDescription = {
  workspaceId: "workspace_demo", accountIds: ["account_gmail"],
  workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
  capabilities: { operations: { describe: true, query: true, simulate: true, apply: true, revert: true }, surfaces: { rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true }, mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false } }, authority: { sendMail: false, deleteProviderMail: false } },
  workspaceRevision: 4, facetDefinitions: [], workflowStates: [], laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision: 4 },
};

function installViewSearchApi() {
  const writes: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === "/v1/accounts") return Response.json({ items: [demoAccount], nextCursor: null });
    if (path === "/v1/organization/collections-pins/query") return Response.json({ workspaceId: "workspace_demo", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] });
    if (path.startsWith("/v1/inbox?")) return searchResponse();
    if (path === "/v1/organization/describe") return Response.json(liveAuthorityDescription);
    if (path === "/v1/organization/views") return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, items: [] });
    if (path === "/v1/organization/views/prepare") {
      const preparation = JSON.parse(String(init?.body));
      return Response.json({ workspaceId: "workspace_demo", workspaceRevision: 4, draft: {
        mode: "create", viewId: null, viewRevision: null, source: preparation.source, identity: preparation.identity, definition: preparation.definition,
        unsupportedClauses: preparation.unsupportedClauses, preparationNotices: [], definitionDigest: `sha256:${"a".repeat(64)}`, definitionKind: "match_all", effectiveAccountIds: ["account_gmail"],
        summary: summarizeOrganizationViewDefinition(preparation.definition), saveEligibility: { allowed: false, code: "unsupported_clauses", detail: "Review unsupported clauses" },
      } });
    }
    if (init?.method === "POST") writes.push(path);
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  return writes;
}

describe("global mail search location contract", () => {
  test("opens from Inbox, Reader, Organization, and Settings with a safe exact source", () => {
    const sources = [
      "/?destination=inbox",
      "/?destination=focus&thread=thread_1&accountId=acct_1",
      "/?destination=organization",
      "/settings/reading?panel=appearance",
    ];
    for (const source of sources) {
      browserWindow.history.replaceState({}, "", source);
      openMailSearch("production");
      const state = readMailSearchState(browserWindow.location as unknown as Location);
      expect(state).not.toBeNull();
      expect(state?.query).toBe("production");
      expect(state?.source).toBe(source);
      expect(new URL(browserWindow.location.href).searchParams.get("search")).toBe("mail");
    }
  });

  test("rejects cross-origin return targets and serializes an exact saved scope", () => {
    expect(safeInternalSearchReturn("https://attacker.example/steal", browserWindow.location as unknown as Location)).toBe("/?destination=inbox");
    expect(safeInternalSearchReturn("/api/private", browserWindow.location as unknown as Location)).toBe("/?destination=inbox");
    expect(safeInternalSearchReturn("/unknown", browserWindow.location as unknown as Location)).toBe("/?destination=inbox");
    expect(safeInternalSearchReturn("/?destination=inbox&search=mail&searchQuery=recursive&searchResultReader=1", browserWindow.location as unknown as Location)).toBe("/?destination=inbox");
    expect(safeInternalSearchReturn("/?destination=not-a-workspace", browserWindow.location as unknown as Location)).toBe("/?destination=inbox");
    expect(safeInternalSearchReturn("/?destination=space%3Alaunch&q=moon", browserWindow.location as unknown as Location)).toBe("/?destination=space%3Alaunch&q=moon");
    expect(safeInternalSearchReturn("/settings/reading?panel=appearance", browserWindow.location as unknown as Location)).toBe("/settings/reading?panel=appearance");
    const state: MailSearchState = {
      query: "launch notes",
      mailbox: "focus",
      evidence: "human",
      accountId: "acct_work",
      collectionId: "space_launch",
      source: "/settings",
    };
    browserWindow.history.replaceState({}, "", mailSearchUrl(browserWindow.location as unknown as Location, state));
    expect(readMailSearchState(browserWindow.location as unknown as Location)).toEqual(state);
    expect(mailSearchPinFilter(state)).toEqual({
      mailbox: "focus",
      attention: "all",
      classification: "human",
      person: null,
      query: "launch notes",
      accountId: "acct_work",
      collectionId: "space_launch",
      dataSource: "stored_mail",
    });
    expect(mailSearchRequest(state)).toContain("query=launch+notes");
    expect(mailSearchRequest(state)).toContain("accountId=acct_work");
    expect(mailSearchRequest(state)).toContain("collectionId=space_launch");
  });

  test("nests a result Reader in SurfaceHistory and restores the serialized search on Back", async () => {
    const state: MailSearchState = {
      query: "launch notes",
      mailbox: "focus",
      evidence: "human",
      accountId: "acct_work",
      collectionId: "space_launch",
      source: "/settings/reading?panel=appearance",
    };
    browserWindow.history.replaceState({}, "", mailSearchUrl(browserWindow.location as unknown as Location, state));
    const reader = mailSearchReaderUrl({ threadId: "thread/1", accountId: "acct_work" }, browserWindow.location as unknown as Location);
    const readerUrl = new URL(reader, browserWindow.location.origin);
    expect(readerUrl.pathname).toBe("/");
    expect(readerUrl.searchParams.get("destination")).toBe("inbox");
    expect(readerUrl.searchParams.get("searchQuery")).toBe("launch notes");
    expect(readerUrl.searchParams.get("searchSpace")).toBe("space_launch");
    expect(readerUrl.searchParams.get("returnTo")).toBeNull();

    const history = new SurfaceHistory(browserWindow as never);
    history.initialize();
    expect(() => history.openReaderLocation(new URL("https://attacker.example/?thread=stolen"), { workspaceX: 0, workspaceY: 0, target: null })).toThrow();
    history.openReaderLocation(readerUrl, { workspaceX: 0, workspaceY: 0, target: null });
    expect(readSurfaceLocation(browserWindow.location).reader).toEqual({ threadId: "thread/1", accountId: "acct_work" });
    expect(readMailSearchState(browserWindow.location as unknown as Location)).toBeNull();

    expect(history.dismiss("reader").mode).toBe("back");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readSurfaceLocation(browserWindow.location).reader).toBeNull();
    expect(readMailSearchState(browserWindow.location as unknown as Location)).toEqual(state);
  });

  test("reopens a saved Inbox scope through the API default mailbox semantics", () => {
    openMailSearchFilter({
      mailbox: "inbox",
      attention: "all",
      classification: "all",
      person: null,
      query: "launch",
      accountId: "acct_work",
      collectionId: null,
      dataSource: "stored_mail",
    });
    const state = readMailSearchState(browserWindow.location as unknown as Location);
    expect(state?.mailbox).toBe("inbox");
    expect(mailSearchRequest(state!)).toBe("/v1/inbox?limit=100&classification=all&query=launch&accountId=acct_work");
  });
});

describe("GlobalMailSearch interaction", () => {
  test("hands Search to the common View authoring surface without writing a pin and restores context on cancel", async () => {
    const writes = installViewSearchApi();
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=inbox&demo=1");
    openMailSearch("apartment");
    const container = browserWindow.document.createElement("div"); browserWindow.document.body.append(container); root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush(); await flush();
    const original = browserWindow.location.href;
    await act(async () => button("Save as View").click()); await flush();
    expect(browserWindow.document.querySelector("#views-title")?.textContent).toBe("Review this live View");
    expect(browserWindow.document.body.textContent).toContain("General text search");
    await act(async () => button("Cancel").click()); await flush();
    expect(writes).toEqual([]);
    expect(browserWindow.location.href).toBe(original);
    expect(browserWindow.document.querySelector("#views-title")).toBeNull();
    expect((browserWindow.document.querySelector('input[aria-label="Search stored mail"]') as unknown as HTMLInputElement).value).toBe("apartment");
  });

  test("keeps advanced scope controls collapsed and exposes one accessible close action", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=inbox&demo=1");
    openMailSearch();
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    const input = browserWindow.document.querySelector('input[aria-label="Search stored mail"]') as unknown as HTMLInputElement;
    const filterToggle = browserWindow.document.querySelector(".global-mail-filter-toggle") as unknown as HTMLButtonElement;
    const filters = browserWindow.document.querySelector("#global-mail-search-filters") as unknown as HTMLElement;
    expect(isSameNode(browserWindow.document.activeElement, input)).toBe(true);
    expect(filterToggle.getAttribute("aria-expanded")).toBe("false");
    expect(filters.hidden).toBe(true);
    expect(browserWindow.document.querySelectorAll('button[aria-label^="Close Search mail"]').length).toBe(1);
    expect(browserWindow.document.querySelector(".global-mail-search-backdrop")?.getAttribute("aria-hidden")).toBe("true");
    expect(button("Save as View").disabled).toBe(true);

    filterToggle.focus();
    await act(async () => filterToggle.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }) as unknown as KeyboardEvent));
    expect((browserWindow.document.activeElement as unknown as Element).getAttribute("aria-label")).toStartWith("Close Search mail");

    await act(async () => filterToggle.click());
    expect(filterToggle.getAttribute("aria-expanded")).toBe("true");
    expect(filters.hidden).toBe(false);
    expect(filters.querySelectorAll("select").length).toBe(4);
  });

  test("keeps overflowing results in the shrinkable 1024px track when filters expand", async () => {
    globalThis.fetch = (async (input) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return searchResponse([...inboxFixture, ...inboxFixture.map((message) => ({ ...message, id: `${message.id}-second-page` }))]);
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    installSearchStyles();
    openMailSearch("mail");
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    await act(async () => (browserWindow.document.querySelector(".global-mail-filter-toggle") as unknown as HTMLButtonElement).click());
    const dialog = browserWindow.document.querySelector(".global-mail-search")!;
    const results = browserWindow.document.querySelector(".global-mail-search-results")!;
    const dialogStyle = browserWindow.getComputedStyle(dialog);
    const resultsStyle = browserWindow.getComputedStyle(results);
    expect(dialogStyle.gridTemplateAreas).toContain("results");
    expect(dialogStyle.gridTemplateRows).toContain("minmax(0,1fr)");
    expect(resultsStyle.maxHeight).toBe("none");
    expect(resultsStyle.overflowY).toBe("auto");
    expect(results.querySelectorAll(".global-mail-result-list a").length).toBe(inboxFixture.length * 2);
    expect((browserWindow.document.querySelector("#global-mail-search-filters") as unknown as HTMLElement).hidden).toBe(false);
  });

  test("wraps a maximum-length no-result query inside the compact state", async () => {
    const query = "x".repeat(200);
    globalThis.fetch = (async (input) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return searchResponse([]);
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    installSearchStyles();
    openMailSearch(query);
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    const heading = browserWindow.document.querySelector(".global-mail-search-state h2")!;
    const headingStyle = browserWindow.getComputedStyle(heading);
    expect(heading.textContent).toContain(query);
    expect(headingStyle.maxWidth).toBe("100%");
    expect(headingStyle.overflowWrap).toBe("anywhere");
  });

  test("includes the year only when a result is outside the current year", async () => {
    const currentYear = new Date().getFullYear();
    const current = { ...structuredClone(inboxFixture[0]!), id: "current-year", receivedAt: `${currentYear}-07-03T12:00:00.000Z` };
    const previous = { ...structuredClone(inboxFixture[0]!), id: "previous-year", receivedAt: `${currentYear - 1}-07-03T12:00:00.000Z` };
    globalThis.fetch = (async (input) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return searchResponse([current, previous]);
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    openMailSearch("same day");
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    const times = [...browserWindow.document.querySelectorAll(".global-mail-result-list time")];
    expect(times[0]?.textContent).not.toContain(String(currentYear));
    expect(times[1]?.textContent).toContain(String(currentYear - 1));
  });

  test("moves from the query into results with ArrowDown and back with ArrowUp", async () => {
    globalThis.fetch = (async (input) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return searchResponse();
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=inbox");
    openMailSearch("Launch");
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    const input = browserWindow.document.querySelector('input[aria-label="Search stored mail"]') as unknown as HTMLInputElement;
    const result = browserWindow.document.querySelector(".global-mail-result-list a") as unknown as HTMLAnchorElement;
    expect(result).not.toBeNull();
    await act(async () => input.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }) as unknown as KeyboardEvent));
    expect(isSameNode(browserWindow.document.activeElement, result)).toBe(true);
    await act(async () => result.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowUp" }) as unknown as KeyboardEvent));
    expect(isSameNode(browserWindow.document.activeElement, input)).toBe(true);
  });

  test("typing invalidates the old result generation before the debounced query runs", async () => {
    installViewSearchApi(); openMailSearch("alpha");
    const container = browserWindow.document.createElement("div"); browserWindow.document.body.append(container); root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush(); await flush();
    expect(button("Save as View").disabled).toBe(false);
    const field = browserWindow.document.querySelector('input[aria-label="Search stored mail"]') as unknown as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(browserWindow.HTMLInputElement.prototype, "value")!.set!.call(field, "beta");
      field.dispatchEvent(new browserWindow.InputEvent("input", { bubbles: true, data: "beta" }) as unknown as Event);
    });
    expect(button("Save as View").disabled).toBe(true);
    expect(browserWindow.document.querySelectorAll('.global-mail-result-list a')).toHaveLength(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); }); await flush();
    expect(new URL(browserWindow.location.href).searchParams.get("searchQuery")).toBe("beta");
    expect(button("Save as View").disabled).toBe(false);
  });

  test("ignores a late prepared draft when the Search scope changes", async () => {
    const writes = installViewSearchApi(); const api = globalThis.fetch;
    let finishPreparation: (() => void) | undefined;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/v1/organization/views/prepare") await new Promise<void>((resolve) => { finishPreparation = resolve; });
      return api(input, init);
    }) as typeof fetch;
    openMailSearch("alpha");
    const container = browserWindow.document.createElement("div"); browserWindow.document.body.append(container); root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush(); await flush();
    await act(async () => button("Save as View").click()); await flush();
    expect(browserWindow.document.body.textContent).toContain("Preparing this live View");
    await act(async () => openMailSearch("beta")); await flush();
    await act(async () => finishPreparation?.()); await flush();
    expect(browserWindow.document.querySelector(".search-view-authoring")).toBeNull();
    expect((browserWindow.document.querySelector('input[aria-label="Search stored mail"]') as unknown as HTMLInputElement).value).toBe("beta");
    expect(writes).toEqual([]);
  });

  test("restores a saved Search snapshot, result anchor and scroll after loading", async () => {
    installViewSearchApi(); openMailSearch("alpha");
    const source = browserWindow.location.pathname + browserWindow.location.search;
    const href = mailSearchReaderUrl(inboxFixture[0]!);
    browserWindow.sessionStorage.setItem("orca:search-view-return:v1", JSON.stringify({ url: source, draft: "alpha", scrollTop: 80, loaded: 1, focusHref: href }));
    const container = browserWindow.document.createElement("div"); browserWindow.document.body.append(container); root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush(); await flush();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 70)); });
    const anchor = browserWindow.document.querySelector(".global-mail-result-list a");
    expect(isSameNode(browserWindow.document.activeElement, anchor)).toBe(true);
    expect(browserWindow.document.querySelector(".global-mail-search-results")?.scrollTop).toBe(80);
    expect(browserWindow.sessionStorage.getItem("orca:search-view-return:v1")).toBeNull();
    expect(browserWindow.location.pathname + browserWindow.location.search).toBe(source);
  });

  test("requests a saved Inbox scope without the unsupported inbox view value", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const path = String(input);
      requests.push(path);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return new Response(JSON.stringify({ accounts: [demoAccount], messages: [], nextCursor: null, counts: { attention: { focus: 0, normal: 0, quiet: 0, hidden: 0, all: 0 }, classification: { likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 0 } } }), { status: 200 });
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    openMailSearchFilter({
      mailbox: "inbox",
      attention: "all",
      classification: "all",
      person: null,
      query: "launch",
      accountId: demoAccount.id,
      collectionId: null,
      dataSource: "stored_mail",
    });

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();

    const inboxRequest = requests.find((path) => path.startsWith("/v1/inbox?"));
    expect(inboxRequest).toBe(`/v1/inbox?limit=100&classification=all&query=launch&accountId=${encodeURIComponent(demoAccount.id)}`);
    expect(new URL(inboxRequest!, browserWindow.location.origin).searchParams.has("view")).toBe(false);
  });

  test("a zero-result general search enters unsupported review without any persistence", async () => {
    const writes = installViewSearchApi();
    const api = globalThis.fetch;
    globalThis.fetch = (async (input, init) => String(input).startsWith("/v1/inbox?") ? searchResponse([]) : api(input, init)) as typeof fetch;
    openMailSearch("moonbase ledger");
    const container = browserWindow.document.createElement("div"); browserWindow.document.body.append(container); root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush(); await flush();
    expect(browserWindow.document.body.textContent).toContain("Nothing found for “moonbase ledger”");
    await act(async () => button("Save as View").click()); await flush(); await flush();
    expect(browserWindow.document.body.textContent).toContain("General text search");
    expect(button("Save View").disabled).toBe(true);
    expect(writes).toEqual([]);
  });
});
