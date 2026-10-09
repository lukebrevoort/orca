import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { accountFixture, inboxFixture, type ThreadDetail } from "@orca/shared";
import { MessageReader } from "./App";
import { TopLayerProvider } from "./top-layer";
import { editorToPlainText } from "./compose-workspace";

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
async function render(current: ThreadDetail = detail) { await act(async () => root.render(<TopLayerProvider><MessageReader detail={current} error={null} fallbackMessages={[]} fallbackTitle="Group note" onBack={() => {}} onRetry={() => {}} status="ready" onAttentionChange={async () => "normal"} /></TopLayerProvider>)); }
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
    if (new URL(String(path), "http://localhost").pathname === "/v1/drafts" && !init?.method) return Response.json([]);
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

test("keeps the first-unread card visible and open after a same-thread read refresh", async () => {
  const messages = Array.from({length:24}, (_, index) => ({...detail.messages[0]!, id:`reader-${index}`, receivedAt:`2026-10-08T${String(index).padStart(2,"0")}:00:00.000Z`, unread:index >= 21}));
  const conversation = {...detail, messages};
  await render(conversation);
  const before = JSON.stringify(conversation.messages.map(message => message.unread));
  const first = browser.document.querySelector('[aria-controls="reader-card-reader-21"]')!;
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(first.closest("li")?.hasAttribute("hidden")).toBe(false);
  expect(browser.document.querySelector('[aria-controls="reader-card-reader-23"]')!.getAttribute("aria-expanded")).toBe("false");
  await render({...conversation, messages:messages.map(message => ({...message, unread:false}))});
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(first.closest("li")?.hasAttribute("hidden")).toBe(false);
  expect(browser.document.querySelector('[aria-controls="reader-card-reader-0"]')?.closest("li")?.hasAttribute("hidden")).toBe(true);
  expect(button("First unread").disabled).toBe(false);
  await click("Expand all");
  expect(browser.document.querySelectorAll('.reader-card-toggle[aria-expanded="true"]').length).toBe(24);
  await click("Collapse all");
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(JSON.stringify(conversation.messages.map(message => message.unread))).toBe(before);
  expect(writes).toEqual([]);
});

test("an all-read conversation initially opens its latest message", async () => {
  const messages = Array.from({length:24}, (_, index) => ({...detail.messages[0]!, id:`reader-${index}`, receivedAt:`2026-10-08T${String(index).padStart(2,"0")}:00:00.000Z`, unread:false}));
  await render({...detail, messages});
  expect(browser.document.querySelector('[aria-controls="reader-card-reader-23"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(button("First unread").disabled).toBe(true);
  await render({...detail, messages:[...messages, {...messages[23]!, id:"new-unread", receivedAt:"2026-10-09T01:00:00.000Z", unread:true}]});
  expect(button("First unread").disabled).toBe(false);
  expect(browser.document.querySelector(".reader-unread-divider")).not.toBeNull();
});
