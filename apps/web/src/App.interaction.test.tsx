import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { InboxApp, PROFILE_PHOTO_CHANGED_EVENT, PROFILE_PHOTO_FALLBACK_SRC, defaultReaderPreferences, writeStoredProfilePhoto } from "./App";

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

async function renderApp() {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(<InboxApp demoMode preferences={defaultReaderPreferences} theme="light" setTheme={() => {}} />);
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
    const avatar = browserWindow.document.querySelector(".wave-rail-account img");
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
