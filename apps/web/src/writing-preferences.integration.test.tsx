import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { accountFixture, inboxFixture, type ThreadDetail } from "@orca/shared";
import { MessageReader } from "./App";
import { TopLayerProvider } from "./top-layer";

const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "KeyboardEvent", "getComputedStyle"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browser: InstanceType<typeof Window>;
let root: Root;
let writes: Record<string, any>[];
let releasePreferences: (() => void) | undefined;
let delayPreferences: boolean;
const account = { ...accountFixture, capabilities: { read: true, draft: true, send: true } };
const source = inboxFixture[0]!;
const detail: ThreadDetail = {
  account,
  thread: { id: source.threadId, provider: "gmail", providerThreadId: "provider-thread", subject: "Group note", latestReceivedAt: source.receivedAt, messageCount: 1, labels: [], participants: [source.from], readState: "read", attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: 10 } },
  messages: [{ ...source, subject: "Group note", accountId: account.id, to: [{ name: null, email: account.email }, { name: "Dana", email: "dana@example.com" }], cc: [{ name: "Anika", email: "anika@example.com" }, { name: "Duplicate", email: "DANA@example.com" }], bcc: [], bodyText: "Original group note", bodyHtml: null, internetMessageId: "<group@example.com>", references: [], attachments: [] }],
};
function button(name: string) { const found = [...browser.document.querySelectorAll("button")].find(button => button.textContent?.trim() === name); expect(found).toBeDefined(); return found!; }
async function click(name: string) { await act(async () => button(name).click()); }
async function render() { await act(async () => root.render(<TopLayerProvider><MessageReader detail={detail} error={null} fallbackMessages={[]} fallbackTitle="Group note" onBack={() => {}} onRetry={() => {}} status="ready" onAttentionChange={async () => "normal"} /></TopLayerProvider>)); }
beforeEach(() => {
  browser = new Window({ url: "http://localhost/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : name === "getComputedStyle" ? browser.getComputedStyle.bind(browser) : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as Element); writes = []; delayPreferences = false; releasePreferences = undefined;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (String(path) === "/v1/preferences") {
      if (delayPreferences) await new Promise<void>(resolve => { releasePreferences = resolve; });
      return Response.json({ signature: "Best, Luke", composeFormat: "plain", replyBehavior: "reply_all", notifyByDefault: false });
    }
    if (String(path) === "/v1/drafts" && !init?.method) return Response.json([]);
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return Response.json({ ...body, id: "saved", accountId: account.id, revision: 1, attachments: [], deliveryStatus: "draft", providerSyncStatus: "synced", providerSyncError: null, providerDraftId: null, providerMessageId: null, providerThreadId: null, createdAt: source.receivedAt, updatedAt: source.receivedAt });
    }
    return Response.json({ items: [], nextCursor: null });
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close(); globalThis.fetch = originalFetch;
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

test("primary Reply all sends the actual deduplicated group recipients into the draft; explicit Reply stays sender-only", async () => {
  await render(); await click("Reply all (default)");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
  expect(writes.at(-1)?.to.map((contact: any) => contact.email)).toEqual([source.from.email, "dana@example.com"]);
  expect(writes.at(-1)?.cc.map((contact: any) => contact.email)).toEqual(["anika@example.com"]);
  expect(writes.at(-1)?.body).toEqual({ text: "\n\nBest, Luke", html: null });
  await click("Reply");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
  expect(writes.at(-1)?.to.map((contact: any) => contact.email)).toEqual([source.from.email]);
  expect(writes.at(-1)?.cc).toEqual([]);
});

test("late preference arrival preserves an explicitly opened reply and its typed body", async () => {
  delayPreferences = true; await render(); await click("Reply");
  await click("Edit recipients");
  expect(browser.document.querySelector('[name="subject"]')?.getAttribute("value")).toBe("Re: Group note");
  const editor = browser.document.querySelector('[aria-label="Message body"]')!;
  await act(async () => { editor.innerHTML = "<p>Already writing</p>"; editor.dispatchEvent(new browser.Event("input", { bubbles: true })); });
  await act(async () => releasePreferences!());
  expect(editor.textContent).toBe("Already writing");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
  expect(writes.at(-1)?.to.map((contact: any) => contact.email)).toEqual([source.from.email]);
  expect(writes.at(-1)?.body.text).toBe("Already writing");
});

test("format choice is explicit, preserves literal text, and controls saved HTML", async () => {
  await render(); await click("Reply");
  const editor = browser.document.querySelector('[aria-label="Message body"]')!;
  const format = browser.document.querySelector('[aria-label="Message format"]') as unknown as HTMLSelectElement;
  await act(async () => format.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "r", bubbles: true }) as unknown as Event));
  expect(browser.document.querySelector('[aria-label="Collapse reply"]')).not.toBeNull();
  await act(async () => { editor.innerHTML = "<p>**Literal** &lt;safe&gt;</p>"; editor.dispatchEvent(new browser.Event("input", { bubbles: true })); });
  expect(button("B").disabled).toBe(true);
  await act(async () => { format.value = "rich"; format.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event); });
  expect(editor.innerHTML).toContain("<strong>Literal</strong>");
  await act(async () => { format.value = "plain"; format.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event); });
  expect(editor.textContent).toBe("**Literal** <safe>");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 460)); });
  expect(writes.at(-1)?.body).toEqual({ text: "**Literal** <safe>", html: null });
});
