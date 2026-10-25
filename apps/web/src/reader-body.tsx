import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

/** Keep exact geometry after focus enters message content. The browser can
 * scroll before focusin; preserve its chosen visible offset while revealing bodies. Retain it until
 * this thread unmounts: changing back during Tab/Shift+Tab can move the target.
 * Display controls do not opt in, so ordinary view toggles keep the fast path. */
export function ReaderMessageList({ children, restorePosition = false }: { children: ReactNode; restorePosition?: boolean }) {
  const [fullBodyLayout, setFullBodyLayout] = useState(false);
  return <div className="reader-message-list" aria-label="Messages in conversation" role="region"
    data-full-body-layout={fullBodyLayout || restorePosition ? "true" : undefined}
    onFocusCapture={(event) => {
      const target = event.target;
      if (fullBodyLayout || restorePosition || !(target instanceof HTMLElement)
        || !target.closest(".reader-content") || target.closest(".reader-display-controls")) return;
      const workspace = event.currentTarget.closest<HTMLElement>(".desktop-workspace");
      const before = target.getBoundingClientRect();
      const contained = workspace && /^(auto|scroll)$/.test(window.getComputedStyle(workspace).overflowY);
      const viewport = contained ? workspace.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      // Only preserve a position the browser already revealed. In particular,
      // offscreen focus({ preventScroll: true }) must not trigger our own reveal.
      const wasVisible = before.bottom > viewport.top && before.top < viewport.bottom;
      flushSync(() => setFullBodyLayout(true));
      if (wasVisible) {
        const delta = target.getBoundingClientRect().top - before.top;
        if (delta) {
          if (contained) workspace.scrollTop += delta;
          else window.scrollBy({ top: delta, behavior: "instant" });
        }
      }
    }}>{children}</div>;
}

export function splitQuotedContent(body: string) {
  // Fold only an unambiguous trailing quote block. Inline replies and forwarded
  // prose remain visible, and concatenating both parts recovers the exact input.
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const start = lines.findIndex((line, index) => index > 0 && (/^\s*>/.test(line) || /^\s*On .+wrote:\s*$/i.test(line)));
  if (start < 0) return { current: body, quoted: null };
  const rest = lines.slice(start + (/^\s*>/.test(lines[start]!) ? 0 : 1));
  if (!rest.some(line => /^\s*>/.test(line)) || rest.some(line => line.trim() && !/^\s*>/.test(line))) return { current: body, quoted: null };
  return { current: lines.slice(0, start).join(""), quoted: lines.slice(start).join("") };
}

/** Presentation only: HTML must already have passed the API's providerHtmlPolicy.
 * Switching alternatives preserves content, links, and reply source data.
 * Keep formatted DOM mounted while hidden: toggles must not refetch images. */
