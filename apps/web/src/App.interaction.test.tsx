import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StrictMode, act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { App, GmailComposePermissionDialog, InboxApp, PROFILE_PHOTO_CHANGED_EVENT, PROFILE_PHOTO_FALLBACK_SRC, SettingsHome, defaultReaderPreferences, type ReaderPreferences, writeStoredProfilePhoto } from "./App";
import { ComposeWorkspace, createEmptyComposeDraft, useComposeDraft, type ComposeDraft, type ComposeDraftFields } from "./compose-workspace";
import { accountFixture, inboxFixture, type Collection, type InboxMessage, type MessageDraft, type PropagatedAgentEvent, type ThreadDetail, type UserPreferences } from "@orca/shared";
import { demoAccount, demoAgentEvents, demoMessages } from "./demo-data";
import { TopLayerProvider } from "./top-layer";
import { closeMailSearch, mailSearchLocationEvent, readMailSearchState } from "./global-search";

type FrameCallback = (timestamp: number) => void;
type ScrollPosition = { x: number; y: number };

const globalNames = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Node",
  "Element",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "DragEvent",
  "MutationObserver",
  "CustomEvent",
  "Text",
  "DocumentFragment",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "performance",
] as const;

const originalGlobalDescriptors = new Map<string, PropertyDescriptor | undefined>(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

let browserWindow: InstanceType<typeof Window>;
let root: Root | null;
let scrollPosition: ScrollPosition;
let nextFrameId: number;
let frameCallbacks: Map<number, FrameCallback>;
let cancelledFrameIds: number[];

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function isSameNode(left: unknown, right: unknown) {
  return left === right;
}

function installDom() {
  browserWindow = new Window({ url: "http://localhost:5173/dev/inbox" });
  scrollPosition = { x: 0, y: 0 };
  nextFrameId = 0;
  frameCallbacks = new Map();
  cancelledFrameIds = [];

  Object.defineProperties(browserWindow, {
    scrollX: { configurable: true, get: () => scrollPosition.x },
    scrollY: { configurable: true, get: () => scrollPosition.y },
    scrollTo: {
      configurable: true,
      value: (leftOrOptions: number | ScrollToOptions, top?: number) => {
        if (typeof leftOrOptions === "number") {
          scrollPosition = { x: leftOrOptions, y: top ?? 0 };
          return;
        }
        scrollPosition = {
          x: leftOrOptions.left ?? scrollPosition.x,
          y: leftOrOptions.top ?? scrollPosition.y,
        };
      },
    },
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        const id = ++nextFrameId;
        frameCallbacks.set(id, callback);
        return id;
      },
    },
    cancelAnimationFrame: {
      configurable: true,
      value: (id: number) => {
        cancelledFrameIds.push(id);
        frameCallbacks.delete(id);
      },
    },
    matchMedia: {
      configurable: true,
      value: () => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      }),
    },
  });

  const windowGlobals: Record<string, unknown> = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement,
    HTMLButtonElement: browserWindow.HTMLButtonElement,
    HTMLInputElement: browserWindow.HTMLInputElement,
    Node: browserWindow.Node,
    Element: browserWindow.Element,
    Event: browserWindow.Event,
    KeyboardEvent: browserWindow.KeyboardEvent,
    MouseEvent: browserWindow.MouseEvent,
    PointerEvent: browserWindow.PointerEvent,
    DragEvent: browserWindow.DragEvent,
    MutationObserver: browserWindow.MutationObserver,
    CustomEvent: browserWindow.CustomEvent,
    Text: browserWindow.Text,
    DocumentFragment: browserWindow.DocumentFragment,
    getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
    performance: browserWindow.performance,
  };
  for (const [name, value] of Object.entries(windowGlobals)) setGlobal(name, value);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

function restoreDom() {
  for (const name of globalNames) {
    const descriptor = originalGlobalDescriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  if (originalActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browserWindow.close();
}

async function renderApp(
  preferences: ReaderPreferences = defaultReaderPreferences,
  strict = false,
  options: Pick<Parameters<typeof InboxApp>[0], "demoMode" | "theme" | "bulkAttentionClient" | "initialDemoMessages"> = { theme: "light" },
) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  const app = <TopLayerProvider><InboxApp demoMode={options.demoMode ?? true} preferences={preferences} theme={options.theme ?? "light"} setTheme={() => {}} bulkAttentionClient={options.bulkAttentionClient} initialDemoMessages={options.initialDemoMessages} /></TopLayerProvider>;
  await act(async () => {
    root!.render(strict ? <StrictMode>{app}</StrictMode> : app);
  });
  return container;
}

function messageRow(sender: string) {
  const rows = [...browserWindow.document.querySelectorAll("button.message-row")] as unknown as HTMLButtonElement[];
  const row = rows
    .find((candidate) => candidate.textContent?.includes(sender));
  if (!row) throw new Error(`Could not find message row for ${sender}`);
  return row;
}

function inboxPane() {
  const pane = browserWindow.document.querySelector(".content-pane") as unknown as HTMLElement | null;
  if (!pane) throw new Error("Could not find the inbox content pane");
  return pane;
}

function desktopWorkspace() {
  const workspace = browserWindow.document.querySelector(".desktop-workspace") as unknown as HTMLElement | null;
  if (!workspace) throw new Error("Could not find the desktop workspace scrollport");
  return workspace;
}

function setScroll(position: ScrollPosition) {
  scrollPosition = position;
}

function trackFocus(element: HTMLButtonElement) {
  const originalFocus = element.focus.bind(element);
  const calls: Array<FocusOptions | undefined> = [];
  element.focus = ((options?: FocusOptions) => {
    calls.push(options);
    originalFocus(options);
  }) as typeof element.focus;
  return calls;
}

function flushAnimationFrames() {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) callback(0);
}

function DraftScopeHarness({ scope, availableDrafts, selectedDraft, demoMode = true }: { scope: string; availableDrafts?: MessageDraft[]; selectedDraft?: MessageDraft; demoMode?: boolean }) {
  const controller = useComposeDraft("scope-test", scope, demoMode, selectedDraft, availableDrafts);
  return <div><button data-testid="edit-draft" onClick={() => controller.updateDraft({ subject: scope === "new" ? "New draft edited" : "Saved draft edited" })} type="button">Edit</button><output data-testid="draft-subject">{controller.draft.subject}</output></div>;
}

function createTestMessageDraft(id: string, subject: string): MessageDraft {
  return {
    id,
    accountId: "scope-test",
    revision: 1,
    to: [],
    cc: [],
    bcc: [],
    subject,
    body: { text: "", html: null },
    context: null,
    attachments: [],
    deliveryStatus: "draft",
    providerSyncStatus: "not_applicable",
    providerSyncError: null,
    providerDraftId: null,
    providerMessageId: null,
    providerThreadId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function ComposeValidationHarness({
  initialDraft,
  contacts = [],
  variant = "panel",
  onSend,
}: {
  initialDraft: ComposeDraft;
  contacts?: Array<{ name: string | null; email: string }>;
  variant?: "panel" | "reply";
  onSend: (draft: ComposeDraft) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  return <ComposeWorkspace
    canSend
    contacts={contacts}
    controller={{
      draft,
      saveStatus: "saved",
      hasContent: true,
      updateDraft(update) {
        setDraft((current) => {
          const next = { ...current, ...update };
          draftRef.current = next;
          return next;
        });
      },
      attachFiles: () => ({ accepted: [], rejected: [] }),
      removeAttachment() {},
      discardDraft() {},
      async sendDraft(deliveryFields?: Partial<ComposeDraftFields>) {
        const sentDraft = { ...draftRef.current, ...deliveryFields };
        onSend(sentDraft);
        return { draftId: sentDraft.id, status: "sent", providerMessageId: "demo-sent", providerThreadId: null, error: null };
      },
    }}
    variant={variant}
  />;
}

async function renderComposeValidationHarness(props: Parameters<typeof ComposeValidationHarness>[0]) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(<ComposeValidationHarness {...props} />);
  });
  return container;
}

async function enterInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    const previous = input.value;
    input.value = value;
    (input as unknown as { _valueTracker?: { setValue: (tracked: string) => void } })._valueTracker?.setValue(previous);
    input.dispatchEvent(new browserWindow.InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }) as unknown as Event);
  });
}

async function openMessage(sender: string) {
  await act(async () => {
    messageRow(sender).click();
  });
  expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
}

