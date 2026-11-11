import { afterEach, expect, test } from "bun:test";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useSettingsNavigationGuard } from "./settings-navigation-guard";
import { requestViewNavigation } from "./view-navigation-guard";

const names = ["window", "document", "HTMLElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT"];
const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
let cleanup = () => {};
afterEach(async () => {
  await act(async () => cleanup());
  names.forEach((name, i) => { const value = originals[i]; if (value) Object.defineProperty(globalThis, name, value); else Reflect.deleteProperty(globalThis, name); });
});

test("Settings keeps edits on Stay, ignores section links, blocks unload and releases an explicit leave once", async () => {
  const browser = new Window({ url: "http://localhost/dev/settings" });
  const values = [browser, browser.document, browser.HTMLElement, browser.Element, browser.Node, true];
  names.forEach((name, i) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[i] }));
  const host = browser.document.createElement("div"); browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement); cleanup = () => root.unmount();
  let guard!: ReturnType<typeof useSettingsNavigationGuard>;
  function Editor({ dirty }: { dirty: boolean }) {
    const ref = useRef<HTMLElement>(null);
    guard = useSettingsNavigationGuard(dirty, ref, () => {});
    return <main ref={ref}><textarea defaultValue="Unsaved signature" /><a href="#writing">Writing</a></main>;
  }
  await act(async () => root.render(<Editor dirty />));
  let leaves = 0;
  await act(async () => requestViewNavigation(() => { leaves++; }));
  expect(guard.asking).toBe(true); expect(leaves).toBe(0);
  await act(async () => guard.keep());
  expect(host.querySelector("textarea")?.value).toBe("Unsaved signature");
  const sectionClick = new browser.MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => host.querySelector("a")!.dispatchEvent(sectionClick));
  expect(sectionClick.defaultPrevented).toBe(false); expect(guard.asking).toBe(false);
  const unload = new browser.Event("beforeunload", { cancelable: true }); browser.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => requestViewNavigation(() => { leaves++; }));
  await act(async () => guard.discard());
  expect(leaves).toBe(1);
  const releasedUnload = new browser.Event("beforeunload", { cancelable: true }); browser.dispatchEvent(releasedUnload);
  expect(releasedUnload.defaultPrevented).toBe(false);
  await act(async () => root.render(<Editor dirty={false} />));
  await act(async () => requestViewNavigation(() => { leaves++; }));
  expect(leaves).toBe(2); expect(guard.asking).toBe(false);
});
