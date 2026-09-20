import { TopLayer } from "./top-layer";
import { ColorPresetPicker } from "./color-preset-picker";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { defaultSpaceColor, destinationCreateSchema, destinationListSchema, destinationMutationResultSchema, type MailDestination } from "@orca/shared";
import { desktopDestinationHref, useOnlineStatus } from "./navigation";

export const destinationChangeEvent = "orca:destination-authority-changed";

type Catalog = { data: ReturnType<typeof destinationListSchema.parse> | null; loading: boolean; error: string };
let snapshot: Catalog = { data: null, loading: false, error: "" };
let generation = 0;
const listeners = new Set<() => void>();
function publish(next: Catalog) { snapshot = next; listeners.forEach(listener => listener()); }
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? `Request failed (${response.status}).`);
  return response.json();
}
export async function refreshDestinations() {
  const owner = ++generation;
  publish({ ...snapshot, loading: true });
  try {
    const data = destinationListSchema.parse(await request("/v1/destinations"));
    if (owner === generation) publish({ data, loading: false, error: "" });
  } catch (error) {
    if (owner === generation) publish({ ...snapshot, loading: false, error: String(error) });
    throw error;
  }
}
export function destinationLabel(id: string | null | undefined) {
  return snapshot.data?.destinations.find(item => item.id === id)?.name ?? (id ? "Unavailable space" : "No space");
}
// Explicitly synthetic destinations for the existing /dev preview only.
const previewCatalog = destinationListSchema.parse({ revision: 1, fallbackDestinationId: "inbox", legacyDestinationIds: { normal: "inbox", focus: "focus", notify: "signals", quiet: "quiet" }, destinations: ["Inbox", "Focus", "Signals", "Quiet"].map((name, position) => ({ id: name.toLowerCase(), name, isFallback: position === 0, position, retiredAt: null, revision: 1, notificationPreference: "quiet", delivery: "proposal_only", counts: { total: 0, unread: 0 } })) });
export function useDestinations(preview = false) {
  const liveState = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
  const state = preview ? { data: previewCatalog, loading: false, error: "" } : liveState;
  const online = useOnlineStatus();
  useEffect(() => { if (!preview && !snapshot.loading) void refreshDestinations().catch(() => {}); }, [preview]);
  return { ...state, label: (id: string | null | undefined) => state.data?.destinations.find(item => item.id === id)?.name ?? (id ? "Unavailable space" : "No space"), active: state.data?.destinations.filter(item => !item.retiredAt).sort((a,b) => a.position-b.position) ?? [], locked: preview || !online || state.loading || !state.data || Boolean(state.error), refresh: refreshDestinations };
}

type SpaceDraft = { name: string; color: string };
const validName = (name: string) => destinationCreateSchema.shape.name.safeParse(name).success;

