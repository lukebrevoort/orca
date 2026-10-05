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
function Harness() { controller = useComposeDraft(activeAccount, "new", false); return null; }
beforeEach(async () => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  requests = []; saved = null; activeAccount = "second";
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
