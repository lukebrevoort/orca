import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { TopLayerProvider } from "./top-layer";
import { ComposeWorkspace, useComposeDraft, type ComposeDraftController, type ComposeDraftFields } from "./compose-workspace";

const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const;
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: InstanceType<typeof Window>;
let root: Root;
let controller: ComposeDraftController;
let mode: "panel" | "zen";
let scope: string;
let deliveries: Partial<ComposeDraftFields>[];
let fail: boolean;
let hold: (() => Promise<void>) | undefined;
function Harness() {
  controller = useComposeDraft("transition-test", scope, true);
  return <ComposeWorkspace key={mode} variant={mode} contacts={[]} canSend controller={{ ...controller, sendDraft: async fields => {
    deliveries.push(fields ?? {});
    await hold?.();
    if (fail) throw new Error("Synthetic failure");
    return controller.sendDraft!(fields);
  } }} />;
}
async function render() { await act(async () => root.render(<TopLayerProvider><Harness /></TopLayerProvider>)); }
function input(kind: string) { return browser.document.querySelector(`input[name="${kind}-recipient"]`)! as unknown as HTMLInputElement; }
async function type(kind: string, value: string) { await act(async () => { const field = input(kind); field.value = value; field.dispatchEvent(new browser.Event("input", { bubbles: true }) as unknown as Event); }); }
async function click(text: string) { await act(async () => { const button = [...browser.document.querySelectorAll("button")].find(button => button.textContent === text); expect(button).toBeDefined(); button!.click(); }); }
beforeEach(async () => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "window" ? browser : browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  root = createRoot(container as unknown as Element);
  mode = "panel"; scope = "new"; deliveries = []; fail = false; hold = undefined;
  await render();
  await act(async () => controller.updateDraft({ body: "Draft words" }));
});
afterEach(async () => {
  await act(async () => root.unmount()); browser.close();
  for (const name of names) { const descriptor = originals.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
test("demo delivery is labeled as simulation without verified Gmail access or provider IDs", async () => {
  expect(controller.demonstration).toBe(true);
  expect(browser.document.body.textContent).toContain("Demo send only — no real email is sent.");
  await type("to", "family@example.com");
  expect(browser.document.body.textContent).toContain("Sending only simulates delivery in this preview.");
  expect(browser.document.body.textContent).not.toContain("Gmail has confirmed");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Demo must stay local"); }) as unknown as typeof fetch;
  try {
    await act(async () => {
      const result = await controller.sendDraft!({ to: [{ name: null, email: "family@example.com" }] });
      expect(result).toMatchObject({ status: "sent", providerMessageId: null, providerThreadId: null });
    });
    expect(requests).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
test("pending To, Cc and Bcc survive panel/Zen remounts; invalid input prevents partial delivery", async () => {
  await click("Add Cc or Bcc");
  await type("to", "to@example.com"); await type("cc", "cc@example.com"); await type("bcc", "unfinished");
  mode = "zen"; await render();
  expect(input("to").value).toBe("to@example.com"); expect(input("cc").value).toBe("cc@example.com"); expect(input("bcc").value).toBe("unfinished");
  expect(browser.document.querySelector('[name="subject"]')?.getAttribute("aria-label")).toBe("Subject");
  await click("Send"); expect(deliveries).toHaveLength(0); expect(input("bcc").getAttribute("aria-invalid")).toBe("true");
  mode = "panel"; await render(); expect(input("bcc").value).toBe("unfinished");
  await type("bcc", "bcc@example.com"); await click("Send");
  expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ to: [{ email: "to@example.com" }], cc: [{ email: "cc@example.com" }], bcc: [{ email: "bcc@example.com" }] });
  expect(input("to").value).toBe("");
  await act(async () => controller.updateDraft({ body: "Another message" }));
  await type("to", "next@example.com"); await click("Send"); expect(deliveries).toHaveLength(2);
});
test("failed send preserves committed draft and retry does not duplicate recipients", async () => {
  fail = true; await type("to", "same@example.com; same@example.com"); await click("Send");
  expect(controller.draft.body).toBe("Draft words"); expect(controller.draft.to).toHaveLength(1);
  mode = "zen"; await render(); fail = false; await click("Send"); expect(deliveries).toHaveLength(2);
});
test("pending-only draft has content and discard or scope change resets queries", async () => {
  await act(async () => controller.updateDraft({ body: "" })); await type("to", "unfinished");
  expect(controller.hasContent).toBe(true);
  await act(async () => controller.discardDraft()); expect(input("to").value).toBe("");
  await type("to", "another"); scope = "other"; await render(); expect(input("to").value).toBe("");
});
test("controller rejects invalid hidden recipients before synthetic send", async () => {
  await act(async () => controller.updateDraft({ to: [{ name: null, email: "ready@example.com" }] }));
  await click("Add Cc or Bcc"); await type("bcc", "unfinished"); await click("Hide Cc and Bcc");
  await expect(controller.sendDraft!()).rejects.toThrow("complete");
  expect(controller.draft.body).toBe("Draft words"); expect(controller.recipientQueries?.bcc).toBe("unfinished");
});
test("rapid send clicks run a single delivery", async () => {
  let release!: () => void;
  hold = () => new Promise(resolve => { release = resolve; });
  await type("to", "ready@example.com");
  await act(async () => {
    const button = [...browser.document.querySelectorAll("button")].find(button => button.textContent === "Send")!;
    button.click(); button.click();
  });
  expect(deliveries).toHaveLength(1);
  await act(async () => { release(); });
});
