import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { SummaryPage } from "./summary-page";
const globals = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLTextAreaElement", "Event", "MouseEvent", "Node", "Element", "MutationObserver", "Text", "DocumentFragment", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: Window, root: Root, container: HTMLElement, clock: number;
const now = () => clock;
beforeEach(async () => {
  browser = new Window();
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : browser[name] });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container); clock = 0;
  await act(async () => root.render(<SummaryPage now={now} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const name of globals) { const original = originals.get(name); if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); }
});
function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const result = Array.from(within.querySelectorAll("button")).find(item => item.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string, within?: ParentNode) { await act(async () => button(label, within).click()); }
function text() { return container.textContent!; }
function tileCounts() { return Array.from(container.querySelectorAll(".summary-tiles strong")).map(item => item.textContent); }
async function edit(value: string) {
  const area = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event);
    area.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
  });
}
test("demo content is labeled, routine is collapsed and notifications contain counts only", () => {
  expect(text()).toContain("Demo data");
  expect(text()).toContain("Why: Your review is requested");
  expect(tileCounts()).toEqual(["1", "1", "1", "1"]);
  expect(container.querySelectorAll("details")).toHaveLength(2);
  for (const details of container.querySelectorAll("details")) expect(details.open).toBe(false);
  const preview = container.querySelectorAll("details")[1]!;
  expect(preview.textContent).toContain("Needs you: 1");
  expect(preview.textContent).not.toContain("Maya");
  expect(preview.textContent).not.toContain("482631");
  expect(text()).toContain("1 day waiting");
});
test("tiles focus each section heading, including in Digest", async () => {
  const labels = ["Needs you", "Drafted replies", "Waiting on", "Codes"];
  for (const digest of [false, true]) {
    if (digest) await click("Digest");
    for (let index = 0; index < labels.length; index++) {
      const tile = container.querySelectorAll<HTMLButtonElement>(".summary-tiles button")[index]!;
      await act(async () => tile.click());
      expect(document.activeElement?.id).toBe(["summary-needs", "summary-drafted", "summary-waiting", "summary-codes"][index]);
      expect(tile.textContent).toContain(labels[index]!);
    }
  }
});
test("Digest removes all message content and retains counts and category-only preview", async () => {
  await click("Reveal"); await click("Digest");
  expect(button("Digest").getAttribute("aria-pressed")).toBe("true");
  for (const content of ["Maya Chen", "Review the launch plan", "482631", "Weekly activity digest", "Design review notes", "Budget confirmation", "Workspace sign-in"]) expect(text()).not.toContain(content);
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector(".summary-card")).toBeNull();
  expect(tileCounts()).toEqual(["1", "1", "1", "1"]);
  await click("Personal"); expect(button("Digest").getAttribute("aria-pressed")).toBe("false");
  await click("Work"); expect(button("Digest").getAttribute("aria-pressed")).toBe("true");
});
test("account switching isolates content and preserves local actions", async () => {
  await click("Mark handled"); await click("Approve reply"); await click("Stop tracking");
  expect(tileCounts()).toEqual(["0", "0", "0", "1"]);
  expect(text()).toContain("Handled"); expect(text()).toContain("Approved"); expect(text()).toContain("Stopped");
  expect(text()).toContain("Demo: nothing was sent");
  await click("Personal");
  expect(button("Personal").getAttribute("aria-pressed")).toBe("true");
  expect(text()).not.toContain("Maya Chen"); expect(text()).toContain("Sam Rivera");
  expect(text()).toContain("2 days waiting"); expect(tileCounts()).toEqual(["1", "1", "1", "1"]);
  await click("Work"); expect(tileCounts()).toEqual(["0", "0", "0", "1"]);
  expect(button("Mark handled").disabled).toBe(true);
});
test("draft editing exposes Edited, prevents blank approval and retains edits by account", async () => {
  await edit("  \n ");
  expect(text()).toContain("Edited"); expect(text()).toContain("Enter a reply before approving.");
  expect(button("Approve reply").disabled).toBe(true);
  await edit("Thanks, confirmed.");
  expect(button("Approve reply").disabled).toBe(false);
  await click("Personal"); await click("Work");
  expect(container.querySelector("textarea")!.value).toBe("Thanks, confirmed.");
  await click("Approve reply");
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(text()).toContain("Demo: nothing was sent");
});
test("follow-up is created on demand and remains in Waiting on", async () => {
  expect(container.querySelectorAll("textarea")).toHaveLength(1);
  await click("Draft follow-up"); expect(container.querySelectorAll("textarea")).toHaveLength(2);
  expect(tileCounts()[1]).toBe("1"); expect(button("Draft follow-up").disabled).toBe(true);
  const waiting = container.querySelector('[aria-labelledby="summary-waiting"]')!;
  await click("Approve reply", waiting);
  expect(waiting.textContent).toContain("Demo: nothing was sent");
  await click("Stop tracking"); expect(tileCounts()[2]).toBe("0");
  expect(waiting.querySelector("textarea")!.disabled).toBe(true);
});
test("codes mask by default, reveal per account, copy with adjacent live feedback", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  expect(text()).not.toContain("482631"); expect(text()).toContain("2:00 remaining");
  await click("Reveal"); expect(text()).toContain("482631");
  await click("Copy"); expect(copied).toEqual(["482631"]);
  expect(button("Copy").nextElementSibling?.getAttribute("aria-live")).toBe("polite");
  expect(button("Copy").nextElementSibling?.textContent).toBe("Code copied.");
  await click("Hide"); expect(text()).not.toContain("482631");
  await click("Personal"); expect(text()).not.toContain("482631"); expect(text()).not.toContain("915204");
  expect(button("Copy").nextElementSibling?.textContent).toBe("");
  await click("Reveal"); expect(text()).toContain("915204");
  await click("Copy"); expect(copied).toEqual(["482631", "915204"]);
});
test("Copy rechecks clock at click time before the next timer render", async () => {
  let copies = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { copies++; } } });
  await click("Reveal"); clock = 120000;
  await click("Copy");
  expect(copies).toBe(0); expect(text()).toContain("Code expired. Nothing copied.");
  expect(text()).not.toContain("482631"); expect(text()).toContain("Expired");
  expect(button("Reveal").disabled).toBe(true); expect(tileCounts()[3]).toBe("0");
});
test("clipboard rejection and unavailable clipboard expose graceful feedback", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  await click("Copy"); expect(text()).toContain("Could not copy.");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  await click("Copy"); expect(text()).toContain("Reveal the code to copy it manually.");
});
test("countdown refreshes and masks a revealed code at expiry", async () => {
  const originalSetInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  try {
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 1000) tick = () => callback(...args);
      return originalSetInterval(callback, delay, ...args);
    }) as typeof setInterval;
    // Remount so the countdown effect registers its callback under the stub.
    await act(async () => root.render(<SummaryPage key="countdown" now={now} />));
    await click("Reveal");
    expect(text()).toContain("482631");
    expect(tick).toBeDefined();
    clock = 120000;
    await act(async () => tick!());
    expect(text()).toContain("Expired"); expect(text()).not.toContain("482631");
    expect(tileCounts()[3]).toBe("0");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("approving a demo draft makes no fetch or beacon requests", async () => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const beaconDescriptor = Object.getOwnPropertyDescriptor(navigator, "sendBeacon");
  const fetchStub = mock(async () => new Response());
  const beaconStub = mock(() => true);
  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchStub });
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beaconStub });
    await click("Approve reply");
    expect(text()).toContain("Demo: nothing was sent");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(beaconStub).not.toHaveBeenCalled();
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
    if (beaconDescriptor) Object.defineProperty(navigator, "sendBeacon", beaconDescriptor);
    else Reflect.deleteProperty(navigator, "sendBeacon");
  }
});
test("stopping tracking disables an unapproved follow-up textarea", async () => {
  await click("Draft follow-up");
  const waiting = container.querySelector('[aria-labelledby="summary-waiting"]')!;
  expect(waiting.querySelector("textarea")!.disabled).toBe(false);
  await click("Stop tracking");
  expect(waiting.querySelector("textarea")!.disabled).toBe(true);
});
