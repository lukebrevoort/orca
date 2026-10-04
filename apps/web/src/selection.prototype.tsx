/** Throwaway: three interaction models on /dev/inbox?selection-prototype&variant=A.
 * Sample mail only; actions are in-memory. No provider mutations or persistence.
 */
import { useEffect, useRef, useState } from "react";
import type { InboxMessage } from "@orca/shared";
import "./selection.prototype.css";

const concepts = [
  { key: "A", name: "Place", description: "Pick up a conversation. Give it a place.", note: "Drag a letter into a space. To gather several, tap their initials first. You can also tap a space to place them." },
  { key: "B", name: "Sweep", description: "Start with what you want to do.", note: "Choose a space, then sweep across the conversations that belong there. Nothing moves until you finish." },
  { key: "C", name: "Sentence", description: "One thought. One decision.", note: "Mark the conversations, finish the sentence, and let the rest disappear." },
];
const spaces = [
  { name: "Focus", mark: "◉", hint: "Keep it close", detail: "The conversations you want to return to." },
  { name: "Quiet", mark: "☾", hint: "Give it room", detail: "Still here. Just out of your way." },
  { name: "Later", mark: "↗", hint: "Another time", detail: "A place for things that can wait." },
];
const label = (message: InboxMessage) => message.from.name || message.from.email;
const initials = (message: InboxMessage) => label(message).split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();

