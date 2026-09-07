import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { inboxClassificationResponseSchema, organizationViewListResponseSchema, userPreferencesSchema } from "@orca/shared";
import { TopLayer, useTopLayerActive } from "./top-layer";
import "./first-view-guidance.css";

type ReadState = { status: "loading" | "ready" | "error"; completedAt: string | null; hasViews: boolean; hasMail: boolean };
type Guidance = ReadState & {
  hidden: boolean; saving: boolean; saveError: boolean; selectionRequest: number; selectionDestination: "inbox" | "all" | null;
  consumeSelection: (request: number) => void; dismiss: () => Promise<void>; retry: () => void; start: (kind: "search" | "selection") => void;
};
const GuidanceContext = createContext<Guidance | null>(null);
const initial: ReadState = { status: "loading", completedAt: null, hasViews: false, hasMail: false };
// Tutorial prose is deliberately not mail, a View definition, or preparation input.
const sample = { kind: "tutorial", title: "Project updates", description: "A saved View keeps matching conversations together as new mail arrives." } as const;

async function read(url: string, signal: AbortSignal, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { credentials: "include", ...init, signal });
  if (!response.ok) throw new Error(`Guidance request failed (${response.status})`);
  return response.json();
}

export function FirstViewGuidanceProvider({ children, demoMode = false, onSearch, onSelect }: { children: ReactNode; demoMode?: boolean; onSearch: () => void; onSelect: () => "inbox" | "all" | void }) {
  const [state, setState] = useState<ReadState>(initial);
  const [refresh, setRefresh] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [selectionRequest, setSelectionRequest] = useState(0);
  const [selectionDestination, setSelectionDestination] = useState<"inbox" | "all" | null>(null);
  const selectionCounter = useRef(0);
  const consumeSelection = useCallback((request: number) => setSelectionRequest(current => current === request ? 0 : current), []);
  const generation = useRef(0);
  const mutation = useRef<AbortController | null>(null);
  const startFrame = useRef<number | null>(null);
  const completed = useRef<string | null>(null);
  useEffect(() => () => { mutation.current?.abort(); if (startFrame.current !== null) window.cancelAnimationFrame(startFrame.current); generation.current++; }, []);
  useEffect(() => {
    const update = () => setRefresh(value => value + 1);
    window.addEventListener("orca:views-changed", update);
    window.addEventListener("online", update);
    return () => { window.removeEventListener("orca:views-changed", update); window.removeEventListener("online", update); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++generation.current;
    if (demoMode) { setState({ status: "ready", completedAt: null, hasViews: true, hasMail: false }); return () => controller.abort(); }
    setState(value => ({ ...value, status: "loading" }));
    // A failed canonical View list is not an empty workspace. All three reads
    // must succeed before presenting an invitation or an empty-mail example.
    void Promise.all([
      read("/v1/preferences", controller.signal).then(value => userPreferencesSchema.parse(value)),
      read("/v1/organization/views", controller.signal).then(value => organizationViewListResponseSchema.parse(value)),
      read("/v1/inbox?view=all&classification=all&limit=1", controller.signal).then(value => inboxClassificationResponseSchema.parse(value)),
    ]).then(([preferences, views, mail]) => {
      if (controller.signal.aborted || request !== generation.current) return;
      completed.current = completed.current ?? preferences.firstViewGuidanceCompletedAt;
      setState({ status: "ready", completedAt: completed.current, hasViews: views.items.length > 0, hasMail: mail.messages.length > 0 });
    }).catch(() => { if (!controller.signal.aborted && request === generation.current) setState(value => ({ ...value, status: "error" })); });
    return () => controller.abort();
  }, [demoMode, refresh]);

  async function dismiss() {
    setHidden(true);
    if (mutation.current || completed.current || demoMode) return;
    const controller = new AbortController(); mutation.current = controller;
    setSaving(true); setSaveError(false);
    try {
      const value = userPreferencesSchema.parse(await read("/v1/preferences", controller.signal, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ firstViewGuidanceCompletedAt: new Date().toISOString() }) }));
      if (controller.signal.aborted) return;
      completed.current = value.firstViewGuidanceCompletedAt;
      setState(current => ({ ...current, completedAt: value.firstViewGuidanceCompletedAt }));
    } catch { if (!controller.signal.aborted) setSaveError(true); }
    finally { if (!controller.signal.aborted) { mutation.current = null; setSaving(false); } }
  }
  function start(kind: "search" | "selection") {
    if (state.status !== "ready" || !state.hasMail || demoMode) return;
    setHidden(true);
    // Let the help layer restore focus before opening the production surface.
    if (startFrame.current !== null) window.cancelAnimationFrame(startFrame.current);
    startFrame.current = window.requestAnimationFrame(() => {
      startFrame.current = null;
      if (kind === "search") onSearch();
      else { const destination = onSelect(); setSelectionDestination(destination ?? null); setSelectionRequest(++selectionCounter.current); }
    });
  }
  return <GuidanceContext.Provider value={{ ...state, hidden, saving, saveError, selectionRequest, selectionDestination, consumeSelection, dismiss, retry: () => { generation.current++; setState(value => ({ ...value, status: "loading" })); setRefresh(value => value + 1); }, start }}>{children}</GuidanceContext.Provider>;
}

