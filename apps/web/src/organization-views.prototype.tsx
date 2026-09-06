// THROWAWAY BRE-380: compare Ask, Workbench, and Inbox drawer on the existing
// Organization route via ?prototype=views&variant=A|B|C. Sample mail, memory only.
import { useEffect, useState } from "react";
import "./organization-views.prototype.css";

type Mail = { id: string; sender: string; address: string; subject: string; snippet: string; date: string; unread: boolean };
const mail: Mail[] = [
  { id: "1", sender: "Maya Chen", address: "maya@juniper.example", subject: "Apartment tour on Saturday", snippet: "The sunny corner apartment is available at 11. Would you like to come by?", date: "10:42", unread: true },
  { id: "2", sender: "Juniper Rentals", address: "leasing@juniper.example", subject: "Apartment application received", snippet: "Thanks, Luke. We just need one more reference before the next step.", date: "Yesterday", unread: true },
  { id: "3", sender: "Apartment Living", address: "offers@living.example", subject: "Apartment furniture: the autumn edit", snippet: "A fresh look for your home. Explore this season’s collection.", date: "Yesterday", unread: false },
  { id: "4", sender: "Maya Chen", address: "maya@juniper.example", subject: "Apartment floor plan and details", snippet: "Here is the floor plan we talked about. The windows face the courtyard.", date: "Sep 3", unread: false },
  { id: "5", sender: "Theo Park", address: "theo@studio.example", subject: "Orca design review", snippet: "I tried the new reader. A few thoughts on how it feels to get back to mail.", date: "Sep 3", unread: true },
  { id: "6", sender: "North Coffee", address: "receipt@north.example", subject: "Your coffee receipt", snippet: "Thanks for stopping by this morning.", date: "Sep 2", unread: false },
];
type Definition = { subject: string; senders: string[]; unread: boolean };
type Draft = { name: string; definition: Definition; source: string };
type Saved = Draft & { id: number };
const names = ["Ask first", "Live workbench", "Beside your mail"];
const initial: Definition = { subject: "apartment", senders: [], unread: false };
const match = (d: Definition) => mail.filter(m => m.subject.toLowerCase().includes(d.subject.toLowerCase()) && (!d.senders.length || d.senders.includes(m.address)) && (!d.unread || m.unread));
const explain = (d: Definition) => `Subject contains “${d.subject || "anything"}”${d.senders.length ? `, from ${d.senders.map(s => mail.find(m => m.address === s)?.sender ?? s).join(" or ")}` : ", from anyone"}${d.unread ? ", unread only" : ""}.`;
const fresh = (source: string): Draft => ({ name: "Apartment hunt", definition: { ...initial }, source });

