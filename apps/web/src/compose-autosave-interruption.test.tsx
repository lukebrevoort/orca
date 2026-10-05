import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MessageDraft } from "@orca/shared";
import { useComposeDraft, type ComposeDraftController } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let available: MessageDraft[];
let server: MessageDraft;
let mutations: { method: string; body: Partial<MessageDraft> }[];
let holdPatch: Promise<void> | null;
const accountId = "synthetic-account";
const key = `orca-compose-draft:${accountId}:new`;
const firstBody = "Initial saved writing";
const lastBody = `${firstBody}\nEdited immediately before Back and Forward`;
function Harness() {
  controller = useComposeDraft(accountId, "new", false, undefined, available);
  return null;
}
async function render() { await act(async () => root.render(<Harness />)); }
async function waitSave() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 480)); }); }
beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  server = {
    id: "synthetic-draft", accountId, revision: 1,
    to: [{ name: "Maya", email: "maya@example.com" }], cc: [], bcc: [],
    subject: "Synthetic draft", body: { text: firstBody, html: null }, context: null, attachments: [],
    deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null,
    providerDraftId: null, providerMessageId: null, providerThreadId: null,
    createdAt: "2026-10-05T12:00:00.000Z", updatedAt: "2026-10-05T12:00:00.000Z",
  };
  available = [server]; mutations = []; holdPatch = null;
  globalThis.fetch = (async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH" || init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      mutations.push({ method: init.method, body });
      await holdPatch;
      server = { ...server, ...body, revision: server.revision + 1 };
    }
    return Response.json(server);
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as unknown as Record<string, unknown>)[name]; }
  delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

for (const interrupt of [false, true]) test(`latest body reaches API when drafts list ${interrupt ? "refreshes during" : "does not interrupt"} autosave debounce`, async () => {
  await render();
  await act(async () => controller.updateDraft({ cc: [{ name: null, email: "cc@example.com" }], bcc: [{ name: null, email: "bcc@example.com" }] }));
  await waitSave();
  expect(mutations).toHaveLength(1);
  expect(server.revision).toBe(2);
  expect(controller.saveMessage).toBe("Saved to Orca and Gmail");
  await act(async () => controller.updateDraft({ body: lastBody }));
  expect(controller.saveStatus).toBe("saving");
  if (interrupt) {
    // App's Close/history refresh returns the unchanged remote copy before 420ms.
    available = [{ ...server }];
    await render();
    // Repeated Close/reopen refreshes must not turn a local checkpoint into remote success.
    for (let i = 0; i < 2; i++) { available = [{ ...server }]; await render(); }
  }
  await waitSave();
  const local = JSON.parse(browser.localStorage.getItem(key)!);
  expect(controller.draft.body).toBe(lastBody);
  expect(local.body).toBe(lastBody);
  expect(server.body.text).toBe(lastBody);
  expect(mutations).toHaveLength(2);
});

test("a locally checkpointed edit is saved remotely after controller remount", async () => {
  await render();
  await act(async () => controller.updateDraft({ body: lastBody }));
  await act(async () => root.unmount());
  expect(JSON.parse(browser.localStorage.getItem(key)!).body).toBe(lastBody);
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  available = [{ ...server }];
  await render();
  await waitSave();
  expect(controller.draft.body).toBe(lastBody);
  expect(controller.conflict).toBeNull();
  expect(server.body.text).toBe(lastBody);
  expect(mutations).toHaveLength(1);
});

test("latest body is reported as saving until its actual remote acknowledgment", async () => {
  await render();
  let release!: () => void;
  holdPatch = new Promise<void>(resolve => { release = resolve; });
  try {
    await act(async () => controller.updateDraft({ body: lastBody }));
    available = [{ ...server }]; await render();
    expect(controller.saveStatus).toBe("saving");
    expect(controller.saveMessage).toBe("Saving…");
    await waitSave();
    expect(mutations).toHaveLength(1);
    expect(server.body.text).toBe(firstBody);
    expect(controller.draft.body).toBe(lastBody);
    expect(controller.saveStatus).toBe("saving");
    expect(controller.saveMessage).toBe("Saving to Orca…");
    await act(async () => release());
    expect(server.body.text).toBe(lastBody);
    expect(controller.saveStatus).toBe("saved");
    expect(controller.saveMessage).toBe("Saved to Orca and Gmail");
  } finally { release(); }
});

test("already-synced drafts-list refresh makes no duplicate mutation", async () => {
  await render();
  available = [{ ...server }]; await render();
  await waitSave();
  expect(mutations).toHaveLength(0);
  expect(controller.saveMessage).toBe("Saved to Orca and Gmail");
});
