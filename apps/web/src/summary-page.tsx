import { useEffect, useRef, useState } from "react";
import { inboxClassificationResponseSchema, messageDraftSchema, waitingSummarySchema, type InboxMessage, type MessageDraft } from "@orca/shared";
import { createFixtures } from "./summary-demo/fixtures";
import { canApprove, categories, countdown, countdownTone, counts, isExpired, notificationLines, pluralize, transition, type AccountId, type Action, type Code, type Reply } from "./summary-demo/model";
import { clipboardFeedback } from "./summary-demo/clipboard-feedback";
import "./summary-page.css";

const systemNow = () => Date.now();
const sectionIds = ["needs", "drafted", "waiting", "codes"];
type SummaryPageProps = { demoMode?: boolean; now?: () => number; accountId?: string; accountEmail?: string; onOpenDrafts?: () => void; onOpenInbox?: () => void; onOpenMessage?: (message: InboxMessage, origin: HTMLButtonElement) => void; onOpenDraft?: (draft: MessageDraft, origin: HTMLButtonElement) => void; onOpenWaiting?: (source: { messageId: string; threadId: string }, origin: HTMLButtonElement) => void; };
type Load<T> = { accountId: string; status: "loading" | "ready" | "error"; items: T[] };

export function SummaryPage(props: SummaryPageProps) {
  if (props.demoMode) return <SummaryDemo now={props.now} />;
  return <LiveSummary {...props} />;
}