export function EffortlessViewsPrototype() {
  const [variant, setVariant] = useState(() => Math.max(0, ["A", "B", "C"].indexOf(new URLSearchParams(location.search).get("variant") ?? "A")));
  const [entry, setEntry] = useState<"describe" | "examples" | "search">("describe");
  const [prompt, setPrompt] = useState("Put all my apartment-hunting emails together");
  const [followup, setFollowup] = useState("Only unread mail");
  const [query, setQuery] = useState("apartment");
  const [selected, setSelected] = useState<string[]>(["1", "2"]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [undo, setUndo] = useState<Draft | null>(null);
  const [correction, setCorrection] = useState<Mail | null>(null);
  const [guide, setGuide] = useState(true);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState("");
  const [remove, setRemove] = useState(false);
  const [inspect, setInspect] = useState(false);
  const current = draft ?? saved.find(s => s.id === active) ?? null;
  const results = current ? match(current.definition) : [];
  const preview = (next: Draft) => { setDraft(next); setActive(null); setNotice(""); setCorrection(null); setRemove(false); };
  const update = (d: Definition) => { if (draft) { setUndo(draft); setDraft({ ...draft, definition: d }); } };
  function switchVariant(next: number) { const n = (next + 3) % 3; setVariant(n); const url = new URL(location.href); url.searchParams.set("variant", ["A", "B", "C"][n]!); history.replaceState(null, "", url); }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest("input,textarea,select,[contenteditable]")) return; if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); switchVariant(variant + (e.key === "ArrowRight" ? 1 : -1)); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [variant]);
  function describe() {
    if (/apartment|rental/i.test(prompt)) preview(fresh("description"));
    else if (/orca/i.test(prompt)) preview({ name: "Orca", definition: { ...initial, subject: "orca" }, source: "description" });
    else { setNotice("This sample can interpret apartment hunting or Orca. Try either, or use a subject filter below."); }
  }
  function group() {
    const examples = mail.filter(m => selected.includes(m.id));
    const subject = examples.every(m => /apartment/i.test(m.subject)) ? "apartment" : "";
    preview({ name: subject ? "Apartment hunt" : "Selected senders", source: "examples", definition: { subject, unread: false, senders: [...new Set(examples.map(m => m.address))] } });
  }
  function save() {
    if (!draft?.name.trim()) return;
    const id = editing ?? Date.now();
    const next = { ...draft, name: draft.name.trim(), id };
    setSaved(old => editing ? old.map(s => s.id === id ? next : s) : [...old, next]);
    setDraft(null); setActive(id); setEditing(null); setUndo(null); setNotice("Saved for this prototype session. Your mail and notification preferences are unchanged.");
  }
  const mailRows = (rows: Mail[], selection = false) => <div className="ev-mail-list">{rows.map(m => <article className="ev-mail" key={m.id}>
    {selection ? <input aria-label={`Select ${m.subject}`} type="checkbox" checked={selected.includes(m.id)} onChange={() => setSelected(s => s.includes(m.id) ? s.filter(id => id !== m.id) : [...s, m.id])} /> : <span className="ev-glyph" aria-hidden="true">{m.sender.slice(0,1)}</span>}
    <div className="ev-mail-copy"><div className="ev-mail-meta"><strong>{m.sender}</strong><span>{m.date}</span></div><h4>{m.subject}{m.unread ? <span className="ev-unread" aria-label="Unread" /> : null}</h4><p>{m.snippet}</p></div>
    {draft && !selection ? <button className="ev-subtle" aria-label={`Correct match: ${m.subject}`} onClick={() => setCorrection(m)}>Doesn’t belong</button> : null}
  </article>)}</div>;
  const entryControls = <div className="ev-entry">
    <div className="ev-tabs" aria-label="Start a view">{(["describe", "examples", "search"] as const).map((e,i) => <button key={e} aria-pressed={entry === e} onClick={() => {setEntry(e);setNotice("");}}>{["Describe it", "Use selected mail", "Keep a search"][i]}</button>)}</div>
    {entry === "describe" ? <><label className="ev-field"><span>What would you like to see together?</span><textarea value={prompt} onChange={e => setPrompt(e.target.value)} /></label><button className="ev-primary" disabled={offline || !prompt.trim()} onClick={describe}>Show matching mail <span aria-hidden="true">↗</span></button>{offline ? <p className="ev-note">Assistance is unavailable. Use a search or edit the subject directly.</p> : null}<p className="ev-note">Try apartment hunting or Orca project mail.</p></> : null}
    {entry === "examples" ? <><p className="ev-note">Select a few examples. We’ll suggest what they share.</p>{variant !== 2 ? mailRows(mail.slice(0,4), true) : null}<button className="ev-primary" disabled={!selected.length} onClick={group}>Group mail like this · {selected.length}</button></> : null}
    {entry === "search" ? <><label className="ev-field"><span>Search mail by subject</span><input value={query} onChange={e => setQuery(e.target.value)} /></label><p className="ev-note">{match({subject:query, senders:[], unread:false}).length} matching conversations</p><button className="ev-primary" disabled={!query.trim()} onClick={() => preview({name:query[0]!.toUpperCase()+query.slice(1),source:"search",definition:{subject:query,senders:[],unread:false}})}>Keep this search</button></> : null}
  </div>;
  const editingControls = draft ? <div className="ev-edit">
    <label className="ev-field"><span>View name</span><input value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})} /></label>
    <p className="ev-explanation">{explain(draft.definition)}</p>
    <form className="ev-followup" onSubmit={e => {e.preventDefault();if (/unread/i.test(followup)) update({...draft.definition,unread:true});else if (/rental|maya|juniper/i.test(followup)) update({...draft.definition,senders:["maya@juniper.example","leasing@juniper.example"]});else setNotice("This sample supports unread-only or rental-sender refinements. Edit filters yourself for other subjects.");}}><label className="ev-field"><span>Refine in your own words</span><input value={followup} onChange={e => setFollowup(e.target.value)} /></label><button disabled={offline || !followup.trim()} type="submit">Update preview</button></form><div className="ev-refine"><button aria-pressed={draft.definition.unread} onClick={() => update({...draft.definition,unread:!draft.definition.unread})}>Unread only</button><button disabled={offline} onClick={() => update({...draft.definition,senders:["maya@juniper.example","leasing@juniper.example"]})}>Only rental conversations</button>{undo ? <button onClick={() => {setDraft(undo);setUndo(null);setCorrection(null);}}>Undo refinement</button> : null}</div>
    <details className="ev-details"><summary>Edit filters yourself</summary><label className="ev-field"><span>Subject contains</span><input value={draft.definition.subject} onChange={e => update({...draft.definition,subject:e.target.value})} /></label>{draft.definition.senders.length ? <button onClick={() => update({...draft.definition,senders:[]})}>Include all senders</button> : null}<p className="ev-note">These filters are the exact interpretation being previewed.</p></details>
    <div className="ev-actions"><button className="ev-primary" disabled={!draft.name.trim()} onClick={save}>{editing ? "Save changes" : "Save view"}</button><button onClick={() => {setDraft(null);setActive(editing);setEditing(null);setCorrection(null);setUndo(null);setNotice("Draft discarded. Nothing changed.");}}>Discard</button></div>
    <p className="ev-note">A view gathers mail here. It doesn’t move mail or change notifications.</p>
  </div> : current ? <div className="ev-edit"><h2>{current.name}</h2><p className="ev-explanation">{explain(current.definition)}</p><div className="ev-actions"><button onClick={() => {setDraft({...current});setEditing(active);setNotice("");}}>Edit view</button><button onClick={() => setRemove(true)}>Remove view</button></div>{remove ? <div className="ev-correction"><p>Remove this view? Your mail stays available.</p><button onClick={() => {setSaved(s => s.filter(v=>v.id!==active));setActive(null);setRemove(false);setNotice("View removed. Mail kept.");}}>Confirm removal</button><button onClick={() => setRemove(false)}>Keep view</button></div> : null}</div> : null;
  const resultPanel = <section className="ev-results" aria-label="Matching mail"><header><div><span className="ev-eyebrow">{draft ? "Preview before saving" : current ? "Your saved view" : "Your mail, your way"}</span><h3>{current ? `${results.length} ${results.length === 1 ? "conversation" : "conversations"}` : "See what belongs."}</h3></div>{current ? <span className="ev-count">{results.length.toString().padStart(2,"0")}</span> : null}</header>
    {correction && draft ? <div className="ev-correction"><strong>What should change?</strong><p>This sample can narrow the view to Maya and Juniper Rentals. That also leaves out future mail from other senders.</p><button onClick={() => {update({...draft.definition,senders:["maya@juniper.example","leasing@juniper.example"]});setCorrection(null);}}>Preview those senders only</button><button onClick={() => setCorrection(null)}>Keep current matches</button></div> : null}
    {current ? results.length ? mailRows(results) : <div className="ev-empty"><h3>No mail matches yet.</h3><p>Broaden the subject or senders. You can also save this view for future mail.</p></div> : <div className="ev-empty"><span className="ev-big-wave" aria-hidden="true">≈</span><p>Start with a thought, a few messages,<br/>or a search worth keeping.</p></div>}
  </section>;
  return <section className={`ev-prototype ev-variant-${variant}`} aria-label="Effortless views prototype">
    <div className="ev-lab"><span>INTERACTION STUDY · BRE-380</span><span>Sample mail · simulated assistance · memory only</span></div>
    <header className="ev-heading"><div><span className="ev-eyebrow">Organization / Your views</span><h1>{variant === 0 ? "Make room for what matters." : variant === 1 ? "A view that fits you." : "Organize from here."}</h1></div><button onClick={() => {setDraft(null);setActive(null);setEditing(null);setUndo(null);setNotice("");}}>New view +</button></header>
    {guide ? <div className="ev-guide"><span><strong>Your first useful view.</strong> Start with mail you already care about. Preview it, adjust it, keep it.</span><button onClick={() => setGuide(false)} aria-label="Dismiss first-view help">×</button></div> : null}
    {saved.length ? <nav className="ev-saved" aria-label="Saved prototype views">{saved.map((v,i) => <div key={v.id}><button aria-pressed={active === v.id} onClick={() => {setActive(v.id);setDraft(null);setEditing(null);setCorrection(null);setUndo(null);setNotice("");}}>{v.name} <span>{match(v.definition).length}</span></button><button aria-label={`Move ${v.name} earlier`} disabled={i===0} onClick={() => setSaved(old => {const next=[...old];[next[i-1],next[i]]=[next[i]!,next[i-1]!];return next;})}>←</button></div>)}</nav> : null}
    {notice ? <p className="ev-notice" role="status">{notice}</p> : null}
    {variant === 0 ? <div className="ev-ask-layout">{!current ? <div className="ev-ask-start">{entryControls}</div> : null}{current ? <div className="ev-preview-layout">{resultPanel}{editingControls}</div> : null}</div> : variant === 1 ? <div className="ev-workbench"><aside>{current ? editingControls : entryControls}</aside>{resultPanel}</div> : <div className="ev-inbox-layout"><section className="ev-source-mail"><header><h3>Inbox</h3><span>6 conversations</span></header>{mailRows(mail,true)}</section><aside className="ev-drawer">{current ? <>{resultPanel}{editingControls}</> : entryControls}</aside></div>}
    <div className="ev-study-tools"><button onClick={() => setInspect(!inspect)} aria-expanded={inspect}>Inspect prototype state</button><button onClick={() => setOffline(!offline)} aria-pressed={offline}>Assistance {offline ? "off" : "on"}</button><button onClick={() => setGuide(!guide)}>First-view help</button></div>
    {inspect ? <pre className="ev-state">{JSON.stringify({layout:names[variant],entry,draft,saved,active,editing,selected,assistance:!offline,matchingIds:results.map(m=>m.id)},null,2)}</pre> : null}
    <nav className="ev-switcher" aria-label="Prototype layouts"><button aria-label="Previous layout" onClick={() => switchVariant(variant-1)}>←</button><span>{["A","B","C"][variant]} · {names[variant]}</span><button aria-label="Next layout" onClick={() => switchVariant(variant+1)}>→</button></nav>
  </section>;
}
