import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { WorkspaceHeader } from "./desktop-switch";
import { TopLayerProvider } from "./top-layer";

const styles = await Bun.file(new URL("./mobile-mail.css", import.meta.url)).text();
const baseStyles = (await Promise.all(["styles.css", "desktop-switch.css", "mail-selection.css"].map(file => Bun.file(new URL(file, import.meta.url)).text()))).join("\n");
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
  test("keeps the safe browser viewport for routes without edge-to-edge insets", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
    expect(html).not.toContain("viewport-fit=cover");
  });

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

  test("full cascade keeps normal and compact Inbox spacing and long-snippet clamps", () => {
    for (const density of ["calm", "compact"]) {
      const phone = new Window({ width: 390, height: 844 });
      phone.document.documentElement.dataset.readerDensity = density;
      const sheet = phone.document.createElement("style");
      sheet.textContent = baseStyles + styles;
      phone.document.head.append(sheet);
      phone.document.body.innerHTML = '<main class="desktop-shell mobile-mail-shell"><header class="desktop-workspace-header"></header><div class="inbox-view inbox-view-inbox"><div class="message-row-wrap"><button class="message-row"><div class="message-copy"><p>A long snippet</p></div></button><button class="keep-thread-button"></button></div></div></main>';
      const row = phone.getComputedStyle(phone.document.querySelector('.message-row')!);
      const snippet = phone.getComputedStyle(phone.document.querySelector('.message-copy > p')!);
      expect(row.paddingTop).toBe("16px");
      expect(row.paddingRight).toBe("20px");
      expect(row.paddingBottom).toBe("58px");
      // Happy DOM drops vendor display values; assert the authored clamp here,
      // and verify its actual two-line geometry in browser review.
      expect(styles).toContain(':root .desktop-shell.mobile-mail-shell .inbox-view-inbox .message-copy > p { display: -webkit-box;');
      expect(snippet.getPropertyValue("-webkit-line-clamp")).toBe("2");
      expect(phone.getComputedStyle(phone.document.querySelector('.keep-thread-button')!).right).toBe("16px");
      expect(phone.getComputedStyle(phone.document.querySelector('.desktop-workspace-header')!).position).toBe("sticky");
      phone.close();
    }
  });

  test("small viewports keep the delivery controls in scroll flow with safe-area support", () => {
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("@media (max-width: 760px) and (max-height: 500px)");
    expect(styles).toContain(".mobile-compose-panel .compose-delivery-bar { position: static; }");
    expect(styles).toContain(".zen-canvas .compose-workspace-zen > .compose-delivery-bar { position: static;");
  });
});