export default function SelectionPrototype({ messages }: { messages: InboxMessage[] }) {
  const sweep = useRef<boolean | null>(null);
  const [variant, setVariant] = useState(() => new URLSearchParams(location.search).get("variant") || "A");
  const [selected, setSelected] = useState<string[]>([]);
  const [moved, setMoved] = useState<string[]>([]);
  const [destination, setDestination] = useState<string | null>(null);
  const [hoveredSpace, setHoveredSpace] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<{ ids: string[]; destination: string } | null>(null);
  const [reading, setReading] = useState<InboxMessage | null>(null);
  const concept = concepts.find(item => item.key === variant) || concepts[0]!;
  const mail = messages.slice(0, 8).filter(message => !moved.includes(message.id));
  function switchVariant(key: string) {
    const url = new URL(location.href); url.searchParams.set("variant", key); history.replaceState({}, "", url);
    setVariant(key); setSelected([]); setMoved([]); setDestination(null); setReceipt(null); setReading(null);
  }
  function cycle(delta: number) { switchVariant(concepts[(concepts.indexOf(concept) + delta + concepts.length) % concepts.length]!.key); }
  function toggle(id: string) { setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
  function place(target: string, ids = selected) {
    if (!ids.length) return;
    setReceipt({ ids, destination: target }); setMoved(current => [...current, ...ids]); setSelected([]); setDestination(null); setDragged([]);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); cycle(event.key === "ArrowRight" ? 1 : -1); }
      if (event.key === "Escape") { setReading(null); setSelected([]); setDestination(null); }
    };
    const endSweep = () => { sweep.current = null; };
    window.addEventListener("pointerup", endSweep);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerup", endSweep); };
  });
  function rows(mode: "place" | "sweep" | "sentence") {
    return <div className={`selection-study-mail selection-study-mail-${mode}`}>
      {mail.length === 0 && <div className="selection-study-empty"><span>All clear.</span><p>Some room to think.</p><button onClick={() => { setMoved([]); setReceipt(null); }}>Bring the sample mail back</button></div>}
      {mail.map((message, index) => {
        const picked = selected.includes(message.id);
        const isGathering = mode === "sentence" || mode === "sweep" && !!destination;
        return <article key={message.id} className={`selection-study-letter ${picked ? "is-held" : ""}`} draggable={mode === "place"}
          onPointerDown={event => { if (mode !== "sweep" || !destination || event.button !== 0) return; event.preventDefault(); sweep.current = !picked; toggle(message.id); }}
          onPointerEnter={event => { if (mode !== "sweep" || !destination || event.buttons !== 1 || sweep.current === null) return; setSelected(current => sweep.current ? current.includes(message.id) ? current : [...current, message.id] : current.filter(id => id !== message.id)); }}
          onDragStart={event => { const ids = picked ? selected : [message.id]; setDragged(ids); event.dataTransfer.setData("text/plain", ids.join(",")); event.dataTransfer.effectAllowed = "all"; }} onDragEnd={() => { setDragged([]); setHoveredSpace(null); }}>
          {mode !== "sweep" && <button className="selection-study-initial" aria-pressed={picked} aria-label={`${picked ? "Release" : "Gather"} ${label(message)}`} onClick={() => toggle(message.id)}><span>{initials(message)}</span><i aria-hidden="true">{picked ? "✓" : "+"}</i></button>}
          <button className="selection-study-letter-body" aria-pressed={isGathering ? picked : undefined} aria-label={isGathering ? `${picked ? "Release" : "Gather"} ${message.subject}` : `Read ${message.subject}`} onClick={event => { if (mode === "sweep" && destination && event.detail > 0) return; isGathering ? toggle(message.id) : setReading(message); }}>
            <span className="selection-study-sender">{label(message)} <small>{index < 2 ? "a moment ago" : "earlier today"}</small></span>
            <strong>{message.subject || "A note for you"}</strong>
            <span className="selection-study-snippet">{message.snippet}</span>
          </button>
          {mode === "sweep" && destination && <button aria-label={`${picked ? "Release" : "Gather"} ${label(message)}`} aria-pressed={picked} className="selection-study-sweep-mark" onClick={event => { if (event.detail === 0) toggle(message.id); }}>{picked ? "✓" : "＋"}</button>}
          {mode === "place" && <span aria-hidden="true" className="selection-study-grip">⠿</span>}
        </article>;
      })}
    </div>;
  }
  return <section className={`selection-study selection-study-${concept.key}`} aria-label="Selection interaction prototype">
    <header className="selection-study-heading"><span className="selection-study-eyebrow">An inbox with room to think</span><h1>Inbox<span>{mail.length}</span></h1><p>{concept.description}</p></header>
    {receipt && <div className="selection-study-receipt" role="status"><span>{receipt.ids.length === 1 ? "One conversation" : `${receipt.ids.length} conversations`} placed in {receipt.destination}.</span><button onClick={() => { setMoved(current => current.filter(id => !receipt.ids.includes(id))); setReceipt(null); }}>Undo</button></div>}
    {concept.key === "A" && <div className="selection-study-place-layout">
      <div><div className="selection-study-list-heading"><span>YOUR LETTERS</span><span>{selected.length ? `${selected.length} in hand` : "Tap initials to gather"}</span></div>{rows("place")}</div>
      <aside className={`selection-study-places ${selected.length || dragged.length ? "is-ready" : ""}`} aria-label="Places for your mail"><div className="selection-study-places-intro"><span>Make a little space.</span><p>{selected.length ? "Where would you like these to live?" : "A home for whatever comes next."}</p></div>
        {spaces.map(space => <button key={space.name} className={`selection-study-place ${hoveredSpace === space.name ? "is-over" : ""}`} disabled={!selected.length && !dragged.length} onClick={() => place(space.name)} onDragEnter={event => event.preventDefault()} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setHoveredSpace(space.name); }} onDragLeave={() => setHoveredSpace(null)} onDrop={event => { event.preventDefault(); place(space.name, dragged); setHoveredSpace(null); }}><span className="selection-study-space-mark" aria-hidden="true">{space.mark}</span><strong>{space.name}</strong><span>{space.hint}</span><i aria-hidden="true">↗</i></button>)}
        {selected.length > 0 && <button className="selection-study-release" onClick={() => setSelected([])}>Put them back <kbd>esc</kbd></button>}
        <p className="selection-study-footnote">Only these conversations move.<br/>Their senders stay as they are.</p>
      </aside>
    </div>}
    {concept.key === "B" && <>
      <div className="selection-study-intent"><span className="selection-study-eyebrow">What would make today lighter?</span><div>{spaces.map(space => <button key={space.name} aria-pressed={destination === space.name} onClick={() => { setDestination(space.name); setSelected([]); }}><span aria-hidden="true">{space.mark}</span><strong>{space.hint}</strong><small>Move to {space.name}</small></button>)}</div></div>
      <div className="selection-study-sweep-heading"><p>{destination ? <>Which conversations belong in <strong>{destination}</strong>?</> : "Choose an intention above, then sweep up the mail that fits."}</p>{destination && <button onClick={() => { setDestination(null); setSelected([]); }}>Never mind</button>}</div>
      {rows("sweep")}
      {selected.length > 0 && destination && <div className="selection-study-finish"><span>{selected.length} {selected.length === 1 ? "conversation" : "conversations"}. A little more room.</span><button onClick={() => place(destination)}>Place in {destination} <span aria-hidden="true">→</span></button></div>}
    </>}
    {concept.key === "C" && <>
      <div className="selection-study-sentence"><span>Let’s put</span><button className="selection-study-word" onClick={() => setSelected(selected.length === mail.length ? [] : mail.map(message => message.id))}>{selected.length ? `these ${selected.length} conversations` : "a few conversations"}</button><span>in</span><label><span className="visually-hidden">Choose a space</span><select value={destination || ""} onChange={event => setDestination(event.target.value)}><option value="" disabled>a space</option>{spaces.map(space => <option key={space.name}>{space.name}</option>)}</select></label><span>.</span>{selected.length > 0 && destination && <button className="selection-study-sentence-commit" aria-label={`Place in ${destination}`} onClick={() => place(destination)}>↗</button>}</div>
      <div className="selection-study-sentence-sub"><p>{selected.length ? "Just these conversations. Nothing else changes." : "Tap the initials beside any conversation to begin."}</p>{selected.length > 0 && <button onClick={() => setSelected([])}>Start over</button>}</div>
      {rows("sentence")}
    </>}
    <p className="selection-study-instruction">{concept.note}</p>
    <nav className="selection-study-switcher" aria-label="Prototype concepts"><button aria-label="Previous concept" onClick={() => cycle(-1)}>←</button><div><small>INTERACTION STUDY · SAMPLE MAIL ONLY</small><strong>{concept.key} / {concept.name}</strong><output>{selected.length} held{destination ? ` · ${destination}` : ""} · {moved.length} placed</output></div><button aria-label="Next concept" onClick={() => cycle(1)}>→</button><button className="selection-study-reset" onClick={() => switchVariant(concept.key)}>Reset</button></nav>
    {reading && <div className="selection-study-reader-backdrop" onClick={() => setReading(null)}><section role="dialog" aria-modal="true" aria-label={reading.subject} className="selection-study-reader" onClick={event => event.stopPropagation()}><button autoFocus onClick={() => setReading(null)}>Back to your mail</button><p>{label(reading)}</p><h2>{reading.subject}</h2><p>{reading.snippet}</p><small>Reading preview · sample mail only</small></section></div>}
  </section>;
}
