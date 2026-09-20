import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { MessageDraft } from "@orca/shared";
import { createEmptyComposeDraft, useComposeDraft, type ComposeDraftController, type ComposeDraftFields } from "./compose-workspace";
import type { WritingPreferenceState } from "./writing-preferences";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let preferences: WritingPreferenceState;
let accountId: string;
let available: MessageDraft[] | null | undefined;
let writes: Record<string, any>[];
let saved: MessageDraft | null;
let enabled: boolean;
let initialFields: ComposeDraftFields | undefined;
function Harness() {
  controller = useComposeDraft(accountId, "new", false, undefined, available, { preferences, enabled, initialFields });
  return null;
}
async function render() { await act(async () => root.render(<Harness />)); }
async function waitSave() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); }); }
function remote(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return { id: "saved-draft", accountId, revision: 1, to: [], cc: [], bcc: [], subject: "", body: { text: "", html: null }, context: null, attachments: [], deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null, providerDraftId: null, providerMessageId: null, providerThreadId: null, createdAt: "2026-09-20T12:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z", ...overrides };
}
beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  accountId = "account-a"; available = []; writes = []; saved = null; enabled = true; initialFields = undefined;
  preferences = { accountId, status: "ready", preferences: { signature: "Best, Alex", composeFormat: "plain", replyBehavior: "reply_all" } };
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (path.endsWith("/send")) return Response.json({ draftId: saved!.id, status: "sent", providerMessageId: "fake-message", providerThreadId: null, error: null });
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      saved = remote({ ...body, revision: (saved?.revision ?? 0) + 1 });
      return Response.json(saved);
    }
    return Response.json(saved);
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test("new hydrated draft initializes once and keeps plain format through mocked autosave and send", async () => {
  await render();
  expect(controller.draft.body).toBe("\n\nBest, Alex");
  expect(controller.draft.composeFormat).toBe("plain");
  await act(async () => controller.updateDraft({ body: "**Literal**\nBest, Alex", to: [{ name: null, email: "recipient@example.com" }] }));
  await waitSave();
  expect(writes.at(-1)?.body).toEqual({ text: "**Literal**\nBest, Alex", html: null });
  await act(async () => { await controller.sendDraft!(); });
  expect(writes.at(-1)?.body).toEqual({ text: "**Literal**\nBest, Alex", html: null });
});

test("late preferences cannot overwrite typing, deletion, or pending-recipient interaction", async () => {
  preferences = { ...preferences, status: "loading" };
  await render();
  await act(async () => controller.setRecipientQueries!({ to: "incomplete", cc: "", bcc: "" }));
  await act(async () => controller.setRecipientQueries!({ to: "", cc: "", bcc: "" }));
  preferences = { ...preferences, status: "ready" }; await render();
  expect(controller.draft.body).toBe("");
  expect(controller.draft.writingPreferencesApplied).not.toBe(true);
});

test("discarded draft stays empty until the next writing session and uses refreshed settings", async () => {
  await render();
  await act(async () => controller.discardDraft());
  expect(controller.draft.body).toBe("");
  enabled = false; await render();
  preferences = { ...preferences, preferences: { ...preferences.preferences, signature: "Next signature" } };
  enabled = true; await render();
  expect(controller.draft.body).toBe("\n\nNext signature");
});

test("empty local recovered drafts are preserved even when preferences are ready", async () => {
  const draft = { ...createEmptyComposeDraft(accountId), composeFormat: "rich" };
  browser.localStorage.setItem(`orca-compose-draft:${accountId}:new`, JSON.stringify(draft));
  await render();
  expect(controller.draft.body).toBe("");
  expect(controller.draft.composeFormat).toBe("rich");
  expect(controller.draft.id).toBe(draft.id);
});

test("typing before hydration is preserved and a saved competing draft becomes a conflict", async () => {
  available = null;
  await render();
  await act(async () => controller.updateDraft({ body: "Live typing" }));
  available = [remote({ body: { text: "Server writing", html: "<p>Server writing</p>" } })];
  await render();
  expect(controller.draft.body).toBe("Live typing");
  expect(controller.conflict?.server.body.text).toBe("Server writing");
});

test("rich saved drafts keep their format and body while new settings request plain text", async () => {
  available = [remote({ body: { text: "**Recovered**", html: "<p><strong>Recovered</strong></p>" } })];
  await render();
  expect(controller.draft.body).toBe("**Recovered**");
  expect(controller.draft.composeFormat).toBe("rich");
  await act(async () => controller.updateDraft({ to: [{ name: null, email: "recipient@example.com" }] }));
  await waitSave();
  expect(writes.at(-1)?.body).toEqual({ text: "**Recovered**", html: "<p><strong>Recovered</strong></p>" });
  await act(async () => { await controller.sendDraft!(); });
  expect(writes.at(-1)?.body).toEqual({ text: "**Recovered**", html: "<p><strong>Recovered</strong></p>" });
});

