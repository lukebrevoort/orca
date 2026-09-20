import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MessageDraft } from "@orca/shared";
import { DraftConflictNotice, useComposeDraft, type ComposeDraftController } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let available: MessageDraft[];
let posts: Record<string, any>[];
let mutations: string[];
let failCreate = false;
let holdCreate: (() => Promise<void>) | null = null;
const server: MessageDraft = {
  id: "original", accountId: "account-test", revision: 2,
  to: [{ name: null, email: "server@example.com" }], cc: [], bcc: [],
  subject: "Server subject", body: { text: "Server words", html: null }, context: null, attachments: [],
  deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null,
  providerDraftId: null, providerMessageId: null, providerThreadId: null,
  createdAt: "2026-07-08T12:00:00.000Z", updatedAt: "2026-07-08T13:00:00.000Z",
};
function Harness() { controller = useComposeDraft("account-test", "new", false, undefined, available); return null; }
async function render() { await act(async () => root.render(<Harness />)); }
async function waitSave() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 480)); }); }
beforeEach(async () => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  available = [{ ...server, revision: 1 }]; posts = []; mutations = []; failCreate = false; holdCreate = null;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") mutations.push(`${method} ${input}`);
    if (method === "PATCH") return Response.json({ error: { code: "stale_draft" } }, { status: 409 });
    if (method === "POST") {
      const content = JSON.parse(String(init?.body)); posts.push(content);
      await holdCreate?.();
      if (failCreate) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json({ ...server, ...content, id: `copy-${posts.length}`, revision: 1 });
    }
    return Response.json(server);
  }) as typeof fetch;
  await render();
  await act(async () => controller.updateDraft({ body: "Before conflict" }));
  await waitSave();
  expect(controller.conflict?.server.revision).toBe(2);
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
async function edit() {
  await act(async () => {
    controller.updateDraft({ body: "Typed AFTER conflict", subject: "Latest subject", to: [{ name: null, email: "latest@example.com" }], cc: [{ name: null, email: "cc@example.com" }], bcc: [{ name: null, email: "bcc@example.com" }] });
    controller.attachFiles([new File(["attachment bytes"], "latest.txt", { type: "application/octet-stream" })]);
  });
}
for (const choice of ["local", "server"] as const) test(`${choice}: saves latest edits and attachment bytes as a distinct recoverable draft`, async () => {
  await edit();
  await act(async () => controller.resolveConflict!(choice));
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ body: { text: "Typed AFTER conflict" }, subject: "Latest subject", to: [{ email: "latest@example.com" }], cc: [{ email: "cc@example.com" }], bcc: [{ email: "bcc@example.com" }], attachments: [{ filename: "latest.txt", contentBase64: btoa("attachment bytes") }] });
  expect(controller.conflict).toBeNull();
  expect(controller.draft.id).toBe(choice === "local" ? "copy-1" : "original");
  expect(controller.draft.body).toBe(choice === "local" ? "Typed AFTER conflict" : "Server words");
  expect(mutations).toEqual(["PATCH /v1/drafts/original", "POST /v1/drafts"]);
});
for (const choice of ["local", "server"] as const) test(`${choice}: storage failure retains conflict and current editor`, async () => {
  await edit();
  Object.defineProperty(browser, "localStorage", { value: { getItem: browser.localStorage.getItem.bind(browser.localStorage), setItem() { throw new Error("quota"); } } });
  await act(async () => controller.resolveConflict!(choice));
  expect(controller.conflict).not.toBeNull(); expect(controller.draft.body).toBe("Typed AFTER conflict"); expect(posts).toHaveLength(0);
  expect(controller.saveStatus).toBe("failed");
});
test("failed recovery creation retains conflict", async () => {
  failCreate = true; await edit(); await act(async () => controller.resolveConflict!("server"));
  expect(controller.conflict).not.toBeNull(); expect(controller.draft.body).toBe("Typed AFTER conflict");
});
test("edits while saving recovery cannot be replaced by the server", async () => {
  let release!: () => void; holdCreate = () => new Promise(resolve => { release = resolve; });
  let resolution!: Promise<void>;
  await act(async () => { resolution = controller.resolveConflict!("server"); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => controller.updateDraft({ body: "Even newer" }));
  await act(async () => { release(); await resolution; });
  expect(controller.conflict).not.toBeNull(); expect(controller.draft.body).toBe("Even newer");
});
test("replacement conflict cannot be cleared by an older resolution", async () => {
  let release!: () => void; holdCreate = () => new Promise(resolve => { release = resolve; });
  let resolution!: Promise<void>;
  await act(async () => { resolution = controller.resolveConflict!("server"); await new Promise(resolve => setTimeout(resolve, 0)); });
  available = [{ ...server, revision: 3, body: { text: "Newest server", html: null } }]; await render();
  await act(async () => { release(); await resolution; });
  expect(controller.conflict?.server.revision).toBe(3); expect(controller.draft.body).toBe("Before conflict");
});

test("comparison shows live fields and both revisions without stale local text", async () => {
  await edit();
  const html = renderToStaticMarkup(<DraftConflictNotice conflict={controller.conflict!} local={controller.draft} onResolve={controller.resolveConflict!} />);
  for (const text of ["Typed AFTER conflict", "Latest subject", "latest@example.com", "cc@example.com", "bcc@example.com", "latest.txt", "Server words", "revision 1", "revision 2", "Nothing is sent"]) expect(html).toContain(text);
  expect(html).not.toContain("Before conflict");
});
test("failure checkpointing the selected version retains the original editor after recovery creation", async () => {
  const storage = browser.localStorage;
  let writes = 0;
  Object.defineProperty(browser, "localStorage", { value: { getItem: storage.getItem.bind(storage), setItem(key: string, value: string) { if (++writes > 1) throw new Error("quota"); storage.setItem(key, value); } } });
  await act(async () => controller.resolveConflict!("server"));
  expect(posts).toHaveLength(1); expect(controller.conflict).not.toBeNull(); expect(controller.draft.body).toBe("Before conflict");
});
test("duplicate resolution clicks create only one copy", async () => {
  let release!: () => void; holdCreate = () => new Promise(resolve => { release = resolve; });
  let resolution!: Promise<void>;
  await act(async () => { resolution = controller.resolveConflict!("local"); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => controller.resolveConflict!("server"));
  await act(async () => { release(); await resolution; });
  expect(posts).toHaveLength(1); expect(controller.draft.id).toBe("copy-1");
});