async function escapeReader() {
  await act(async () => {
    browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function goBackToInbox() {
  const back = browserWindow.document.querySelector('[aria-label="Reader controls"] button') as unknown as HTMLButtonElement | null;
  if (!back) throw new Error("Could not find reader back control");
  await act(async () => {
    back.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function openZen() {
  const compose = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement | null;
  if (!compose) throw new Error("Could not find compose button");
  await act(async () => {
    compose.click();
  });

  const zenButton = browserWindow.document.querySelector("button.panel-zen") as unknown as HTMLButtonElement | null;
  if (!zenButton) throw new Error("Could not find Open in Zen control");
  await act(async () => {
    zenButton.click();
  });

  const canvas = browserWindow.document.querySelector(".zen-canvas") as unknown as HTMLElement | null;
  if (!canvas) throw new Error("Could not find Zen canvas");
  return canvas;
}

async function waitFor(milliseconds: number) {
  await act(async () => {
    if (milliseconds === 0) {
      await Promise.resolve();
      await Promise.resolve();
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
}

async function renderSettingsHome(theme: "light" | "dark" = "light", demoMode = false) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(<SettingsHome demoMode={demoMode} preferences={defaultReaderPreferences} setPreferences={() => {}} setTheme={() => {}} systemTheme="light" theme={theme} />);
  });
  return container;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiError(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

function createProductionInboxFetch(
  collectionsResponse: Promise<Response>,
  onCollectionsRequest?: () => void,
  options: { messages?: InboxMessage[]; agentEvents?: PropagatedAgentEvent[] } = {},
): typeof fetch {
  const messages = options.messages ?? inboxFixture;
  const syncStatus = {
    accounts: [{ ...accountFixture, state: "idle", lastSyncedAt: "2026-06-28T17:30:00.000Z", error: null }],
  };
  const inbox = {
    accounts: [accountFixture],
    messages,
    nextCursor: null,
    counts: {
      attention: { focus: 0, normal: messages.length, quiet: 0, hidden: 0, all: messages.length },
      classification: { likely_human: messages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: messages.length },
    },
  };
  const threadDetail = (message: InboxMessage): ThreadDetail => ({
    account: accountFixture,
    thread: {
      id: message.threadId,
      provider: message.provider,
      providerThreadId: `provider-${message.threadId}`,
      subject: message.subject,
      latestReceivedAt: message.receivedAt,
      messageCount: 1,
      labels: message.labels,
      participants: [message.from],
      readState: message.unread ? "unread" : "read",
      attention: { hasUnread: message.unread, hasStarred: false, hasDraft: false, humanSignal: message.humanSignal },
    },
    messages: [{
      id: message.id,
      accountId: message.accountId,
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      from: message.from,
      to: [{ name: accountFixture.displayName, email: accountFixture.email }],
      cc: [],
      bcc: [],
      subject: message.subject,
      snippet: message.snippet,
      bodyText: message.snippet,
      bodyHtml: null,
      internetMessageId: `<${message.id}@example.com>`,
      references: [],
      receivedAt: message.receivedAt,
      unread: message.unread,
      labels: message.labels,
      humanSignal: message.humanSignal,
      humanClassification: message.humanClassification,
      attachments: [],
    }],
  });

  return (async (input: string | URL | Request) => {
    const url = new URL(String(input), browserWindow.location.href);
    if (url.pathname === "/v1/me") return jsonResponse(accountFixture);
    if (url.pathname === "/v1/sync/status") return jsonResponse(syncStatus);
    if (url.pathname === "/v1/sync/gmail") return jsonResponse({});
    if (url.pathname === "/v1/inbox") return jsonResponse(inbox);
    const requestedThread = url.pathname.match(/^\/v1\/threads\/([^/]+)$/)?.[1];
    if (requestedThread) {
      const message = messages.find((candidate) => candidate.threadId === decodeURIComponent(requestedThread));
      if (message) return jsonResponse(threadDetail(message));
    }
    if (url.pathname === "/v1/collections") {
      onCollectionsRequest?.();
      return collectionsResponse;
    }
    if (url.pathname === "/v1/pins" || url.pathname === "/v1/reminders" || url.pathname === "/v1/drafts" || url.pathname === "/v1/attention/view-settings" || url.pathname === "/v1/agent-event-mutes") return jsonResponse([]);
    if (url.pathname === "/v1/reminders/view-settings") return jsonResponse({ displayName: "Later" });
    if (url.pathname === "/v1/agent-events") return jsonResponse({ events: options.agentEvents ?? [], nextCursor: null });
    if (url.pathname === "/v1/attention/resolve") {
      const matched = messages.find((candidate) => candidate.from.email.toLowerCase() === url.searchParams.get("address")?.toLowerCase());
      return jsonResponse({ behavior: matched?.attentionBehavior ?? "normal", rule: null });
    }
    throw new Error(`Unexpected production Inbox request: ${url.pathname}${url.search}`);
  }) as typeof fetch;
}

describe("OAuth login availability and recovery", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installDom();
    browserWindow.history.replaceState({}, "", "/login");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  async function renderLogin() {
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => {
      root!.render(<App />);
    });
    await waitFor(0);
  }

  function providerButton(label: string) {
    const button = [...browserWindow.document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === label) as unknown as HTMLButtonElement | undefined;
    if (!button) throw new Error(`Could not find provider button: ${label}`);
    return button;
  }

  test("enables every configured provider after checking the public contract", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const provider = String(input).includes("/outlook/") ? "outlook" : "gmail";
      return jsonResponse({ provider, available: true, reason: null });
    }) as typeof fetch;

    await renderLogin();

    expect(providerButton("Continue with Google").disabled).toBe(false);
    expect(providerButton("Continue with Outlook").disabled).toBe(false);
    expect(browserWindow.document.querySelector(".oauth-provider-availability")).toBeNull();
  });

  test("keeps an unavailable provider inert and gives one readable repair action", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const provider = String(input).includes("/outlook/") ? "outlook" : "gmail";
      return provider === "gmail"
        ? jsonResponse({ provider, available: false, reason: "configuration_required" })
        : jsonResponse({ provider, available: true, reason: null });
    }) as typeof fetch;

    await renderLogin();

    const gmail = providerButton("Continue with Google");
    expect(gmail.disabled).toBe(true);
    expect(gmail.getAttribute("aria-describedby")).toBe("gmail-unavailable-reason");
    expect(providerButton("Continue with Outlook").disabled).toBe(false);
    expect(browserWindow.document.body.textContent).toContain("Gmail sign-in is unavailable here");
    expect(browserWindow.document.body.textContent).toContain("Nothing in Orca or your mail account changed");
    expect(providerButton("Check availability again")).toBeTruthy();
    expect(browserWindow.document.body.textContent).not.toMatch(/GMAIL_|CLIENT_|SECRET|TOKEN_ENCRYPTION/i);
  });

  test("downgrades stale readiness after a provider-unavailable start and rechecks before enabling OAuth", async () => {
    let gmailStatusRequests = 0;
    let outlookStatusRequests = 0;
    let gmailStartRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/gmail/status")) {
        gmailStatusRequests += 1;
        return jsonResponse({ provider: "gmail", available: true, reason: null });
      }
      if (url.includes("/outlook/status")) {
        outlookStatusRequests += 1;
        return jsonResponse({ provider: "outlook", available: true, reason: null });
      }
      if (url.includes("/gmail/login")) {
        gmailStartRequests += 1;
        return jsonResponse({ error: { code: "provider_unavailable", message: "Missing GMAIL_CLIENT_SECRET=do-not-render" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderLogin();
    const gmail = providerButton("Continue with Google");
    expect(gmail.disabled).toBe(false);

    await act(async () => { gmail.click(); });
    await waitFor(0);

    expect(gmailStartRequests).toBe(1);
    expect(providerButton("Continue with Google").disabled).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Gmail sign-in is unavailable here");
    expect(browserWindow.document.body.textContent).toContain("Nothing in Orca or your mail account changed");
    const recoveryActions = [...browserWindow.document.querySelectorAll(".oauth-retry-button")] as unknown as HTMLButtonElement[];
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]?.textContent?.trim()).toBe("Check availability again");

    await act(async () => { recoveryActions[0]!.click(); });
    await waitFor(0);

    expect(gmailStartRequests).toBe(1);
    expect(gmailStatusRequests).toBe(2);
    expect(outlookStatusRequests).toBe(2);
    expect(providerButton("Continue with Google").disabled).toBe(false);
    expect(browserWindow.document.querySelector(".oauth-provider-availability")).toBeNull();
  });

  test("does not let an availability recheck race an OAuth start", async () => {
    let statusRequests = 0;
    let finishStart!: (response: Response) => void;
    const startResponse = new Promise<Response>((resolve) => { finishStart = resolve; });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        statusRequests += 1;
        const provider = url.includes("/outlook/") ? "outlook" : "gmail";
        return provider === "outlook"
          ? jsonResponse({ provider, available: false, reason: "configuration_required" })
          : jsonResponse({ provider, available: true, reason: null });
      }
      if (url.includes("/gmail/login")) return startResponse;
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderLogin();
    const recovery = providerButton("Check availability again");
    await act(async () => {
      providerButton("Continue with Google").click();
      await waitFor(0);
    });

    expect(recovery.disabled).toBe(true);
    await act(async () => { recovery.click(); });
    await waitFor(0);
    expect(statusRequests).toBe(2);

    await act(async () => {
      finishStart(apiError(503, "provider_unavailable", "Missing GMAIL_CLIENT_SECRET=do-not-render"));
      await startResponse;
    });
    await waitFor(0);

    expect(providerButton("Continue with Google").disabled).toBe(true);
    const recoveryActions = [...browserWindow.document.querySelectorAll(".oauth-retry-button")] as unknown as HTMLButtonElement[];
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]?.disabled).toBe(false);
    expect(browserWindow.document.body.textContent).not.toMatch(/GMAIL_|CLIENT_|SECRET|do-not-render/i);
  });

  test("recovers a failed availability check and sanitizes a failed provider start", async () => {
    let availabilityAttempt = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/status")) {
        availabilityAttempt += 1;
        if (availabilityAttempt <= 2) throw new Error("GMAIL_CLIENT_SECRET=do-not-render");
        const provider = url.includes("/outlook/") ? "outlook" : "gmail";
        return jsonResponse({ provider, available: true, reason: null });
      }
      if (url.includes("/gmail/login")) {
        return jsonResponse({ error: { code: "provider_unavailable", message: "Missing GMAIL_CLIENT_SECRET=do-not-render" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderLogin();
    expect(browserWindow.document.body.textContent).toContain("Sign-in choices could not be checked");
    expect(providerButton("Continue with Google").disabled).toBe(true);

    await act(async () => { providerButton("Check again").click(); });
    await waitFor(0);
    const gmail = providerButton("Continue with Google");
    expect(gmail.disabled).toBe(false);

    await act(async () => { gmail.click(); });
    await waitFor(0);
    expect(browserWindow.document.body.textContent).toContain("Gmail sign-in is unavailable here");
    expect(providerButton("Continue with Google").disabled).toBe(true);
    expect(providerButton("Check availability again")).toBeTruthy();
    expect(browserWindow.document.body.textContent).not.toMatch(/GMAIL_|CLIENT_|SECRET|do-not-render/i);
  });
});

const loadedPreferences: UserPreferences = {
  signature: "Warmly, Luke",
  composeFormat: "rich",
  replyBehavior: "reply_all",
  notifyByDefault: true,
};

describe("Compose delivery validation", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("rejects a pending matching suggestion and keeps the invalid To input focused", async () => {
    const sent: ComposeDraft[] = [];
    const draft = {
      ...createEmptyComposeDraft("account"),
      to: [{ name: "Dana", email: "dana@example.com" }],
      body: "Keep this draft intact.",
    };
    await renderComposeValidationHarness({
      initialDraft: draft,
      contacts: [{ name: "Maya Chen", email: "maya@example.com" }],
      onSend: (value) => sent.push(value),
    });
    const input = browserWindow.document.querySelector('[aria-label="Add To recipient"]') as unknown as HTMLInputElement;
    await enterInput(input, "maya");
    expect(browserWindow.document.querySelector('[role="option"]')?.textContent ?? "").toContain("Maya Chen");

    const send = browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      send.click();
    });

    expect(sent).toHaveLength(0);
    expect(input.value).toBe("maya");
    expect(browserWindow.document.activeElement === (input as unknown)).toBe(true);
    expect(browserWindow.document.querySelector('[role="alert"]')?.textContent).toContain("Choose a suggestion or enter a complete email address");
    expect(browserWindow.document.querySelector('[aria-label="Message body"]')?.textContent).toContain("Keep this draft intact.");
  });

  test("never drops a malformed token from otherwise valid visible recipient input", async () => {
    const sent: ComposeDraft[] = [];
    const draft = {
      ...createEmptyComposeDraft("account"),
      to: [{ name: "Maya", email: "maya@example.com" }],
      body: "The details are attached below.",
    };
    await renderComposeValidationHarness({ initialDraft: draft, onSend: (value) => sent.push(value) });
    const carbonToggle = [...browserWindow.document.querySelectorAll("button")]
      .find((button) => button.textContent === "Add Cc or Bcc") as unknown as HTMLButtonElement;
    await act(async () => carbonToggle.click());
    const bcc = browserWindow.document.querySelector('[aria-label="Add Bcc recipient"]') as unknown as HTMLInputElement;
    await enterInput(bcc, "anika@example.com, unfinished-address");

    const send = browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement;
    await act(async () => send.click());

    expect(sent).toHaveLength(0);
    expect(bcc.value).toBe("anika@example.com, unfinished-address");
    expect(browserWindow.document.activeElement === (bcc as unknown)).toBe(true);
    expect(browserWindow.document.querySelector('[role="alert"]')?.textContent).toContain("unfinished-address");
  });

  for (const { address, kind } of [
    { address: "maya@example.com>", kind: "To" },
    { address: "maya@example..com", kind: "Cc" },
    { address: "maya@-example.com", kind: "Bcc" },
  ] as const) {
    test(`rejects shared-schema-invalid ${kind} input ${address} inline and restores field focus`, async () => {
      const sent: ComposeDraft[] = [];
      const draft = {
        ...createEmptyComposeDraft("account"),
        to: [{ name: "Dana", email: "dana@example.com" }],
        body: "Keep this draft intact.",
      };
      await renderComposeValidationHarness({ initialDraft: draft, onSend: (value) => sent.push(value) });
      if (kind !== "To") {
        const carbonToggle = [...browserWindow.document.querySelectorAll("button")]
          .find((button) => button.textContent === "Add Cc or Bcc") as unknown as HTMLButtonElement;
        await act(async () => carbonToggle.click());
      }
      const input = browserWindow.document.querySelector(`[aria-label="Add ${kind} recipient"]`) as unknown as HTMLInputElement;
      await enterInput(input, address);

      const send = browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement;
      await act(async () => send.click());

      expect(sent).toHaveLength(0);
      expect(input.value).toBe(address);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(browserWindow.document.activeElement === (input as unknown)).toBe(true);
      expect(browserWindow.document.querySelector('[role="alert"]')?.textContent).toContain(address);
      expect(browserWindow.document.querySelector('[aria-label="Message body"]')?.textContent).toContain("Keep this draft intact.");
    });
  }

  test("commits valid pending To, Cc, and Bcc input into the exact delivery payload", async () => {
    const sent: ComposeDraft[] = [];
    const draft = { ...createEmptyComposeDraft("account"), body: "A complete note." };
    await renderComposeValidationHarness({ initialDraft: draft, onSend: (value) => sent.push(value) });
    const carbonToggle = [...browserWindow.document.querySelectorAll("button")]
      .find((button) => button.textContent === "Add Cc or Bcc") as unknown as HTMLButtonElement;
    await act(async () => carbonToggle.click());
    const to = browserWindow.document.querySelector('[aria-label="Add To recipient"]') as unknown as HTMLInputElement;
    const cc = browserWindow.document.querySelector('[aria-label="Add Cc recipient"]') as unknown as HTMLInputElement;
    const bcc = browserWindow.document.querySelector('[aria-label="Add Bcc recipient"]') as unknown as HTMLInputElement;
    await enterInput(to, "maya@example.com");
    await enterInput(cc, "Dana <dana@example.com>");
    await enterInput(bcc, "anika@example.com");

    await act(async () => {
      (browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([{ name: null, email: "maya@example.com" }]);
    expect(sent[0]?.cc).toEqual([{ name: "Dana", email: "dana@example.com" }]);
    expect(sent[0]?.bcc).toEqual([{ name: null, email: "anika@example.com" }]);
  });

  test("blocks an empty reply, explains the policy, and returns focus to the message body", async () => {
    const sent: ComposeDraft[] = [];
    const draft = {
      ...createEmptyComposeDraft("account"),
      to: [{ name: "Maya", email: "maya@example.com" }],
      subject: "Re: Launch notes",
    };
    await renderComposeValidationHarness({ initialDraft: draft, variant: "reply", onSend: (value) => sent.push(value) });
    const send = browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("aria-describedby")).not.toBeNull();
    expect(browserWindow.document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toContain("Write a reply or add an attachment");

    await act(async () => send.click());

    expect(sent).toHaveLength(0);
    expect(browserWindow.document.activeElement?.getAttribute("aria-label")).toBe("Message body");
    expect(browserWindow.document.querySelector('[role="alert"]')?.textContent).toContain("Your reply is still here");
  });

  test("allows an attachment-only reply and labels that delivery policy before sending", async () => {
    const sent: ComposeDraft[] = [];
    const file = new browserWindow.File(["notes"], "notes.txt", { type: "text/plain" }) as unknown as File;
    const draft = {
      ...createEmptyComposeDraft("account"),
      to: [{ name: "Maya", email: "maya@example.com" }],
      subject: "Re: Launch notes",
      attachments: [{ id: "notes", filename: "notes.txt", mimeType: "text/plain", size: 5, file, previewUrl: null }],
    };
    await renderComposeValidationHarness({ initialDraft: draft, variant: "reply", onSend: (value) => sent.push(value) });
    const send = browserWindow.document.querySelector("button.compose-send") as unknown as HTMLButtonElement;
    expect(send.getAttribute("aria-disabled")).toBeNull();
    expect(browserWindow.document.querySelector(".compose-delivery-empty")?.textContent).toBe("Attachment-only reply");

    await act(async () => {
      send.click();
      await Promise.resolve();
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("");
    expect(sent[0]?.attachments).toHaveLength(1);
  });
});

function settingsButton(label: string) {
  const button = [...browserWindow.document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === label) as unknown as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Could not find Settings button: ${label}`);
  return button;
}

describe("Settings recovery", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("retries the canonical preference read without ever PATCHing fallback values", async () => {
    let preferenceReads = 0;
    const requests: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url === "/v1/preferences") {
        preferenceReads += 1;
        return preferenceReads === 1
          ? apiError(503, "temporarily_unavailable", "Preferences are temporarily unavailable")
          : jsonResponse(loadedPreferences);
      }
      if (url === "/v1/accounts") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/v1/mcp/connections") return jsonResponse({ items: [] });
      if (url === "/v1/sync/status") return jsonResponse({ accounts: [] });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await renderSettingsHome();
    await waitFor(0);

    const signature = browserWindow.document.querySelector(".settings-field textarea") as unknown as HTMLTextAreaElement;
    const accountRadios = [...browserWindow.document.querySelectorAll('input[name="compose-format"], input[name="reply-behavior"]')] as unknown as HTMLInputElement[];
    expect(signature.disabled).toBe(true);
    expect(accountRadios.every((input) => input.disabled)).toBe(true);
    expect(settingsButton("Save account choices").disabled).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Nothing on your account was changed");

    await act(async () => {
      settingsButton("Try loading account choices again").click();
    });
    await waitFor(0);

    expect(signature.disabled).toBe(false);
    expect(settingsButton("Save account choices").disabled).toBe(true);
    expect(requests.filter((request) => request.url === "/v1/preferences" && request.method === "PATCH")).toHaveLength(0);
    expect(preferenceReads).toBe(2);
  });

  test("preserves newer edits across slow saves, failed saves, and PATCH retry", async () => {
    let patchCount = 0;
    let resolveFirstPatch!: (response: Response) => void;
    const patchBodies: UserPreferences[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/v1/preferences" && (init?.method ?? "GET") === "GET") return jsonResponse(loadedPreferences);
      if (url === "/v1/preferences" && init?.method === "PATCH") {
        patchCount += 1;
        const body = JSON.parse(String(init.body)) as UserPreferences;
        patchBodies.push(body);
        if (patchCount === 1) return new Promise<Response>((resolve) => { resolveFirstPatch = resolve; });
        if (patchCount === 2) return apiError(503, "temporarily_unavailable", "Save service unavailable");
        return jsonResponse(body);
      }
      if (url === "/v1/accounts") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/v1/mcp/connections") return jsonResponse({ items: [] });
      if (url === "/v1/sync/status") return jsonResponse({ accounts: [] });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderSettingsHome();
    await waitFor(0);
    const signature = browserWindow.document.querySelector(".settings-field textarea") as unknown as HTMLTextAreaElement;
    const plainFormat = browserWindow.document.querySelector('input[name="compose-format"][value="plain"]') as unknown as HTMLInputElement;
    const richFormat = browserWindow.document.querySelector('input[name="compose-format"][value="rich"]') as unknown as HTMLInputElement;
    const reply = browserWindow.document.querySelector('input[name="reply-behavior"][value="reply"]') as unknown as HTMLInputElement;

    await act(async () => {
      plainFormat.click();
    });
    expect(settingsButton("Save account choices").disabled).toBe(false);
    await act(async () => {
      settingsButton("Save account choices").click();
    });
    expect(signature.disabled).toBe(false);
    expect(settingsButton("Saving…").disabled).toBe(true);

    await act(async () => {
      reply.click();
    });
    await act(async () => {
      resolveFirstPatch(jsonResponse({ ...loadedPreferences, signature: "First edit" }));
    });
    await waitFor(0);

    expect(reply.checked).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Newer edits are still here");
    expect(settingsButton("Save account choices").disabled).toBe(false);

    await act(async () => {
      settingsButton("Save account choices").click();
    });
    await waitFor(0);
    expect(browserWindow.document.body.textContent).toContain("Your account choices are still here");

    await act(async () => {
      richFormat.click();
    });
    await act(async () => {
      settingsButton("Try saving again").click();
    });
    await waitFor(0);

    expect(patchBodies.map((body) => `${body.composeFormat}:${body.replyBehavior}`)).toEqual(["plain:reply_all", "plain:reply", "rich:reply"]);
    expect(richFormat.checked).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Account preferences saved");
  });

  test("gives session, account, agent, and sync read failures scoped recovery", async () => {
    let accountReads = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/v1/preferences") return apiError(401, "unauthorized", "Session expired");
      if (url === "/v1/accounts") {
        accountReads += 1;
        return accountReads === 1
          ? apiError(500, "internal_error", "Account service failed")
          : jsonResponse({ items: [], nextCursor: null });
      }
      if (url === "/v1/mcp/connections") return apiError(403, "forbidden", "Agent access denied");
      if (url === "/v1/sync/status") throw new TypeError("Failed to fetch");
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderSettingsHome("dark");
    await waitFor(0);

    expect(browserWindow.document.body.textContent).toContain("Your Orca session expired");
    expect(browserWindow.document.querySelector('a[href^="/login"]')?.textContent).toContain("Sign in again");
    expect(browserWindow.document.body.textContent).toContain("Connected accounts are temporarily unavailable");
    expect(browserWindow.document.body.textContent).toContain("Orca cannot read agent connections");
    expect(browserWindow.document.body.textContent).toContain("Sync status is unavailable while Orca is offline");

    await act(async () => {
      settingsButton("Try loading connected accounts again").click();
    });
    await waitFor(0);
    expect(accountReads).toBe(2);
    expect(browserWindow.document.body.textContent).toContain("No mail provider is connected yet");
  });

  test("keeps edited account choices local when the session expires during save", async () => {
    let preferencePatches = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/v1/preferences" && (init?.method ?? "GET") === "GET") return jsonResponse(loadedPreferences);
      if (url === "/v1/preferences" && init?.method === "PATCH") {
        preferencePatches += 1;
        return apiError(401, "unauthorized", "Session expired");
      }
      if (url === "/v1/accounts") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/v1/mcp/connections") return jsonResponse({ items: [] });
      if (url === "/v1/sync/status") return jsonResponse({ accounts: [] });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderSettingsHome();
    await waitFor(0);
    const plainFormat = browserWindow.document.querySelector('input[name="compose-format"][value="plain"]') as unknown as HTMLInputElement;
    await act(async () => { plainFormat.click(); });
    await act(async () => { settingsButton("Save account choices").click(); });
    await waitFor(0);

    expect(plainFormat.checked).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Your account choices are still here");
    expect(browserWindow.document.querySelector('.settings-save-bar a[href^="/login"]')?.textContent).toBe("Sign in again");
    expect(preferencePatches).toBe(1);
  });

  test("retries agent connections and sync status without reloading other Settings reads", async () => {
    let preferenceReads = 0;
    let accountReads = 0;
    let agentReads = 0;
    let syncReads = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/v1/preferences") { preferenceReads += 1; return jsonResponse(loadedPreferences); }
      if (url === "/v1/accounts") { accountReads += 1; return jsonResponse({ items: [], nextCursor: null }); }
      if (url === "/v1/mcp/connections") {
        agentReads += 1;
        return agentReads === 1 ? apiError(503, "temporarily_unavailable", "Agent service unavailable") : jsonResponse({ items: [] });
      }
      if (url === "/v1/sync/status") {
        syncReads += 1;
        return syncReads === 1 ? apiError(503, "temporarily_unavailable", "Sync service unavailable") : jsonResponse({ accounts: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderSettingsHome();
    await waitFor(0);
    expect(browserWindow.document.body.textContent).toContain("Agent connections are temporarily unavailable");
    expect(browserWindow.document.body.textContent).toContain("Sync status is temporarily unavailable");

    await act(async () => { settingsButton("Try loading agent connections again").click(); });
    await waitFor(0);
    expect(browserWindow.document.body.textContent).toContain("No ChatGPT or Codex connection has access to this workspace");
    expect(agentReads).toBe(2);
    expect(syncReads).toBe(1);

    await act(async () => { settingsButton("Try loading sync status again").click(); });
    await waitFor(0);
    expect(syncReads).toBe(2);
    expect(preferenceReads).toBe(1);
    expect(accountReads).toBe(1);
  });

  test("ignores a stale canonical GET after a newer preference read has completed", async () => {
    let preferenceReads = 0;
    let resolveStaleRead!: (response: Response) => void;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/v1/preferences") {
        preferenceReads += 1;
        if (preferenceReads === 1) return apiError(503, "temporarily_unavailable", "Preferences are temporarily unavailable");
        if (preferenceReads === 2) return new Promise<Response>((resolve) => { resolveStaleRead = resolve; });
        return jsonResponse({ ...loadedPreferences, signature: "Newest canonical value" });
      }
      if (url === "/v1/accounts") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/v1/mcp/connections") return jsonResponse({ items: [] });
      if (url === "/v1/sync/status") return jsonResponse({ accounts: [] });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await renderSettingsHome();
    await waitFor(0);
    const retry = settingsButton("Try loading account choices again");
    await act(async () => {
      retry.click();
      retry.click();
    });
    await waitFor(0);
    const signature = browserWindow.document.querySelector(".settings-field textarea") as unknown as HTMLTextAreaElement;
    expect(preferenceReads).toBe(3);
    expect(signature.value).toBe("Newest canonical value");

    await act(async () => {
      resolveStaleRead(jsonResponse({ ...loadedPreferences, signature: "Stale canonical value" }));
    });
    await waitFor(0);
    expect(signature.value).toBe("Newest canonical value");
  });
});

describe("Write shortcut", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("opens writing with C and keeps modified keys available", async () => {
    await renderApp();
    const compose = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement | null;
    expect(compose?.getAttribute("aria-keyshortcuts")).toBe("c");
    expect(compose?.querySelector("kbd")?.textContent).toBe("C");

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).toBeNull();

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).not.toBeNull();
    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
  });

  test("starts writing in Zen mode when the preference is enabled", async () => {
    await renderApp({ ...defaultReaderPreferences, composeZenByDefault: true });

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });

    expect(browserWindow.document.querySelector(".zen-canvas")).not.toBeNull();
  });
});

describe("App top-layer contract", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    restoreDom();
  });

  test("keeps reader, Compose, and Zen in one topmost Escape stack", async () => {
    const container = await renderApp({ ...defaultReaderPreferences, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    await openMessage("Mom");
    const composeOpener = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement;
    composeOpener.focus();
    await act(async () => composeOpener.click());

    const compose = browserWindow.document.querySelector('[role="dialog"][aria-label="Compose message"]') as unknown as HTMLElement;
    expect(compose).not.toBeNull();
    expect(compose.getAttribute("aria-modal")).toBe("true");
    expect(container.inert).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();

    const zenOpener = compose.querySelector("button.panel-zen") as unknown as HTMLButtonElement;
    zenOpener.focus();
    await act(async () => zenOpener.click());
    expect(browserWindow.document.querySelector('[role="dialog"][aria-label="Zen writing mode"]')).not.toBeNull();
    const stacked = [...browserWindow.document.querySelectorAll("[data-top-layer]")] as unknown as HTMLElement[];
    expect(stacked.map((layer) => layer.dataset.topLayer)).toEqual(["background", "active"]);
    expect(stacked[0]?.inert).toBe(true);

    await escapeReader();
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.querySelector('[aria-label="Zen writing mode"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).not.toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, zenOpener)).toBe(true);

    await escapeReader();
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, composeOpener)).toBe(true);
  });

  test("gives Gmail permission the same focus, busy, and Escape behavior", async () => {
    function PermissionHarness() {
      const [open, setOpen] = useState(false);
      const [status, setStatus] = useState<"idle" | "loading">("idle");
      return <TopLayerProvider>
        <button data-testid="permission-opener" onClick={() => { setStatus("idle"); setOpen(true); }} type="button">Request send access</button>
        {open ? <GmailComposePermissionDialog error={null} onCancel={() => setOpen(false)} onContinue={() => setStatus("loading")} status={status} /> : null}
      </TopLayerProvider>;
    }
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<PermissionHarness />));
    const opener = container.querySelector('[data-testid="permission-opener"]') as unknown as HTMLButtonElement;
    opener.focus();
    await act(async () => opener.click());
    let permission = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="gmail-permission-title"]') as unknown as HTMLElement;
    expect(permission.getAttribute("aria-modal")).toBe("true");
    expect(browserWindow.document.activeElement?.textContent).toBe("Continue to Google");
    await escapeReader();
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.querySelector('[aria-labelledby="gmail-permission-title"]')).toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, opener)).toBe(true);

    await act(async () => opener.click());
    permission = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="gmail-permission-title"]') as unknown as HTMLElement;
    const continueButton = [...permission.querySelectorAll("button")].find((button) => button.textContent === "Continue to Google") as unknown as HTMLButtonElement;
    await act(async () => continueButton.click());
    expect(permission.getAttribute("aria-busy")).toBe("true");
    expect([...permission.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
    await act(async () => { browserWindow.document.body.focus(); });
    await escapeReader();
    expect(isSameNode(browserWindow.document.querySelector('[aria-labelledby="gmail-permission-title"]'), permission)).toBe(true);
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(isSameNode(browserWindow.document.activeElement, permission)).toBe(true);
  });

  test("suspends Compose and search shortcuts behind Manage spaces and Pin Builder", async () => {
    await renderApp();
    const globalSearch = browserWindow.document.querySelector('input[aria-label="Search mail"]') as unknown as HTMLInputElement;
    const manage = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Manage") as unknown as HTMLButtonElement;
    manage.focus();
    await act(async () => manage.click());
    const manageDialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]') as unknown as HTMLElement;
    expect(manageDialog).not.toBeNull();
    const manageFocus = browserWindow.document.activeElement as unknown as HTMLElement;
    await act(async () => {
      manageFocus.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }) as unknown as Event);
      manageFocus.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, manageFocus)).toBe(true);
    expect(browserWindow.document.activeElement).not.toBe(globalSearch);
    await escapeReader();
    await act(async () => flushAnimationFrames());

    const pinOpener = browserWindow.document.querySelector("button.pinned-person-add") as unknown as HTMLButtonElement;
    pinOpener.focus();
    await act(async () => pinOpener.click());
    const pinBuilder = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="pin-builder-title"]') as unknown as HTMLElement;
    expect(pinBuilder).not.toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, pinBuilder.querySelector("input"))).toBe(true);
    const pinBuilderFocus = browserWindow.document.activeElement as unknown as HTMLElement;
    await act(async () => {
      pinBuilderFocus.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }) as unknown as Event);
      pinBuilderFocus.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(browserWindow.document.querySelectorAll('[aria-label="Compose message"]')).toHaveLength(0);
    expect(browserWindow.document.activeElement).not.toBe(globalSearch);
    await escapeReader();
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.querySelector('[aria-labelledby="pin-builder-title"]')).toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, pinOpener)).toBe(true);
  });

  test("restores the Compose trigger when default Zen and Compose close together", async () => {
    await renderApp({ ...defaultReaderPreferences, composeZenByDefault: true, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    browserWindow.document.body.tabIndex = -1;
    browserWindow.document.body.focus();
    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    expect(Boolean(browserWindow.document.querySelector('[aria-label="Zen writing mode"]'))).toBe(true);

    await escapeReader();
    await act(async () => flushAnimationFrames());
    const composeTrigger = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement;
    expect(Boolean(browserWindow.document.querySelector('[aria-label="Zen writing mode"]'))).toBe(false);
    expect(Boolean(browserWindow.document.querySelector('[aria-label="Compose message"]'))).toBe(false);
    expect(isSameNode(browserWindow.document.activeElement, composeTrigger)).toBe(true);
  });

  test("restores a stable visible app control when Remove pin deletes the opener", async () => {
    await renderApp({ ...defaultReaderPreferences, motion: "reduced" });
    const savedPins = browserWindow.document.querySelector('[aria-label="Saved pins"]') as unknown as HTMLElement;
    savedPins.hidden = true;
    const customize = browserWindow.document.querySelector('button[aria-label^="Customize "]') as unknown as HTMLButtonElement;
    customize.focus();
    await act(async () => customize.click());
    const remove = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Remove pin") as unknown as HTMLButtonElement;
    await act(async () => { remove.click(); await Promise.resolve(); });
    await act(async () => flushAnimationFrames());

    const composeTrigger = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement;
    expect(Boolean(browserWindow.document.querySelector('[aria-labelledby="pin-appearance-title"]'))).toBe(false);
    expect(customize.isConnected).toBe(false);
    expect(isSameNode(browserWindow.document.activeElement, composeTrigger)).toBe(true);
  });
});

describe("Inbox row action affordances", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("uses icon-first controls while keeping accessible names and states", async () => {
    await renderApp();
    const wrap = messageRow("Jordan Bell").parentElement as unknown as HTMLElement;
    const pin = wrap.querySelector("button.pin-sender-button") as unknown as HTMLButtonElement | null;
    const keep = wrap.querySelector("button.keep-thread-button") as unknown as HTMLButtonElement | null;
    const tune = wrap.querySelector("button.sender-attention-trigger") as unknown as HTMLButtonElement | null;

    expect(pin).not.toBeNull();
    expect(pin?.querySelector("svg.message-action-icon")).not.toBeNull();
    expect(pin?.getAttribute("aria-label")).toBe("Pin Jordan Bell");
    expect(pin?.getAttribute("title")).toBe("Pin Jordan Bell");

    expect(keep).not.toBeNull();
    expect(keep?.querySelector("svg.message-action-icon")).not.toBeNull();
    expect(keep?.getAttribute("aria-label")).toContain("Keep ");
    expect(keep?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(keep?.getAttribute("title")).toBe("Keep in collection");

    expect(tune).not.toBeNull();
    expect(tune?.querySelector("svg.message-action-icon")).not.toBeNull();
    expect(tune?.getAttribute("aria-label")).toBe("Manage mail from Jordan Bell");
    expect(tune?.getAttribute("title")).toBe("Tune mail from Jordan Bell");
    expect(tune?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      pin?.click();
    });
    const pinned = (messageRow("Jordan Bell").parentElement as unknown as HTMLElement).querySelector("button.pin-sender-button") as unknown as HTMLButtonElement;
    expect(pinned.disabled).toBe(true);
    expect(pinned.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      tune?.click();
    });
    expect(tune?.getAttribute("aria-expanded")).toBe("true");
  });

  test("presents thread saving as an immediate, accessible collection checklist", async () => {
    await renderApp();
    const wrap = messageRow("Luke Brevoort").parentElement as unknown as HTMLElement;
    const keep = wrap.querySelector("button.keep-thread-button") as unknown as HTMLButtonElement;

    await act(async () => {
      keep.click();
    });

    const dialog = browserWindow.document.querySelector('.thread-organizer[role="dialog"]') as unknown as HTMLElement | null;
    expect(dialog).not.toBeNull();
    if (!dialog) throw new Error("Could not find the thread organizer dialog");
    expect(dialog.getAttribute("aria-describedby")).toBe("organizer-description");
    expect(browserWindow.document.activeElement?.getAttribute("aria-label")).toBe("Close organizer");
    const appContainer = browserWindow.document.querySelector("main.desktop-shell")?.parentElement?.parentElement;
    expect(appContainer?.hasAttribute("inert")).toBe(true);
    expect(appContainer?.getAttribute("aria-hidden")).toBe("true");
    expect(dialog.querySelector(".organizer-pin-section h3")?.textContent).toBe("Quick access");
    expect(dialog.querySelector(".organizer-collections h3")?.textContent).toBe("Collections");

    const collectionButtons = [...dialog.querySelectorAll(".organizer-collection-list > button")] as unknown as HTMLButtonElement[];
    expect(collectionButtons).toHaveLength(2);
    expect(collectionButtons[0].getAttribute("aria-pressed")).toBe("true");
    expect(collectionButtons[1].getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      collectionButtons[1].click();
    });
    expect(dialog.querySelector(".organizer-selection-count")?.textContent).toBe("2 selected");
    expect(collectionButtons[1].getAttribute("aria-pressed")).toBe("true");

    const newCollection = dialog.querySelector("button.organizer-new-collection") as unknown as HTMLButtonElement;
    await act(async () => {
      newCollection.click();
    });
    expect(dialog.querySelector('input[aria-label="New collection name"]')).not.toBeNull();
    expect([...dialog.querySelectorAll("footer button")].map((button) => button.textContent)).toEqual(["Done"]);
  });
});

describe("Desktop evidence and navigation", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("keeps evidence modal, closes the top layer with Escape, and restores trigger focus", async () => {
    await renderApp();
    const rowEvidence = browserWindow.document.querySelector("button.message-evidence-button") as unknown as HTMLButtonElement;
    rowEvidence.setAttribute("data-focus-origin", "list-evidence");
    rowEvidence.focus();
    await act(async () => { rowEvidence.click(); });
    const listDialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Why here?"]') as unknown as HTMLElement | null;
    expect(listDialog).not.toBeNull();
    expect(listDialog?.textContent).toContain("authoritative placement trace");
    expect(browserWindow.document.activeElement?.getAttribute("aria-label")).toBe("Close evidence");
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await act(async () => { flushAnimationFrames(); });
    expect(browserWindow.document.querySelector('[role="dialog"][aria-label="Why here?"]')).toBeNull();
    expect(browserWindow.document.activeElement?.getAttribute("data-focus-origin")).toBe("list-evidence");

    const row = messageRow("Mom");
    await act(async () => { row.click(); });
    const readerTrigger = browserWindow.document.querySelector("button.thread-lane-why") as unknown as HTMLButtonElement;
    readerTrigger.setAttribute("data-focus-origin", "reader-evidence");
    readerTrigger.focus();
    await act(async () => { readerTrigger.click(); });
    const placementDialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Thread placement evidence"]');
    expect(placementDialog).not.toBeNull();
    expect(placementDialog?.textContent).toContain("Winning source");
    expect(placementDialog?.textContent).toContain("workspace fallback");
    expect(placementDialog?.textContent).toContain("Precedence level");
    expect(placementDialog?.textContent).toContain("Actor");
    expect(placementDialog?.textContent).toContain("Reason");
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await act(async () => { flushAnimationFrames(); });
    expect(browserWindow.document.querySelector("article.message-reader")).not.toBeNull();
    expect(browserWindow.document.querySelector('[role="dialog"][aria-label="Thread placement evidence"]')).toBeNull();
    expect(browserWindow.document.activeElement?.getAttribute("data-focus-origin")).toBe("reader-evidence");
  });

  test("applies a Manual Override and Safety Lock from the current Thread experience", async () => {
    await renderApp();
    await openMessage("Mom");
    const trigger = browserWindow.document.querySelector("button.thread-lane-trigger") as unknown as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Thread Lane controls"]') as unknown as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.closest("#orca-top-layer-root")?.parentElement?.tagName).toBe("BODY");
    const focus = [...dialog.querySelectorAll(".thread-lane-options button")].find((button) => button.textContent?.includes("Focus")) as unknown as HTMLButtonElement;
    await act(async () => { focus.click(); });
    expect(trigger.textContent).toContain("Focus");
    expect(focus.getAttribute("aria-pressed")).toBe("true");
    const lock = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Lock placement") as unknown as HTMLButtonElement;
    await act(async () => { lock.click(); });
    expect(dialog.textContent).toContain("Locked by you");
    expect([...dialog.querySelectorAll(".thread-lane-options button")].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    const close = dialog.querySelector('header button[aria-label="Close"]') as unknown as HTMLButtonElement;
    await act(async () => { close.click(); });
    const why = browserWindow.document.querySelector("button.thread-lane-why") as unknown as HTMLButtonElement;
    await act(async () => { why.click(); });
    const evidence = browserWindow.document.querySelector('[role="dialog"][aria-label="Thread placement evidence"]');
    expect(evidence?.textContent).toContain("manual override");
    expect(evidence?.textContent).toContain("2 manual override");
    expect(evidence?.textContent).toContain("demo-human");
    expect(evidence?.textContent).toContain("Safety Lock active");
  });

  test("contains Lane drawer focus in both directions and restores the trigger after Escape", async () => {
    await renderApp(defaultReaderPreferences, true);
    await openMessage("Mom");
    const trigger = browserWindow.document.querySelector("button.thread-lane-trigger") as unknown as HTMLButtonElement;
    trigger.focus();

    await act(async () => { trigger.click(); });
    await act(async () => { flushAnimationFrames(); });
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Thread Lane controls"]') as unknown as HTMLElement;
    expect(dialog).not.toBeNull();
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    first.setAttribute("data-focus-boundary", "first");
    last.setAttribute("data-focus-boundary", "last");
    trigger.setAttribute("data-focus-origin", "lane-trigger");

    expect(browserWindow.document.activeElement?.getAttribute("data-focus-boundary")).toBe("first");
    last.focus();
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(browserWindow.document.activeElement?.getAttribute("data-focus-boundary")).toBe("first");
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
    expect(browserWindow.document.activeElement?.getAttribute("data-focus-boundary")).toBe("last");

    await act(async () => { browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await act(async () => { flushAnimationFrames(); });
    expect(browserWindow.document.querySelector('[role="dialog"][aria-label="Thread Lane controls"]')).toBeNull();
    expect(browserWindow.document.activeElement?.getAttribute("data-focus-origin")).toBe("lane-trigger");
  });

  test("writes stable destinations and follows browser history", async () => {
    await renderApp();
    const navButtons = [...browserWindow.document.querySelectorAll("button.desktop-sidebar-item")] as unknown as HTMLButtonElement[];
    const focus = navButtons.find((button) => button.textContent?.includes("Focus"))!;
    const custom = navButtons.find((button) => button.textContent?.includes("Orca launch"))!;
    await act(async () => { focus.click(); });
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("focus");
    await act(async () => { custom.click(); });
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toStartWith("space:");
    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(focus.getAttribute("aria-current")).toBe("page");
  });

  test("returns from a Search result to Search, then restores the mounted source Reader", async () => {
    const originalFetch = globalThis.fetch;
    const resultMessage = inboxFixture[0]!;
    const sourceMessage: InboxMessage = {
      ...resultMessage,
      id: `${resultMessage.id}-source`,
      threadId: `${resultMessage.threadId}-source`,
      providerMessageId: `${resultMessage.providerMessageId}-source`,
      subject: "Source reader conversation",
    };
    const source = `/dev/inbox?destination=focus&q=${encodeURIComponent(resultMessage.subject)}&thread=${encodeURIComponent(sourceMessage.threadId)}&accountId=${encodeURIComponent(sourceMessage.accountId)}`;
    const productionFetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])), undefined, { messages: [resultMessage, sourceMessage] });
    browserWindow.history.replaceState({}, "", source);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), browserWindow.location.href);
      if (url.pathname === "/v1/accounts") return jsonResponse({ items: [accountFixture], nextCursor: null });
      if (url.pathname === "/v1/organization/collections-pins/query") return jsonResponse({ workspaceId: "workspace_1", accountIds: [accountFixture.id], collections: [], pins: [], queries: [] });
      return productionFetch(input, init);
    }) as typeof fetch;

    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 10 && !browserWindow.document.querySelector("article.message-reader"); index += 1) await waitFor(0);
      expect(browserWindow.document.querySelector("article.message-reader")).not.toBeNull();
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(sourceMessage.subject);

      const headerSearch = browserWindow.document.querySelector('input[aria-label="Search mail"]') as unknown as HTMLInputElement;
      await act(async () => headerSearch.form?.dispatchEvent(new browserWindow.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      expect(new URL(browserWindow.location.href).searchParams.get("search")).toBe("mail");
      const searchLayer = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="global-mail-search-title"]') as unknown as HTMLElement;
      expect(searchLayer).not.toBeNull();
      expect(new URL(browserWindow.location.href).searchParams.get("searchQuery")).toBe(resultMessage.subject);
      for (let index = 0; index < 10 && !browserWindow.document.querySelector(".global-mail-result-list a"); index += 1) await waitFor(1);
      const result = browserWindow.document.querySelector(".global-mail-result-list a") as unknown as HTMLAnchorElement;
      expect(result).not.toBeNull();

      await act(async () => {
        result.dispatchEvent(new browserWindow.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
        await Promise.resolve();
      });
      for (let index = 0; index < 10 && !browserWindow.document.querySelector(".reader-kicker")?.textContent?.includes("Search results"); index += 1) await waitFor(0);
      expect(browserWindow.document.querySelector(".reader-back")?.textContent).toContain("Search results");
      expect(browserWindow.document.querySelector(".reader-kicker")?.textContent).toContain("Search results");
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(resultMessage.subject);
      expect(searchLayer.isConnected).toBe(false);

      await act(async () => {
        (browserWindow.document.querySelector(".reader-back") as unknown as HTMLButtonElement).click();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(readMailSearchState(browserWindow.location as unknown as Location)).not.toBeNull();
      expect(browserWindow.document.querySelector('[role="dialog"][aria-labelledby="global-mail-search-title"]')).not.toBeNull();
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(sourceMessage.subject);

      await act(async () => {
        closeMailSearch();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(`${browserWindow.location.pathname}${browserWindow.location.search}`).toBe(source);
      expect(browserWindow.document.querySelector(".content-pane")?.getAttribute("aria-label")).toBe("Message reader");
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(sourceMessage.subject);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("closes an invalid Search return to a synchronized Inbox fallback", async () => {
    const originalFetch = globalThis.fetch;
    const message = inboxFixture[0]!;
    const source = `/dev/inbox?destination=focus&thread=${encodeURIComponent(message.threadId)}&accountId=${encodeURIComponent(message.accountId)}`;
    const productionFetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])));
    browserWindow.history.replaceState({}, "", source);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), browserWindow.location.href);
      if (url.pathname === "/v1/accounts") return jsonResponse({ items: [accountFixture], nextCursor: null });
      if (url.pathname === "/v1/organization/collections-pins/query") return jsonResponse({ workspaceId: "workspace_1", accountIds: [accountFixture.id], collections: [], pins: [], queries: [] });
      return productionFetch(input, init);
    }) as typeof fetch;

    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 10 && !browserWindow.document.querySelector("article.message-reader"); index += 1) await waitFor(0);
      expect(browserWindow.document.querySelector("article.message-reader")).not.toBeNull();

      const invalidSearch = new URL(browserWindow.location.href);
      invalidSearch.searchParams.set("search", "mail");
      invalidSearch.searchParams.set("searchQuery", "");
      invalidSearch.searchParams.set("searchMailbox", "all");
      invalidSearch.searchParams.set("searchEvidence", "all");
      invalidSearch.searchParams.set("searchSource", "/api/private");
      await act(async () => {
        browserWindow.history.replaceState({}, "", `${invalidSearch.pathname}${invalidSearch.search}`);
        browserWindow.dispatchEvent(new browserWindow.Event(mailSearchLocationEvent));
        await Promise.resolve();
      });
      expect(browserWindow.document.querySelector('[role="dialog"][aria-labelledby="global-mail-search-title"]')).not.toBeNull();

      await act(async () => {
        closeMailSearch();
        await Promise.resolve();
      });
      expect(`${browserWindow.location.pathname}${browserWindow.location.search}`).toBe("/?destination=inbox");
      expect(browserWindow.document.querySelector('[role="dialog"][aria-labelledby="global-mail-search-title"]')).toBeNull();
      expect(browserWindow.document.querySelector(".content-pane")?.getAttribute("aria-label")).toBe("Inbox");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves a production custom-space deep link until deferred collections select it", async () => {
    const originalFetch = globalThis.fetch;
    let resolveCollections!: (response: Response) => void;
    let collectionsRequested = false;
    const collectionsResponse = new Promise<Response>((resolve) => {
      resolveCollections = resolve;
    });
    const collection: Collection = {
      id: "collection_deferred_launch",
      accountId: accountFixture.id,
      name: "Launch review",
      color: "#70867d",
      position: 0,
      threadIds: [inboxFixture[0]!.threadId],
      createdAt: "2026-06-28T17:30:00.000Z",
      updatedAt: "2026-06-28T17:30:00.000Z",
    };

    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=space%3Acollection_deferred_launch");
    globalThis.fetch = createProductionInboxFetch(collectionsResponse, () => { collectionsRequested = true; });
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 10 && !collectionsRequested; index += 1) await waitFor(0);

      expect(collectionsRequested).toBe(true);
      expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("space:collection_deferred_launch");

      await act(async () => {
        resolveCollections(jsonResponse([collection]));
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let index = 0; index < 10 && !browserWindow.document.querySelector('[aria-current="page"]')?.textContent?.includes("Launch review"); index += 1) await waitFor(0);

      expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("space:collection_deferred_launch");
      expect(browserWindow.document.querySelector('nav[aria-label="Primary navigation"] [aria-current="page"]')?.textContent).toContain("Launch review");
      expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Launch review");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back only after production collections settle without the requested custom space", async () => {
    const originalFetch = globalThis.fetch;
    let resolveCollections!: (response: Response) => void;
    let collectionsRequested = false;
    const collectionsResponse = new Promise<Response>((resolve) => {
      resolveCollections = resolve;
    });

    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=space%3Acollection_missing");
    globalThis.fetch = createProductionInboxFetch(collectionsResponse, () => { collectionsRequested = true; });
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 10 && !collectionsRequested; index += 1) await waitFor(0);

      expect(collectionsRequested).toBe(true);
      expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("space:collection_missing");

      await act(async () => {
        resolveCollections(jsonResponse([]));
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let index = 0; index < 10 && new URL(browserWindow.location.href).searchParams.get("destination") !== "inbox"; index += 1) await waitFor(0);

      expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("inbox");
      expect(browserWindow.document.querySelector('nav[aria-label="Primary navigation"] [aria-current="page"]')?.textContent).toContain("Inbox");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("persists hidden workspace visibility across a reload", async () => {
    await renderApp();
    const manage = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.trim().toLowerCase() === "manage") as unknown as HTMLButtonElement;
    await act(async () => { manage.click(); });
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]') as unknown as HTMLElement;
    const signalsRow = [...dialog.querySelectorAll("article")].find((row) => row.textContent?.includes("Signals"))!;
    const hide = [...signalsRow.querySelectorAll("button")].find((button) => button.textContent === "Hide") as unknown as HTMLButtonElement;
    await act(async () => { hide.click(); });
    expect([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Signals"))).toBe(false);

    await act(async () => { root!.unmount(); });
    root = null;
    await renderApp();
    expect([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Signals"))).toBe(false);
  });

  test("persists one absolute order when a drag crosses multiple rows", async () => {
    await renderApp();
    const manage = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.trim().toLowerCase() === "manage") as unknown as HTMLButtonElement;
    await act(async () => { manage.click(); });
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]')!;
    const rows = [...dialog.querySelectorAll(".desktop-space-list article")];
    const focus = rows.find((row) => row.textContent?.includes("Focus"))!;
    const later = rows.find((row) => row.textContent?.includes("Later"))!;
    await act(async () => {
      focus.dispatchEvent(new browserWindow.DragEvent("dragstart", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      later.dispatchEvent(new browserWindow.DragEvent("dragover", { bubbles: true, cancelable: true }));
      later.dispatchEvent(new browserWindow.DragEvent("drop", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const labels = [...dialog.querySelectorAll(".desktop-space-list article > div > strong")].map((label) => label.textContent);
    expect(labels.slice(0, 4)).toEqual(["Signals", "Quiet", "Later", "Focus"]);
  });

  test("keeps Inbox and Settings on the same customized sidebar projection in both themes", async () => {
    browserWindow.localStorage.setItem("orca:space-preferences:v1:acct_demo", JSON.stringify({
      revision: 1,
      order: ["collection_demo_life", "focus", "quiet", "later", "collection_demo_work", "signals"],
      hidden: ["signals"],
      labels: { focus: "Deep focus", collection_demo_work: "Launch watch" },
    }));
    const sidebarRows = () => [...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
      .map((button) => button.textContent?.replace(/\s+/g, " ").trim());

    for (const theme of ["light", "dark"] as const) {
      browserWindow.history.replaceState({}, "", "/dev/inbox");
      await renderApp(defaultReaderPreferences, false, { theme });
      await waitFor(0);
      const inboxRows = sidebarRows();
      expect(inboxRows.some((label) => label?.includes("Launch watch"))).toBe(true);
      expect(inboxRows.some((label) => label?.includes("Signals"))).toBe(false);

      await act(async () => root!.unmount());
      root = null;
      browserWindow.history.replaceState({}, "", "/dev/settings");
      await renderSettingsHome(theme, true);
      await waitFor(0);
      expect(sidebarRows()).toEqual(inboxRows);
      const customDestination = [...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Launch watch")) as unknown as HTMLButtonElement;
      await act(async () => customDestination.click());
      expect(browserWindow.location.pathname).toBe("/dev/inbox");
      expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("space:collection_demo_work");

      await act(async () => root!.unmount());
      root = null;
    }
  });

  test("reacts immediately to connectivity changes across Inbox and Settings in both themes", async () => {
    let online = true;
    Object.defineProperty(browserWindow.navigator, "onLine", { configurable: true, get: () => online });

    for (const route of ["inbox", "settings"] as const) {
      for (const theme of ["light", "dark"] as const) {
        browserWindow.history.replaceState({}, "", route === "inbox" ? "/dev/inbox" : "/dev/settings");
        if (route === "inbox") await renderApp(defaultReaderPreferences, false, { theme });
        else await renderSettingsHome(theme, true);

        expect(browserWindow.document.querySelector(".desktop-health")?.textContent).not.toContain("offline");
        online = false;
        await act(async () => browserWindow.dispatchEvent(new browserWindow.Event("offline")));
        expect(browserWindow.document.querySelector(".desktop-health")?.textContent).toContain("offline");
        expect(browserWindow.document.querySelector(".desktop-connectivity-notice")?.textContent).toContain("Cached mail stays readable");
        expect(browserWindow.document.querySelector(".desktop-connectivity-notice button")?.textContent).toBe("Open drafts");

        online = true;
        await act(async () => browserWindow.dispatchEvent(new browserWindow.Event("online")));
        expect(browserWindow.document.querySelector(".desktop-connectivity-notice")).toBeNull();
        await act(async () => root!.unmount());
        root = null;
      }
    }
  });

  test("keeps a canonical destination through create, rename, reorder, hide, restore, and active fallback", async () => {
    await renderApp();
    const manageButton = () => [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.trim().toLowerCase() === "manage") as unknown as HTMLButtonElement;
    await act(async () => manageButton().click());
    const createTrigger = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "+ Create a workflow space") as unknown as HTMLButtonElement;
    await act(async () => createTrigger.click());
    const createForm = browserWindow.document.querySelector(".desktop-create-space") as unknown as HTMLElement;
    const nameInput = createForm.querySelector('input[aria-label="Workflow space name"]') as unknown as HTMLInputElement;
    await enterInput(nameInput, "Launch review");
    const createButton = [...createForm.querySelectorAll("button")].find((button) => button.textContent === "Create") as unknown as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    await act(async () => { createButton.click(); await Promise.resolve(); });
    await waitFor(0);

    const createdDestination = new URL(browserWindow.location.href).searchParams.get("destination");
    expect(createdDestination).toStartWith("space:collection_demo_");
    expect(browserWindow.document.querySelector('nav[aria-label="Primary navigation"] [aria-current="page"]')?.textContent).toContain("Launch review");

    await act(async () => manageButton().click());
    let dialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]') as unknown as HTMLElement;
    let activeRow = [...dialog.querySelectorAll("article")].find((row) => row.textContent?.includes("Launch review"))!;
    Object.defineProperty(browserWindow, "prompt", { configurable: true, value: () => "Renamed launch" });
    await act(async () => { ([...activeRow.querySelectorAll("button")].find((button) => button.textContent === "Rename") as unknown as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe(createdDestination);
    expect(browserWindow.document.querySelector('nav[aria-label="Primary navigation"] [aria-current="page"]')?.textContent).toContain("Renamed launch");

    dialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]') as unknown as HTMLElement;
    activeRow = [...dialog.querySelectorAll("article")].find((row) => row.textContent?.includes("Renamed launch"))!;
    const moveUp = activeRow.querySelector('button[aria-label^="Move Renamed launch up"]') as unknown as HTMLButtonElement;
    if (!moveUp.disabled) await act(async () => { moveUp.click(); await Promise.resolve(); });
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe(createdDestination);

    const hide = [...activeRow.querySelectorAll("button")].find((button) => button.textContent === "Hide") as unknown as HTMLButtonElement;
    await act(async () => hide.click());
    expect(browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]')).toBeNull();
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("inbox");
    expect(browserWindow.document.querySelector('nav[aria-label="Primary navigation"] [aria-current="page"]')?.textContent).toContain("Inbox");
    expect([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Renamed launch"))).toBe(false);
    await act(async () => { flushAnimationFrames(); flushAnimationFrames(); flushAnimationFrames(); });
    expect((browserWindow.document.activeElement as unknown as HTMLElement).classList.contains("content-pane")).toBe(true);

    await act(async () => manageButton().click());
    const restore = [...browserWindow.document.querySelectorAll(".desktop-hidden-spaces button")].find((button) => button.textContent?.includes("Renamed launch")) as unknown as HTMLButtonElement;
    await act(async () => restore.click());
    expect(new URL(browserWindow.location.href).searchParams.get("destination")).toBe("inbox");
    expect([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Renamed launch"))).toBe(true);
  });
});

describe("Drafts mailbox", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("opens the saved drafts view and reopens a selected draft", async () => {
    await renderApp();

    const draftsButton = [...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
      .find((button) => button.textContent?.includes("Drafts")) as HTMLButtonElement | undefined;
    expect(draftsButton).toBeDefined();

    draftsButton!.focus();
    await act(async () => {
      draftsButton!.click();
    });
    await act(async () => {
      flushAnimationFrames();
    });
    expect(browserWindow.document.querySelector(".draft-row")?.textContent).toContain("A calmer launch note");
    expect((browserWindow.document.activeElement as unknown as Element | null)?.textContent).toContain("Drafts");

    const draftRow = browserWindow.document.querySelector(".draft-row") as unknown as HTMLButtonElement | null;
    expect(draftRow).not.toBeNull();
    const focusCalls = trackFocus(draftRow!);
    draftRow!.focus();
    await act(async () => {
      draftRow!.click();
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).not.toBeNull();
    const subject = browserWindow.document.querySelector('input[name="subject"]') as unknown as HTMLInputElement | null;
    expect(subject?.value).toBe("A calmer launch note");
    const closePanel = browserWindow.document.querySelector('button[aria-label="Close panel"]') as unknown as HTMLButtonElement | null;
    expect(closePanel).not.toBeNull();
    Object.defineProperty(browserWindow, "matchMedia", { configurable: true, value: () => ({ matches: true, media: "", onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }) });
    await act(async () => { closePanel!.click(); });
    await act(async () => { flushAnimationFrames(); });
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
  });

  test("keeps a new draft isolated through mounted close and reopen scope transitions", async () => {
    const savedDraft = createTestMessageDraft("saved-draft", "Saved draft");
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => {
      root!.render(<DraftScopeHarness availableDrafts={[savedDraft]} scope="new" />);
    });
    const edit = browserWindow.document.querySelector('[data-testid="edit-draft"]') as unknown as HTMLButtonElement | null;
    expect(edit).not.toBeNull();
    await act(async () => { edit!.click(); });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });
    expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("New draft edited");

    await act(async () => {
      root!.render(<DraftScopeHarness availableDrafts={[savedDraft]} scope="draft:saved-draft" selectedDraft={savedDraft} />);
    });
    expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("Saved draft");
    await act(async () => {
      root!.render(<DraftScopeHarness availableDrafts={[savedDraft]} scope="new" />);
    });
    expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("New draft edited");

    await act(async () => {
      root!.render(<DraftScopeHarness availableDrafts={[savedDraft]} scope="draft:saved-draft" selectedDraft={savedDraft} />);
    });
    await act(async () => {
      root!.render(<DraftScopeHarness availableDrafts={[savedDraft]} scope="new" />);
    });
    expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("New draft edited");
  });

  test("does not let a deferred old save patch the newly selected draft", async () => {
    const draftA = createTestMessageDraft("draft-a", "Draft A");
    const draftB = createTestMessageDraft("draft-b", "Draft B");
    const availableDrafts = [draftA, draftB];
    const originalFetch = globalThis.fetch;
    const pendingRequests: Array<{ url: string; init: RequestInit | undefined; resolve: (response: Response) => void }> = [];
    globalThis.fetch = (async (input, init) => new Promise<Response>((resolve) => {
      pendingRequests.push({ url: String(input), init, resolve });
    })) as typeof fetch;
    try {
      const container = browserWindow.document.createElement("div");
      browserWindow.document.body.append(container);
      root = createRoot(container as unknown as Element);
      await act(async () => {
        root!.render(<DraftScopeHarness availableDrafts={availableDrafts} demoMode={false} scope="draft:draft-a" />);
      });
      expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("Draft A");
      const edit = browserWindow.document.querySelector('[data-testid="edit-draft"]') as unknown as HTMLButtonElement | null;
      expect(edit).not.toBeNull();
      await act(async () => { edit!.click(); });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      });
      expect(pendingRequests.map((request) => request.url)).toEqual(["/v1/drafts/draft-a"]);

      await act(async () => {
        root!.render(<DraftScopeHarness availableDrafts={availableDrafts} demoMode={false} scope="draft:draft-b" />);
      });
      expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("Draft B");
      const oldSave = pendingRequests[0]!;
      oldSave.resolve(new Response(JSON.stringify({ ...draftA, subject: "Draft A edited", revision: 2 }), { status: 200, headers: { "content-type": "application/json" } }));
      await act(async () => { await Promise.resolve(); });
      expect(pendingRequests.map((request) => request.url)).toEqual(["/v1/drafts/draft-a"]);
      expect(browserWindow.document.querySelector('[data-testid="draft-subject"]')?.textContent).toBe("Draft B");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("moves between user-owned workflow spaces without reviving classification tabs", async () => {
    await renderApp();
    const primary = browserWindow.document.querySelector('nav[aria-label="Primary navigation"]');
    expect(primary).not.toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Inbox classification views"]')).toBeNull();

    const signals = [...(primary?.querySelectorAll("button.desktop-sidebar-item") ?? [])]
      .find((button) => button.textContent?.includes("Signals")) as HTMLButtonElement | undefined;
    const quiet = [...(primary?.querySelectorAll("button.desktop-sidebar-item") ?? [])]
      .find((button) => button.textContent?.includes("Quiet")) as HTMLButtonElement | undefined;
    expect(signals).toBeDefined();
    expect(quiet).toBeDefined();

    await act(async () => { signals!.click(); });
    expect(signals!.getAttribute("aria-current")).toBe("page");
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Signals");
    await act(async () => { quiet!.click(); });
    expect(quiet!.getAttribute("aria-current")).toBe("page");
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Quiet");
  });

});

describe("Pin navigation and bulk sender actions", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  function buttonByName(name: string) {
    const button = browserWindow.document.querySelector(`button[aria-label="${name}"]`) as unknown as HTMLButtonElement | null;
    if (!button) throw new Error(`Could not find ${name}`);
    return button;
  }

  test("lets a user-owned workflow space replace a temporary person filter", async () => {
    await renderApp();

    await act(async () => {
      buttonByName("Open Maya Chen pin").click();
    });
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Maya Chen");
    expect(buttonByName("Open Maya Chen pin").getAttribute("aria-pressed")).toBe("true");

    const signals = [...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
      .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement;
    await act(async () => { signals.click(); });

    expect(signals.getAttribute("aria-current")).toBe("page");
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Signals");
    expect(buttonByName("Open Maya Chen pin").getAttribute("aria-pressed")).toBe("false");
  });

  test("opens a pinned thread from outside its current signal view", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement).click();
    });
    await act(async () => {
      buttonByName("Open Dinner on Sunday? pin").click();
    });

    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(browserWindow.document.querySelector("#reader-title")?.textContent).toContain("Dinner on Sunday?");
  });

  test("lets keyboard users unpin a saved thread directly from the rail", async () => {
    await renderApp();
    const pin = buttonByName("Open Dinner on Sunday? pin");

    await act(async () => {
      pin.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }) as unknown as Event);
    });

    expect(browserWindow.document.querySelector('button[aria-label="Open Dinner on Sunday? pin"]')).toBeNull();
  });

  test("starts a saved search from the global no-results state", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?q=moonbase%20ledger");
    await renderApp();
    const search = browserWindow.document.querySelector('input[aria-label="Search mail"]') as unknown as HTMLInputElement;
    expect(search.value).toBe("moonbase ledger");
    const save = [...browserWindow.document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Save this search")) as HTMLButtonElement | undefined;
    expect(save).toBeDefined();
    await act(async () => { save!.click(); });
    expect((browserWindow.document.querySelector(".pin-builder-search input") as unknown as HTMLInputElement).value).toBe("moonbase ledger");
    const initialSave = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Pin this filter") as unknown as HTMLButtonElement;
    await act(async () => initialSave.click());
    expect(browserWindow.document.querySelector(".pin-builder-actions")?.textContent).toContain("Confirm this zero-match scope");
    const confirmedSave = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Pin zero-match filter") as unknown as HTMLButtonElement;
    await act(async () => confirmedSave.click());
    expect(browserWindow.document.querySelector('[aria-labelledby="pin-builder-title"]')).toBeNull();
  });

  test("announces a concise result status without making the message list live", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?q=Jordan");
    await renderApp();
    const listRegion = browserWindow.document.querySelector(".inbox-body");
    const resultStatus = browserWindow.document.querySelector(".inbox-results-status");

    expect(listRegion?.hasAttribute("aria-live")).toBe(false);
    expect(listRegion?.hasAttribute("aria-busy")).toBe(false);
    expect(resultStatus?.getAttribute("role")).toBe("status");
    expect(resultStatus?.getAttribute("aria-atomic")).toBe("true");
    expect(resultStatus?.textContent).toBe("1 result for Jordan.");
  });

  test("exposes the visible bulk-selection state as pressed", async () => {
    await renderApp();
    const selectMode = [...browserWindow.document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Select") as unknown as HTMLButtonElement;
    await act(async () => { selectMode.click(); });
    const selectAll = browserWindow.document.querySelector(".bulk-select-all") as unknown as HTMLButtonElement;

    expect(selectAll.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { selectAll.click(); });
    expect(selectAll.getAttribute("aria-pressed")).toBe("true");
    expect([...browserWindow.document.querySelectorAll("button.message-row")].every((row) => row.getAttribute("aria-pressed") === "true")).toBe(true);

    await act(async () => { selectAll.click(); });
    expect(selectAll.getAttribute("aria-pressed")).toBe("false");
    expect([...browserWindow.document.querySelectorAll("button.message-row")].every((row) => row.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  test("moves multiple selected senders to Quiet in one action", async () => {
    await renderApp();
    const selectMode = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement;
    await act(async () => {
      selectMode.click();
    });
    expect(browserWindow.document.querySelector("button.message-select-button")).toBeNull();
    expect(browserWindow.document.querySelector(".message-row-wrap-selecting .message-select-indicator")).not.toBeNull();
    await act(async () => {
      buttonByName("Select Mom: Dinner on Sunday?").click();
      buttonByName("Select Jordan Bell: Re: Team offsite planning").click();
    });
    const quiet = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button')].find((button) => button.textContent === "Quiet") as unknown as HTMLButtonElement;
    await act(async () => {
      quiet.click();
    });

    expect(browserWindow.document.querySelector(".bulk-action-message")?.textContent).toBe("2 senders moved to Quiet.");
    expect([...browserWindow.document.querySelectorAll("button.message-row")].some((row) => row.textContent?.includes("Mom"))).toBe(false);
    expect([...browserWindow.document.querySelectorAll("button.message-row")].some((row) => row.textContent?.includes("Jordan Bell"))).toBe(false);
    expect([...browserWindow.document.querySelectorAll("button")].some((button) => button.textContent === "Done selecting")).toBe(false);
  });

  test("keeps selection across search and includes hidden selections in the sender count", async () => {
    await renderApp();
    const selectMode = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement;
    await act(async () => { selectMode.click(); });
    await act(async () => { buttonByName("Select Mom: Dinner on Sunday?").click(); });

    const search = browserWindow.document.querySelector('input[aria-label="Search the stream"]') as unknown as HTMLInputElement;
    await enterInput(search, "Jordan");

    expect(browserWindow.document.querySelector(".bulk-action-bar strong")?.textContent).toBe("1 sender selected");
    expect(buttonByName("Select Jordan Bell: Re: Team offsite planning").getAttribute("aria-pressed")).toBe("false");
    await act(async () => { buttonByName("Select Jordan Bell: Re: Team offsite planning").click(); });
    expect(browserWindow.document.querySelector(".bulk-action-bar strong")?.textContent).toBe("2 senders selected");
  });

  test("reconciles mixed failure, keeps only the failed sender selected, and retries it", async () => {
    let requestCount = 0;
    const bulkAttentionClient: NonNullable<Parameters<typeof InboxApp>[0]["bulkAttentionClient"]> = async ({ targets, behavior }) => {
      requestCount += 1;
      return {
        behavior,
        outcomes: targets.map((target) => requestCount === 1 && target.address === "jordan@example.com"
          ? { status: "failed" as const, target, retryable: true, error: { code: "temporarily_unavailable" as const, message: "Try again" }, resolution: { behavior: "normal" as const, rule: null } }
          : { status: "succeeded" as const, target, resolution: { behavior, rule: null } }),
      };
    };
    await renderApp(defaultReaderPreferences, false, { theme: "dark", bulkAttentionClient });
    await act(async () => { ([...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement).click(); });
    await act(async () => {
      buttonByName("Select Mom: Dinner on Sunday?").click();
      buttonByName("Select Jordan Bell: Re: Team offsite planning").click();
    });
    const quiet = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button')].find((button) => button.textContent === "Quiet") as unknown as HTMLButtonElement;
    await act(async () => { quiet.click(); await Promise.resolve(); });

    expect(browserWindow.document.querySelector(".bulk-action-message")?.textContent).toContain("1 sender moved to Quiet. 1 sender could not be updated. 1 sender is ready to retry.");
    expect(browserWindow.document.querySelector(".bulk-action-bar strong")?.textContent).toBe("1 sender selected");
    expect(buttonByName("Deselect Jordan Bell: Re: Team offsite planning").getAttribute("aria-pressed")).toBe("true");
    expect([...browserWindow.document.querySelectorAll("button.message-row")].some((row) => row.textContent?.includes("Mom"))).toBe(false);

    const retry = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Retry failed") as unknown as HTMLButtonElement;
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect(requestCount).toBe(2);
    expect(browserWindow.document.querySelector(".bulk-action-message")?.textContent).toBe("1 sender moved to Quiet.");
    expect([...browserWindow.document.querySelectorAll("button")].some((button) => button.textContent === "Done selecting")).toBe(false);
  });

  test("retries a retryable exact sender target after its canonical state removes the row", async () => {
    const requests: Array<Array<{ accountId: string; address: string }>> = [];
    const bulkAttentionClient: NonNullable<Parameters<typeof InboxApp>[0]["bulkAttentionClient"]> = async ({ targets, behavior }) => {
      requests.push([...targets]);
      return requests.length === 1
        ? {
          behavior,
          outcomes: [{
            status: "failed",
            target: targets[0]!,
            retryable: true,
            error: { code: "temporarily_unavailable", message: "Retry the canonical write" },
            resolution: { behavior: "hidden", rule: null },
          }],
        }
        : {
          behavior,
          outcomes: [{ status: "succeeded", target: targets[0]!, resolution: { behavior, rule: null } }],
        };
    };
    await renderApp(defaultReaderPreferences, false, { theme: "light", bulkAttentionClient });
    await act(async () => { ([...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement).click(); });
    await act(async () => { buttonByName("Select Jordan Bell: Re: Team offsite planning").click(); });
    const quiet = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button').values()].find((button) => button.textContent === "Quiet") as unknown as HTMLButtonElement;
    await act(async () => { quiet.click(); await Promise.resolve(); });

    expect([...browserWindow.document.querySelectorAll("button.message-row")].some((row) => row.textContent?.includes("Jordan Bell"))).toBe(false);
    const retry = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Retry failed") as unknown as HTMLButtonElement;
    await act(async () => { retry.click(); await Promise.resolve(); });

    expect(requests).toEqual([
      [{ accountId: "acct_demo", address: "jordan@example.com" }],
      [{ accountId: "acct_demo", address: "jordan@example.com" }],
    ]);
    expect(browserWindow.document.querySelector(".bulk-action-message")?.textContent).toBe("1 sender moved to Quiet.");
  });

  test("keeps paginated same-id messages distinct across accounts, restores the exact row, and retries the exact target", async () => {
    const source = demoMessages[0]!;
    const gmailAccount = { ...demoAccount, id: "account-gmail" };
    const outlookAccount = { ...demoAccount, id: "account-outlook", provider: "outlook" as const, email: "outlook@example.com" };
    const gmailMessage: InboxMessage = {
      ...source,
      id: "shared-message-id",
      accountId: gmailAccount.id,
      provider: "gmail",
      providerMessageId: "gmail-shared-message",
      threadId: "gmail-shared-thread",
      from: { name: "Shared Gmail", email: " Shared@Example.com " },
      subject: "Gmail copy",
      receivedAt: "2026-07-02T12:00:00.000Z",
      unread: false,
    };
    const refreshedGmailMessage = { ...gmailMessage, subject: "Gmail copy refreshed", snippet: "Refreshed on page two." };
    const outlookMessage: InboxMessage = {
      ...source,
      id: "shared-message-id",
      accountId: outlookAccount.id,
      provider: "outlook",
      providerMessageId: "outlook-shared-message",
      threadId: "outlook-shared-thread",
      from: { name: "Shared Outlook", email: "shared@example.com" },
      subject: "Outlook copy",
      receivedAt: "2026-07-03T12:00:00.000Z",
      unread: false,
    };
    const counts = {
      attention: { focus: 0, normal: 2, quiet: 0, hidden: 0, all: 2 },
      classification: { likely_human: 2, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 2 },
    };
    const requests: Array<Array<{ accountId: string; address: string }>> = [];
    const bulkAttentionClient: NonNullable<Parameters<typeof InboxApp>[0]["bulkAttentionClient"]> = async ({ targets, behavior }) => {
      requests.push(targets);
      return {
        behavior,
        outcomes: targets.map((target) => requests.length === 1 && target.accountId === "account-outlook"
          ? { status: "failed" as const, target, retryable: true, error: { code: "temporarily_unavailable" as const, message: "Try again" }, resolution: { behavior: "normal" as const, rule: null } }
          : { status: "succeeded" as const, target, resolution: { behavior, rule: null } }),
      };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/v1/me") return jsonResponse(gmailAccount);
      if (url === "/v1/sync/status") return jsonResponse({ accounts: [] });
      if (url.includes("/v1/inbox?view=all&classification=all&limit=100&cursor=")) {
        return jsonResponse({ accounts: [gmailAccount, outlookAccount], messages: [refreshedGmailMessage, outlookMessage], counts, nextCursor: null });
      }
      if (url === "/v1/inbox?view=all&classification=all&limit=100") {
        return jsonResponse({ accounts: [gmailAccount, outlookAccount], messages: [gmailMessage], counts, nextCursor: "page-two" });
      }
      if (url === "/v1/sync/gmail" && init?.method === "POST") return apiError(503, "temporarily_unavailable", "Skip background refresh in this test");
      return apiError(503, "temporarily_unavailable", `Unexpected auxiliary request: ${url}`);
    }) as typeof fetch;
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light", bulkAttentionClient });
      await waitFor(0);
      const loadMore = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Load more messages") as unknown as HTMLButtonElement;
      expect(loadMore).toBeDefined();
      await act(async () => { loadMore.click(); await Promise.resolve(); });

      expect([...browserWindow.document.querySelectorAll("button.message-row")].map((row) => row.textContent)).toEqual([
        expect.stringContaining("Shared Outlook"),
        expect.stringContaining("Shared Gmail"),
      ]);
      expect(browserWindow.document.body.textContent).toContain("Gmail copy refreshed");

      const outlookOrigin = messageRow("Shared Outlook");
      await act(async () => { outlookOrigin.click(); });
      await escapeReader();
      await act(async () => flushAnimationFrames());
      expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(outlookOrigin);

      await act(async () => { ([...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement).click(); });
      await act(async () => {
        buttonByName("Select Shared Gmail: Gmail copy refreshed").click();
        buttonByName("Select Shared Outlook: Outlook copy").click();
      });

      expect(browserWindow.document.querySelector(".bulk-action-bar strong")?.textContent).toBe("2 senders selected");
      const quiet = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button')].find((button) => button.textContent === "Quiet") as unknown as HTMLButtonElement;
      await act(async () => { quiet.click(); await Promise.resolve(); });

      expect(browserWindow.document.querySelector(".bulk-action-bar strong")?.textContent).toBe("1 sender selected");
      expect(buttonByName("Deselect Shared Outlook: Outlook copy").getAttribute("aria-pressed")).toBe("true");
      const retry = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Retry failed") as unknown as HTMLButtonElement;
      await act(async () => { retry.click(); await Promise.resolve(); });

      expect(requests).toEqual([
        [
          { accountId: "account-gmail", address: "shared@example.com" },
          { accountId: "account-outlook", address: "shared@example.com" },
        ],
        [{ accountId: "account-outlook", address: "shared@example.com" }],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disables every duplicate bulk submission path while saving", async () => {
    let resolveRequest!: (value: Awaited<ReturnType<NonNullable<Parameters<typeof InboxApp>[0]["bulkAttentionClient"]>>>) => void;
    let requestedTarget!: { accountId: string; address: string };
    let calls = 0;
    const bulkAttentionClient: NonNullable<Parameters<typeof InboxApp>[0]["bulkAttentionClient"]> = ({ targets }) => {
      calls += 1;
      requestedTarget = targets[0]!;
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    };
    await renderApp(defaultReaderPreferences, false, { theme: "light", bulkAttentionClient });
    await act(async () => { ([...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent === "Select") as unknown as HTMLButtonElement).click(); });
    await act(async () => { buttonByName("Select Mom: Dinner on Sunday?").click(); });
    const quiet = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button')].find((button) => button.textContent === "Quiet") as unknown as HTMLButtonElement;
    await act(async () => { quiet.click(); await Promise.resolve(); });

    const actionButtons = [...browserWindow.document.querySelectorAll('.bulk-action-bar [role="group"] button')] as unknown as HTMLButtonElement[];
    expect(browserWindow.document.querySelector(".bulk-action-bar")?.getAttribute("aria-busy")).toBe("true");
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect((browserWindow.document.querySelector(".bulk-select-all") as unknown as HTMLButtonElement).disabled).toBe(true);
    quiet.click();
    expect(calls).toBe(1);

    await act(async () => {
      resolveRequest({ behavior: "quiet", outcomes: [{ status: "succeeded", target: requestedTarget, resolution: { behavior: "quiet", rule: null } }] });
      await Promise.resolve();
    });
  });
});

describe("Inbox reader viewport restoration", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  async function expectReaderOrigin(label: string) {
    for (let index = 0; index < 20 && browserWindow.document.querySelector(".reader-back span")?.textContent !== label; index += 1) await waitFor(0);
    expect(browserWindow.document.querySelector(".reader-back span")?.textContent).toBe(label);
    expect(browserWindow.document.querySelector(".reader-kicker")?.textContent).toStartWith(`${label} ·`);
  }

  test("keeps a loaded Reader mounted and scrolled through an unrelated delayed mailbox refresh", async () => {
    const originalFetch = globalThis.fetch;
    const selectedMessage = inboxFixture[0]!;
    const unrelatedMessage: InboxMessage = {
      ...selectedMessage,
      id: `${selectedMessage.id}-unrelated`,
      threadId: `${selectedMessage.threadId}-unrelated`,
      providerMessageId: `${selectedMessage.providerMessageId}-unrelated`,
      subject: "Unrelated mailbox row",
      from: { name: "Unrelated Sender", email: "unrelated@example.com" },
    };
    const initialMessages = [selectedMessage, unrelatedMessage];
    const refreshedMessages = initialMessages.map((message, index) => index === 1
      ? { ...message, subject: `${message.subject} (refreshed elsewhere)` }
      : { ...message });
    const baseFetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])), undefined, { messages: initialMessages });
    let inboxReadCount = 0;
    let threadReadCount = 0;
    let resolveDelayedInbox!: (response: Response) => void;
    const delayedInbox = new Promise<Response>((resolve) => { resolveDelayedInbox = resolve; });
    let resolveUnexpectedThreadRefresh!: (response: Response) => void;
    const unexpectedThreadRefresh = new Promise<Response>((resolve) => { resolveUnexpectedThreadRefresh = resolve; });
    let holdLaterThreadReads = false;

    browserWindow.history.replaceState({}, "", `/dev/inbox?destination=inbox&thread=${encodeURIComponent(selectedMessage.threadId)}&accountId=${encodeURIComponent(selectedMessage.accountId)}`);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), browserWindow.location.href);
      if (url.pathname === "/v1/inbox") {
        inboxReadCount += 1;
        if (inboxReadCount === 2) return delayedInbox;
      }
      if (url.pathname === `/v1/threads/${encodeURIComponent(selectedMessage.threadId)}`) {
        threadReadCount += 1;
        if (holdLaterThreadReads) return unexpectedThreadRefresh;
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 30 && (!browserWindow.document.querySelector(".reader-document:not(.reader-loading)") || inboxReadCount < 2); index += 1) await waitFor(0);

      const workspace = desktopWorkspace();
      const readerDocument = browserWindow.document.querySelector(".reader-document:not(.reader-loading)");
      if (!readerDocument) throw new Error("Reader did not settle before delayed mailbox refresh");
      workspace.scrollTop = 640;
      const detailReadsBeforeRefresh = threadReadCount;
      let readerDocumentRemoved = false;
      const observer = new browserWindow.MutationObserver((records) => {
        readerDocumentRemoved ||= records.some((record) => [...record.removedNodes].some((node) =>
          isSameNode(node, readerDocument)
          || Boolean((node as unknown as { contains?: (target: unknown) => boolean }).contains?.(readerDocument)),
        ));
      });
      observer.observe(browserWindow.document.body, { childList: true, subtree: true });
      holdLaterThreadReads = true;

      await act(async () => {
        resolveDelayedInbox(jsonResponse({
          accounts: [accountFixture],
          messages: refreshedMessages,
          nextCursor: null,
          counts: {
            attention: { focus: 0, normal: refreshedMessages.length, quiet: 0, hidden: 0, all: refreshedMessages.length },
            classification: { likely_human: refreshedMessages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: refreshedMessages.length },
          },
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let index = 0; index < 10 && threadReadCount === detailReadsBeforeRefresh; index += 1) await waitFor(0);

      expect(threadReadCount).toBe(detailReadsBeforeRefresh);
      expect(browserWindow.document.querySelector(".reader-loading")).toBeNull();
      expect(browserWindow.document.querySelector(".reader-document")).toBe(readerDocument);
      expect(readerDocumentRemoved).toBe(false);
      expect(workspace.scrollTop).toBe(640);
      observer.disconnect();
    } finally {
      resolveUnexpectedThreadRefresh?.(await baseFetch(`/v1/threads/${encodeURIComponent(selectedMessage.threadId)}?accountId=${encodeURIComponent(selectedMessage.accountId)}`));
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes changed active-thread content without replaying Reader loading or losing scroll", async () => {
    const originalFetch = globalThis.fetch;
    const selectedMessage = inboxFixture[0]!;
    const updatedSubject = `${selectedMessage.subject} — updated`;
    const refreshedMessages = inboxFixture.map((message, index) => index === 0
      ? { ...message, subject: updatedSubject, snippet: `${message.snippet} New reply.` }
      : { ...message });
    const baseFetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])));
    let inboxReadCount = 0;
    let threadReadCount = 0;
    let activeSnapshotChanged = false;
    let resolveDelayedInbox!: (response: Response) => void;
    const delayedInbox = new Promise<Response>((resolve) => { resolveDelayedInbox = resolve; });

    browserWindow.history.replaceState({}, "", `/dev/inbox?destination=inbox&thread=${encodeURIComponent(selectedMessage.threadId)}&accountId=${encodeURIComponent(selectedMessage.accountId)}`);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), browserWindow.location.href);
      if (url.pathname === "/v1/inbox") {
        inboxReadCount += 1;
        if (inboxReadCount === 2) return delayedInbox;
      }
      if (url.pathname === `/v1/threads/${encodeURIComponent(selectedMessage.threadId)}`) {
        threadReadCount += 1;
        const response = await baseFetch(input, init);
        if (activeSnapshotChanged) {
          const detail = await response.json() as ThreadDetail;
          return jsonResponse({
            ...detail,
            thread: { ...detail.thread, subject: updatedSubject },
            messages: detail.messages.map((message) => ({ ...message, subject: updatedSubject, snippet: `${message.snippet} New reply.`, bodyText: `${message.bodyText} New reply.` })),
          });
        }
        return response;
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 30 && (!browserWindow.document.querySelector(".reader-document:not(.reader-loading)") || inboxReadCount < 2); index += 1) await waitFor(0);

      const workspace = desktopWorkspace();
      const readerDocument = browserWindow.document.querySelector(".reader-document:not(.reader-loading)");
      if (!readerDocument) throw new Error("Reader did not settle before active-thread refresh");
      workspace.scrollTop = 720;
      const detailReadsBeforeRefresh = threadReadCount;
      activeSnapshotChanged = true;

      await act(async () => {
        resolveDelayedInbox(jsonResponse({
          accounts: [accountFixture],
          messages: refreshedMessages,
          nextCursor: null,
          counts: {
            attention: { focus: 0, normal: refreshedMessages.length, quiet: 0, hidden: 0, all: refreshedMessages.length },
            classification: { likely_human: refreshedMessages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: refreshedMessages.length },
          },
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let index = 0; index < 20 && browserWindow.document.querySelector("#reader-title")?.textContent !== updatedSubject; index += 1) await waitFor(0);

      expect(threadReadCount).toBe(detailReadsBeforeRefresh + 1);
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(updatedSubject);
      expect(browserWindow.document.querySelector(".reader-loading")).toBeNull();
      expect(browserWindow.document.querySelector(".reader-document")).toBe(readerDocument);
      expect(workspace.scrollTop).toBe(720);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fetches fresh detail after explicit Retry and after selecting another thread", async () => {
    const originalFetch = globalThis.fetch;
    const failedMessage = inboxFixture[0]!;
    const nextMessage: InboxMessage = {
      ...failedMessage,
      id: `${failedMessage.id}-next`,
      threadId: `${failedMessage.threadId}-next`,
      providerMessageId: `${failedMessage.providerMessageId}-next`,
      subject: "A different selected conversation",
      from: { name: "Next Reader", email: "next-reader@example.com" },
    };
    const baseFetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])), undefined, { messages: [failedMessage, nextMessage] });
    const threadReads: string[] = [];
    let failFirstDetail = true;

    browserWindow.history.replaceState({}, "", `/dev/inbox?destination=inbox&thread=${encodeURIComponent(failedMessage.threadId)}&accountId=${encodeURIComponent(failedMessage.accountId)}`);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), browserWindow.location.href);
      if (url.pathname.startsWith("/v1/threads/") && !url.pathname.endsWith("/read")) {
        threadReads.push(`${url.pathname}${url.search}`);
        if (failFirstDetail) {
          failFirstDetail = false;
          return apiError(503, "temporarily_unavailable", "Reader detail is temporarily unavailable");
        }
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 20 && !browserWindow.document.querySelector(".reader-state button"); index += 1) await waitFor(0);
      const retry = browserWindow.document.querySelector(".reader-state button") as unknown as HTMLButtonElement;
      expect(retry?.textContent).toBe("Try again");

      await act(async () => retry.click());
      for (let index = 0; index < 20 && !browserWindow.document.querySelector(".reader-document:not(.reader-loading)"); index += 1) await waitFor(0);
      expect(threadReads.filter((path) => path.includes(encodeURIComponent(failedMessage.threadId)))).toHaveLength(2);

      await goBackToInbox();
      await act(async () => messageRow(nextMessage.from.name ?? nextMessage.from.email).click());
      for (let index = 0; index < 20 && browserWindow.document.querySelector("#reader-title")?.textContent !== nextMessage.subject; index += 1) await waitFor(0);
      expect(threadReads.some((path) => path.includes(encodeURIComponent(nextMessage.threadId)) && path.includes(`accountId=${encodeURIComponent(nextMessage.accountId)}`))).toBe(true);
      expect(browserWindow.document.querySelector("#reader-title")?.textContent).toBe(nextMessage.subject);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("labels a direct and reloaded production Focus reader from its synchronized destination", async () => {
    const originalFetch = globalThis.fetch;
    const message = inboxFixture[0]!;
    browserWindow.history.replaceState({}, "", `/dev/inbox?destination=focus&thread=${encodeURIComponent(message.threadId)}&accountId=${encodeURIComponent(message.accountId)}`);
    globalThis.fetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])));
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      await expectReaderOrigin("Focus");

      await act(async () => root!.unmount());
      root = null;
      globalThis.fetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])));
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      await expectReaderOrigin("Focus");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("labels a deferred production custom-space reader after load, Forward, and reload", async () => {
    const originalFetch = globalThis.fetch;
    const message = inboxFixture[0]!;
    const collection: Collection = {
      id: "collection_deferred_reader",
      accountId: accountFixture.id,
      name: "Launch review",
      color: "#70867d",
      position: 0,
      threadIds: [message.threadId],
      createdAt: "2026-06-28T17:30:00.000Z",
      updatedAt: "2026-06-28T17:30:00.000Z",
    };
    let resolveCollections!: (response: Response) => void;
    const collectionsResponse = new Promise<Response>((resolve) => { resolveCollections = resolve; });
    browserWindow.history.replaceState({}, "", `/dev/inbox?destination=space%3A${collection.id}&thread=${encodeURIComponent(message.threadId)}&accountId=${encodeURIComponent(message.accountId)}`);
    globalThis.fetch = createProductionInboxFetch(collectionsResponse);
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      await act(async () => {
        resolveCollections(jsonResponse([collection]));
        await Promise.resolve();
        await Promise.resolve();
      });
      await expectReaderOrigin("Launch review");

      await act(async () => {
        browserWindow.history.back();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        browserWindow.history.forward();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await expectReaderOrigin("Launch review");

      await act(async () => root!.unmount());
      root = null;
      globalThis.fetch = createProductionInboxFetch(Promise.resolve(jsonResponse([collection])));
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      await expectReaderOrigin("Launch review");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps reader and composer in URL order across browser Back and Forward", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=inbox&q=launch&flag=kept#mail");
    await renderApp();
    await openMessage("Luke Brevoort");
    let params = new URL(browserWindow.location.href).searchParams;
    expect(params.get("thread")).toBe("thread_1");
    expect(params.get("accountId")).toBe("acct_demo");
    expect(params.get("q")).toBe("launch");
    expect(params.get("flag")).toBe("kept");

    await act(async () => {
      (browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement).click();
    });
    params = new URL(browserWindow.location.href).searchParams;
    expect(params.get("compose")).toBe("1");
    expect(params.get("thread")).toBe("thread_1");

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).toBeNull();
    expect(new URL(browserWindow.location.href).searchParams.get("thread")).toBeNull();

    await act(async () => {
      browserWindow.history.forward();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(new URL(browserWindow.location.href).searchParams.get("thread")).toBe("thread_1");
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
  });

  test("returns from a reader to the same shared custom-space destination", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=inbox&q=launch&flag=kept");
    await renderApp();
    const custom = [...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
      .find((button) => button.textContent?.includes("Orca launch")) as unknown as HTMLButtonElement;
    await act(async () => custom.click());
    const customDestination = new URL(browserWindow.location.href).searchParams.get("destination");
    expect(customDestination).toBe("space:collection_demo_work");

    const filteredResult = browserWindow.document.querySelector("button.message-row") as unknown as HTMLButtonElement;
    expect(filteredResult.textContent).toContain("Launch notes for Orca Mail");
    await act(async () => filteredResult.click());
    let params = new URL(browserWindow.location.href).searchParams;
    expect(params.get("destination")).toBe(customDestination);
    expect(params.get("q")).toBe("launch");
    expect(params.get("flag")).toBe("kept");
    expect(params.get("thread")).toBe("thread_1");

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    params = new URL(browserWindow.location.href).searchParams;
    expect(params.get("thread")).toBeNull();
    expect(params.get("destination")).toBe(customDestination);
    expect(custom.getAttribute("aria-current")).toBe("page");
  });

  test("cancels an animated Compose close when browser Back already revealed the reader", async () => {
    await renderApp();
    await openMessage("Luke Brevoort");
    await act(async () => {
      (browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement).click();
    });
    const close = browserWindow.document.querySelector('button[aria-label="Close panel"]') as unknown as HTMLButtonElement;
    await act(async () => close.click());
    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).not.toBeNull();

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(700);

    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(new URL(browserWindow.location.href).searchParams.get("thread")).toBe("thread_1");
  });

  test("reloads an initial deep link once and gives it a safe in-app Back target", async () => {
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=focus&q=notes&thread=thread_1&accountId=acct_demo&flag=kept");
    await renderApp();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();

    await act(async () => {
      root!.unmount();
    });
    root = null;
    await renderApp();
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const params = new URL(browserWindow.location.href).searchParams;
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).toBeNull();
    expect(params.get("thread")).toBeNull();
    expect(params.get("destination")).toBe("focus");
    expect(params.get("q")).toBe("notes");
    expect(params.get("flag")).toBe("kept");
  });

  test("reconciles a bfcache pageshow with the current surface URL", async () => {
    await renderApp();
    browserWindow.history.replaceState(browserWindow.history.state, "", "/dev/inbox?destination=focus&thread=thread_1&accountId=acct_demo");
    const pageShow = new browserWindow.Event("pageshow") as unknown as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", { configurable: true, value: true });
    await act(async () => {
      browserWindow.dispatchEvent(pageShow as never);
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(browserWindow.document.querySelector("#reader-title")?.textContent).toContain("Launch notes for Orca Mail");
  });

  test("observes and scrolls the desktop workspace for reader jump-to-top", async () => {
    await renderApp();
    await openMessage("Luke Brevoort");
    const workspace = desktopWorkspace();
    Object.defineProperty(workspace, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(workspace, "scrollTo", {
      configurable: true,
      value: (options: ScrollToOptions) => { workspace.scrollTop = options.top ?? workspace.scrollTop; },
    });
    workspace.scrollTop = 420;
    await act(async () => {
      workspace.dispatchEvent(new browserWindow.Event("scroll") as unknown as Event);
    });
    const jump = browserWindow.document.querySelector("button.reader-jump-top") as unknown as HTMLButtonElement;
    expect(jump.hidden).toBe(false);
    await act(async () => jump.click());
    expect(workspace.scrollTop).toBe(0);
  });

  test("restores the desktop workspace and origin focus after Escape", async () => {
    await renderApp();
    const workspace = desktopWorkspace();
    const origin = messageRow("Jordan Bell");
    const focusCalls = trackFocus(origin);
    workspace.scrollLeft = 13;
    workspace.scrollTop = 143;

    await openMessage("Jordan Bell");
    expect(workspace.scrollTop).toBe(0);
    workspace.scrollLeft = 4;
    workspace.scrollTop = 8;
    await escapeReader();

    expect(workspace.scrollLeft).toBe(13);
    expect(workspace.scrollTop).toBe(143);
    expect(scrollPosition).toEqual({ x: 0, y: 0 });
    expect(new URL(browserWindow.location.href).searchParams.get("thread")).toBeNull();
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
  });

  test("restores the selected row and workspace offsets after Inbox Back", async () => {
    await renderApp();
    const workspace = desktopWorkspace();
    const origin = messageRow("Luke Brevoort");
    const focusCalls = trackFocus(origin);
    workspace.scrollLeft = 17;
    workspace.scrollTop = 319;

    await openMessage("Luke Brevoort");
    workspace.scrollLeft = 0;
    workspace.scrollTop = 0;
    await goBackToInbox();

    expect(workspace.scrollLeft).toBe(17);
    expect(workspace.scrollTop).toBe(319);
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
  });

  test("re-arms the list return point when Forward reopens a reader", async () => {
    await renderApp({ ...defaultReaderPreferences, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    const workspace = desktopWorkspace();
    const origin = messageRow("Luke Brevoort");
    const focusCalls = trackFocus(origin);
    workspace.scrollLeft = 17;
    workspace.scrollTop = 319;

    await openMessage("Luke Brevoort");
    await goBackToInbox();
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });
    expect(workspace.scrollLeft).toBe(17);
    expect(workspace.scrollTop).toBe(319);
    const firstRestoreCount = focusCalls.length;

    await act(async () => {
      browserWindow.history.forward();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(workspace.scrollLeft).toBe(0);
    expect(workspace.scrollTop).toBe(0);

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });
    expect(workspace.scrollLeft).toBe(17);
    expect(workspace.scrollTop).toBe(319);
    expect(focusCalls).toHaveLength(firstRestoreCount + 1);
    expect(isSameNode(browserWindow.document.activeElement, origin)).toBe(true);

    const secondRestoreCount = focusCalls.length;
    const composeTrigger = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement;
    composeTrigger.focus();
    await act(async () => composeTrigger.click());
    await act(async () => {
      (browserWindow.document.querySelector('button[aria-label="Close panel"]') as unknown as HTMLButtonElement).click();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });
    expect(Boolean(browserWindow.document.querySelector('[aria-label="Compose message"]'))).toBe(false);
    expect(focusCalls).toHaveLength(secondRestoreCount);
    expect(isSameNode(browserWindow.document.activeElement, composeTrigger)).toBe(true);
  });

  test("restores a reader row once without stealing focus after a fresh Compose closes", async () => {
    await renderApp({ ...defaultReaderPreferences, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    const origin = messageRow("Luke Brevoort");
    const rowFocusCalls = trackFocus(origin);

    await openMessage("Luke Brevoort");
    await goBackToInbox();
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect((browserWindow.history.state as { __orcaSurfaceHistoryV1?: { returnContext?: unknown } }).__orcaSurfaceHistoryV1?.returnContext).toBeNull();
    const readerRestoreCount = rowFocusCalls.length;

    const composeTrigger = browserWindow.document.querySelector("button.desktop-compose") as unknown as HTMLButtonElement;
    composeTrigger.focus();
    await act(async () => composeTrigger.click());
    await escapeReader();
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });

    expect(browserWindow.document.querySelector('[aria-label="Compose message"]')).toBeNull();
    expect(rowFocusCalls).toHaveLength(readerRestoreCount);
    expect(isSameNode(browserWindow.document.activeElement, composeTrigger)).toBe(true);
  });

  test("opens a propagated event source and returns to the same signal position", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement).click();
    });
    const workspace = desktopWorkspace();
    const card = [...browserWindow.document.querySelectorAll("article.agent-event")].find((item) => item.textContent?.includes("Orca 2.4 is ready in TestFlight"));
    const origin = card?.querySelector("button") as unknown as HTMLButtonElement | null;
    if (!origin) throw new Error("Could not find the propagated event source action");
    const focusCalls = trackFocus(origin);
    workspace.scrollLeft = 3;
    workspace.scrollTop = 188;

    await act(async () => {
      origin.click();
      await Promise.resolve();
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(browserWindow.document.querySelector("#reader-title")?.textContent).toContain("Orca 2.4 is ready to test");

    workspace.scrollLeft = 0;
    workspace.scrollTop = 0;
    await goBackToInbox();

    expect(workspace.scrollLeft).toBe(3);
    expect(workspace.scrollTop).toBe(188);
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
    const firstRestoreCount = focusCalls.length;

    await act(async () => {
      browserWindow.history.forward();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(workspace.scrollLeft).toBe(0);
    expect(workspace.scrollTop).toBe(0);

    await act(async () => {
      browserWindow.history.back();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
    });
    expect(workspace.scrollLeft).toBe(3);
    expect(workspace.scrollTop).toBe(188);
    expect(focusCalls).toHaveLength(firstRestoreCount + 1);
    expect(isSameNode(browserWindow.document.activeElement, origin)).toBe(true);
    expect(browserWindow.localStorage.getItem("orca-demo-agent-event-lifecycles-v1")).toContain('"state":"seen"');
  });

  test("keeps a connected propagated-event origin through Back, Forward, and Back", async () => {
    const originalFetch = globalThis.fetch;
    const message: InboxMessage = { ...inboxFixture[0]!, attentionBehavior: "notify" };
    const template = demoAgentEvents[1]!;
    const event: PropagatedAgentEvent = {
      ...template,
      id: "event_production_collision",
      source: {
        ...template.source,
        accountId: message.accountId,
        provider: message.provider,
        messageId: message.id,
        providerMessageId: message.providerMessageId,
        threadId: message.threadId,
        sender: message.from,
        subject: message.subject,
        receivedAt: message.receivedAt,
        sourceUrl: `http://localhost:5173/dev/inbox?thread=${encodeURIComponent(message.threadId)}&accountId=${encodeURIComponent(message.accountId)}`,
      },
    };
    browserWindow.history.replaceState({}, "", "/dev/inbox?destination=signals");
    globalThis.fetch = createProductionInboxFetch(Promise.resolve(jsonResponse([])), undefined, { messages: [message], agentEvents: [event] });
    try {
      await renderApp(defaultReaderPreferences, false, { demoMode: false, theme: "light" });
      for (let index = 0; index < 20 && (!browserWindow.document.querySelector("article.agent-event")
        || ![...browserWindow.document.querySelectorAll("button.message-row")].some((candidate) => candidate.textContent?.includes(message.from.name!))); index += 1) await waitFor(0);
      const card = [...browserWindow.document.querySelectorAll("article.agent-event")].find((item) => item.textContent?.includes(event.title));
      const origin = card?.querySelector("button") as unknown as HTMLButtonElement | null;
      if (!origin) throw new Error("Could not find the production propagated-event source action");
      const row = messageRow(message.from.name!);
      const eventFocusCalls = trackFocus(origin);
      const rowFocusCalls = trackFocus(row);
      const workspace = desktopWorkspace();
      workspace.scrollLeft = 5;
      workspace.scrollTop = 244;

      origin.focus();
      await act(async () => origin.click());
      expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
      await goBackToInbox();
      await act(async () => {
        for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
      });
      expect(isSameNode(browserWindow.document.activeElement, origin)).toBe(true);
      const firstEventRestoreCount = eventFocusCalls.length;

      await act(async () => {
        browserWindow.history.forward();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(workspace.scrollLeft).toBe(0);
      expect(workspace.scrollTop).toBe(0);
      await act(async () => {
        browserWindow.history.back();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        for (let index = 0; index < 5 && frameCallbacks.size > 0; index += 1) flushAnimationFrames();
      });
      expect(workspace.scrollLeft).toBe(5);
      expect(workspace.scrollTop).toBe(244);
      expect(eventFocusCalls).toHaveLength(firstEventRestoreCount + 1);
      expect(rowFocusCalls).toHaveLength(0);
      expect(isSameNode(browserWindow.document.activeElement, origin)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reveals and restores a quieted local signal without changing its source mail", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement).click();
    });
    const review = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Review quieted")) as unknown as HTMLButtonElement;
    await act(async () => review.click());
    const quieted = [...browserWindow.document.querySelectorAll("article.agent-event")].find((item) => item.textContent?.includes("Figma renews September 3"));
    expect(quieted?.textContent).toContain("Dismissed");
    const restore = [...(quieted?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Restore") as unknown as HTMLButtonElement;
    await act(async () => {
      restore.click();
      await Promise.resolve();
    });
    expect(quieted?.textContent).toContain("Seen");
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("All Mail")) as unknown as HTMLButtonElement).click();
    });
    expect(messageRow("Figma Billing")).not.toBeNull();
  });

  test("keeps broad mutes explicitly reversible before restoring the event", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('nav[aria-label="Primary navigation"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement).click();
    });
    const review = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Review quieted")) as unknown as HTMLButtonElement;
    await act(async () => review.click());
    const muted = [...browserWindow.document.querySelectorAll("article.agent-event")].find((item) => item.textContent?.includes("Routine Cloud sign-in notice"));
    if (!muted) throw new Error("Could not find the muted signal fixture");
    const restore = [...muted.querySelectorAll("button")].find((button) => button.textContent === "Restore event") as unknown as HTMLButtonElement;
    const unmute = [...muted.querySelectorAll("button")].find((button) => button.textContent?.includes("Unmute alerts@routinecloud.example")) as unknown as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    await act(async () => {
      unmute.click();
      await Promise.resolve();
    });
    expect(restore.disabled).toBe(false);
    await act(async () => {
      restore.click();
      await Promise.resolve();
    });
    expect(muted.textContent).toContain("Seen");
    expect(browserWindow.localStorage.getItem("orca-demo-agent-event-mutes-v1")).toBe("[]");
  });

  test("cancels an old focus frame when a new reader opens before it runs", async () => {
    await renderApp();
    const first = messageRow("Jordan Bell");
    const second = messageRow("Luke Brevoort");
    setScroll({ x: 0, y: 55 });

    await openMessage("Jordan Bell");
    setScroll({ x: 0, y: 0 });
    await escapeReader();
    expect(frameCallbacks.size).toBeGreaterThan(0);

    await openMessage("Luke Brevoort");
    await act(async () => flushAnimationFrames());

    expect(cancelledFrameIds.length).toBeGreaterThan(0);
    expect(browserWindow.document.activeElement).not.toBe(first);
    expect(browserWindow.document.activeElement).not.toBe(second);
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
  });

  test("refreshes the rail avatar when a changed photo returns from settings", async () => {
    await renderApp();
    const avatar = browserWindow.document.querySelector(".desktop-account-avatar img");
    expect(avatar?.getAttribute("src")).toBe(PROFILE_PHOTO_FALLBACK_SRC);

    const changedPhoto = "data:image/png;base64,ZmFrZS1wcm9maWxl";
    expect(writeStoredProfilePhoto({ id: "acct_demo" }, changedPhoto, browserWindow.localStorage)).toBe(true);
    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    });

    expect(avatar?.getAttribute("src")).toBe(changedPhoto);

    const secondPhoto = "data:image/png;base64,ZmFrZS1zZWNvbmQ=";
    expect(writeStoredProfilePhoto({ id: "acct_demo" }, secondPhoto, browserWindow.localStorage)).toBe(true);
    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.CustomEvent(PROFILE_PHOTO_CHANGED_EVENT, { detail: { accountId: "acct_demo" } }));
    });
    expect(avatar?.getAttribute("src")).toBe(secondPhoto);
  });
});