function LiveSummary({ accountId, accountEmail, onOpenDrafts, onOpenInbox, onOpenMessage, onOpenDraft, onOpenWaiting }: SummaryPageProps) {
  const [retry, setRetry] = useState(0);
  const [openingDraft, setOpeningDraft] = useState<string | null>(null);
  const [draftOpenError, setDraftOpenError] = useState<string | null>(null);
  const activeAccount = useRef(accountId); activeAccount.current = accountId;
  const draftOpenController = useRef<AbortController | null>(null);
  const [mail, setMail] = useState<Load<InboxMessage> | null>(null);
  const [drafts, setDrafts] = useState<Load<MessageDraft> | null>(null);
  const [focus, setFocus] = useState<Load<InboxMessage> | null>(null);
  const [quiet, setQuiet] = useState<Load<InboxMessage> | null>(null);
  const [waiting, setWaiting] = useState<Load<ReturnType<typeof waitingSummarySchema.parse>["waitingOn"][number]> | null>(null);
  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    setOpeningDraft(null); setDraftOpenError(null);
    setMail({ accountId, status: "loading", items: [] });
    setDrafts({ accountId, status: "loading", items: [] });
    setFocus({ accountId, status: "loading", items: [] });
    setQuiet({ accountId, status: "loading", items: [] });
    setWaiting({ accountId, status: "loading", items: [] });
    const read = async (url: string) => {
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Request failed");
      return response.json();
    };
    const params = new URLSearchParams({ classification: "human", limit: "5", accountId });
    void read(`/v1/summary/waiting?${new URLSearchParams({ accountId })}`).then(value => {
      const result = waitingSummarySchema.parse(value);
      if (result.accountId !== accountId) throw new Error("Wrong account");
      if (!controller.signal.aborted) setWaiting({ accountId, status: "ready", items: result.waitingOn });
    }).catch(() => { if (!controller.signal.aborted) setWaiting({ accountId, status: "error", items: [] }); });
    void read(`/v1/inbox?${params}`).then(value => {
      const page = inboxClassificationResponseSchema.parse(value);
      if (!controller.signal.aborted) setMail({ accountId, status: "ready", items: page.messages.filter(item => item.accountId === accountId) });
    }).catch(() => { if (!controller.signal.aborted) setMail({ accountId, status: "error", items: [] }); });
    for (const [view, setView] of [["focus", setFocus], ["quiet", setQuiet]] as const) {
      const params = new URLSearchParams({ view, classification: "all", limit: "3", accountId });
      void read(`/v1/inbox?${params}`).then(value => {
        const page = inboxClassificationResponseSchema.parse(value);
        if (!controller.signal.aborted) setView({ accountId, status: "ready", items: page.messages.filter(item => item.accountId === accountId) });
      }).catch(() => { if (!controller.signal.aborted) setView({ accountId, status: "error", items: [] }); });
    }
    void read(`/v1/drafts?${new URLSearchParams({ accountId, omitSentContent: "true" })}`).then(value => {
      if (!Array.isArray(value)) throw new Error("Invalid drafts");
      const items = value.map(item => messageDraftSchema.parse(item)).filter(item => item.accountId === accountId && item.deliveryStatus === "draft");
      if (!controller.signal.aborted) setDrafts({ accountId, status: "ready", items });
    }).catch(() => { if (!controller.signal.aborted) setDrafts({ accountId, status: "error", items: [] }); });
    return () => { controller.abort(); draftOpenController.current?.abort(); draftOpenController.current = null; };
  }, [accountId, retry]);
  const currentMail = mail?.accountId === accountId ? mail : null;
  const currentDrafts = drafts?.accountId === accountId ? drafts : null;
  const currentWaiting = waiting?.accountId === accountId ? waiting : null;
  async function openDraft(id: string, origin: HTMLButtonElement) {
    if (!accountId || draftOpenController.current) return;
    const controller = new AbortController();
    draftOpenController.current = controller;
    setOpeningDraft(id); setDraftOpenError(null);
    try {
      const response = await fetch(`/v1/drafts/${encodeURIComponent(id)}?${new URLSearchParams({ accountId })}`, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Draft unavailable");
      const draft = messageDraftSchema.parse(await response.json());
      if (draft.accountId !== accountId || draft.id !== id || draft.deliveryStatus !== "draft") throw new Error("Draft unavailable");
      if (!controller.signal.aborted && activeAccount.current === accountId) onOpenDraft?.(draft, origin);
    } catch {
      if (!controller.signal.aborted && activeAccount.current === accountId) setDraftOpenError("Could not open this draft. Refresh Summary and try again.");
    } finally {
      if (!controller.signal.aborted && activeAccount.current === accountId) { draftOpenController.current = null; setOpeningDraft(null); }
    }
  }
  const retryButton = <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button>;
  function attentionSection(label: string, state: Load<InboxMessage> | null) {
    const current = state?.accountId === accountId ? state : null;
    return <section aria-label={label}><h2>{label}</h2>
      {!current || current.status === "loading" ? <p role="status">Loading {label.toLowerCase()}…</p> : current.status === "error" ? <><p role="alert">{label} could not be loaded.</p>{retryButton}</> : <>
        <p>Up to three recent messages in this space.</p>
        {current.items.length ? current.items.map(item => <article className="summary-card" key={`${item.accountId}:${item.id}`}><h3>{item.subject || "(no subject)"}</h3><p>{item.from.name || item.from.email}{item.unread ? " · Unread" : ""}</p><button type="button" aria-label={`Open message: ${item.subject || "no subject"}`} onClick={event => onOpenMessage?.(item, event.currentTarget)}>Open message</button></article>) : <p>No messages here.</p>}
      </>}
    </section>;
  }

  return <section aria-labelledby="summary-title" className="summary-page">
    <header className="summary-intro"><h1 id="summary-title">Summary</h1><p>{accountEmail ? `For ${accountEmail}` : "Loading your account…"}</p><p>Snapshot loaded when you opened Summary. Refresh to see recent changes.</p><button type="button" disabled={!accountId} onClick={() => setRetry(value => value + 1)}>Refresh Summary</button></header>
    <section aria-labelledby="summary-needs"><h2 id="summary-needs">Recent human Inbox mail</h2>
      {!currentMail || currentMail.status === "loading" ? <p role="status">Loading mail…</p> : currentMail.status === "error" ? <><p role="alert">Mail could not be loaded.</p>{retryButton}</> : <>
        <p>Up to five recent Inbox messages classified as likely human.</p>
        {currentMail.items.length ? currentMail.items.map(item => <article className="summary-card" key={`${item.accountId}:${item.id}`}><h3>{item.subject || "(no subject)"}</h3><p>{item.from.name || item.from.email}{item.unread ? " · Unread" : ""}</p><button type="button" aria-label={`Open message: ${item.subject || "no subject"}`} onClick={event => onOpenMessage?.(item, event.currentTarget)}>Open message</button></article>) : <p>No recent human mail.</p>}
        <button type="button" onClick={onOpenInbox}>Open Inbox</button>
      </>}
    </section>
    <section aria-labelledby="summary-drafted"><h2 id="summary-drafted">Saved drafts</h2>
      {!currentDrafts || currentDrafts.status === "loading" ? <p role="status">Loading drafts…</p> : currentDrafts.status === "error" ? <><p role="alert">Drafts could not be loaded.</p>{retryButton}</> : <>
        {currentDrafts.items.length ? <><p>{currentDrafts.items.length} saved {currentDrafts.items.length === 1 ? "draft" : "drafts"}.{currentDrafts.items.length > 5 ? " Showing the first five." : ""}</p>{currentDrafts.items.slice(0, 5).map(item => <article className="summary-card" key={item.id}><h3>{item.subject.trim() || "(no subject)"}</h3><p>{item.to.length ? item.to.map(person => person.name || person.email).join(", ") : "No recipient yet"}</p><button type="button" aria-label={`Open draft: ${item.subject.trim() || "no subject"}`} disabled={openingDraft !== null} onClick={event => void openDraft(item.id, event.currentTarget)}>{openingDraft === item.id ? "Opening…" : "Open draft"}</button></article>)}</> : <p>No saved drafts yet.</p>}
        {draftOpenError && <p role="alert">{draftOpenError}</p>}
        <button type="button" onClick={onOpenDrafts}>Open Drafts</button>
      </>}
    </section>
    {attentionSection("Focus", focus)}
    {attentionSection("Quiet", quiet)}
    <section aria-labelledby="summary-waiting"><h2 id="summary-waiting">Possible follow-ups</h2>
      <p>Estimates from up to 500 messages in the last 14 days: the latest message appears to be from your address and is over three days old. This does not establish that a reply is expected.</p>
      {!currentWaiting || currentWaiting.status === "loading" ? <p role="status">Loading possible follow-ups…</p> : currentWaiting.status === "error" ? <><p role="alert">Possible follow-ups could not be loaded.</p>{retryButton}</> : currentWaiting.items.length ? currentWaiting.items.map(item => <article className="summary-card" key={item.source.threadId}><h3>{item.title || "(no subject)"}</h3><p>Last observed {item.days} days ago</p><button type="button" aria-label={`Open conversation: ${item.title || "no subject"}`} onClick={event => onOpenWaiting?.(item.source, event.currentTarget)}>Open conversation</button></article>) : <p>No possible follow-ups found in this window.</p>}
    </section>
    <section aria-labelledby="summary-more"><h2 id="summary-more">More in Summary</h2><p>Codes are not available here yet.</p></section>
  </section>;
}

