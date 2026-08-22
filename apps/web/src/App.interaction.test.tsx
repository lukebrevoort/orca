import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { InboxApp, PROFILE_PHOTO_CHANGED_EVENT, PROFILE_PHOTO_FALLBACK_SRC, defaultReaderPreferences, type ReaderPreferences, writeStoredProfilePhoto } from "./App";

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

async function renderApp(preferences: ReaderPreferences = defaultReaderPreferences) {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(<InboxApp demoMode preferences={preferences} theme="light" setTheme={() => {}} />);
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

async function openZen() {
  const compose = browserWindow.document.querySelector("button.tidal-compose-fab") as unknown as HTMLButtonElement | null;
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

  test("opens writing with Cmd/Ctrl+Shift+M and keeps other keys available", async () => {
    await renderApp();
    const compose = browserWindow.document.querySelector("button.tidal-compose-fab") as unknown as HTMLButtonElement | null;
    expect(compose?.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+M Control+Shift+M");
    expect(compose?.querySelector("kbd")?.textContent).toBe("⌘⇧M");

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).toBeNull();

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", metaKey: true, bubbles: true, cancelable: true }));
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).toBeNull();

    await act(async () => {
      browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { key: "m", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
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
    expect(browserWindow.document.querySelector("main.app-shell")?.hasAttribute("inert")).toBe(true);
    expect(browserWindow.document.querySelector(".app-theme-toggle")?.hasAttribute("inert")).toBe(true);
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

    const libraryButton = browserWindow.document.querySelector('button[aria-label="Open collections and pins menu"]') as unknown as HTMLButtonElement | null;
    expect(libraryButton).not.toBeNull();
    await act(async () => {
      libraryButton!.click();
    });
    const draftsButton = [...browserWindow.document.querySelectorAll("button.mailbox-tab")]
      .find((button) => button.textContent?.includes("Drafts")) as HTMLButtonElement | undefined;
    expect(draftsButton).toBeDefined();

    await act(async () => {
      draftsButton!.click();
    });
    expect(browserWindow.document.querySelector(".draft-row")?.textContent).toContain("A calmer launch note");

    const draftRow = browserWindow.document.querySelector(".draft-row") as unknown as HTMLButtonElement | null;
    expect(draftRow).not.toBeNull();
    await act(async () => {
      draftRow!.click();
    });
    expect(browserWindow.document.querySelector('aside[aria-label="Compose message"]')).not.toBeNull();
    const subject = browserWindow.document.querySelector('input[name="subject"]') as unknown as HTMLInputElement | null;
    expect(subject?.value).toBe("A calmer launch note");
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

  test("keeps a person pin active while moving between signal views", async () => {
    await renderApp();

    await act(async () => {
      buttonByName("Open Maya Chen pin").click();
    });
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Maya Chen");
    expect(buttonByName("Open Maya Chen pin").getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      (browserWindow.document.querySelector("#classification-tab-tideline") as unknown as HTMLButtonElement).click();
    });

    expect(browserWindow.document.querySelector("#classification-tab-tideline")?.getAttribute("aria-selected")).toBe("true");
    expect(browserWindow.document.querySelector(".stream-title-line h1")?.textContent).toBe("Maya Chen");
    expect(buttonByName("Open Maya Chen pin").getAttribute("aria-pressed")).toBe("true");
  });

  test("opens a pinned thread from outside its current signal view", async () => {
    await renderApp();
    await act(async () => {
      (browserWindow.document.querySelector("#classification-tab-tideline") as unknown as HTMLButtonElement).click();
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

  test("saves and restores the signal view with a filter pin", async () => {
    await renderApp();
    await act(async () => {
      (browserWindow.document.querySelector("#classification-tab-tideline") as unknown as HTMLButtonElement).click();
    });
    await act(async () => {
      (browserWindow.document.querySelector("button.pinned-person-add") as unknown as HTMLButtonElement).click();
    });

    const signal = browserWindow.document.querySelectorAll(".pin-builder-fields select")[1] as unknown as HTMLSelectElement;
    expect(signal.value).toBe("tideline");
    await act(async () => {
      (browserWindow.document.querySelector("button.pin-builder-save") as unknown as HTMLButtonElement).click();
    });
    await act(async () => {
      (browserWindow.document.querySelector("#classification-tab-human") as unknown as HTMLButtonElement).click();
    });
    await act(async () => {
      buttonByName("Open Tideline pin").click();
    });

    expect(browserWindow.document.querySelector("#classification-tab-tideline")?.getAttribute("aria-selected")).toBe("true");
    expect(buttonByName("Open Tideline pin").getAttribute("aria-pressed")).toBe("true");
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
      (browserWindow.document.querySelector("#classification-tab-tideline") as unknown as HTMLButtonElement).click();
    });
    expect(messageRow("Figma Billing")).not.toBeNull();
  });

  test("keeps broad mutes explicitly reversible before restoring the event", async () => {
    await renderApp();
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
