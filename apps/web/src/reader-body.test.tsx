import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { ReaderBody, ReaderMessageList } from "./reader-body";
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
  test("folds trailing HTML history once and preserves nodes and open state across alternatives", async () => {
    const reply = '<p>Current reply.</p><div class="gmail_attr">On Monday, Sam wrote:</div>\n<div class="gmail_quote"><blockquote>Earlier discussion.</blockquote><span class="orca-mail-image-note">[Image blocked: Quoted chart]</span></div> \n';
    await act(async () => root.render(<StrictMode><ReaderBody html={reply} text="Current reply." /></StrictMode>));
    const body = container.querySelector<HTMLElement>(".reader-body-html")!;
    const details = body.querySelector("details")!;
    const quote = details.querySelector(".gmail_quote");
    const note = details.querySelector(".orca-mail-image-note");
    expect(details.className).toBe("reader-quoted");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Show quoted history");
    expect(details.querySelector(".gmail_attr")?.textContent).toBe("On Monday, Sam wrote:");
    expect(body.querySelector("p")?.parentElement).toBe(body);
    expect(note?.textContent).toBe("Quoted chart");
    expect(note?.getAttribute("aria-label")).toBe("Blocked image: Quoted chart");
    expect(container.querySelectorAll(".reader-images-hidden-note").length).toBe(1);
    details.open = true;
    await click("Plain text");
    await click("Formatted");
    await act(async () => root.render(<StrictMode><ReaderBody html={reply} text="Current reply." /></StrictMode>));
    expect(container.querySelector(".reader-body-html")).toBe(body);
    expect(body.querySelectorAll("details").length).toBe(1);
    expect(body.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector(".gmail_quote")).toBe(quote);
    expect(details.querySelector(".orca-mail-image-note")).toBe(note);
  });
  test("recognizes trailing quote markers inside a single formatted wrapper", async () => {
    for (const marker of ['class="yahoo_quoted"', 'id="divRplyFwdMsg"', 'class="gmail_quote"']) {
      await render("one", `<div class="orca-mail-formatted"><p>Reply.</p><p>On Tuesday, Lee wrote:</p>\n<div ${marker}>History.</div>\n</div>`, null);
      const wrapper = container.querySelector<HTMLElement>(".orca-mail-formatted")!;
      expect(wrapper.querySelector("details")?.parentElement).toBe(wrapper);
      expect(wrapper.querySelector("details > div")?.textContent).toBe("On Tuesday, Lee wrote:\nHistory.");
    }
    await render("one", "<p>Reply.</p><blockquote>History.</blockquote> \n", null);
    expect(container.querySelector("details blockquote")?.textContent).toBe("History.");
  });
  test("leaves non-trailing quotes and trailing unwrapped answer text visible", async () => {
    for (const body of [html, "<blockquote>History.</blockquote>Current answer.", '<div class="gmail_quote">History.</div><p>Footer.</p>']) {
      await render("one", body, null);
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector(".reader-body-html")?.innerHTML).toBe(body);
    }
  });
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
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".reader-body-plain")?.textContent).toContain("Footer remains available.");
    expect(container.querySelector(".reader-body-plain")?.textContent).toContain("Earlier discussion.");
    expect(container.querySelector(".reader-body-plain")?.textContent).toContain("Footer remains available.");
    expect(container.textContent).toContain("Some formatting may be missing.");
    await click("Show complete original text");
    expect(container.querySelector(".reader-body-plain")?.textContent).toBe(text);
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


