import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { runInNewContext } from "node:vm";
import { installNativeFindInputGuard } from "./native-find-input-guard.mjs";

type Guard = { snapshot: () => { blockedKeys: number; blockedInputs: number }; reset: () => void; dispose: () => void };
const browser = new Window();
const guard = () => (browser as unknown as { __orcaNativeFindInputGuard?: Guard }).__orcaNativeFindInputGuard!;
afterEach(() => guard()?.dispose());
afterAll(() => browser.close());

describe("native Find input boundary", () => {
  test("is self-contained when serialized into the page", () => {
    runInNewContext(`(${installNativeFindInputGuard.toString()})()`, { window: browser });
    expect(guard().snapshot()).toEqual({ blockedKeys: 0, blockedInputs: 0 });
    expect(() => installNativeFindInputGuard(browser)).toThrow("already installed");
  });
  test("blocks misdirected query shortcuts and Escape without calling app handlers", () => {
    installNativeFindInputGuard(browser);
    let appKeys = 0;
    const listener = () => appKeys++;
    browser.addEventListener("keydown", listener);
    for (const key of ["f", "r", " ", "3", "Escape", "a"]) {
      const event = new browser.KeyboardEvent("keydown", { key, ctrlKey: key === "a", bubbles: true, cancelable: true });
      browser.document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(appKeys).toBe(0);
    expect(guard().snapshot().blockedKeys).toBe(6);
    browser.removeEventListener("keydown", listener);
  });
  test("leaves browser Find accelerators and modifier keys unhandled", () => {
    installNativeFindInputGuard(browser);
    for (const init of [{ key: "f", ctrlKey: true }, { key: "F", metaKey: true }, { key: "Control" }, { key: "Shift" }]) {
      const event = new browser.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      browser.document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(guard().snapshot().blockedKeys).toBe(0);
  });
  test("blocks beforeinput, resets attempt diagnostics and restores ordinary input after disposal", () => {
    installNativeFindInputGuard(browser);
    const input = new browser.InputEvent("beforeinput", { data: "synthetic", inputType: "insertText", bubbles: true, cancelable: true });
    browser.document.body.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
    expect(guard().snapshot().blockedInputs).toBe(1);
    guard().reset();
    expect(guard().snapshot()).toEqual({ blockedKeys: 0, blockedInputs: 0 });
    guard().dispose();
    const key = new browser.KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true });
    browser.document.body.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  });
});
