import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { VerificationCodeStrip } from "./verification-code-strip";

const globals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"] as const;
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: InstanceType<typeof Window>;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browser.close();
});
async function render(messageId = "one", bodyText = "code: 123456") {
  await act(async () => root.render(<VerificationCodeStrip messageId={messageId} bodyText={bodyText} />));
}
async function click(label: string) {
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click(); });
}
test("copies real code while masked and announces success", async () => {
  let copied = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  await render();
  expect(container.querySelector("code")?.textContent).toBe("••••••");
  await click("Copy");
  expect(copied).toBe("123456");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Code copied.");
  expect(container.querySelector("code")?.textContent).toBe("••••••");
});
test("clipboard rejection reports failure; message switch clears reveal and feedback", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  await render(); await click("Copy");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Could not copy. Reveal the code to copy it manually.");
  await click("Reveal"); expect(container.querySelector("code")?.textContent).toBe("123456");
  await render("two"); expect(container.querySelector("code")?.textContent).toBe("••••••");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
});
test("never renders mail markup and supports empty mail and length matching", async () => {
  await render("markup", '<img onerror="alert(1)"> code: 1234-5678');
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe("••••••••");
  await render("empty", ""); expect(container.textContent).toBe("");
});
