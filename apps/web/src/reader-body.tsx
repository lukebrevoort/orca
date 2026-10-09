import { useId, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

/** Keep exact geometry after focus enters message content. This is synchronous
 * so the browser's default focus scroll sees rendered heights. Retain it until
 * this thread unmounts: changing back during Tab/Shift+Tab can move the target.
 * Display controls do not opt in, so ordinary view toggles keep the fast path. */
export function ReaderMessageList({ children }: { children: ReactNode }) {
  const [fullBodyLayout, setFullBodyLayout] = useState(false);
  return <div className="reader-message-list" aria-label="Messages in conversation" role="region"
    data-full-body-layout={fullBodyLayout ? "true" : undefined}
    onFocusCapture={(event) => {
      const target = event.target;
      if (fullBodyLayout || !(target instanceof HTMLElement)
        || !target.closest(".reader-content") || target.closest(".reader-display-controls")) return;
      flushSync(() => setFullBodyLayout(true));
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
 * Switching alternatives never rewrites content, links, or reply source data.
 * Keep formatted DOM mounted while hidden: toggles must not refetch images. */
export function ReaderBody({ html, text }: { html: string | null; text: string | null }) {
  const [preferredView, setPreferredView] = useState<"formatted" | "text">(() => text && splitQuotedContent(text).quoted ? "text" : "formatted");
  const bodyId = useId();
  const [showOriginal, setShowOriginal] = useState(false);
  const formattedContent = useMemo(() => ({ __html: html ?? "" }), [html]);
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
            <div className="reader-body reader-body-html" dangerouslySetInnerHTML={formattedContent} />
          </div>
        ) : null}
        {!showHtml && plainBody ? (
          <>
            {hasHtml ? <p className="reader-display-note">Text version. Some formatting may be missing.</p> : null}
            <div className="reader-body reader-body-plain">{showOriginal ? text : plainBody.current}</div>
            {!showOriginal && plainBody.quoted ? <details className="reader-quoted"><summary>Show quoted history</summary><div>{plainBody.quoted}</div></details> : null}
            <button type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(!showOriginal)}>{showOriginal ? "Return to reading view" : "Show complete original text"}</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