export function useViewGuidanceSelectionRequest(destination?: string) {
  const guidance = useContext(GuidanceContext);
  const request = !guidance?.selectionDestination || destination === guidance.selectionDestination ? guidance?.selectionRequest ?? 0 : 0;
  const consume = guidance?.consumeSelection;
  useEffect(() => { if (request) consume?.(request); }, [request, consume]);
  return request;
}

function GuidanceContent({ onLeave }: { onLeave?: () => void }) {
  const guidance = useContext(GuidanceContext)!;
  const titleId = useId();
  const skip = () => { void guidance.dismiss(); onLeave?.(); };
  if (guidance.status !== "ready") return <section className="first-view-guidance" aria-busy={guidance.status === "loading"}>
    <div className="first-view-guidance-copy"><span className="first-view-eyebrow">Your first live View</span><h2 id={titleId} data-dialog-initial-focus tabIndex={-1}>Keep useful mail together</h2></div>
    {guidance.status === "loading" ? <p role="status">Checking your saved Views and mail…</p> : <><p role="alert">Could not check your mail and saved Views. Your mail and preferences are unchanged.</p><button type="button" onClick={guidance.retry}>Retry guidance</button></>}
  </section>;
  return <section className="first-view-guidance" aria-labelledby={titleId}>
    <div className="first-view-guidance-copy"><span className="first-view-eyebrow">Your first live View</span><h2 id={titleId} data-dialog-initial-focus tabIndex={-1}>Keep useful mail together</h2>
      <p>{guidance.hasMail ? "Start with a search or selected conversations. Preview the matching mail, then save a View you can open from My spaces." : "When mail arrives, turn a search or selected conversations into a View. You can skip and return to Getting started in Organization → Views."}</p>
    </div>
    {guidance.hasMail ? <div className="first-view-starts"><button type="button" onClick={() => { onLeave?.(); guidance.start("search"); }}><strong>Search mail</strong><span>Find mail, then choose Save as View.</span></button><button type="button" onClick={() => { onLeave?.(); guidance.start("selection"); }}><strong>Use selected mail</strong><span>Select conversations from one account, then choose Use these senders.</span></button></div>
      : <figure className="first-view-sample" data-provenance={sample.kind}><figcaption>Example only · cannot be saved</figcaption><strong>{sample.title}</strong><p>{sample.description}</p><small>No sample mail is added to your mailbox.</small></figure>}
    <footer><button type="button" onClick={skip}>Skip for now</button>{!guidance.hasMail ? <button type="button" onClick={skip}>Return when mail arrives</button> : null}<small>Saved for your Orca user across devices and connected accounts.</small></footer>
  </section>;
}

export function FirstViewInvitation() {
  const guidance = useContext(GuidanceContext);
  const layerActive = useTopLayerActive();
  if (!guidance || layerActive) return null;
  if (guidance.saveError) return <p className="first-view-save-state" role="alert">Hidden for this visit. Could not save your choice across devices. <button disabled={guidance.saving} type="button" onClick={() => void guidance.dismiss()}>Retry saving choice</button></p>;
  if (guidance.hidden || guidance.status !== "ready" || guidance.completedAt || guidance.hasViews) return null;
  return <GuidanceContent/>;
}

export function ViewGettingStarted() {
  const guidance = useContext(GuidanceContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!guidance) return null;
  return <><button className="view-action" ref={trigger} type="button" onClick={() => { guidance.retry(); setOpen(true); }}>Getting started</button>{open ? <TopLayer ariaLabel="Getting started with Views" className="first-view-help" layerClassName="first-view-help-layer" backdropClassName="first-view-help-backdrop" returnFocusRef={trigger} onClose={() => { void guidance.dismiss(); setOpen(false); }}><button className="first-view-help-close" type="button" aria-label="Close Getting started" onClick={() => { void guidance.dismiss(); setOpen(false); }}>×</button><GuidanceContent onLeave={() => setOpen(false)}/></TopLayer> : null}</>;
}