function SummaryDemo({ now = systemNow }: { now?: () => number }) {
  const [state, setState] = useState(() => createFixtures(now()));
  const [accountId, setAccountId] = useState<AccountId>("work");
  const [digestByAccount, setDigestByAccount] = useState({ work: false, personal: false });
  const [time, setTime] = useState(now);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const headings = useRef<Array<HTMLHeadingElement | null>>([]);
  useEffect(() => {
    const timer = setInterval(() => setTime(now()), 1000);
    return () => clearInterval(timer);
  }, [now]);
  const account = state[accountId];
  const digest = digestByAccount[accountId];
  const totals = counts(account, time);
  function update(action: Action) { setState(current => transition(current, accountId, action)); }
  async function copy(code: Code) {
    if (isExpired(code, now())) {
      setTime(now());
      setFeedback(current => ({ ...current, [code.id]: clipboardFeedback("expired") }));
      return;
    }
    try {
      await navigator.clipboard.writeText(code.value);
      setFeedback(current => ({ ...current, [code.id]: clipboardFeedback("copied") }));
    } catch {
      setFeedback(current => ({ ...current, [code.id]: clipboardFeedback("failed") }));
    }
  }
  function draftEditor(reply: Reply, stopped = false) {
    return <div className="summary-draft">
      <span className="summary-chip" data-status={reply.status}>{reply.status}</span>
      <label htmlFor={reply.id}>Reply for {reply.subject}</label>
      <textarea id={reply.id} value={reply.body} disabled={stopped || reply.status === "Approved"}
        aria-describedby={!reply.body.trim() ? `${reply.id}-hint` : undefined}
        onInput={event => update({ type: "edit", id: reply.id, body: event.currentTarget.value })} />
      {!reply.body.trim() && <p id={`${reply.id}-hint`}>Enter a reply before approving.</p>}
      <button disabled={stopped || !canApprove(reply)} onClick={() => update({ type: "approve", id: reply.id })}>Approve reply</button>
      {reply.status === "Approved" && <p role="status">Demo: nothing was sent</p>}
    </div>;
  }
  function heading(index: number, label: string) {
    return <h2 id={`summary-${sectionIds[index]}`} data-section={sectionIds[index]} tabIndex={-1} ref={node => { headings.current[index] = node; }}>{label}</h2>;
  }
  return <section aria-labelledby="summary-title" className="summary-page">
    <header className="summary-intro"><div className="summary-toolbar"><span className="summary-chip">Demo data</span><span>Fixture preview · changes last while this page is open</span></div>
      <h1 id="summary-title">Summary</h1><p>A little clarity for your day.</p>
    </header>
    <div className="summary-toolbar">
      <div className="summary-accounts" role="group" aria-label="Demo account">
        {(["work", "personal"] as const).map(id => <button key={id} aria-pressed={accountId === id} onClick={() => { setAccountId(id); setTime(now()); }}>{id === "work" ? "Work" : "Personal"}</button>)}
      </div>
      <button aria-pressed={digest} onClick={() => setDigestByAccount(current => ({ ...current, [accountId]: !digest }))}>Digest</button>
    </div>
    <section aria-labelledby="summary-glance"><h2 id="summary-glance">At a glance</h2>
      <div className="summary-tiles">{categories.map((category, index) => <button key={category} data-section={sectionIds[index]} onClick={() => headings.current[index]?.focus()}><strong>{totals[index]}</strong><span>{category}</span></button>)}</div>
    </section>
    {digest && <p>Digest · category counts only</p>}
    <section aria-labelledby="summary-needs">{heading(0, "Needs your attention")}
      {!digest && account.attention.map(item => <article className="summary-card" key={item.id}><h3>{item.subject}</h3><p>{item.person}</p><p>Why: {item.reason}</p>
        {item.handled && <span className="summary-chip" data-status="Handled">Handled</span>}<button disabled={item.handled} onClick={() => update({ type: "handle", id: item.id })}>Mark handled</button></article>)}
    </section>
    <section aria-labelledby="summary-drafted">{heading(1, "Drafted replies")}
      {!digest && account.replies.map(reply => <article className="summary-card" key={reply.id}><h3>{reply.subject}</h3><p>{reply.person}</p>{draftEditor(reply)}</article>)}
    </section>
    <section aria-labelledby="summary-waiting">{heading(2, "Waiting on")}
      {!digest && account.waiting.map(item => <article className="summary-card" key={item.id}><h3>{item.subject}</h3><p>{item.person} · {pluralize(item.days, "day")} waiting</p>
        {item.stopped && <span className="summary-chip" data-status="Stopped">Stopped</span>}
        <div className="summary-toolbar"><button disabled={item.stopped || Boolean(item.draft)} onClick={() => update({ type: "follow-up", id: item.id })}>Draft follow-up</button><button disabled={item.stopped} onClick={() => update({ type: "stop", id: item.id })}>Stop tracking</button></div>
        {item.draft && draftEditor(item.draft, item.stopped)}</article>)}
    </section>
    <section aria-labelledby="summary-codes">{heading(3, "Codes")}
      {!digest && account.codes.map(code => {
        const expired = isExpired(code, time);
        return <article className="summary-card" key={code.id}><h3>{code.subject}</h3><p>{code.person}</p><p data-tone={countdownTone(code, time)}>{countdown(code, time)}</p>
          <div className="summary-code-row"><output aria-label="Verification code">{revealed[code.id] && !expired ? code.value : "••••••"}</output>
            <button disabled={expired} aria-pressed={Boolean(revealed[code.id]) && !expired} onClick={() => setRevealed(current => ({ ...current, [code.id]: !current[code.id] }))}>{revealed[code.id] && !expired ? "Hide" : "Reveal"}</button>
            <div className="summary-copy"><button onClick={() => void copy(code)}>Copy</button><span aria-live="polite">{feedback[code.id] ?? ""}</span></div>
          </div></article>;
      })}
    </section>
    {!digest && <details className="summary-disclosure"><summary data-section="routine">Routine · {account.routine.length}</summary>{account.routine.map(item => <article key={item.id}><h3>{item.subject}</h3><p>{item.person}</p></article>)}</details>}
    <details className="summary-disclosure"><summary>Notification preview</summary><p>Example only · category counts</p><ul>{notificationLines(account, time).map(line => <li key={line}>{line}</li>)}</ul></details>
  </section>;
}
