import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { TopLayer, TopLayerProvider } from "./top-layer";

const globalNames = [
  "window", "document", "HTMLElement", "Node", "Element", "Event", "KeyboardEvent",
  "MouseEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
] as const;
const originalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");

let browserWindow: InstanceType<typeof Window>;
let root: Root | null;
let container: ReturnType<InstanceType<typeof Window>["document"]["createElement"]>;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function isSameNode(left: unknown, right: unknown) {
  return left === right;
}

function installDom() {
  browserWindow = new Window({ url: "http://localhost:5173/" });
  Object.defineProperties(browserWindow, {
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } },
    cancelAnimationFrame: { configurable: true, value: () => {} },
  });
  const values: Record<string, unknown> = {
    window: browserWindow,
    document: browserWindow.document,
    HTMLElement: browserWindow.HTMLElement,
    Node: browserWindow.Node,
    Element: browserWindow.Element,
    Event: browserWindow.Event,
    KeyboardEvent: browserWindow.KeyboardEvent,
    MouseEvent: browserWindow.MouseEvent,
    MutationObserver: browserWindow.MutationObserver,
    getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
    requestAnimationFrame: browserWindow.requestAnimationFrame.bind(browserWindow),
    cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  };
  for (const [name, value] of Object.entries(values)) setGlobal(name, value);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = browserWindow.document.createElement("div");
  container.id = "root";
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
}

function NestedLayers() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return <TopLayerProvider>
    <button data-testid="outer-opener" onClick={() => setOuter(true)} type="button">Open outer</button>
    {outer ? <TopLayer ariaLabel="Outer layer" onClose={() => setOuter(false)}>
      <button data-testid="first" type="button">First</button>
      <input aria-label="Layer input" />
      <button data-testid="inner-opener" onClick={() => setInner(true)} type="button">Open inner</button>
      <button data-testid="last" type="button">Last</button>
    </TopLayer> : null}
    {inner ? <TopLayer ariaLabel="Inner layer" onClose={() => setInner(false)}>
      <button data-testid="inner-close" onClick={() => setInner(false)} type="button">Close inner</button>
      <button data-testid="close-all" onClick={() => { setInner(false); setOuter(false); }} type="button">Close all</button>
    </TopLayer> : null}
  </TopLayerProvider>;
}

function BusyLayer() {
  const [open, setOpen] = useState(true);
  return <TopLayerProvider>{open ? <TopLayer ariaBusy ariaLabel="Busy layer" backdrop={false} dismissible={false} onClose={() => setOpen(false)}>
    <p>Still working</p>
  </TopLayer> : null}</TopLayerProvider>;
}

async function keydown(key: string, shiftKey = false) {
  await act(async () => {
    browserWindow.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey }));
  });
}

describe("shared top-layer contract", () => {
  beforeEach(installDom);

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    for (const name of globalNames) {
      const descriptor = originalDescriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    if (originalActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
    else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    root = null;
    browserWindow.close();
  });

  test("stacks nested dialogs, traps Tab both ways, and restores each opener", async () => {
    await act(async () => root!.render(<NestedLayers />));
    const outerOpener = browserWindow.document.querySelector('[data-testid="outer-opener"]') as unknown as HTMLButtonElement;
    outerOpener.focus();
    await act(async () => outerOpener.click());

    const outerDialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Outer layer"]') as unknown as HTMLElement;
    expect(outerDialog.getAttribute("aria-modal")).toBe("true");
    expect(container.inert).toBe(true);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    const first = outerDialog.querySelector('[data-testid="first"]') as unknown as HTMLButtonElement;
    const last = outerDialog.querySelector('[data-testid="last"]') as unknown as HTMLButtonElement;
    const layerInput = outerDialog.querySelector('[aria-label="Layer input"]') as unknown as HTMLInputElement;
    let backgroundShortcutCount = 0;
    let inputKeyCount = 0;
    browserWindow.addEventListener("keydown", () => { backgroundShortcutCount += 1; });
    layerInput.addEventListener("keydown", () => { inputKeyCount += 1; });
    first.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "c" }) as unknown as Event);
    first.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "k", metaKey: true }) as unknown as Event);
    expect(backgroundShortcutCount).toBe(0);
    layerInput.dispatchEvent(new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "c" }) as unknown as Event);
    expect(backgroundShortcutCount).toBe(1);
    expect(inputKeyCount).toBe(1);
    last.focus();
    await keydown("Tab");
    expect(isSameNode(browserWindow.document.activeElement, first)).toBe(true);
    await keydown("Tab", true);
    expect(isSameNode(browserWindow.document.activeElement, last)).toBe(true);

    const innerOpener = outerDialog.querySelector('[data-testid="inner-opener"]') as unknown as HTMLButtonElement;
    innerOpener.focus();
    await act(async () => innerOpener.click());
    const layers = [...browserWindow.document.querySelectorAll("[data-top-layer]")] as unknown as HTMLElement[];
    expect(layers.map((layer) => layer.dataset.topLayer)).toEqual(["background", "active"]);
    expect(layers[0]?.inert).toBe(true);
    expect(layers[0]?.getAttribute("aria-hidden")).toBe("true");

    await keydown("Escape");
    expect(browserWindow.document.querySelector('[aria-label="Inner layer"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Outer layer"]')).not.toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, innerOpener)).toBe(true);
    await keydown("Escape");
    expect(browserWindow.document.querySelector('[aria-label="Outer layer"]')).toBeNull();
    expect(isSameNode(browserWindow.document.activeElement, outerOpener)).toBe(true);
    expect(container.inert).toBe(false);
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  test("keeps focus inside a busy layer with no enabled actions and ignores Escape", async () => {
    await act(async () => root!.render(<BusyLayer />));
    const dialog = browserWindow.document.querySelector('[role="dialog"][aria-label="Busy layer"]') as unknown as HTMLElement;
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    await keydown("Tab");
    expect(isSameNode(browserWindow.document.activeElement, dialog)).toBe(true);
    await keydown("Tab", true);
    expect(isSameNode(browserWindow.document.activeElement, dialog)).toBe(true);
    await keydown("Escape");
    expect(isSameNode(browserWindow.document.querySelector('[aria-label="Busy layer"]'), dialog)).toBe(true);
  });

  test("coalesces nested unregister restoration into one frame and restores the external opener", async () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    Object.defineProperties(browserWindow, {
      requestAnimationFrame: {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
          frameId += 1;
          callbacks.set(frameId, callback);
          return frameId;
        },
      },
      cancelAnimationFrame: {
        configurable: true,
        value: (id: number) => { callbacks.delete(id); },
      },
    });

    await act(async () => root!.render(<NestedLayers />));
    const opener = browserWindow.document.querySelector('[data-testid="outer-opener"]') as unknown as HTMLButtonElement;
    opener.focus();
    await act(async () => opener.click());
    const innerOpener = browserWindow.document.querySelector('[data-testid="inner-opener"]') as unknown as HTMLButtonElement;
    await act(async () => innerOpener.click());
    const closeAll = browserWindow.document.querySelector('[data-testid="close-all"]') as unknown as HTMLButtonElement;
    await act(async () => closeAll.click());

    expect(callbacks.size).toBe(1);
    for (const callback of callbacks.values()) callback(0);
    expect(isSameNode(browserWindow.document.activeElement, opener)).toBe(true);
  });
});
