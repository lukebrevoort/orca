import { TopLayer } from "./top-layer";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { destinationListSchema, destinationMutationResultSchema, type MailDestination } from "@orca/shared";
import { useOnlineStatus } from "./navigation";

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
  return snapshot.data?.destinations.find(item => item.id === id)?.name ?? (id ? "Unavailable destination" : "No destination");
}
// Explicitly synthetic destinations for the existing /dev preview only.
const previewCatalog = destinationListSchema.parse({ revision: 1, fallbackDestinationId: "inbox", legacyDestinationIds: { normal: "inbox", focus: "focus", notify: "signals", quiet: "quiet" }, destinations: ["Inbox", "Focus", "Signals", "Quiet"].map((name, position) => ({ id: name.toLowerCase(), name, isFallback: position === 0, position, retiredAt: null, revision: 1, notificationPreference: "quiet", delivery: "proposal_only", counts: { total: 0, unread: 0 } })) });
export function useDestinations(preview = false) {
  const liveState = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
  const state = preview ? { data: previewCatalog, loading: false, error: "" } : liveState;
  const online = useOnlineStatus();
  useEffect(() => { if (!preview && !snapshot.loading) void refreshDestinations().catch(() => {}); }, [preview]);
  return { ...state, label: (id: string | null | undefined) => state.data?.destinations.find(item => item.id === id)?.name ?? (id ? "Unavailable destination" : "No destination"), active: state.data?.destinations.filter(item => !item.retiredAt).sort((a,b) => a.position-b.position) ?? [], locked: preview || !online || state.loading || !state.data || Boolean(state.error), refresh: refreshDestinations };
}

export function DestinationManager({ onClose, onCreated, preview = false }: { onClose: () => void; onCreated: (id: string) => void; preview?: boolean }) {
  const catalog = useDestinations(preview);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function mutate(path: string, method: string, change: object, created = false) {
    if (catalog.locked || lock.current || !catalog.data) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = destinationMutationResultSchema.parse(await request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: catalog.data.revision, ...change }) }));
      ++generation;
      publish({ data: snapshot.data && snapshot.data.revision > result.state.revision ? snapshot.data : result.state, loading: false, error: "" });
      window.dispatchEvent(new Event(destinationChangeEvent));
      if (created) { onCreated(result.destinationId); onClose(); }
    } catch (cause) { setError(`${String(cause)} Reload and review before trying again.`); await refreshDestinations().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  }
  return <TopLayer ariaLabelledBy="destination-manager-title" className="simple-attention-dialog destination-manager" layerClassName="desktop-dialog-layer" backdropClassName="desktop-dialog-backdrop" backdropAriaLabel="Close destination manager" initialFocusSelector="input" dismissible={!busy} ariaBusy={busy} onClose={onClose}>
    <h2 id="destination-manager-title">Your mail destinations</h2>
    <p>Names are shared across your accounts. Routing choices stay with each account.</p>
    {preview && <p role="status">Synthetic preview. Connect an account to create or change durable destinations.</p>}
    <form onSubmit={event => { event.preventDefault(); void mutate("/v1/destinations", "POST", { name: name.trim() }, true); }}>
      <label>New destination<input autoFocus required maxLength={120} value={name} onInput={event => setName(event.currentTarget.value)} /></label>
      <button disabled={busy || catalog.locked || !name.trim()}>Create destination</button>
    </form>
    {catalog.active.map(item => <DestinationEditor key={item.id} item={item} fallbackId={catalog.data?.fallbackDestinationId ?? ""} disabled={busy || catalog.locked} mutate={mutate} />)}
    {(error || catalog.error) && <p role="alert">{error || catalog.error} <button disabled={busy} onClick={() => void catalog.refresh().catch(() => {})}>Reload destinations</button></p>}
    <p>Move its conversations and update sender choices first. Removing a destination never deletes mail. Notification delivery is not available.</p>
    <footer><button disabled={busy} onClick={onClose}>Done</button></footer>
  </TopLayer>;
}
function DestinationEditor({ item, fallbackId, disabled, mutate }: { item: MailDestination; fallbackId: string; disabled: boolean; mutate: (path: string, method: string, change: object) => Promise<void> }) {
  const [name, setName] = useState(item.name);
  useEffect(() => setName(item.name), [item.name]);
  return <details><summary>{item.name}{item.isFallback ? " · Default" : ""}</summary>
    <label>Name<input value={name} maxLength={120} disabled={disabled} onInput={event => setName(event.currentTarget.value)} /></label>
    <button disabled={disabled || !name.trim() || name.trim() === item.name} onClick={() => void mutate(`/v1/destinations/${encodeURIComponent(item.id)}`, "PATCH", { name: name.trim() })}>Rename</button>
    {item.isFallback ? <p>Your default destination cannot be removed.</p> : <p>Move conversations and update sender choices before removing this destination.</p>}
    <button aria-label={`Remove ${item.name}`} disabled={disabled || item.isFallback || !fallbackId} onClick={() => void mutate(`/v1/destinations/${encodeURIComponent(item.id)}/retire`, "POST", { reassignToDestinationId: fallbackId })}>Remove destination</button>
  </details>;
}
