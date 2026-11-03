import { useEffect, useRef, useState } from "react";
import { TopLayer, useTopLayerActive } from "./top-layer";
import "./feedback-corner.css";
import { FeedbackMedia, type FeedbackMediaFile } from "./feedback-media";

type Submission = { id: string; message: string; platform: "web"; attachments?: FeedbackMediaFile[] };
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
  const [files, setFiles] = useState<FeedbackMediaFile[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [mediaWorking, setMediaWorking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const [pending, setPending] = useState<Submission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const scopeVersion = useRef(0);
  const sending = useRef(false);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const topLayerActive = useTopLayerActive();

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    if (["/login", "/mobile-auth", "/onboarding"].includes(window.location.pathname) || window.location.pathname.startsWith("/dev/")) {
      return () => { alive.current = false; controller.abort(); request.current?.abort(); };
    }
    // Only the server can establish the signed-in owner's entitlement. No
    // client-selected destination or personal integration credentials are used.
    const check = () => {
      void fetch("/v1/feedback/ticket", { credentials: "include", signal: controller.signal })
        .then(async response => response.ok ? response.json() : [401, 403].includes(response.status) ? { available: false } : null)
        .then(result => {
          if (controller.signal.aborted || !result) return;
          setAvailable(result.available === true);
          if (result.available !== true) {
            scopeVersion.current++; request.current?.abort(); request.current = null; sending.current = false;
            setOpen(false); setFiles([]); setReviewed(false); setPending(null); setMessage(""); setReceipt(null); setError(null); setBusy(false);
          }
        }).catch(() => {});
    };
    check(); window.addEventListener("focus", check);
    return () => { alive.current = false; controller.abort(); request.current?.abort(); window.removeEventListener("focus", check); };
  }, []);

  useEffect(() => {
    if (!message && !files.length) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [message, files.length]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || mediaWorking || !message.trim() || (files.length > 0 && !reviewed)) return;
    const version = scopeVersion.current;
    sending.current = true;
    setBusy(true); setError(null); setProgress(0);
    const submission = pending ?? { id: crypto.randomUUID(), message: message.trim(), platform: "web" as const, ...(files.length ? { attachments: files } : {}) };
    setPending(submission);
    try {
      const response = await new Promise<{ status: number; result: unknown }>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); request.current = xhr;
        xhr.open("POST", "/v1/feedback/ticket"); xhr.withCredentials = true;
        xhr.setRequestHeader("content-type", "application/json");
        xhr.timeout = submission.attachments?.length ? 300_000 : 30_000;
        xhr.upload.onprogress = event => { if (alive.current && version === scopeVersion.current) setProgress(event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null); };
        xhr.upload.onload = () => { if (alive.current && version === scopeVersion.current) setProgress(100); };
        xhr.onload = () => { let result: unknown = null; try { result = JSON.parse(xhr.responseText); } catch {} resolve({ status: xhr.status, result }); };
        xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error("Couldn’t confirm delivery. Your text and attachments are still here. Retry this same submission."));
        xhr.send(JSON.stringify(submission));
      });
      const result = response.result;
      if (!alive.current || version !== scopeVersion.current) return;
      if (response.status < 200 || response.status >= 300) {
        // These statuses reject before delivery. Ambiguous failures retain the
        // exact immutable ID and text so a retry recovers the same Linear issue.
        if ([400, 413].includes(response.status)) setPending(null);
        if (response.status === 401) throw new Error("Your session expired. Sign in again to send this feedback.");
        if (response.status === 403 || response.status === 503) throw new Error("Linear feedback isn’t available for this account. Check the feedback configuration and try again.");
        if (response.status === 400 || response.status === 413) throw new Error("Check your feedback and attachments: up to 3 supported files, 10 MB each, 20 MB total.");
        throw new Error("Delivery could not be confirmed. Retry to check and send this same feedback.");
      }
      if (!validReceipt(result)) throw new Error("Delivery could not be confirmed. Retry to check this same feedback.");
      setReceipt(result); setPending(null); setMessage(""); setFiles([]); setReviewed(false);
    } catch (cause) {
      if (alive.current && version === scopeVersion.current) setError(cause instanceof Error && cause.name !== "TimeoutError" && cause.name !== "TypeError"
        ? cause.message : "Couldn’t confirm delivery. Your text is still here. Retry this same submission.");
    } finally {
      if (version === scopeVersion.current) { request.current = null; sending.current = false; if (alive.current) setBusy(false); }
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
        <p className="feedback-corner-hint">Creates a ticket in your Linear with only your message and reviewed attachments.</p>
        <FeedbackMedia files={files} onChange={setFiles} reviewed={reviewed} onReviewed={setReviewed} locked={pending !== null || busy} onWorking={setMediaWorking} />
        {busy && <p role="status" className="feedback-corner-hint">{progress === 100 ? "Confirming ticket and private media in Linear…" : progress === null ? "Uploading to Orca…" : `Uploading to Orca… ${progress}%`}</p>}
        {files.length > 0 && !pending && !busy && <button type="button" disabled={mediaWorking} onClick={() => { setFiles([]); setReviewed(false); }}>Discard attachments</button>}
        {error && <p role="alert" className="feedback-corner-error">{error}</p>}
        <button className="feedback-corner-send" type="submit" disabled={busy || mediaWorking || !message.trim() || (files.length > 0 && !reviewed)}>{busy ? "Sending…" : pending ? "Retry submission" : "Send to Linear"}</button>
      </form>}
    </TopLayer>}
  </>;
}
