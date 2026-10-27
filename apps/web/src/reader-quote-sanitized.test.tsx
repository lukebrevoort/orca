import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ReaderBody } from "./reader-body";
import { sanitizeInboundHtml } from "../../api/src/mail/provider-html.ts";

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

async function render(raw: string) {
  const html = sanitizeInboundHtml(raw);
  await act(async () => root.render(<StrictMode><ReaderBody html={html} text={null} /></StrictMode>));
  return container.querySelector(".reader-body-html");
}
const gmail = '<div>Reply here</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Sam wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex">History <a href="https://example.com">link</a></blockquote></div>';
test("folds real sanitized Gmail wrappers and keeps current reply visible", async () => {
  await render(gmail);
  const details = container.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  expect(details.className).toBe("reader-quoted");
  expect(details.querySelector("summary")?.textContent).toBe("Show quoted history");
  expect(details.textContent).toContain("On Mon, Sam wrote:");
  expect(details.querySelector("blockquote a")?.getAttribute("href")).toBe("https://example.com");
  expect(details.textContent).not.toContain("Reply here");
  expect(container.querySelectorAll("details").length).toBe(1);
});
test("traverses only trailing plain wrappers, including a whole-message wrapper", async () => {
  for (const raw of [
    `<div>${gmail}</div>`,
    '<div>Reply</div><div><div><blockquote>History</blockquote></div></div>',
  ]) {
    await render(raw);
    expect(container.querySelector("details blockquote")?.textContent).toContain("History");
    expect(container.querySelector("details")?.textContent).not.toContain("Reply");
  }
});
test("leaves sanitized Yahoo and Outlook history fully visible without reliable quote structure", async () => {
  for (const raw of [
    '<div>Reply</div><div class="yahoo_quoted" id="yahoo_quoted_x"><div>On Monday, Sam wrote:</div><div><div>History</div></div></div>',
    '<div>Reply</div><hr><div id="divRplyFwdMsg"><b>From:</b> Sam<br><b>Sent:</b> Mon</div><div>History body</div>',
  ]) {
    const body = await render(raw);
    expect(container.querySelector("details")).toBeNull();
    expect(body?.innerHTML).toBe(sanitizeInboundHtml(raw)!);
    expect(body?.textContent).toContain("Reply");
    expect(body?.textContent).toContain("History");
  }
});
test("never folds answers, whole messages, or quotes inside arbitrary layouts", async () => {
  for (const raw of [
    '<div>Reply</div><blockquote>History</blockquote>Unique answer',
    gmail + 'Unique answer',
    '<div>Reply</div><div><blockquote>History</blockquote>Unique answer</div>',
    '<blockquote>History</blockquote>',
    '<div><div>On Monday, Sam wrote:</div><blockquote>History</blockquote></div>',
    '<div>Reply</div><table><tr><td><blockquote>History</blockquote></td></tr></table>',
    '<div>Reply</div><div><p>Unique answer</p><blockquote>History</blockquote></div>',
    '<br><blockquote>History</blockquote>',
    '',
    '<div>Reply</div><div>On Monday, Sam wrote:<blockquote>History</blockquote>Unique answer',
  ]) {
    await render(raw);
    expect(container.querySelector("details")).toBeNull();
    if (raw.includes("Unique answer")) expect(container.textContent).toContain("Unique answer");
  }
});
test("keeps hostile and large sanitized quote content inert and intact", async () => {
  const history = 'History '.repeat(10000);
  await render(`<p>Reply</p><div><blockquote>${history}&lt;script&gt;alert(1)&lt;/script&gt;<script>alert(2)</script><a href="javascript:alert(3)">link</a></blockquote></div>`);
  expect(container.querySelector("details blockquote")?.textContent).toContain(history);
  expect(container.querySelector("script, [onclick], [onerror], [href^='javascript:']")).toBeNull();
  expect(container.querySelector("details")?.textContent).toContain('<script>alert(1)</script>');
});
