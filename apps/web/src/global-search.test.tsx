import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { inboxFixture } from "@orca/shared";

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

const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "InputEvent", "KeyboardEvent", "Location"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/?destination=organization" });
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
  async function verifyLateSaveSettlement(outcome: "resolve" | "reject") {
    let resolveSave!: (response: Response) => void;
    let rejectSave!: (reason: Error) => void;
    let resolveScopeB!: (response: Response) => void;
    const saveSignals: AbortSignal[] = [];
    const savedBodies: unknown[] = [];
    const pendingSave = new Promise<Response>((resolve, reject) => {
      resolveSave = resolve;
      rejectSave = reject;
    });
    const pendingScopeB = new Promise<Response>((resolve) => {
      resolveScopeB = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) {
        const request = new URL(path, browserWindow.location.origin);
        return request.searchParams.get("view") === "focus" ? pendingScopeB : searchResponse();
      }
      if (path === "/v1/pins" && init?.method === "POST") {
        if (init.signal) saveSignals.push(init.signal);
        savedBodies.push(JSON.parse(String(init.body)));
        return pendingSave;
      }
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;
    openMailSearchFilter({
      mailbox: "all",
      attention: "all",
      classification: "all",
      person: null,
      query: "scope alpha",
      accountId: null,
      collectionId: null,
      dataSource: "stored_mail",
    });

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="" theme="light" title="Inbox"/></TopLayerProvider>));
    await flush();
    await flush();
    expect(browserWindow.document.querySelector(".global-mail-result-list a")).not.toBeNull();

    await act(async () => button("Save this search").click());
    expect(button("Saving…").disabled).toBe(true);
    expect(savedBodies).toHaveLength(1);
    expect(JSON.parse((savedBodies[0] as { targetId: string }).targetId)).toMatchObject({ query: "scope alpha", mailbox: "all" });

    const mailbox = browserWindow.document.querySelector('.global-mail-search-filters select') as unknown as HTMLSelectElement;
    await act(async () => {
      mailbox.value = "focus";
      mailbox.dispatchEvent(new browserWindow.Event("change", { bubbles: true }) as unknown as Event);
    });
    expect(new URL(browserWindow.location.href).searchParams.get("searchMailbox")).toBe("focus");
    const resultsRegion = browserWindow.document.querySelector(".global-mail-search-results") as unknown as HTMLElement;
    expect(resultsRegion.textContent).not.toContain(inboxFixture[0]!.subject);
    expect(resultsRegion.textContent).toContain("Looking beyond this screen");
    expect(saveSignals[0]?.aborted).toBe(true);
    await act(async () => {
      resolveScopeB(searchResponse());
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(button("Save this search").disabled).toBe(false);

    await act(async () => {
      if (outcome === "resolve") resolveSave(new Response(JSON.stringify({ ok: true }), { status: 201 }));
      else rejectSave(new Error("late scope-alpha failure"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button("Save this search").disabled).toBe(false);
    expect(browserWindow.document.querySelector(".global-mail-search-actions")?.textContent).not.toContain("Saved “");
    expect(browserWindow.document.querySelector(".global-mail-search-actions")?.textContent).not.toContain("late scope-alpha failure");
  }

  test("ignores a late save success after the visible scope changes", async () => {
    await verifyLateSaveSettlement("resolve");
  });

  test("ignores a late save failure after the visible scope changes", async () => {
    await verifyLateSaveSettlement("reject");
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

  test("Enter always opens a visible no-result state and zero-match save requires explicit confirmation", async () => {
    const writes: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === "/v1/accounts") return new Response(JSON.stringify({ items: [demoAccount], nextCursor: null }), { status: 200 });
      if (path === "/v1/organization/collections-pins/query") return new Response(JSON.stringify({ workspaceId: "workspace_1", accountIds: [demoAccount.id], collections: [{ id: "space_launch", accountId: demoAccount.id, name: "Launch", color: "#70867d", position: 0, threadIds: [], revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], pins: [], queries: [] }), { status: 200 });
      if (path.startsWith("/v1/inbox?")) return new Response(JSON.stringify({ accounts: [demoAccount], messages: [], nextCursor: null, counts: { attention: { focus: 0, normal: 0, quiet: 0, hidden: 0, all: 0 }, classification: { likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 0 } } }), { status: 200 });
      if (path === "/v1/pins" && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    }) as typeof fetch;

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" onThemeChange={() => {}} query="moonbase ledger" theme="light" title="Organization"/></TopLayerProvider>));

    const entry = browserWindow.document.querySelector('input[aria-label="Search mail"]') as unknown as HTMLInputElement;
    await act(async () => {
      entry.form?.dispatchEvent(new browserWindow.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await flush();
    await flush();

    expect(browserWindow.document.querySelector('[role="dialog"][aria-labelledby="global-mail-search-title"]')).not.toBeNull();
    expect(browserWindow.document.querySelector(".global-mail-search-state")?.textContent).toContain("Nothing found in this scope");
    expect(new URL(browserWindow.location.href).searchParams.get("searchQuery")).toBe("moonbase ledger");
    expect(new URL(browserWindow.location.href).searchParams.get("searchSource")).toBe("/?destination=organization");

    await act(async () => button("Save this search").click());
    expect(writes).toHaveLength(0);
    expect(browserWindow.document.querySelector(".global-mail-search-actions")?.textContent).toContain("currently has zero matches");
    await act(async () => button("Save zero-match search").click());
    await flush();
    expect(writes).toHaveLength(1);
    const target = JSON.parse((writes[0] as { targetId: string }).targetId);
    expect(target).toMatchObject({ query: "moonbase ledger", mailbox: "all", classification: "all", accountId: null, collectionId: null, dataSource: "stored_mail" });
    expect(browserWindow.document.querySelector(".global-mail-search-actions")?.textContent).toContain("with this exact account, space, mailbox, and evidence scope");
  });
});
