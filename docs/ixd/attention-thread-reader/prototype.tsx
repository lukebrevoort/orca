import React, { useRef, useState, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { behaviors, inbox, labels, messages as fixtureMessages, thread } from "./fixture";
import { decodePreview, groupAttention, initialMessage, splitTrailingQuote } from "./model";
import "./prototype.css";

const messages = new URLSearchParams(location.search).get("read") === "all" ? fixtureMessages.map(m => ({...m, unread:false})) : fixtureMessages;
const platform = document.getElementById("root")!.dataset.platform!;
const stamp = (date: string) => new Intl.DateTimeFormat("en", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:"UTC" }).format(new Date(date));
const day = (date: string) => date.slice(0,10) === "2026-10-08" ? "Today" : date.slice(0,10) === "2026-10-07" ? "Yesterday" : "Earlier this week";

function Prototype() {
  const [dark, setDark] = useState(false);
  const [screen, setScreen] = useState("reader");
  const [opened, setOpened] = useState(new Set([initialMessage(messages)!.id]));
  const [earlier, setEarlier] = useState(false);
  const [original, setOriginal] = useState(new Set<string>());
  const [emailLayout, setEmailLayout] = useState(new Set<string>());
  const [why, setWhy] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [large, setLarge] = useState(false);
  const refs = useRef(new Map<string, HTMLElement>());
  const firstUnread = messages.findIndex(m => m.unread);
  const entryIndex = firstUnread < 0 ? messages.length - 1 : firstUnread;
  const unreadCount = messages.filter(m=>m.unread).length;
  const toggle = (set: Set<string>, value: string) => { const next = new Set(set); next.has(value) ? next.delete(value) : next.add(value); return next; };
  function jump(id: string) { setEarlier(true); setOpened(s => new Set([...s,id])); setTarget(id); }
  useLayoutEffect(() => { if (target) { refs.current.get(target)?.scrollIntoView({block:"start"}); refs.current.get(target)?.focus({preventScroll:true}); setTarget(null); } }, [target]);
  const allOpen = opened.size === messages.length;
  return <div className={`prototype ${platform} ${dark ? "dark" : ""} ${large ? "large" : ""}`}>
    <div className="review-ribbon">DESIGN PREVIEW <span>Synthetic mail · no account connected</span></div>
    <aside className="sidebar"><div className="wordmark">orca <span>≈</span></div><p className="eyebrow">Mail</p><button onClick={()=>setScreen("inbox")} aria-pressed={screen==="inbox"}>All mail <span>10</span></button><button onClick={()=>setScreen("reader")} aria-pressed={screen==="reader"}>Reading room <span>24</span></button><p className="sidebar-note">Attention sets the order.<br/>Spaces say where mail lives.</p><div className="profile"><span className="avatar">AM</span><span>Alex Morgan<small>Fixture account</small></span></div></aside>
    <main>
      <header className="topbar"><button onClick={()=>setScreen(screen === "reader" ? "inbox" : "reader")}>{screen === "reader" ? "← All mail" : "Open conversation →"}</button><div><button onClick={()=>setLarge(!large)} aria-pressed={large}>Large text</button><button onClick={()=>setDark(!dark)} aria-pressed={dark}>{dark ? "Light" : "Black"}</button></div></header>
      {screen === "inbox" ? <div className="inbox-page"><p className="eyebrow">Thursday, October 8</p><h1>All mail</h1><p className="intro">Sorted by attention, then newest within each group.</p><div className="priority-legend">{behaviors.map(b=><span key={b}>{labels[b]}</span>)}</div>
        {groupAttention(inbox).map(group=><section className="attention-group" key={group.behavior} aria-label={labels[group.behavior]}><header><h2>{labels[group.behavior]}</h2><span>{group.messages.length} conversations</span></header>{group.messages.map((row,i)=><React.Fragment key={row.id}>{i===0||day(row.receivedAt)!==day(group.messages[i-1]!.receivedAt)?<h3 className="date-label">{day(row.receivedAt)}</h3>:null}<div className="mail-row"><button className="mail-open" disabled={row.threadId !== thread.thread.id} title={row.threadId !== thread.thread.id ? "Only Reading room has a conversation in this preview" : undefined} onClick={()=>setScreen("reader")}><span className="avatar">{row.from.name!.split(" ").map(s=>s[0]).join("")}</span><span className="mail-copy"><strong>{row.from.name}<span className="attention-label">{labels[group.behavior]}</span></strong><b>{row.subject}</b><span>{decodePreview(row.snippet)}</span></span><time>{stamp(row.receivedAt).split(",")[0]}</time></button><div className="placement"><span>Space: Everything else</span><button onClick={()=>setWhy(row.id)}>Why this order?</button></div>{why===row.id?<div className="why-panel"><strong>{labels[group.behavior]} attention</strong><p>This conversation is above lower-attention groups. Newest messages come first within {labels[group.behavior]}.</p><p>Source: current attention value. The winning rule is unavailable in this fixture. “Everything else” is its space, not its priority.</p><button onClick={()=>setWhy(null)}>Close explanation</button></div>:null}</div></React.Fragment>)}</section>)}
      </div> : <div className="conversation"><header className="conversation-heading"><p className="eyebrow">CONVERSATION <span className="attention-label">Focus</span></p><h1>Reading room<br className="desktop-break"/> · opening weekend</h1><p>Maya, Noah & you <span>· 24 messages · {unreadCount} unread</span></p><div className="thread-context"><span>Space: Everything else</span><button onClick={()=>setWhy(why?null:"thread")}>Why Focus?</button></div>{why=== "thread" ? <div className="why-panel"><p>Current attention: Focus. Rule provenance is unavailable. This does not establish which rule placed the conversation in Everything else.</p></div>:null}</header>
        <nav className="reader-tools" aria-label="Conversation navigation"><button disabled={firstUnread < 0} onClick={()=>{if(firstUnread >= 0)jump(messages[firstUnread]!.id);}}>First unread <span>{unreadCount}</span></button><button onClick={()=>jump(messages.at(-1)!.id)}>Newest ↓</button><button onClick={()=>{setEarlier(!allOpen);setOpened(allOpen?new Set([initialMessage(messages)!.id]):new Set(messages.map(m=>m.id)));}}>{allOpen ? "Collapse all" : "Expand all"}</button></nav>
        <div className="message-stack"><button className="earlier" onClick={()=>setEarlier(!earlier)} aria-expanded={earlier}><span>{earlier ? "−" : "+"} {entryIndex} earlier messages</span><small>{entryIndex === 21 ? "Oct 1–7 · all read" : "Earlier in this conversation"}</small></button>
          {messages.filter((_,i)=>earlier||i>=entryIndex).map(message=>{const isOpen=opened.has(message.id); const isOriginal=original.has(message.id); const parts=splitTrailingQuote(message.bodyText!);return <React.Fragment key={message.id}>{firstUnread >= 0 && message.id===messages[firstUnread]!.id?<div className="unread-boundary">First unread <span>Thursday, October 8</span></div>:null}<article className={`message-card ${isOpen?"open":""}`} tabIndex={-1} ref={node=>{if(node)refs.current.set(message.id,node);else refs.current.delete(message.id);}} data-message={message.id}>
            <button className="card-toggle" aria-expanded={isOpen} aria-controls={`body-${message.id}`} onClick={()=>setOpened(s=>toggle(s,message.id))}><span className="avatar">{message.from.name!.split(" ").map(s=>s[0]).join("")}</span><span className="card-copy"><strong>{message.from.name} {message.unread?<span className="unread">Unread</span>:null}{message===messages.at(-1)?<span className="newest">Newest</span>:null}</strong><span className="recipients">To {message.to.map(r=>r.name??r.email).join(", ")}{message.cc.length?` · Cc ${message.cc.length}`:""}</span>{!isOpen?<span className="preview">{message.snippet}</span>:null}</span><span className="card-end"><time>{stamp(message.receivedAt)}</time><span>{isOpen?"−":"+"}</span></span></button>
            <div className="message-expanded" id={`body-${message.id}`} hidden={!isOpen}>
              <details className="recipient-detail"><summary>{message.from.email} · Details</summary><dl><dt>From</dt><dd>{message.from.email}</dd><dt>To</dt><dd>{message.to.map(r=>r.email).join(", ")}</dd>{message.cc.length?<><dt>Cc</dt><dd>{message.cc.map(r=>r.email).join(", ")}</dd></>:null}<dt>Sent</dt><dd>{stamp(message.receivedAt)} UTC</dd></dl></details>
              <div className="body-text">{isOriginal ? message.bodyText : parts.current}</div>
              {!isOriginal && parts.quote ? <details className="quote"><summary>Quoted history · show</summary><div className="body-text">{parts.quote}</div></details> : null}
              <div className="body-options"><button aria-pressed={isOriginal} onClick={()=>setOriginal(s=>toggle(s,message.id))}>{isOriginal?"Return to reading view":"Show complete original text"}</button>{message.bodyHtml?<button aria-pressed={emailLayout.has(message.id)} onClick={()=>setEmailLayout(s=>toggle(s,message.id))}>Email layout</button>:null}</div>
              {message.bodyHtml && emailLayout.has(message.id)?<section className="email-layout" aria-label="Complete sanitized email layout"><p className="eyebrow">Complete email layout · synthetic sanitized HTML</p><div dangerouslySetInnerHTML={{__html:message.bodyHtml}}/></section>:null}
              {message.attachments.length?<div className="attachment"><span>↳</span><div><strong>reading-room-plan.pdf</strong><small>42 KB · Details only in web preview</small></div></div>:null}
            </div></article></React.Fragment>;})}
        </div><footer className="reader-footer"><p>All 24 messages remain available.</p><div><button disabled title="Sending is outside this design preview">Reply</button><button disabled>Reply all</button><button disabled>Forward</button></div><small>Sending is unavailable in this synthetic preview.</small></footer>
      </div>}
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Prototype/>);