test("account switch rejects stale preferences and other-account saved drafts", async () => {
  enabled = false; await render();
  accountId = "account-b";
  available = [remote({ accountId: "account-a", body: { text: "Private A body", html: null } })];
  enabled = true; await render();
  expect(controller.draft.accountId).toBe("account-b");
  expect(controller.draft.body).toBe("");
  preferences = { ...preferences, accountId, preferences: { ...preferences.preferences, signature: "B signature" } };
  await render();
  expect(controller.draft.body).toBe("\n\nB signature");
});

test("rich new draft persists escaped HTML and signature only once across local recovery", async () => {
  preferences = { ...preferences, preferences: { ...preferences.preferences, composeFormat: "rich", signature: "<script>bad()</script>" } };
  await render(); await waitSave();
  expect(writes.at(-1)?.body.html).toContain("&lt;script&gt;");
  expect(writes.at(-1)?.body.html).not.toContain("<script>");
  const body = controller.draft.body;
  await act(async () => root.unmount());
  root = createRoot(browser.document.createElement("div") as unknown as Element);
  available = saved ? [saved] : [];
  await render();
  expect(controller.draft.body).toBe(body);
  expect(controller.draft.composeFormat).toBe("rich");
  expect(controller.conflict).toBeNull();
});

test("plain defaults are retained when typing starts while preferences are loading", async () => {
  preferences = { ...preferences, status: "loading" };
  await render();
  await act(async () => controller.updateDraft({ body: "**Literal typed words**" }));
  preferences = { ...preferences, status: "ready", preferences: { ...preferences.preferences, composeFormat: "rich" } }; await render();
  await waitSave();
  expect(controller.draft.body).toBe("**Literal typed words**");
  expect(writes.at(-1)?.body.html).toBeNull();
});

test("body typed then deleted stays empty after a late preference response", async () => {
  preferences = { ...preferences, status: "loading" }; await render();
  await act(async () => controller.updateDraft({ body: "Deleted thought" }));
  await act(async () => controller.updateDraft({ body: "" }));
  preferences = { ...preferences, status: "ready" }; await render();
  expect(controller.draft.body).toBe("");
});

test("new reply seeds before preferences arrive, with no duplicate on settings refresh", async () => {
  initialFields = { to: [{ name: null, email: "sender@example.com" }], cc: [{ name: null, email: "group@example.com" }], bcc: [], subject: "Re: A note", body: "Forwarded seed", context: null };
  preferences = { ...preferences, status: "loading" }; await render();
  expect(controller.draft.to).toEqual(initialFields.to);
  expect(controller.draft.body).toBe("Forwarded seed");
  preferences = { ...preferences, status: "ready" }; await render();
  expect(controller.draft.to).toEqual(initialFields.to);
  expect(controller.draft.cc).toEqual(initialFields.cc);
  expect(controller.draft.body).toBe("\n\nBest, Alex\n\nForwarded seed");
  preferences = { ...preferences, preferences: { ...preferences.preferences, signature: "Changed" } }; await render();
  expect(controller.draft.body).toBe("\n\nBest, Alex\n\nForwarded seed");
});

test("typing while preferences load retains the once-only reply seed and skips late signature", async () => {
  initialFields = { to: [{ name: null, email: "sender@example.com" }], cc: [{ name: null, email: "group@example.com" }], bcc: [], subject: "Re: Note", body: "Quoted body", context: null };
  preferences = { ...preferences, status: "loading" }; await render();
  expect(controller.draft).toMatchObject({ to: initialFields.to, cc: initialFields.cc, subject: "Re: Note", body: "Quoted body" });
  await act(async () => controller.updateDraft({ body: `My reply\n\n${controller.draft.body}` }));
  preferences = { ...preferences, status: "ready" }; await render();
  expect(controller.draft).toMatchObject({ to: initialFields.to, cc: initialFields.cc, subject: "Re: Note", body: "My reply\n\nQuoted body" });
  expect(controller.draft.writingPreferencesApplied).not.toBe(true);
  initialFields = { ...initialFields, body: "Different quote", subject: "Changed seed" }; await render();
  expect(controller.draft.body).toBe("My reply\n\nQuoted body");
  expect(controller.draft.subject).toBe("Re: Note");
});

test("canonical reply seed never replaces recovered recipients, subject or body", async () => {
  initialFields = { to: [{ name: null, email: "seed@example.com" }], cc: [], bcc: [], subject: "Seed subject", body: "Seed quote", context: null };
  available = [remote({ to: [{ name: null, email: "saved@example.com" }], subject: "Saved subject", body: { text: "Saved writing", html: null } })];
  preferences = { ...preferences, status: "loading" }; await render();
  preferences = { ...preferences, status: "ready" }; await render();
  expect(controller.draft).toMatchObject({ to: [{ email: "saved@example.com" }], subject: "Saved subject", body: "Saved writing" });
});

test("failed draft recovery never treats an unknown saved draft as new", async () => {
  globalThis.fetch = (async (_path: string, _init?: RequestInit): Promise<Response> => { throw new Error("Offline"); }) as typeof fetch;
  available = undefined;
  await render();
  expect(controller.isHydrated).toBe(true);
  expect(controller.draft.body).toBe("");
  expect(controller.draft.writingPreferencesApplied).not.toBe(true);
});
