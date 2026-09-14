import { useEffect, useRef, useState } from "react";
import { destinationBatchLimit, destinationBatchResultSchema, type DestinationConversation } from "@orca/shared";
import { attentionRequest, RoutingRequestError, useRoutingUpdates } from "./attention-routing";
import { useDestinations } from "./mail-destinations";
import { TopLayer } from "./top-layer";

export function conversationKey(target: DestinationConversation) { return JSON.stringify([target.accountId, target.threadId]); }
export function selectedConversations(messages: readonly DestinationConversation[]) {
  return [...new Map(messages.map(message => [conversationKey(message), { accountId: message.accountId, threadId: message.threadId }])).values()];
}

/** Selection stays owned by InboxView; the receipt outlives this dialog and its rows. */
export function BulkSpaceMove({ targets, disabled, preview, queryOwner, onMoved, onBusy }: {
  targets: DestinationConversation[]; disabled: boolean; preview: boolean; queryOwner: number;
  onMoved: (targets: DestinationConversation[], owner: number) => void; onBusy: (busy: boolean) => void;
}) {
  const catalog = useDestinations(preview);
  const updates = useRoutingUpdates();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingTargets, setPendingTargets] = useState<DestinationConversation[] | null>(null);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const currentOwner = useRef(queryOwner);
  currentOwner.current = queryOwner;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setOpen(false); setChoice(""); setError(""); setRecovery(false); }, [queryOwner]);
  const overLimit = targets.length > destinationBatchLimit;
  // Refreshed rows may disappear before the batch response arrives. Keep the
  // attempted scope visible until that request settles; live selection still owns retries.
  const presentedTargets = pendingTargets ?? targets;
  const presentedAccounts = new Set(presentedTargets.map(target => target.accountId)).size;
  const blocked = disabled || busy || updates.recovering || catalog.locked || recovery || updates.recoveryRequired || !targets.length || overLimit;
  async function move() {
    if (blocked || lock.current || !catalog.data || !catalog.active.some(space => space.id === choice)) return;
    const attempted = targets.map(target => ({ ...target }));
    const owner = queryOwner;
    const receiptOwner = updates.begin();
    lock.current = true; setPendingTargets(attempted); setBusy(true); onBusy(true); setError("");
    try {
      const result = destinationBatchResultSchema.parse(await attentionRequest("/v1/destinations/routing/batch", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: catalog.data.revision, changes: attempted.map(target => ({ ...target, destinationId: choice })) }),
      }));
      const expected = attempted.map(conversationKey).sort().join("\n");
      if (result.targets.map(conversationKey).sort().join("\n") !== expected || result.undo.changes.map(conversationKey).sort().join("\n") !== expected || result.undo.expectedRevision !== result.state.revision) throw new Error("Batch response mismatch.");
      if (mounted.current && currentOwner.current === owner) { onMoved(attempted, owner); setOpen(false); }
      await updates.changed({ batch: true, undo: result.undo, text: `${attempted.length} ${attempted.length === 1 ? "conversation" : "conversations"} moved to ${catalog.label(choice)}.` }, receiptOwner);
    } catch (cause) {
      updates.requireRecovery(receiptOwner);
      if (mounted.current && currentOwner.current === owner) {
        const rejected = cause instanceof RoutingRequestError && [400, 401, 403, 404, 409].includes(cause.status);
        setError(rejected ? `${cause.message} No conversations were moved. Reload spaces and review your selection.` : "Move could not be confirmed. Reload current mail and review before making another move. No automatic retry or Undo is available.");
        setRecovery(true);
      }
      // Refresh canonical pages even if navigation removed the original selection.
      await updates.changed(undefined, receiptOwner);
    } finally {
      lock.current = false;
      if (mounted.current) { setPendingTargets(null); setBusy(false); onBusy(false); }
    }
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy(true);
    try { if (!await updates.recover()) throw new Error("Mail reload failed"); if (mounted.current) { setRecovery(false); setError("Current mail reloaded. Review the selected conversations and space before moving again."); } }
    catch { if (mounted.current) setError("Spaces could not reload. Your choice is preserved; try reloading again."); }
    finally { lock.current = false; if (mounted.current) { setBusy(false); onBusy(false); } }
  }
  return <>
    <div className="bulk-space-action">
      <button className="bulk-space-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || busy || preview || !targets.length || overLimit} onClick={() => setOpen(true)}>Move to space</button>
      {overLimit && <span role="status">Select up to {destinationBatchLimit} conversations per move. Deselect {targets.length - destinationBatchLimit} to continue.</span>}
      {preview && <span>Connect an account to move conversations.</span>}
    </div>
    {open && <TopLayer ariaLabelledBy="bulk-space-title" className="simple-attention-dialog bulk-space-dialog" layerClassName="desktop-dialog-layer" backdropClassName="desktop-dialog-backdrop" backdropAriaLabel="Close Move to space" initialFocusSelector=".routing-destinations button" dismissible={!busy} ariaBusy={busy} onClose={() => setOpen(false)}>
      <h2 id="bulk-space-title">Move to space</h2>
      <p>{presentedTargets.length} selected {presentedTargets.length === 1 ? "conversation" : "conversations"} across {presentedAccounts} {presentedAccounts === 1 ? "account" : "accounts"}. Only these conversations move; sender choices stay as they are.</p>
      <div className="routing-destinations" aria-label="Space">{catalog.active.map(space => <button type="button" key={space.id} aria-pressed={choice === space.id} disabled={busy || catalog.locked} onClick={() => setChoice(space.id)}><span aria-hidden="true" className="desktop-space-mark" style={{ background: space.color }} />{space.name}</button>)}</div>
      {catalog.loading && <p role="status">Loading spaces…</p>}
      {busy && <p role="status">Updating selected conversations…</p>}
      {(error || catalog.error) && <p role="alert">{error || catalog.error}</p>}
      {updates.recoveryRequired && !error && <p role="alert">A previous move needs recovery. Reload current mail before moving conversations.</p>}
      {(recovery || updates.recoveryRequired || catalog.error) && <button type="button" disabled={busy || updates.recovering} onClick={() => void reload()}>Reload spaces and mail</button>}
      {!busy && !targets.length && <p role="status">No selected conversations remain in this view. Close and select visible messages.</p>}
      <footer><button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button type="button" disabled={blocked || !catalog.active.some(space => space.id === choice)} onClick={() => void move()}>{busy ? "Moving…" : "Move conversations"}</button></footer>
    </TopLayer>}
  </>;
}