describe("reader content focus layout", () => {
  for (const visible of [true, false]) test(`preserves ${visible ? "visible focus offset" : "offscreen no-scroll intent"} when body geometry changes`, async () => {
    await act(async () => root.render(<section className="desktop-workspace" style={{ overflowY: "auto" }}><ReaderMessageList><ReaderBody html={html} text={text} /></ReaderMessageList></section>));
    const workspace = container.querySelector(".desktop-workspace") as HTMLElement;
    const list = container.querySelector(".reader-message-list") as HTMLElement;
    const link = container.querySelector("a") as HTMLElement;
    workspace.scrollTop = 100;
    workspace.getBoundingClientRect = () => ({ top: 0, bottom: 1000 } as DOMRect);
    link.getBoundingClientRect = () => {
      const top = (visible ? 490 : 4000) + (list.dataset.fullBodyLayout ? 1412 : 0);
      return { top, bottom: top + 20 } as DOMRect;
    };
    await act(async () => link.focus({ preventScroll: !visible }));
    expect(list.dataset.fullBodyLayout).toBe("true");
    expect(workspace.scrollTop).toBe(visible ? 1512 : 100);
  });
  test("restored exact geometry needs no focus correction", async () => {
    await act(async () => root.render(<ReaderMessageList restorePosition><ReaderBody html={html} text={text} /></ReaderMessageList>));
    const link = container.querySelector("a") as HTMLElement;
    link.getBoundingClientRect = () => { throw new Error("Already exact layout must not be measured again"); };
    await act(async () => link.focus());
    expect((container.querySelector(".reader-message-list") as HTMLElement).dataset.fullBodyLayout).toBe("true");
  });
  test("keeps pointer display controls fast, then retains exact geometry through keyboard exit", async () => {
    await act(async () => root.render(<ReaderMessageList><ReaderBody html={html} text={text} /></ReaderMessageList>));
    const list = container.querySelector(".reader-message-list") as HTMLElement;
    const plain = container.querySelectorAll("button")[1] as HTMLButtonElement;
    await act(async () => plain.focus());
    expect(list.dataset.fullBodyLayout).toBeUndefined();
    const originalLink = container.querySelector(".reader-body-html a") as HTMLAnchorElement;
    await act(async () => {
      originalLink.focus();
      // The focus transition must finish before the next frame: state is committed
      // before focus() returns, rather than waiting for an effect.
      expect(list.dataset.fullBodyLayout).toBe("true");
    });
    await act(async () => plain.focus());
    expect(list.dataset.fullBodyLayout).toBe("true");
    expect(container.querySelector(".reader-body-html a")).toBe(originalLink);
  });
  test("covers quoted-history focus and resets for a new thread identity", async () => {
    await act(async () => root.render(<ReaderMessageList key="one"><ReaderBody html={null} text={"Reply\nOn Monday, Sam wrote:\n> Quoted"} /></ReaderMessageList>));
    await act(async () => (container.querySelector("summary") as HTMLElement).focus());
    expect((container.querySelector(".reader-message-list") as HTMLElement).dataset.fullBodyLayout).toBe("true");
    await act(async () => root.render(<ReaderMessageList key="two"><ReaderBody html={null} text={"Reply\nOn Monday, Sam wrote:\n> Quoted"} /></ReaderMessageList>));
    expect((container.querySelector(".reader-message-list") as HTMLElement).dataset.fullBodyLayout).toBeUndefined();
  });
});


