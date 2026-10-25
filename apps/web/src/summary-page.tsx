import { useEffect, useRef, useState } from "react";
import { createFixtures } from "./summary-demo/fixtures";
import { canApprove, categories, countdown, counts, isExpired, notificationLines, pluralize, transition, type AccountId, type Action, type Code, type Reply } from "./summary-demo/model";
import { clipboardFeedback } from "./summary-demo/clipboard-feedback";
import "./summary-page.css";

const systemNow = () => Date.now();
const sectionIds = ["needs", "drafted", "waiting", "codes"];
export function SummaryPage({ now = systemNow }: { now?: () => number }) {
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
      <span className="summary-chip">{reply.status}</span>
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
    return <h2 id={`summary-${sectionIds[index]}`} tabIndex={-1} ref={node => { headings.current[index] = node; }}>{label}</h2>;
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
      <div className="summary-tiles">{categories.map((category, index) => <button key={category} onClick={() => headings.current[index]?.focus()}><strong>{totals[index]}</strong><span>{category}</span></button>)}</div>
    </section>
    {digest && <p>Digest · category counts only</p>}
    <section aria-labelledby="summary-needs">{heading(0, "Needs your attention")}
      {!digest && account.attention.map(item => <article className="summary-card" key={item.id}><h3>{item.subject}</h3><p>{item.person}</p><p>Why: {item.reason}</p>
        {item.handled && <span className="summary-chip">Handled</span>}<button disabled={item.handled} onClick={() => update({ type: "handle", id: item.id })}>Mark handled</button></article>)}
    </section>
    <section aria-labelledby="summary-drafted">{heading(1, "Drafted replies")}
      {!digest && account.replies.map(reply => <article className="summary-card" key={reply.id}><h3>{reply.subject}</h3><p>{reply.person}</p>{draftEditor(reply)}</article>)}
    </section>
    <section aria-labelledby="summary-waiting">{heading(2, "Waiting on")}
      {!digest && account.waiting.map(item => <article className="summary-card" key={item.id}><h3>{item.subject}</h3><p>{item.person} · {pluralize(item.days, "day")} waiting</p>
        {item.stopped && <span className="summary-chip">Stopped</span>}
        <div className="summary-toolbar"><button disabled={item.stopped || Boolean(item.draft)} onClick={() => update({ type: "follow-up", id: item.id })}>Draft follow-up</button><button disabled={item.stopped} onClick={() => update({ type: "stop", id: item.id })}>Stop tracking</button></div>
        {item.draft && draftEditor(item.draft, item.stopped)}</article>)}
    </section>
    <section aria-labelledby="summary-codes">{heading(3, "Codes")}
      {!digest && account.codes.map(code => {
        const expired = isExpired(code, time);
        return <article className="summary-card" key={code.id}><h3>{code.subject}</h3><p>{code.person}</p><p>{countdown(code, time)}</p>
          <div className="summary-code-row"><output aria-label="Verification code">{revealed[code.id] && !expired ? code.value : "••••••"}</output>
            <button disabled={expired} aria-pressed={Boolean(revealed[code.id]) && !expired} onClick={() => setRevealed(current => ({ ...current, [code.id]: !current[code.id] }))}>{revealed[code.id] && !expired ? "Hide" : "Reveal"}</button>
            <div className="summary-copy"><button onClick={() => void copy(code)}>Copy</button><span aria-live="polite">{feedback[code.id] ?? ""}</span></div>
          </div></article>;
      })}
    </section>
    {!digest && <details className="summary-disclosure"><summary>Routine · {account.routine.length}</summary>{account.routine.map(item => <article key={item.id}><h3>{item.subject}</h3><p>{item.person}</p></article>)}</details>}
    <details className="summary-disclosure"><summary>Notification preview</summary><p>Example only · category counts</p><ul>{notificationLines(account, time).map(line => <li key={line}>{line}</li>)}</ul></details>
  </section>;
}