export function DestinationManager({ onClose, onCreated, preview = false }: { onClose: () => void; onCreated: (id: string) => void; preview?: boolean }) {
  const catalog = useDestinations(preview);
  const [name, setName] = useState("");
  const [color, setColor] = useState(defaultSpaceColor);
  // Drafts belong to the manager, so collapsing or switching editors never loses work.
  const [drafts, setDrafts] = useState<Record<string, SpaceDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MailDestination | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const lock = useRef(false);
  const newName = useRef<HTMLInputElement>(null);
  const dirtyItem = (item: MailDestination) => Boolean(drafts[item.id] && (drafts[item.id]!.name !== item.name || drafts[item.id]!.color !== item.color));
  const dirty = name !== "" || color !== defaultSpaceColor || catalog.active.some(dirtyItem);
  const fallback = catalog.active.find(item => item.id === catalog.data?.fallbackDestinationId);
  function requestLeave(action = onClose) {
    if (lock.current) return;
    if (dirty) setLeave(() => action); else action();
  }
  async function mutate(path: string, method: string, change: object): Promise<string | false> {
    if (catalog.locked || lock.current || !catalog.data) return false;
    lock.current = true; setBusy(true); setError(""); setStatus(""); setCreatedId(null);
    try {
      const result = destinationMutationResultSchema.parse(await request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: catalog.data.revision, ...change }) }));
      ++generation;
      publish({ data: snapshot.data && snapshot.data.revision > result.state.revision ? snapshot.data : result.state, loading: false, error: "" });
      window.dispatchEvent(new Event(destinationChangeEvent));
      return result.destinationId;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshDestinations().catch(() => {});
      return false;
    } finally { lock.current = false; setBusy(false); }
  }
  function recoveryLink(label: string, destination: Parameters<typeof desktopDestinationHref>[0]) {
    const href = desktopDestinationHref(destination, window.location.pathname);
    return <a href={href} aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={event => { event.preventDefault(); if (lock.current) return; setRemoving(null); requestLeave(() => window.location.assign(href)); }}>{label}</a>;
  }
  return <>
    <TopLayer ariaLabelledBy="destination-manager-title" className="simple-attention-dialog destination-manager" layerClassName="desktop-dialog-layer" backdropClassName="desktop-dialog-backdrop" backdropAriaLabel="Close space manager" initialFocusSelector="input" dismissible={!busy} ariaBusy={busy} onClose={() => requestLeave()}>
      <h2 id="destination-manager-title">Your spaces</h2>
      <p>Space names, colors, and removal apply across your accounts and devices. Customize tools changes only this device’s tool shortcuts.</p>
      {preview && <p role="status">Synthetic preview. Connect an account to create or change spaces.</p>}
      <form onSubmit={async event => {
        event.preventDefault();
        if (!validName(name)) return;
        const id = await mutate("/v1/destinations", "POST", { name: name.trim(), color });
        if (id) {
          setCreatedId(id);
          setName(""); setColor(defaultSpaceColor); setStatus(`Created “${name.trim()}”.`); newName.current?.focus();
          // Keep other drafts in this manager until the user chooses Done.
        }
      }}>
        <label>New space<input ref={newName} required maxLength={120} disabled={busy || catalog.locked} value={name} onInput={event => setName(event.currentTarget.value)} /></label>
        <ColorPresetPicker color={color} onChange={setColor} disabled={busy || catalog.locked} />
        <button disabled={busy || catalog.locked || !validName(name)}>Create space</button>
      </form>
      <p className="space-name-help">Names must contain 1–120 characters. Leading and trailing spaces are removed.</p>
      {catalog.active.map(item => {
        const draft = drafts[item.id] ?? item;
        const changed = dirtyItem(item);
        const legacy = Object.values(catalog.data?.legacyDestinationIds ?? {}).includes(item.id);
        return <details key={item.id}><summary><span aria-hidden="true" className="desktop-space-mark" style={{ background: item.color }} />{item.name}{item.isFallback ? " · Default" : ""}<small className="space-edit-hint">{changed ? "Unsaved changes" : "Edit name & color"}</small></summary>
          <form onSubmit={async event => {
            event.preventDefault();
            const field = event.currentTarget.querySelector("input");
            if (!validName(draft.name)) return;
            if (await mutate(`/v1/destinations/${encodeURIComponent(item.id)}`, "PATCH", { name: draft.name.trim(), color: draft.color })) {
              setDrafts(current => { const next = { ...current }; delete next[item.id]; return next; });
              setStatus(`Saved “${draft.name.trim()}”.`);
              window.requestAnimationFrame(() => field?.focus());
            }
          }}>
            <label>Name<input aria-label={`Name for ${item.name}`} required value={draft.name} maxLength={120} disabled={busy || catalog.locked} onInput={event => { setStatus(""); setDrafts({ ...drafts, [item.id]: { name: event.currentTarget.value, color: draft.color } }); }} /></label>
            <ColorPresetPicker color={draft.color} onChange={value => { setStatus(""); setDrafts({ ...drafts, [item.id]: { name: draft.name, color: value } }); }} disabled={busy || catalog.locked} />
            <button disabled={busy || catalog.locked || !validName(draft.name) || !changed}>Save changes</button>
          </form>
          <p>{item.isFallback ? "Your default space cannot be removed." : legacy ? "Legacy choices use this space. Keep it available until those choices are migrated." : changed ? "Save your name and color changes before removing this space." : "Review removal before making any changes. Mail is never deleted."}</p>
          <button aria-label={`Remove ${item.name}`} disabled={busy || catalog.locked || item.isFallback || legacy || !fallback || changed} onClick={() => { setError(""); setRemoving(item); }}>Remove space</button>
        </details>;
      })}
      {status && <p role="status">{status}</p>}
      {createdId && <button disabled={busy} onClick={() => requestLeave(() => { onCreated(createdId); onClose(); })}>Open created space</button>}
      {busy && <p role="status">Saving changes…</p>}
      {(error || catalog.error) && <div role="alert"><p>{error || catalog.error}</p><p>Your edits are kept. Review the current spaces, then try your action again.</p><button disabled={busy || catalog.loading} onClick={() => void catalog.refresh().catch(() => {})}>Reload spaces</button></div>}
      <footer><button disabled={busy} onClick={() => requestLeave()}>Done</button></footer>
    </TopLayer>
    {leave && <TopLayer ariaLabel="Unsaved space changes" className="simple-attention-dialog destination-manager" layerClassName="desktop-dialog-layer" backdropClassName="desktop-dialog-backdrop" onClose={() => setLeave(null)}>
      <h2>Keep your space changes?</h2><p>Your unsaved names and colors will be lost if you leave. Choose Keep editing to save each space.</p>
      <footer><button onClick={() => setLeave(null)}>Keep editing</button><button onClick={() => { const action = leave; setLeave(null); action(); }}>Discard changes</button></footer>
    </TopLayer>}
    {removing && <TopLayer ariaLabel={`Remove ${removing.name}?`} className="simple-attention-dialog destination-manager" layerClassName="desktop-dialog-layer" backdropClassName="desktop-dialog-backdrop" onClose={() => setRemoving(null)} dismissible={!busy} ariaBusy={busy} returnFocusRef={newName}>
      <h2>Remove “{removing.name}”?</h2>
      <p>This removes the space across your accounts and devices. No mail is deleted and existing conversations are not moved automatically.</p>
      <p>Your default space is <strong>{fallback?.name ?? "unavailable"}</strong>. Future mail without a conversation, sender, account, or rule destination uses that default.</p>
      <p>Removal is blocked while conversations, sender/account choices, legacy choices, or advanced rules still use this space. Review those references first. There is no automatic undo for removal.</p>
      {error && <div role="alert"><p>{error}</p><p>The space was not removed. Review its references below, or retry after resolving the error.</p></div>}
      {catalog.error && <p role="alert">{catalog.error} <button disabled={busy || catalog.loading} onClick={() => void catalog.refresh().catch(() => {})}>Reload spaces</button></p>}
      <nav className="space-removal-links" aria-label="Review space references">
        {recoveryLink("Review conversations", `destination:${removing.id}`)}
        {recoveryLink("Review sender and account choices", "attention")}
        {recoveryLink("Review advanced rules", "organization-studio")}
      </nav>
      <footer><button disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button disabled={busy || catalog.locked || !fallback || removing.id === fallback.id} onClick={async () => {
        if (await mutate(`/v1/destinations/${encodeURIComponent(removing.id)}/retire`, "POST", { reassignToDestinationId: fallback!.id })) {
          setStatus(`Removed “${removing.name}”. No mail was deleted.`); setRemoving(null);
        }
      }}>{busy ? "Removing…" : error ? "Retry removal" : "Remove space"}</button></footer>
    </TopLayer>}
  </>;
}
