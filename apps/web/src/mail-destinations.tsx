import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { destinationListSchema, destinationMutationResultSchema, type MailDestination } from "@orca/shared";
import { useOnlineStatus } from "./navigation";

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
export function useDestinations() {
  const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
  const online = useOnlineStatus();
  useEffect(() => { if (!snapshot.loading) void refreshDestinations().catch(() => {}); }, []);
  return { ...state, active: state.data?.destinations.filter(item => !item.retiredAt).sort((a,b) => a.position-b.position) ?? [], locked: !online || state.loading || !state.data || Boolean(state.error), refresh: refreshDestinations };
}

export function DestinationManager({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const catalog = useDestinations();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function mutate(path: string, method: string, change: object, created = false) {
    if (catalog.locked || lock.current || !catalog.data) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = destinationMutationResultSchema.parse(await request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: catalog.data.revision, ...change }) }));
      ++generation;
      publish({ data: result.state, loading: false, error: "" });
      if (created) { onCreated(result.destinationId); onClose(); }
    } catch (cause) { setError(`${String(cause)} Reload and review before trying again.`); await refreshDestinations().catch(() => {}); }
    finally { lock.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="simple-attention-dialog" aria-labelledby="destination-manager-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="destination-manager-title">Your mail destinations</h2>
    <p>Names are shared across your accounts. Routing choices stay with each account.</p>
    <form onSubmit={event => { event.preventDefault(); void mutate("/v1/destinations", "POST", { name: name.trim() }, true); }}>
      <label>New destination<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <button disabled={busy || catalog.locked || !name.trim()}>Create destination</button>
    </form>
    {catalog.active.map(item => <DestinationEditor key={item.id} item={item} choices={catalog.active} disabled={busy || catalog.locked} mutate={mutate} />)}
    {(error || catalog.error) && <p role="alert">{error || catalog.error} <button disabled={busy} onClick={() => void catalog.refresh().catch(() => {})}>Reload destinations</button></p>}
    <p>Retiring a destination reassigns its mail and choices. It never deletes messages. Notification delivery is not available.</p>
    <footer><button disabled={busy} onClick={onClose}>Done</button></footer>
  </dialog>;
}
function DestinationEditor({ item, choices, disabled, mutate }: { item: MailDestination; choices: MailDestination[]; disabled: boolean; mutate: (path: string, method: string, change: object) => Promise<void> }) {
  const [name, setName] = useState(item.name);
  const [replacement, setReplacement] = useState("");
  useEffect(() => setName(item.name), [item.name]);
  return <details><summary>{item.name}{item.isFallback ? " · Default" : ""}</summary>
    <label>Name<input value={name} maxLength={120} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
    <button disabled={disabled || !name.trim() || name.trim() === item.name} onClick={() => void mutate(`/v1/destinations/${encodeURIComponent(item.id)}`, "PATCH", { name: name.trim() })}>Rename</button>
    <label>Reassign mail and choices to<select disabled={disabled} value={replacement} onChange={event => setReplacement(event.target.value)}><option value="">Choose replacement</option>{choices.filter(choice => choice.id !== item.id).map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}</select></label>
    <button disabled={disabled || !replacement} onClick={() => void mutate(`/v1/destinations/${encodeURIComponent(item.id)}/retire`, "POST", { reassignToDestinationId: replacement })}>Retire {item.name}</button>
  </details>;
}
