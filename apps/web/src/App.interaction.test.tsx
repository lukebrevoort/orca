import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { InboxApp, PROFILE_PHOTO_CHANGED_EVENT, PROFILE_PHOTO_FALLBACK_SRC, defaultReaderPreferences, type ReaderPreferences, writeStoredProfilePhoto } from "./App";
import { useComposeDraft } from "./compose-workspace";
import type { MessageDraft } from "@orca/shared";

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

async function renderApp(preferences: ReaderPreferences = defaultReaderPreferences, strict = false) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  const app = <InboxApp demoMode preferences={preferences} theme="light" setTheme={() => {}} />;
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

async function openMessage(sender: string) {
  await act(async () => {
    messageRow(sender).click();
  });
  expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
}

async function escapeReader() {
  await act(async () => {
    browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

async function goBackToInbox() {
  const back = browserWindow.document.querySelector('[aria-label="Reader controls"] button') as unknown as HTMLButtonElement | null;
  if (!back) throw new Error("Could not find reader back control");
  await act(async () => {
    back.click();
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
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
}

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
    expect(browserWindow.document.activeElement?.getAttribute("role")).toBe("dialog");
    expect(browserWindow.document.querySelector("main.desktop-shell")?.hasAttribute("inert")).toBe(true);
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
    expect(dialog.parentElement?.parentElement?.tagName).toBe("BODY");
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

  test("persists hidden workspace visibility across a reload", async () => {
    await renderApp();
    const manage = [...browserWindow.document.querySelectorAll("button")].find((button) => button.textContent?.trim().toLowerCase() === "manage") as unknown as HTMLButtonElement;
    await act(async () => { manage.click(); });
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-labelledby="manage-spaces-title"]') as unknown as HTMLElement;
    const signalsRow = [...dialog.querySelectorAll("article")].find((row) => row.textContent?.includes("Signals"))!;
    const hide = [...signalsRow.querySelectorAll("button")].find((button) => button.textContent === "Hide") as unknown as HTMLButtonElement;
    await act(async () => { hide.click(); });
    expect([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Signals"))).toBe(false);

    await act(async () => { root!.unmount(); });
    root = null;
    await renderApp();
    expect([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')].some((button) => button.textContent?.includes("Signals"))).toBe(false);
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

    const draftsButton = [...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
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
    const primary = browserWindow.document.querySelector('aside[aria-label="Primary"]');
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

    const signals = [...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
      .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement;
    await act(async () => { signals.click(); });

    expect(signals.getAttribute("aria-current")).toBe("page");
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Signals");
    expect(buttonByName("Open Maya Chen pin").getAttribute("aria-pressed")).toBe("false");
  });

  test("opens a pinned thread from outside its current signal view", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
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
    const search = browserWindow.document.querySelector('input[aria-label="Search mail, people, or rules"]') as unknown as HTMLInputElement;
    expect(search.value).toBe("moonbase ledger");
    const save = [...browserWindow.document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Save this search")) as HTMLButtonElement | undefined;
    expect(save).toBeDefined();
    await act(async () => { save!.click(); });
    expect((browserWindow.document.querySelector(".pin-builder-search input") as unknown as HTMLInputElement).value).toBe("moonbase ledger");
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

  test("restores the window viewport and origin focus after Escape", async () => {
    await renderApp();
    const pane = inboxPane();
    const origin = messageRow("Jordan Bell");
    const focusCalls = trackFocus(origin);
    setScroll({ x: 13, y: 143 });
    pane.scrollLeft = 0;
    pane.scrollTop = 0;

    await openMessage("Jordan Bell");
    setScroll({ x: 0, y: 0 });
    pane.scrollLeft = 4;
    pane.scrollTop = 8;
    await escapeReader();

    expect(scrollPosition).toEqual({ x: 13, y: 143 });
    expect(pane.scrollLeft).toBe(0);
    expect(pane.scrollTop).toBe(0);
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
  });

  test("restores nested content-pane offsets and focus after Inbox Back", async () => {
    await renderApp();
    const pane = inboxPane();
    const origin = messageRow("Luke Brevoort");
    const focusCalls = trackFocus(origin);
    setScroll({ x: 21, y: 88 });
    pane.scrollLeft = 17;
    pane.scrollTop = 319;

    await openMessage("Luke Brevoort");
    setScroll({ x: 0, y: 0 });
    pane.scrollLeft = 0;
    pane.scrollTop = 0;
    await goBackToInbox();

    expect(scrollPosition).toEqual({ x: 21, y: 88 });
    expect(pane.scrollLeft).toBe(17);
    expect(pane.scrollTop).toBe(319);
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
  });

  test("opens a propagated event source and returns to the same signal position", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("Signals")) as unknown as HTMLButtonElement).click();
    });
    const pane = inboxPane();
    const card = [...browserWindow.document.querySelectorAll("article.agent-event")].find((item) => item.textContent?.includes("Orca 2.4 is ready in TestFlight"));
    const origin = card?.querySelector("button") as unknown as HTMLButtonElement | null;
    if (!origin) throw new Error("Could not find the propagated event source action");
    const focusCalls = trackFocus(origin);
    setScroll({ x: 9, y: 264 });
    pane.scrollLeft = 3;
    pane.scrollTop = 188;

    await act(async () => {
      origin.click();
      await Promise.resolve();
    });
    expect(browserWindow.document.querySelector('[aria-label="Message reader"]')).not.toBeNull();
    expect(browserWindow.document.querySelector("#reader-title")?.textContent).toContain("Orca 2.4 is ready to test");

    setScroll({ x: 0, y: 0 });
    pane.scrollLeft = 0;
    pane.scrollTop = 0;
    await goBackToInbox();

    expect(scrollPosition).toEqual({ x: 9, y: 264 });
    expect(pane.scrollLeft).toBe(3);
    expect(pane.scrollTop).toBe(188);
    await act(async () => flushAnimationFrames());
    expect(browserWindow.document.activeElement as unknown as HTMLElement).toBe(origin);
    expect(focusCalls.some((options) => options?.preventScroll === true)).toBe(true);
    expect(browserWindow.localStorage.getItem("orca-demo-agent-event-lifecycles-v1")).toContain('"state":"seen"');
  });

  test("reveals and restores a quieted local signal without changing its source mail", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
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
      ([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
        .find((button) => button.textContent?.includes("All Mail")) as unknown as HTMLButtonElement).click();
    });
    expect(messageRow("Figma Billing")).not.toBeNull();
  });

  test("keeps broad mutes explicitly reversible before restoring the event", async () => {
    await renderApp();
    await act(async () => {
      ([...browserWindow.document.querySelectorAll('aside[aria-label="Primary"] button.desktop-sidebar-item')]
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
