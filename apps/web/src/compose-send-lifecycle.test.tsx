import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MessageDraft } from "@orca/shared";
import { ComposeWorkspace, useComposeDraft, type ComposeDraftController } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "getComputedStyle"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let account: string;
let scope: string;
let records: Map<string, MessageDraft>;
let requests: string[];
let showComposer: boolean;
let sentNotices: number;
const available: MessageDraft[] = [];
function Harness() { controller = useComposeDraft(account, scope, false, undefined, available); return showComposer ? <ComposeWorkspace controller={controller} contacts={[]} canSend onSent={() => { sentNotices += 1; }} /> : null; }
async function render() { await act(async () => root.render(<Harness />)); }
async function edit(body: string) { await act(async () => controller.updateDraft({ body, to: [{ name: null, email: "fixture@example.com" }] })); }
function gate() {
  let release!: () => void;
  let reached!: () => void;
  return { held: new Promise<void>(r => { release = r; }), started: new Promise<void>(r => { reached = r; }), release: () => release(), reached: () => reached() };
}
beforeEach(async () => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : name === "getComputedStyle" ? browser.getComputedStyle.bind(browser) : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as Element);
  account = "first"; scope = "new"; records = new Map(); requests = []; showComposer = false; sentNotices = 0;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    const owner = url.searchParams.get("accountId")!;
    const method = init?.method ?? "GET";
    requests.push(`${method} ${owner} ${url.pathname}`);
    if (url.pathname.endsWith("/send")) return Response.json({ draftId: url.pathname.split("/")[3], status: "sent", providerMessageId: "synthetic-sent", providerThreadId: null, error: null });
    if (method === "GET") return Response.json(records.get(url.pathname.split("/")[3]!) ?? []);
    const id = method === "POST" ? `draft-${owner}-${records.size}` : url.pathname.split("/")[3]!;
    const saved: MessageDraft = { ...JSON.parse(String(init?.body)), id, accountId: owner, revision: (records.get(id)?.revision ?? 0) + 1, attachments: [], deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null, providerDraftId: null, providerMessageId: null, providerThreadId: null, createdAt: "2026-10-17T12:00:00.000Z", updatedAt: "2026-10-17T12:00:00.000Z" };
    records.set(id, saved);
    return Response.json(saved);
  }) as typeof fetch;
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

for (const transition of ["account", "draft", "return"] as const) {
  for (const stage of ["create", "inspect", "update", "send"] as const) test(`${transition} switch during ${stage} preserves the active writing and stops obsolete work`, async () => {
    await edit("Original delivery");
    if (stage === "inspect" || stage === "update") await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
    const held = gate();
    const fetch = globalThis.fetch;
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const url = new URL(path, "http://localhost");
      if ((stage === "send" && url.pathname.endsWith("/send")) || (stage === "create" && url.pathname === "/v1/drafts" && init?.method === "POST") || (stage === "inspect" && !init?.method) || (stage === "update" && init?.method === "PATCH")) {
        held.reached(); await held.held;
      }
      return fetch(path, init);
    }) as typeof fetch;
    let result!: Promise<unknown>;
    await act(async () => { result = controller.sendDraft!().catch(error => error); await held.started; });
    if (transition === "draft") scope = "draft:another";
    else account = "second";
    await render();
    if (transition === "return") { account = "first"; await render(); }
    await edit("Keep active writing");
    const activeId = controller.draft.id;
    await act(async () => { held.release(); await result; });
    expect(controller.draft.accountId).toBe(account);
    expect(controller.draft.id).toBe(activeId);
    expect(controller.draft.body).toBe("Keep active writing");
    expect(requests.filter(r => r.endsWith("/send"))).toHaveLength(stage === "send" ? 1 : 0);
    expect(controller.saveMessage).not.toBe("Draft discarded");
  });
}

test("unchanged scope still sends once and clears the completed draft", async () => {
  await edit("Successful delivery");
  await act(async () => { expect((await controller.sendDraft!()).status).toBe("sent"); });
  expect(controller.draft.body).toBe("");
  expect(requests.filter(r => r.endsWith("/send"))).toHaveLength(1);
});


test("a send waiting for autosave cannot start delivery after scope changes", async () => {
  const held = gate(); const fetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") { held.reached(); await held.held; }
    return fetch(path, init);
  }) as typeof fetch;
  await edit("Autosave before delivery");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); await held.started; });
  let result!: Promise<unknown>;
  await act(async () => { result = controller.sendDraft!().catch(error => error); });
  account = "second"; await render(); await edit("Keep new writing");
  await act(async () => { held.release(); await result; });
  expect(controller.draft.body).toBe("Keep new writing");
  expect(requests.filter(r => r.endsWith("/send"))).toHaveLength(0);
  expect(requests).toHaveLength(1);
});

test("obsolete send completion cannot unlock a newer pending send", async () => {
  const first = gate(), second = gate(); const fetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname.endsWith("/send")) {
      const held = url.searchParams.get("accountId") === "first" ? first : second;
      held.reached(); await held.held;
    }
    return fetch(path, init);
  }) as typeof fetch;
  await edit("First delivery"); let old!: Promise<unknown>, current!: Promise<unknown>;
  await act(async () => { old = controller.sendDraft!().catch(error => error); await first.started; });
  account = "second"; await render(); await edit("Second delivery");
  await act(async () => { current = controller.sendDraft!(); await second.started; });
  await act(async () => { first.release(); await old; });
  await act(async () => { await expect(controller.sendDraft!()).rejects.toThrow("already being sent"); });
  expect(controller.draft.body).toBe("Second delivery");
  await act(async () => { second.release(); await current; });
  expect(controller.draft.body).toBe("");
  expect(requests.filter(r => r.endsWith("/send"))).toHaveLength(2);
});

for (const fail of [false, true]) test(`obsolete component send ${fail ? "failure" : "success"} cannot close a newly selected draft`, async () => {
  showComposer = true; await render(); await edit("Original delivery");
  const held = gate(); const fetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (new URL(path, "http://localhost").pathname.endsWith("/send")) {
      held.reached(); await held.held;
      if (fail) return Response.json({ error: "fixture_failure" }, { status: 503 });
    }
    return fetch(path, init);
  }) as typeof fetch;
  const send = () => [...browser.document.querySelectorAll("button")].find(button => button.textContent === "Send")!;
  await act(async () => { send().click(); await held.started; });
  scope = "draft:another"; await render(); await edit("Keep selected draft");
  await act(async () => { held.release(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(sentNotices).toBe(0);
  expect(controller.draft.body).toBe("Keep selected draft");
  expect(send().disabled).toBe(false);
  expect(browser.document.body.textContent).not.toContain("fixture_failure");
});