export function ReaderBody({ html, text }: { html: string | null; text: string | null }) {
  const [preferredView, setPreferredView] = useState<"formatted" | "text">(() => text && splitQuotedContent(text).quoted ? "text" : "formatted");
  const bodyId = useId();
  const [showOriginal, setShowOriginal] = useState(false);
  const formattedContent = useMemo(() => ({ __html: html ?? "" }), [html]);
  const formattedBody = useRef<HTMLDivElement>(null);
  const [hasBlockedImages, setHasBlockedImages] = useState(false);
  useLayoutEffect(() => {
    const body = formattedBody.current;
    if (!body) return;
    // Only whitespace may follow history. Never fold a quote with an inline
    // answer or footer after it, or search inside arbitrary sender layouts.
    const meaningfulNodes = (element: Element) => [...element.childNodes].filter(node =>
      node.nodeType !== 3 || Boolean(node.textContent?.trim()));
    let parent: Element = body;
    while (true) {
      const nodes = meaningfulNodes(parent);
      const wrapper = nodes.length === 1 ? nodes[0] : null;
      if (!(wrapper instanceof Element) || !wrapper.matches("div.orca-mail-formatted")) break;
      parent = wrapper;
    }
    const nodes = meaningfulNodes(parent);
    const quote = nodes.at(-1);
    if (!(quote instanceof Element) || quote.hasAttribute("data-orca-quoted-history")
      || !quote.matches('blockquote, [class*="quote"], #divRplyFwdMsg')) return;
    const previous = nodes.at(-2);
    const attribution = previous instanceof Element && (previous.matches(".gmail_attr")
      || /^On .+wrote:$/i.test(previous.textContent?.trim() ?? "")) ? previous : null;
    const details = document.createElement("details");
    details.className = "reader-quoted";
    details.setAttribute("data-orca-quoted-history", "collapsed");
    const summary = document.createElement("summary");
    summary.textContent = "Show quoted history";
    const history = document.createElement("div");
    parent.insertBefore(details, attribution ?? quote);
    details.appendChild(summary);
    details.appendChild(history);
    // Move the original nodes, including whitespace between attribution and
    // quote, so links, enhanced image notes and native details state survive.
    let node: ChildNode | null = attribution ?? quote;
    while (node) {
      const next: ChildNode | null = node.nextSibling;
      history.appendChild(node);
      if (node === quote) break;
      node = next;
    }
  }, [html]);
  useLayoutEffect(() => {
    const notes = formattedBody.current?.querySelectorAll("span.orca-mail-image-note");
    setHasBlockedImages(Boolean(notes?.length));
    notes?.forEach(note => {
      if (note.getAttribute("data-orca-image-note") === "enhanced") return;
      const match = /^\[Image blocked: ([\s\S]*)\]$/.exec(note.textContent ?? "");
      if (!match) return;
      const alt = match[1]!;
      note.textContent = alt;
      note.setAttribute("data-orca-image-note", "enhanced");
      note.setAttribute("aria-label", `Blocked image: ${alt}`);
    });
  }, [html]);
  const hasHtml = Boolean(html?.trim());
  const hasText = Boolean(text?.trim());
  const showHtml = hasHtml && (preferredView === "formatted" || !hasText);
  const plainBody = hasText ? splitQuotedContent(text!) : null;

  if (!hasHtml && !hasText) return <p className="reader-no-body"><strong>Readable body unavailable.</strong><span>Orca synced this message’s details, but no readable text body was available. The rest of this conversation is still here.</span></p>;

  return (
    <div className="reader-content">
      {hasHtml && hasText ? (
        <div aria-label="Message display" className="reader-display-controls" role="group">
          <button aria-controls={bodyId} aria-pressed={showHtml} onClick={() => setPreferredView("formatted")} type="button">Formatted</button>
          <button aria-controls={bodyId} aria-pressed={!showHtml} onClick={() => setPreferredView("text")} type="button">Plain text</button>
        </div>
      ) : null}
      <div id={bodyId}>
        {hasHtml ? (
          <div aria-label="Formatted message" aria-description="Wide content can be scrolled horizontally." className="reader-formatted-region" hidden={!showHtml} role="region" tabIndex={0}>
            {showHtml && hasBlockedImages ? <p className="reader-images-hidden-note">Images hidden for privacy</p> : null}
            <div ref={formattedBody} className="reader-body reader-body-html" dangerouslySetInnerHTML={formattedContent} />
          </div>
        ) : null}
        {!showHtml && plainBody ? (
          <>
            {hasHtml ? <p className="reader-display-note">Text version. Some formatting may be missing.</p> : null}
            <div className="reader-body reader-body-plain">{showOriginal ? text : plainBody.current}</div>
            {!showOriginal && plainBody.quoted ? <details className="reader-quoted"><summary>Show quoted history</summary><div>{plainBody.quoted}</div></details> : null}
            <button className="reader-original-toggle" type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(!showOriginal)}>{showOriginal ? "Return to reading view" : "Show complete original text"}</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
