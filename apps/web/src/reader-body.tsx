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
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const quoteStart = lines.findIndex((line, index) =>
    index > 0 && (/^\s*>/.test(line) || /^\s*On .+wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i.test(line)),
  );
  if (quoteStart < 0) return { current: body.trim(), quoted: null };
  return { current: lines.slice(0, quoteStart).join("\n").trim(), quoted: lines.slice(quoteStart).join("\n").trim() };
}

/** Presentation only: HTML must already have passed the API's providerHtmlPolicy.
 * Switching alternatives never rewrites content, links, or reply source data.
 * Keep formatted DOM mounted while hidden: toggles must not refetch images. */
export function ReaderBody({ html, text }: { html: string | null; text: string | null }) {
  const [preferredView, setPreferredView] = useState<"formatted" | "text">("formatted");
  const bodyId = useId();
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
            <div className="reader-body reader-body-plain">{plainBody.current}</div>
            {plainBody.quoted ? <details className="reader-quoted"><summary>Show quoted history</summary><div>{plainBody.quoted}</div></details> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
