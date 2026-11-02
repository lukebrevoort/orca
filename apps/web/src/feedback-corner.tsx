import { useEffect, useRef, useState } from "react";
import { TopLayer, useTopLayerActive } from "./top-layer";
import "./feedback-corner.css";

type Submission = { id: string; message: string; platform: "web" };
type Receipt = { identifier: string; url: string };

function validReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<Receipt>;
  if (typeof receipt.identifier !== "string" || !receipt.identifier.trim() || typeof receipt.url !== "string") return false;
  try {
    const url = new URL(receipt.url);
    return url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password;
  } catch { return false; }
}

export default function FeedbackCorner() {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<Submission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const topLayerActive = useTopLayerActive();

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (["/login", "/mobile-auth", "/onboarding"].includes(window.location.pathname) || window.location.pathname.startsWith("/dev/")) {
      return () => { alive.current = false; controller.abort(); };
    }
    // Only the server can establish the signed-in owner's entitlement. No
    // client-selected destination or personal integration credentials are used.
    void fetch("/v1/feedback/ticket", { credentials: "include", signal: controller.signal })
      .then(async response => response.ok ? response.json() : null)
      .then(result => { if (!controller.signal.aborted) setAvailable(result?.available === true); })
      .catch(() => {});
    return () => { alive.current = false; controller.abort(); };
  }, []);

  useEffect(() => {
    if (!message) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [message]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || !message.trim()) return;
    sending.current = true;
    setBusy(true); setError(null);
    const submission = pending ?? { id: crypto.randomUUID(), message: message.trim(), platform: "web" as const };
    setPending(submission);
    try {
      const response = await fetch("/v1/feedback/ticket", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify(submission), signal: AbortSignal.timeout(30_000),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!alive.current) return;
      if (!response.ok) {
        // These statuses reject before delivery. Ambiguous failures retain the
        // exact immutable ID and text so a retry recovers the same Linear issue.
        if ([400, 413].includes(response.status)) setPending(null);
        if (response.status === 401) throw new Error("Your session expired. Sign in again to send this feedback.");
        if (response.status === 403 || response.status === 503) throw new Error("Linear feedback isn’t available for this account. Check the feedback configuration and try again.");
        if (response.status === 400 || response.status === 413) throw new Error("Check your feedback text and try again.");
        throw new Error("Delivery could not be confirmed. Retry to check and send this same feedback.");
      }
      if (!validReceipt(result)) throw new Error("Delivery could not be confirmed. Retry to check this same feedback.");
      setReceipt(result); setPending(null); setMessage("");
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error && cause.name !== "TimeoutError" && cause.name !== "TypeError"
        ? cause.message : "Couldn’t confirm delivery. Your text is still here. Retry this same submission.");
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  }

  if (!available) return null;
  return <>
    <button ref={trigger} className="feedback-corner-trigger" hidden={topLayerActive && !open} type="button" aria-label="Feedback" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 11a8 8 0 0 1-8 8H5l-4 3 2-7a8 8 0 1 1 17-4Z" /><path d="M8 9h8M8 13h5" /></svg><span>Feedback</span>
    </button>
    {open && <TopLayer ariaLabel="Send feedback" layerClassName="feedback-corner-layer" backdropClassName="feedback-corner-backdrop" className="feedback-corner-dialog" onClose={() => setOpen(false)} initialFocusRef={receipt ? undefined : editor} returnFocusRef={trigger} ariaBusy={busy}>
      <header><h2>Feedback</h2><button type="button" aria-label="Close feedback" onClick={() => setOpen(false)}>×</button></header>
      {receipt ? <div className="feedback-corner-success">
        <p role="status">Created in Linear.</p>
        <a href={receipt.url} target="_blank" rel="noopener noreferrer">Open {receipt.identifier}</a>
        <button type="button" onClick={() => { setReceipt(null); setError(null); requestAnimationFrame(() => editor.current?.focus()); }}>Send another</button>
      </div> : <form onSubmit={submit}>
        <label htmlFor="orca-feedback-message">Your feedback</label>
        <textarea ref={editor} id="orca-feedback-message" rows={5} maxLength={10000} required value={message} readOnly={pending !== null || busy} placeholder="What should we improve?" onChange={event => setMessage(event.target.value)} />
        <p className="feedback-corner-hint">Creates a ticket in your Linear. Only what you write is shared.</p>
        {error && <p role="alert" className="feedback-corner-error">{error}</p>}
        <button className="feedback-corner-send" type="submit" disabled={busy || !message.trim()}>{busy ? "Sending…" : pending ? "Retry submission" : "Send to Linear"}</button>
      </form>}
    </TopLayer>}
  </>;
}