describe("blocked image presentation", () => {
  const blockedHtml = '<p>Statement ready.</p><span class="orca-mail-image-note">[Image blocked: Harbor Bank logo]</span><span class="orca-mail-image-note">[Image blocked: Spending &amp; savings]</span>';

  test("shows accessible alt placeholders and one privacy note without image elements", async () => {
    await render("blocked", blockedHtml, "Statement ready.");
    const notes = container.querySelectorAll(".orca-mail-image-note");
    expect([...notes].map(note => note.textContent)).toEqual(["Harbor Bank logo", "Spending & savings"]);
    expect(notes[0]?.getAttribute("aria-label")).toBe("Blocked image: Harbor Bank logo");
    expect(notes[1]?.getAttribute("aria-label")).toBe("Blocked image: Spending & savings");
    expect(notes[0]?.getAttribute("data-orca-image-note")).toBe("enhanced");
    expect(container.textContent).not.toContain("[Image blocked:");
    expect(container.querySelectorAll(".reader-images-hidden-note").length).toBe(1);
    expect(container.querySelector(".reader-images-hidden-note")?.textContent).toBe("Images hidden for privacy");
    expect(container.querySelector("img, [src]")).toBeNull();
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Formatted", "Plain text"]);
    const body = container.querySelector(".reader-body-html");
    await click("Plain text");
    expect(container.querySelector(".reader-images-hidden-note")).toBeNull();
    expect(container.querySelector(".reader-body-html")).toBe(body);
    await click("Formatted");
    expect(container.querySelector(".reader-body-html")).toBe(body);
    expect(container.querySelectorAll(".reader-images-hidden-note").length).toBe(1);
    expect(container.querySelector(".orca-mail-image-note")).toBe(notes[0]);
    await render("blocked", "<p>No images here.</p>", "No images here.");
    expect(container.querySelector(".reader-images-hidden-note")).toBeNull();
  });

  test("is idempotent across repeated layout effects and leaves non-matching spans untouched", async () => {
    const body = '<span class="orca-mail-image-note">[Image blocked: [Image blocked: nested alt]]</span><span class="orca-mail-image-note">Original note</span>';
    await act(async () => root.render(<StrictMode><ReaderBody html={body} text={null} /></StrictMode>));
    const notes = container.querySelectorAll(".orca-mail-image-note");
    expect(notes[0]?.textContent).toBe("[Image blocked: nested alt]");
    expect(notes[0]?.getAttribute("aria-label")).toBe("Blocked image: [Image blocked: nested alt]");
    expect(notes[1]?.textContent).toBe("Original note");
    expect(notes[1]?.hasAttribute("data-orca-image-note")).toBe(false);
    expect(notes[1]?.hasAttribute("aria-label")).toBe(false);
  });
});

describe("hostile blocked image placeholder text", () => {
  const cases = [
    ["never activates escaped image markup or event handlers", "<img src=x onerror=alert(1)>"],
    ["never recursively decodes escaped markup entities", "&lt;img src=x onerror=alert(1)&gt;"],
    ["never activates script-looking alt text", "<script>alert(1)</script>"],
    ["never turns javascript URL alt text into a source", "javascript:alert(1)"],
    ["never turns data HTML URL alt text into a source", "data:text/html,<script>alert(1)</script>"],
    ["never truncates long hostile alt text", "<img src=x onerror=alert(1)>".repeat(50)],
    ["never invents content for empty alt text", ""],
    ["never interprets unicode and RTL alt text as markup", "مرحبا שלום \u202E<img src=x onerror=alert(1)>"],
  ] as const;

  for (const [name, alt] of cases) test(name, async () => {
    // The API supplies escaped placeholder text; ReaderBody only enhances it.
    const escapedAlt = alt.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await render("hostile-blocked", `<span class="orca-mail-image-note">[Image blocked: ${escapedAlt}]</span>`, null);
    const chip = container.querySelector(".orca-mail-image-note");
    expect(container.querySelector('img, [src], script, [onerror]')).toBeNull();
    expect(chip?.textContent).toBe(alt);
    expect(chip?.getAttribute("aria-label")).toBe("Blocked image: " + alt);
    expect(chip?.getAttribute("data-orca-image-note")).toBe("enhanced");

    const enhancedHtml = container.querySelector(".reader-body-html")!.innerHTML;
    const before = container.innerHTML;
    // Changing the HTML prop re-runs the layout effect on the enhanced markup.
    await render("hostile-blocked", enhancedHtml, null);
    expect(container.innerHTML).toBe(before);
    expect(container.querySelector('img, [src], script, [onerror]')).toBeNull();
    const enhancedChip = container.querySelector(".orca-mail-image-note");
    expect(enhancedChip?.textContent).toBe(alt);
    expect(enhancedChip?.getAttribute("aria-label")).toBe("Blocked image: " + alt);
  });
});
