import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackQueueItem, FeedbackQueueResponse, FeedbackQueueSubmission, FeedbackQueueSubmissionResponse } from "@orca/shared";
import "./feedback-page.css";

class FeedbackRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function feedbackRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    if (response.status === 401) throw new FeedbackRequestError("Your session expired. Sign in again to view or send feedback.", 401);
    const data = await response.json().catch(() => null);
    throw new FeedbackRequestError(data?.error?.message ?? "Could not reach the feedback queue. Please try again.", response.status, data?.error?.code);
  }
  return response.json() as Promise<T>;
}

export function FeedbackPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<FeedbackQueueSubmission["kind"]>("idea");
  const [items, setItems] = useState<FeedbackQueueItem[]>([]);
  const [deliveryAvailable, setDeliveryAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryId, setRetryId] = useState<string | null>(null);
  const pending = useRef<FeedbackQueueSubmission | null>(null);
  const submitting = useRef(false);
  const loadSequence = useRef(0);
  const alive = useRef(true);
  const [locked, setLocked] = useState(false);

  const loadQueue = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError(null);
    try {
      const data = await feedbackRequest<FeedbackQueueResponse>("/v1/feedback/queue");
      if (!alive.current || sequence !== loadSequence.current) return;
      setItems(data.items); setDeliveryAvailable(data.deliveryAvailable);
    } catch (error) {
      if (alive.current && sequence === loadSequence.current) {
        if (error instanceof FeedbackRequestError && error.status === 401) setItems([]);
        setLoadError(error instanceof Error ? error.message : "Could not load feedback.");
      }
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { alive.current = true; void loadQueue(); return () => { alive.current = false; ++loadSequence.current; }; }, [loadQueue]);
  useEffect(() => {
    if (!title && !description) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [title, description]);

  function accept(result: FeedbackQueueSubmissionResponse) {
    // An older GET must not erase a submission accepted while it was in flight.
    ++loadSequence.current; setLoading(false);
    setItems(current => [result.item, ...current.filter(item => item.id !== result.item.id)].slice(0, 100));
    setDeliveryAvailable(result.deliveryAvailable);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setSubmitError(null); setNotice("");
    pending.current ??= { id: crypto.randomUUID(), title: title.trim(), description: description.trim(), kind, platform: "web", route: "/feedback" };
    setLocked(true);
    try {
      const result = await feedbackRequest<FeedbackQueueSubmissionResponse>("/v1/feedback/queue", pending.current);
      if (!alive.current) return;
      accept(result); pending.current = null; setLocked(false); setTitle(""); setDescription("");
      setNotice(result.item.status === "delivered" ? "Feedback saved and added to the work queue in Linear." : "Feedback saved. It is queued in Orca.");
    } catch (error) {
      if (alive.current) {
        const rejected = error instanceof FeedbackRequestError &&
          ((error.status === 400 && error.code === "invalid_feedback") || (error.status === 413 && error.code === "payload_too_large"));
        if (rejected) { pending.current = null; setLocked(false); }
        setSubmitError(`${error instanceof Error ? error.message : "Submission could not be confirmed."} Your text is still here. ${rejected ? "Edit it and try again." : "Retry to confirm this same report without creating another."}`);
      }
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function retry(id: string) {
    if (submitting.current) return;
    submitting.current = true; setRetryId(id); setNotice(""); setSubmitError(null);
    try {
      const result = await feedbackRequest<FeedbackQueueSubmissionResponse>(`/v1/feedback/queue/${encodeURIComponent(id)}/retry`, {});
      if (!alive.current) return;
      accept(result);
      setNotice(result.item.status === "delivered" ? "Feedback added to Linear." : "Feedback is still safely queued. Wait 30 seconds before retrying delivery.");
    } catch (error) {
      if (alive.current) setSubmitError(error instanceof Error ? error.message : "Could not retry delivery.");
    } finally {
      submitting.current = false;
      if (alive.current) setRetryId(null);
    }
  }

  return <main className="orca-feedback-page">
    <a className="orca-feedback-back" href="/settings">← Settings</a>
    <header><p className="settings-eyebrow">Help shape Orca</p><h1>Feedback</h1><p>A rough edge, a small idea, or something you wish worked differently.</p></header>
    <div className="orca-feedback-layout">
      <section aria-labelledby="feedback-new-title" className="orca-feedback-card">
        <h2 id="feedback-new-title">What’s on your mind?</h2>
        <p>Only the text you enter is shared. Mail, screenshots, and account details aren’t attached.</p>
        <form onSubmit={submit}>
          <label htmlFor="feedback-kind">Type</label>
          <select id="feedback-kind" value={kind} disabled={locked} onChange={event => setKind(event.target.value as FeedbackQueueSubmission["kind"])}>
            <option value="idea">Idea</option><option value="bug">Something’s broken</option><option value="question">Question</option><option value="other">Other</option>
          </select>
          <label htmlFor="feedback-title">Short title</label>
          <input id="feedback-title" autoComplete="off" maxLength={200} required value={title} disabled={locked} onChange={event => setTitle(event.target.value)} placeholder="Make it easier to…" />
          <label htmlFor="feedback-description">Tell us more</label>
          <textarea id="feedback-description" maxLength={10000} required rows={6} value={description} disabled={locked} onChange={event => setDescription(event.target.value)} placeholder="What happened? What would make it better?" />
          <button className="orca-feedback-primary" disabled={busy || retryId !== null || !title.trim() || !description.trim()} type="submit">{busy ? "Saving feedback…" : locked ? "Retry submission" : "Send feedback"}</button>
          <small>Your report is saved before delivery to the work queue. Work begins after review.</small>
        </form>
        {submitError && <p role="alert" className="orca-feedback-error">{submitError}</p>}
        <p role="status" className="orca-feedback-notice">{notice}</p>
      </section>
      <section aria-labelledby="feedback-queue-title" className="orca-feedback-card">
        <div className="orca-feedback-heading"><h2 id="feedback-queue-title">Your feedback</h2><button type="button" disabled={loading || busy || retryId !== null} onClick={() => void loadQueue()}>Refresh</button></div>
        <p>Your latest 100 reports. Queued means saved in Orca; sent to Linear means ready for review there.</p>
        {loading && <p role="status">Loading feedback…</p>}
        {loadError && <p role="alert" className="orca-feedback-error">{loadError} <button type="button" onClick={() => void loadQueue()}>Try again</button></p>}
        {!loading && !loadError && !deliveryAvailable && <p className="orca-feedback-note">Linear delivery isn’t configured. Your feedback is still saved in Orca for review.</p>}
        {!loading && !loadError && items.length === 0 && <div className="orca-feedback-empty"><strong>A little feedback goes a long way.</strong><p>Your first report will appear here once it’s saved.</p></div>}
        <ol className="orca-feedback-list">{items.map(item => <li key={item.id}>
          <div className="orca-feedback-heading"><h3>{item.title}</h3><span className="orca-feedback-badge">{item.status === "delivered" ? "Sent to Linear" : "Queued"}</span></div>
          <p className="orca-feedback-description">{item.description}</p>
          <small>{item.kind} · {new Date(item.createdAt).toLocaleDateString()} · {item.platform}</small>
          {item.status === "delivered" && item.url && /^https:\/\/linear\.app\//.test(item.url) && <a className="orca-feedback-issue" href={item.url} target="_blank" rel="noopener noreferrer">Open {item.identifier ?? "work item"} in Linear</a>}
          {item.deliveryError && <p className="orca-feedback-note">{item.deliveryError}</p>}
          {item.status === "queued" && deliveryAvailable && <button type="button" disabled={busy || retryId !== null} onClick={() => void retry(item.id)}>{retryId === item.id ? "Retrying…" : "Retry Linear delivery"}</button>}
        </li>)}</ol>
      </section>
    </div>
  </main>;
}
