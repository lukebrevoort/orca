import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { WorkspaceHeader } from "./desktop-switch";
import { TopLayerProvider } from "./top-layer";

const styles = await Bun.file(new URL("./mobile-mail.css", import.meta.url)).text();
const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: Window;
let root: Root | undefined;
beforeEach(() => {
  browser = new Window({ url: "http://localhost/dev/inbox", width: 390, height: 844 });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name as keyof Window] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  for (const name of names) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  await browser.close();
});

describe("native-inspired mobile mail", () => {
  test("new compose entry passes the real trigger for focus restoration and stays repeatable", async () => {
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    root = createRoot(container as unknown as HTMLElement);
    const triggers: HTMLButtonElement[] = [];
    await act(async () => root!.render(<TopLayerProvider><WorkspaceHeader health="synced" query="" title="Inbox" theme="light" onThemeChange={() => {}} onCompose={button => triggers.push(button)} /></TopLayerProvider>));
    const button = container.querySelector('button[aria-label="Compose"]')! as unknown as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => { button.click(); button.click(); });
    expect(triggers).toEqual([button, button]);
    expect(container.querySelector('[aria-label="Search mail"]')).not.toBeNull();
  });

  test("desktop header is visually unchanged and phone controls have bounded sizing", () => {
    const sheet = browser.document.createElement("style");
    sheet.textContent = styles;
    browser.document.head.append(sheet);
    browser.document.body.innerHTML = '<main class="mobile-mail-shell"><div class="mobile-mail-header"><button class="mobile-mail-compose">Compose</button></div><nav class="desktop-mobile-navigation"><button class="desktop-mobile-compose">Compose</button></nav></main><section class="mobile-compose-panel"><div class="compose-delivery-bar"></div><input class="compose-writing-area" /></section>';
    const header = browser.document.querySelector('.mobile-mail-header')!;
    const compose = browser.document.querySelector('.mobile-mail-compose')!;
    expect(browser.getComputedStyle(header).display).toBe("grid");
    expect(browser.getComputedStyle(compose).height).toBe("44px");
    expect(browser.getComputedStyle(browser.document.querySelector('.desktop-mobile-compose')!).display).toBe("none");
    const desktop = new Window({ width: 1440, height: 900 });
    const desktopSheet = desktop.document.createElement("style");
    desktopSheet.textContent = styles;
    desktop.document.head.append(desktopSheet);
    desktop.document.body.innerHTML = browser.document.body.innerHTML;
    expect(desktop.getComputedStyle(desktop.document.querySelector('.mobile-mail-header')!).display).toBe("none");
    expect(desktop.getComputedStyle(desktop.document.querySelector('.mobile-mail-compose')!).height).not.toBe("44px");
    desktop.close();
  });

  test("small viewports keep the delivery controls in scroll flow with safe-area support", () => {
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("@media (max-width: 760px) and (max-height: 500px)");
    expect(styles).toContain(".mobile-compose-panel .compose-delivery-bar { position: static; }");
    expect(styles).toContain(".zen-canvas .compose-workspace-zen > .compose-delivery-bar { position: static;");
  });
});
