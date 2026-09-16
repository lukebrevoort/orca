import { useEffect, useRef, useState } from "react";
import { organizationViewListResponseSchema, type OrganizationView } from "@orca/shared";
import { OrganizationAuthorityError, OrganizationAuthorityProvider, OrganizationRecoveryBanner, useOrganizationAuthority } from "./organization-authority";

type DeletionProps = {
  viewId: string;
  label: string;
  demoView?: OrganizationView;
  demoMode?: boolean;
  onCancel: () => void;
  onDeleted: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
};

export function SavedViewDeletion(props: DeletionProps) {
  return <OrganizationAuthorityProvider previewMode={props.demoMode}><DeletionConfirmation {...props}/></OrganizationAuthorityProvider>;
}

function DeletionConfirmation({ viewId, label, demoView, demoMode = false, onCancel, onDeleted, onBusyChange }: DeletionProps) {
  const authority = useOrganizationAuthority();
  const [snapshot, setSnapshot] = useState<{ view: OrganizationView; workspaceRevision: number } | null>(demoMode && demoView ? { view: demoView, workspaceRevision: 0 } : null);
  const [loading, setLoading] = useState(!demoMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const envelope = useRef<string | null>(null);
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (demoMode || authority.state.kind !== "ready") return;
    const controller = new AbortController();
    setLoading(true); setSnapshot(null);
    void authority.response("/v1/organization/views", { signal: controller.signal }, { operation: "read", capability: "query" }).then(async response => {
      if (response.status !== 200) throw new Error("The complete view list is unavailable. Refresh before deleting.");
      const value: unknown = await response.json();
      if (controller.signal.aborted) return;
      const listed = organizationViewListResponseSchema.parse(value);
      const view = listed.items.find(item => item.id === viewId);
      // A previous attempt may have committed despite a lost response. A canonical
      // absence reconciles the shortcut without issuing another mutation.
      if (!view) { onDeletedRef.current(viewId); return; }
      setSnapshot({ view, workspaceRevision: listed.workspaceRevision });
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load this view."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [demoMode, viewId, authority.state.kind, authority.refreshToken, authority.response]);

  const canDelete = !demoMode && Boolean(snapshot) && !loading && !saving && !conflict && authority.state.canMutate && authority.allows.apply;
  async function remove() {
    if (!canDelete || !snapshot || inFlight.current) return;
    inFlight.current = true; setSaving(true); onBusyChange(true); setError(null);
    try {
      if (!demoMode) {
        envelope.current ??= `/v1/organization/views/${encodeURIComponent(viewId)}?${new URLSearchParams({ expectedRevision: String(snapshot.view.revision), expectedWorkspaceRevision: String(snapshot.workspaceRevision), idempotencyKey: `delete-view-${crypto.randomUUID()}` })}`;
        await authority.request(envelope.current, { method: "DELETE" }, { operation: "mutation", capability: "apply", hasReliableData: true });
      }
      if (alive.current) onDeletedRef.current(viewId);
    } catch (reason) {
      if (!alive.current) return;
      const stale = reason instanceof OrganizationAuthorityError && reason.status === 409;
      setConflict(stale);
      setError(stale ? "This view or workspace changed. Refresh and review it again before deleting." : reason instanceof Error ? reason.message : "Could not delete this view. Try again.");
    } finally {
      inFlight.current = false;
      if (alive.current) { setSaving(false); onBusyChange(false); }
    }
  }
  function refresh() {
    // Only a definite conflict abandons the old revision-bound retry envelope.
    // Network/5xx retries retain it to safely recover an ambiguous response.
    if (conflict) envelope.current = null;
    setConflict(false); setError(null); setLoading(true); authority.retry();
  }
  return <section aria-busy={saving || loading} aria-labelledby="delete-saved-view-title" className="desktop-view-delete">
    <h3 id="delete-saved-view-title">Delete “{snapshot?.view.name ?? label}”?</h3>
    <p>This permanently deletes the saved view and its Inbox exclusion policy. Matching mail may return to Inbox. No email is deleted.</p>
    {snapshot ? <p className="desktop-view-delete-policy">{snapshot.view.skipInbox ? "This view currently skips Inbox." : "This view currently keeps mail in Inbox."} Restore instead to keep the view and its policy.</p> : null}
    {!demoMode ? <OrganizationRecoveryBanner/> : <p>Sample views cannot be deleted in this demo. Connect an account to delete saved views.</p>}
    {loading && (authority.state.kind === "ready" || authority.state.kind === "loading") ? <p role="status">Checking the saved view…</p> : null}
    {error ? <p className="desktop-space-operation-error" role="alert">{error}</p> : null}
    <div className="desktop-view-delete-actions"><button autoFocus disabled={saving} onClick={onCancel} type="button">Cancel</button>{error && !saving ? <button onClick={refresh} type="button">Refresh view</button> : null}<button className="desktop-view-delete-confirm" disabled={!canDelete} onClick={() => void remove()} type="button">{saving ? "Deleting…" : "Delete view"}</button></div>
  </section>;
}
