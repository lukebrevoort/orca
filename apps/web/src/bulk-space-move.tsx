import { useEffect, useRef, useState, type ReactNode } from "react";
import { destinationBatchLimit, destinationBatchResultSchema, type DestinationConversation } from "@orca/shared";
import { attentionRequest, RoutingRequestError, useRoutingUpdates } from "./attention-routing";
import { useDestinations } from "./mail-destinations";

export function conversationKey(target: DestinationConversation) { return JSON.stringify([target.accountId, target.threadId]); }
export function selectedConversations(messages: readonly DestinationConversation[]) {
  return [...new Map(messages.map(message => [conversationKey(message), { accountId: message.accountId, threadId: message.threadId }])).values()];
}

/** Selection stays owned by InboxView; the receipt outlives the sentence and its rows. */
export function BulkSpaceMove({ targets, disabled, preview, queryOwner, onMoved, onBusy, scope, resetKey }: {
  scope: ReactNode; resetKey: number;
  targets: DestinationConversation[]; disabled: boolean; preview: boolean; queryOwner: number;
  onMoved: (targets: DestinationConversation[], owner: number) => void; onBusy: (busy: boolean, owner: number, operation: symbol) => void;
}) {
  const catalog = useDestinations(preview);
  const updates = useRoutingUpdates();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingTargets, setPendingTargets] = useState<DestinationConversation[] | null>(null);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const releaseBusy = useRef<(() => void) | null>(null);
  const currentOwner = useRef(queryOwner);
  currentOwner.current = queryOwner;
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    releaseBusy.current?.();
  }; }, []);
  function beginBusy() {
    const operation = Symbol("bulk-space-operation");
    const owner = queryOwner;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (releaseBusy.current === release) releaseBusy.current = null;
      // Parent ownership checks prevent an old query or detached operation from
      // unlocking a newer request, including a remount within the same query.
      onBusy(false, owner, operation);
    };
    releaseBusy.current = release;
    onBusy(true, owner, operation);
    return release;
  }
  useEffect(() => { setChoice(""); setError(""); setRecovery(false); }, [queryOwner, resetKey]);
  useEffect(() => { if (!targets.length && !busy) setChoice(""); }, [targets.length, busy]);
  const overLimit = targets.length > destinationBatchLimit;
  // Refreshed rows may disappear before the batch response arrives. Keep the
  // attempted scope visible until that request settles; live selection still owns retries.
  const presentedTargets = pendingTargets ?? targets;
  const presentedAccounts = new Set(presentedTargets.map(target => target.accountId)).size;
  const blocked = preview || disabled || busy || updates.recovering || catalog.locked || recovery || updates.recoveryRequired || !targets.length || overLimit;
  async function move() {
    if (blocked || lock.current || !catalog.data || !catalog.active.some(space => space.id === choice)) return;
    const attempted = targets.map(target => ({ ...target }));
    const owner = queryOwner;
    const receiptOwner = updates.begin();
    lock.current = true; setPendingTargets(attempted); setBusy(true); setError("");
    const finishBusy = beginBusy();
    try {
      const result = destinationBatchResultSchema.parse(await attentionRequest("/v1/destinations/routing/batch", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: catalog.data.revision, changes: attempted.map(target => ({ ...target, destinationId: choice })) }),
      }));
      const expected = attempted.map(conversationKey).sort().join("\n");
      if (result.targets.map(conversationKey).sort().join("\n") !== expected || result.undo.changes.map(conversationKey).sort().join("\n") !== expected || result.undo.expectedRevision !== result.state.revision) throw new Error("Batch response mismatch.");
      if (mounted.current && currentOwner.current === owner) { onMoved(attempted, owner); }
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
      finishBusy();
      if (mounted.current) { setPendingTargets(null); setBusy(false); }
    }
  }
  async function reload() {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    const finishBusy = beginBusy();
    try { if (!await updates.recover()) throw new Error("Mail reload failed"); if (mounted.current) { setRecovery(false); setError("Current mail reloaded. Review the selected conversations and space before moving again."); } }
    catch { if (mounted.current) setError("Spaces could not reload. Your choice is preserved; try reloading again."); }
    finally { lock.current = false; finishBusy(); if (mounted.current) setBusy(false); }
  }
  return <div className="bulk-space-sentence" aria-busy={busy}>
    <div className="selection-sentence">
      <span>Let’s put</span>{busy ? <span>{presentedTargets.length === 1 ? "this conversation" : `these ${presentedTargets.length} conversations`}</span> : scope}<span>in</span>
      <label className="selection-destination"><span className="visually-hidden">Destination space</span><select aria-label="Destination space" disabled={disabled || busy || catalog.loading || (!preview && catalog.locked)} value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="" disabled>a space</option>
        {catalog.active.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
      </select></label><span>.</span>
      <button className="selection-commit" type="button" aria-label={busy ? "Moving…" : "Move conversations"} title={choice ? `Move selected conversations to ${catalog.label(choice)}` : "Choose a space first"} disabled={blocked || !catalog.active.some(space => space.id === choice)} onClick={() => void move()}><span aria-hidden="true">{busy ? "…" : "↗"}</span></button>
    </div>
    <div className="selection-move-status">
      {overLimit && <p role="status">Select up to {destinationBatchLimit} conversations per move. Deselect {targets.length - destinationBatchLimit} to continue.</p>}
      {preview && <p>Connect an account to move conversations.</p>}
      {catalog.loading && <p role="status">Loading spaces…</p>}
      {busy && <p role="status">Moving {presentedTargets.length} {presentedTargets.length === 1 ? "conversation" : "conversations"} across {presentedAccounts} {presentedAccounts === 1 ? "account" : "accounts"}…</p>}
      {(error || catalog.error) && <p role="alert">{error || catalog.error}</p>}
      {!busy && !targets.length && (recovery || updates.recoveryRequired) && <p role="status">No selected conversations remain in this view. Reload mail and choose visible conversations.</p>}
      {updates.recoveryRequired && !error && <p role="alert">A previous move needs recovery. Reload current mail before moving conversations.</p>}
      {(recovery || updates.recoveryRequired || catalog.error) && <button type="button" disabled={busy || updates.recovering} onClick={() => void reload()}>Reload spaces and mail</button>}
    </div>
  </div>;
}