describe("Zen exit presence", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    restoreDom();
  });

  test("keeps the canvas mounted with its exit state until Save & close finishes", async () => {
    await renderApp();
    const canvas = await openZen();
    const saveAndClose = canvas.querySelector("button.zen-back") as unknown as HTMLButtonElement | null;
    if (!saveAndClose) throw new Error("Could not find Save & close control");

    await act(async () => {
      saveAndClose.click();
    });

    const closingCanvas = browserWindow.document.querySelector(".zen-canvas");
    expect(closingCanvas).not.toBeNull();
    expect(closingCanvas?.classList.contains("zen-canvas-closing")).toBe(true);

    await waitFor(550);

    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
    const panel = browserWindow.document.querySelector("aside[aria-label=\"Compose message\"]");
    expect(panel?.getAttribute("aria-hidden")).toBeNull();
    expect(panel?.hasAttribute("inert")).toBe(false);
  });

  test("uses the same closing lifecycle for Escape", async () => {
    await renderApp();
    const canvas = await openZen();

    await act(async () => {
      canvas.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });

    expect(browserWindow.document.querySelector(".zen-canvas")?.classList.contains("zen-canvas-closing")).toBe(true);
    await waitFor(550);
    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).not.toBeNull();
  });

  test("returns straight to the inbox on Escape when Zen is the default", async () => {
    await renderApp({ ...defaultReaderPreferences, composeZenByDefault: true, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    const canvas = browserWindow.document.querySelector(".zen-canvas") as unknown as HTMLElement | null;
    if (!canvas) throw new Error("Could not find Zen canvas");

    await act(async () => {
      canvas.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });

    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).toBeNull();
  });

  test("keeps Save & close returning to the panel when Zen is the default", async () => {
    await renderApp({ ...defaultReaderPreferences, composeZenByDefault: true, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    const canvas = browserWindow.document.querySelector(".zen-canvas") as unknown as HTMLElement | null;
    if (!canvas) throw new Error("Could not find Zen canvas");
    const saveAndClose = canvas.querySelector("button.zen-back") as unknown as HTMLButtonElement | null;
    if (!saveAndClose) throw new Error("Could not find Save & close control");

    await act(async () => {
      saveAndClose.click();
    });

    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).not.toBeNull();
  });

  test("returns immediately for reduced motion without delaying panel controls", async () => {
    await renderApp({ ...defaultReaderPreferences, motion: "reduced" });
    browserWindow.document.documentElement.dataset.motion = "reduced";
    const canvas = await openZen();
    const saveAndClose = canvas.querySelector("button.zen-back") as unknown as HTMLButtonElement | null;
    if (!saveAndClose) throw new Error("Could not find Save & close control");

    await act(async () => {
      saveAndClose.click();
    });

    expect(browserWindow.document.querySelector(".zen-canvas")).toBeNull();
    const panelAfterZenExit = browserWindow.document.querySelector("aside[aria-label=\"Compose message\"]");
    expect(panelAfterZenExit?.getAttribute("aria-hidden")).toBeNull();

    const closePanelButton = browserWindow.document.querySelector("button[aria-label=\"Close panel\"]") as unknown as HTMLButtonElement | null;
    if (!closePanelButton) throw new Error("Could not find panel close control");
    await act(async () => {
      closePanelButton.click();
    });
    expect(browserWindow.document.querySelector("aside[aria-label=\"Compose message\"]")).toBeNull();
  });
});
