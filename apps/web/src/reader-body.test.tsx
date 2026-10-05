import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ReaderBody } from "./reader-body";
import { messageIdentityKey } from "./App";

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
const html = '<h2>Review requested</h2><p>Check <a href="https://example.com/project/pull/42" target="_blank" rel="noopener noreferrer">pull request #42</a>.</p><pre><code>const ready = true;\nreturn ready;</code></pre><blockquote>Earlier discussion.</blockquote><p>Footer remains available.</p><img alt="Synthetic image placeholder">';
const text = "Review requested\n\nCheck pull request #42.\nconst ready = true;\nreturn ready;\n\nOn Monday, Sam wrote:\n> Earlier discussion.\nFooter remains available.";
async function render(key = "one", htmlBody: string | null = html, textBody: string | null = text) {
  await act(async () => root.render(<ReaderBody key={key} html={htmlBody} text={textBody} />));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === label)!;
  await act(async () => button.click());
}

describe("message body alternatives", () => {
  test("keeps sanitized formatted content and destinations byte-for-byte on first render", async () => {
    await render();
    expect(container.querySelector(".reader-body-html")?.innerHTML).toBe(html);
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Formatted");
    expect(container.querySelector(".reader-formatted-region")?.getAttribute("tabindex")).toBe("0");
    expect(container.querySelector(".reader-body-plain")).toBeNull();
    for (const button of container.querySelectorAll("button")) expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
  });
  test("switches reversibly without deleting quotes, code, links, or footer", async () => {
    await render();
    const originalNode = container.querySelector(".reader-body-html");
    const originalLink = container.querySelector(".reader-body-html a");
    const originalImage = container.querySelector(".reader-body-html img");
    await click("Plain text");
    expect(container.querySelector(".reader-formatted-region")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector(".reader-body-html")).toBe(originalNode);
    expect(container.querySelector(".reader-body-html a")).toBe(originalLink);
    expect(container.querySelector(".reader-body-html img")).toBe(originalImage);
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Plain text");
    expect(container.querySelector(".reader-body-plain")?.textContent).toContain("const ready = true;\nreturn ready;");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details")?.textContent).toContain("Earlier discussion.");
    expect(container.querySelector("details")?.textContent).toContain("Footer remains available.");
    expect(container.textContent).toContain("Some formatting may be missing.");
    await act(async () => { container.querySelector("details")!.open = true; });
    await click("Formatted");
    expect(container.querySelector(".reader-body-html")).toBe(originalNode);
    expect(container.querySelector(".reader-body-html a")).toBe(originalLink);
    expect(container.querySelector(".reader-body-html img")).toBe(originalImage);
    expect(container.querySelector(".reader-formatted-region")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".reader-body-html")?.innerHTML).toBe(html);
    await click("Formatted");
    await render();
    expect(container.querySelector(".reader-body-html a")).toBe(originalLink);
    expect(container.querySelector(".reader-body-html img")).toBe(originalImage);
    expect(container.querySelector(".reader-body-html")?.innerHTML).toBe(html);
  });
  test("scopes the selected alternative to the message identity", async () => {
    await render(); await click("Plain text");
    await render("two", "<p>Another message</p>", "Another message");
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Formatted");
    expect(container.textContent).not.toContain("Earlier discussion");
  });
  test("keeps simultaneous message states separate across reordering and accounts", async () => {
    const first = { accountId: "account-one", id: "shared-id" };
    const second = { accountId: "account-one", id: "other-id" };
    const show = async (messages: typeof first[]) => act(async () => root.render(<>{messages.map(message => <section data-message={messageIdentityKey(message)} key={messageIdentityKey(message)}><ReaderBody html={html} text={text} /></section>)}</>));
    await show([first, second]);
    const section = (message: typeof first) => [...container.querySelectorAll("section")].find(node => node.dataset.message === messageIdentityKey(message))!;
    const firstSection = section(first);
    await act(async () => (firstSection.querySelectorAll("button")[1] as HTMLButtonElement).click());
    await show([second, first]);
    expect(section(first).querySelector('button[aria-pressed="true"]')?.textContent).toBe("Plain text");
    expect(section(second).querySelector('button[aria-pressed="true"]')?.textContent).toBe("Formatted");
    await show([{ ...first, accountId: "account-two" }]);
    expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toBe("Formatted");
  });
  test("recovers from an alternative disappearing on refresh", async () => {
    await render(); await click("Plain text"); await render("one", html, null);
    expect(container.querySelector(".reader-body-html")?.innerHTML).toBe(html);
    expect(container.querySelectorAll("button").length).toBe(0);
    await render("one", null, text);
    expect(container.querySelector(".reader-body-plain")?.textContent).toContain("Review requested");
  });
  test("does not offer invented alternatives or use a snippet as message content", () => {
    for (const [htmlBody, textBody] of [[html, null], [null, text], ["  ", text]] as const) {
      const output = renderToStaticMarkup(<ReaderBody html={htmlBody} text={textBody} />);
      expect(output).not.toContain("Message display");
      expect(output).not.toContain("Readable body unavailable");
    }
    expect(renderToStaticMarkup(<ReaderBody html=" " text={null} />)).toContain("Readable body unavailable");
  });
  test("renders plain-text markup as text, never active HTML", async () => {
    await render("one", null, '<img src=x onerror=alert(1)>\n<script>alert(2)</script>');
    expect(container.querySelector("img,script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });
});
