import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MessageDraft } from "@orca/shared";
import { draftRequestPath, useComposeDraft, type ComposeDraftController } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let requests: Array<{ method: string; url: URL }>;
let saved: MessageDraft | null;
let activeAccount: string;
let available: MessageDraft[] | undefined;
function Harness() { controller = useComposeDraft(activeAccount, "new", false, undefined, available); return null; }
beforeEach(async () => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  requests = []; saved = null; activeAccount = "second"; available = undefined;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost"); const method = init?.method ?? "GET";
    requests.push({ method, url });
    // Match production's first-account fallback so an omitted scope is observable.
    const accountId = url.searchParams.get("accountId") ?? "first";
    if (url.pathname.endsWith("/send")) return Response.json({ draftId: saved!.id, status: "sent", providerMessageId: "fixture-sent", providerThreadId: null, error: null });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "POST" || method === "PATCH") {
      saved = { ...JSON.parse(String(init?.body)), id: "fixture-draft", accountId, revision: (saved?.revision ?? 0) + 1, attachments: [], deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null, providerDraftId: null, providerMessageId: null, providerThreadId: null, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z" };
      return Response.json(saved);
    }
    return Response.json(url.pathname === "/v1/drafts" ? [] : saved);
  }) as typeof fetch;
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
test("recipient entry, autosave, update, inspection and send stay on the composed account", async () => {
  await act(async () => controller.updateDraft({ body: "Safe fixture words", subject: "Account scope" }));
  await act(async () => controller.setRecipientQueries!({ to: "Maya <maya@example.com>", cc: "cc@example.com", bcc: "bcc@example.com" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  expect(saved!.accountId).toBe("second");
  await act(async () => { expect((await controller.sendDraft!()).status).toBe("sent"); });
  expect(saved!.to).toEqual([{ name: "Maya", email: "maya@example.com" }]);
  expect(saved!.cc[0]?.email).toBe("cc@example.com");
  expect(saved!.bcc[0]?.email).toBe("bcc@example.com");
  expect(new Set(requests.map(request => request.url.searchParams.get("accountId")))).toEqual(new Set(["second"]));
  expect(requests.map(request => request.method)).toEqual(["GET", "POST", "GET", "PATCH", "POST"]);
});
test("discard uses the draft owner account", async () => {
  await act(async () => controller.updateDraft({ body: "Keep account scoped" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  await act(async () => { expect(await controller.discardDraft()).toBe(true); });
  expect(requests.at(-1)!.url.searchParams.get("accountId")).toBe("second");
  expect(requests.at(-1)!.method).toBe("DELETE");
});
test("draft paths encode identifiers and account scope independently", () => {
  const url = new URL(draftRequestPath("account + &", "draft/id", "send"), "http://localhost");
  expect(url.pathname).toBe("/v1/drafts/draft%2Fid/send");
  expect(url.searchParams.get("accountId")).toBe("account + &");
});

test("account changes isolate writing and ignore a late previous-account hydration", async () => {
  await act(async () => controller.updateDraft({ subject: "Second account only", body: "Private second writing", to: [{ name: null, email: "second-recipient@example.com" }] }));
  await act(async () => controller.setRecipientQueries!({ to: "", cc: "pending-second", bcc: "" }));
  let releaseFirst!: (response: Response) => void;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    if (url.searchParams.get("accountId") === "first" && !init?.method) return new Promise<Response>(resolve => { releaseFirst = resolve; });
    return previousFetch(path, init);
  }) as typeof fetch;
  activeAccount = "first";
  await act(async () => root.render(<Harness />));
  expect(controller.draft.subject).toBe("");
  expect(controller.recipientQueries).toEqual({ to: "", cc: "", bcc: "" });
  expect(controller.isHydrated).toBe(false);
  activeAccount = "third";
  await act(async () => root.render(<Harness />));
  await act(async () => releaseFirst(Response.json([])));
  expect(controller.draft.accountId).toBe("third");
  expect(controller.draft.body).toBe("");
  activeAccount = "second";
  await act(async () => root.render(<Harness />));
  expect(controller.draft.accountId).toBe("second");
  expect(controller.draft.subject).toBe("Second account only");
  expect(controller.draft.body).toBe("Private second writing");
  expect(controller.draft.to[0]?.email).toBe("second-recipient@example.com");
});

test("unmount and a new account identity never adopt the old account checkpoint", async () => {
  await act(async () => controller.updateDraft({ subject: "Previous identity", body: "Private old writing" }));
  await act(async () => root.unmount());
  activeAccount = "first";
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  await act(async () => root.render(<Harness />));
  expect(controller.draft.accountId).toBe("first");
  expect(controller.draft.subject).toBe("");
  expect(controller.draft.body).toBe("");
  expect(controller.recipientQueries).toEqual({ to: "", cc: "", bcc: "" });
});


test("discard waits for an in-flight first autosave and deletes the created draft", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") await held;
    const result = await previousFetch(path, init);
    if (init?.method === "DELETE") saved = null;
    return result;
  }) as typeof fetch;
  await act(async () => controller.updateDraft({ body: "Discard this synthetic writing" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  let discarding: ReturnType<ComposeDraftController["discardDraft"]>;
  await act(async () => { discarding = controller.discardDraft(); });
  await act(async () => { release(); await discarding; });
  expect(requests.map(request => request.method)).toEqual(["GET", "POST", "DELETE"]);
  expect(saved).toBeNull();
  expect(controller.draft.body).toBe("");
  expect(controller.draft.revision).toBeNull();
  expect(controller.saveMessage).toBe("Draft discarded");
});


for (const failDelete of [false, true]) test(`late DELETE ${failDelete ? "failure" : "success"} cannot reset another account's draft`, async () => {
  await act(async () => controller.updateDraft({ body: "Second account draft" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      await held;
      if (failDelete) return Response.json({ error: "synthetic_delete_failure" }, { status: 503 });
    }
    return previousFetch(path, init);
  }) as typeof fetch;
  let discarding: ReturnType<ComposeDraftController["discardDraft"]>;
  await act(async () => { discarding = controller.discardDraft(); });
  expect(controller.isDiscarding).toBe(true);
  activeAccount = "third";
  await act(async () => root.render(<Harness />));
  await act(async () => controller.updateDraft({ body: "Third account private writing" }));
  await act(async () => { release(); expect(await discarding).toBe(false); });
  expect(controller.draft.accountId).toBe("third");
  expect(controller.draft.body).toBe("Third account private writing");
  expect(controller.isDiscarding).toBe(false);
  expect(controller.saveMessage).not.toContain("discard");
  expect(requests.filter(request => request.method === "DELETE").every(request => request.url.searchParams.get("accountId") === "second")).toBe(true);
});

test("account change while first save is pending cancels discard without deleting the new account", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") await held;
    return previousFetch(path, init);
  }) as typeof fetch;
  await act(async () => controller.updateDraft({ body: "Second account draft" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  let discarding: ReturnType<ComposeDraftController["discardDraft"]>;
  await act(async () => { discarding = controller.discardDraft(); });
  activeAccount = "third";
  await act(async () => root.render(<Harness />));
  await act(async () => controller.updateDraft({ body: "Third account private writing" }));
  await act(async () => { release(); expect(await discarding).toBe(false); });
  expect(controller.draft.accountId).toBe("third");
  expect(controller.draft.body).toBe("Third account private writing");
  expect(controller.draft.revision).toBeNull();
  expect(requests.some(request => request.method === "DELETE")).toBe(false);
});

test("failed DELETE keeps writing recoverable and permits another discard attempt", async () => {
  await act(async () => controller.updateDraft({ body: "Keep this synthetic writing" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => init?.method === "DELETE"
    ? Response.json({ error: "synthetic_delete_failure" }, { status: 503 })
    : previousFetch(path, init)) as typeof fetch;
  await act(async () => { expect(await controller.discardDraft()).toBe(false); });
  expect(controller.draft.body).toBe("Keep this synthetic writing");
  expect(JSON.parse(browser.localStorage.getItem("orca-compose-draft:second:new")!).body).toBe("Keep this synthetic writing");
  expect(controller.isDiscarding).toBe(false);
  globalThis.fetch = previousFetch;
  await act(async () => { expect(await controller.discardDraft()).toBe(true); });
  expect(controller.draft.body).toBe("");
});

test("pending discard blocks a duplicate discard, send and edits, then cancels debounce", async () => {
  await act(async () => controller.updateDraft({ body: "Last saved writing", to: [{ name: null, email: "synthetic@example.com" }] }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  await act(async () => controller.updateDraft({ body: "Edit still in debounce" }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") await held;
    return previousFetch(path, init);
  }) as typeof fetch;
  let discarding: ReturnType<ComposeDraftController["discardDraft"]>;
  await act(async () => { discarding = controller.discardDraft(); });
  await act(async () => {
    expect(await controller.discardDraft()).toBe(false);
    await expect(controller.sendDraft!()).rejects.toThrow("discarding");
    controller.updateDraft({ body: "Blocked edit" });
  });
  expect(controller.draft.body).toBe("Edit still in debounce");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
  await act(async () => { release(); expect(await discarding).toBe(true); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  expect(requests.map(request => request.method)).toEqual(["GET", "POST", "DELETE"]);
  expect(controller.draft.body).toBe("");
});

test("failed first save does not become a false successful discard", async () => {
  globalThis.fetch = (async () => { throw new Error("Synthetic disconnected response"); }) as unknown as typeof fetch;
  await act(async () => controller.updateDraft({ body: "Keep until server identity is known" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  await act(async () => { expect(await controller.discardDraft()).toBe(false); });
  expect(controller.draft.body).toBe("Keep until server identity is known");
  expect(controller.isDiscarding).toBe(false);
});


test("a draft-list response begun before discard cannot restore the deleted draft", async () => {
  await act(async () => controller.updateDraft({ body: "Discard despite stale list" }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 470)); });
  const staleDraft = saved!;
  available = [staleDraft];
  await act(async () => root.render(<Harness />));
  let release!: (response: Response) => void;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => !init?.method
    ? new Promise<Response>(resolve => { release = resolve; })
    : previousFetch(path, init)) as typeof fetch;
  available = undefined;
  await act(async () => root.render(<Harness />));
  await act(async () => { expect(await controller.discardDraft()).toBe(true); });
  await act(async () => release(Response.json([staleDraft])));
  expect(controller.draft.body).toBe("");
  expect(controller.draft.revision).toBeNull();
  expect(controller.saveMessage).toBe("Draft discarded");
});

test("discard refuses to race a delivery already in flight", async () => {
  await act(async () => controller.updateDraft({ body: "Synthetic delivery", to: [{ name: null, email: "fixture@example.com" }] }));
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (new URL(path, "http://localhost").pathname.endsWith("/send")) { started(); await held; }
    return previousFetch(path, init);
  }) as typeof fetch;
  let delivery: ReturnType<NonNullable<ComposeDraftController["sendDraft"]>>;
  await act(async () => { delivery = controller.sendDraft!(); await sending; });
  await act(async () => { expect(await controller.discardDraft()).toBe(false); });
  expect(requests.some(request => request.method === "DELETE")).toBe(false);
  await act(async () => { release(); expect((await delivery).status).toBe("sent"); });
});
