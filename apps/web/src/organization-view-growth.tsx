import "./organization-view-growth.css";
import { useEffect, useState, type ComponentProps } from "react";
import { organizationViewListResponseSchema, organizationViewsFixture, senderGrowthBlocker, type OrganizationView } from "@orca/shared";
import { OrganizationAuthorityProvider, useOrganizationAuthority } from "./organization-authority";
import { OrganizationViewAuthoringWorkspace, type OrganizationViewAuthoringEntry } from "./organization-views";
import { requestViewNavigation } from "./view-navigation-guard";

type Props<T> = ComponentProps<typeof OrganizationViewAuthoringWorkspace<T>>;

/** The chooser only supplies a revision-bound target; prepare resolves all sender facts. */
export function OrganizationViewGrowthWorkspace<T>(props: Props<T>) {
  return <OrganizationAuthorityProvider previewMode={props.demoMode}><GrowthChooser {...props}/></OrganizationAuthorityProvider>;
}
function GrowthChooser<T>(props: Props<T>) {
  const authority = useOrganizationAuthority();
  const [views, setViews] = useState<OrganizationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [targetId, setTargetId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("addSendersTo") ?? "");
  const [review, setReview] = useState<OrganizationViewAuthoringEntry<T> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  function returnToChooser() { setReview(null); setRetry(value => value + 1); }
  useEffect(() => {
    if (review) return;
    if (props.dismissRef) props.dismissRef.current = () => props.onCancel(props.entry.returnContext);
    document.querySelector<HTMLElement>(".view-growth-chooser h2")?.focus();
  }, [review]);
  useEffect(() => {
    if (!props.demoMode && !authority.snapshot) return;
    const controller = new AbortController();
    setError(null);
    if (props.demoMode) { setViews(organizationViewsFixture); return; }
    void authority.request("/v1/organization/views", { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: false }).then(body => {
      if (!controller.signal.aborted) setViews(organizationViewListResponseSchema.parse(body).items);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load Views."); });
    return () => controller.abort();
  }, [authority.snapshot, retry, props.demoMode]);
  if (review) {
    const editingExisting = review.preparation.kind === "saved_view";
    return <>
      {editingExisting ? <aside className="view-growth-return" aria-label="Selected mail preserved"><strong>Your selected mail is kept</strong><p>You are editing this saved view’s existing filters. This does not add your selected senders. Return to the chooser to review adding them, or Cancel there to return to your selected mail.</p><button className="view-action" onClick={() => requestViewNavigation(returnToChooser)} type="button">Return to selected senders</button></aside> : null}
      <OrganizationViewAuthoringWorkspace {...props} entry={review} onCancel={returnToChooser} onCommitted={(result, context) => {
        if (editingExisting) { setNotice("Saved view updated. Your selected mail is kept; review adding its senders below."); returnToChooser(); }
        else props.onCommitted(result, context);
      }}/>
    </>;
  }
  const preparation = props.entry.preparation;
  if (preparation.kind !== "selected_senders") return null;
  const accountId = preparation.references[0]!.accountId;
  const target = views?.find(view => view.id === targetId);
  const blocker = target ? senderGrowthBlocker(target.definition, accountId) : null;
  return <section className="views-workspace view-growth-chooser" aria-labelledby="views-title">
    <header className="views-header"><div><h2 id="views-title" tabIndex={-1} data-dialog-initial-focus>Add to an existing View</h2><p>Widen its sender set, then review matching mail before saving.</p></div></header>
    {notice ? <p role="status">{notice}</p> : null}
    <section className="view-scope-sentence"><span>Selected mail</span><p>{preparation.references.length} {preparation.references.length === 1 ? "message" : "messages"} · {props.entry.accountLabels?.[accountId] ?? accountId}</p><p>Orca checks the exact stored From addresses and omits messages sent by this account. Other filters still apply; a live View does not move mail into a folder.</p></section>
    {!props.demoMode && !authority.snapshot && authority.state.kind !== "loading" ? <p role="alert">{authority.state.detail} Your selected mail is kept. <button className="view-action" onClick={authority.retry} type="button">Retry connection</button></p> : null}
    {!views && !error && (props.demoMode || authority.state.kind === "loading" || authority.snapshot) ? <p role="status">Loading saved Views…</p> : null}
    {error ? <p role="alert">{error} Your selection is kept. <button className="view-action" onClick={() => setRetry(value => value + 1)} type="button">Retry Views</button></p> : null}
    {views ? <label className="view-scope-sentence"><span>Saved View</span><select aria-label="Saved View to grow" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">Choose a saved View</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label> : null}
    {target ? <section className="view-scope-sentence"><span>Current definition · revision {target.revision}</span><p>{target.definition.sender?.addresses?.join(", ") || "No exact sender addresses"}{target.definition.sender?.domains ? ` · domains: ${target.definition.sender.domains.join(", ")}` : ""}</p><p>Account scope: {target.definition.accountIds?.map(id => props.entry.accountLabels?.[id] ?? id).join(", ") ?? "All authorized accounts"}. Inbox policy: {target.skipInbox ? "Keep matching mail out of Inbox" : "Keep matching mail in Inbox"}.</p></section> : null}
    {blocker && target ? <div className="view-state"><p role="status">{blocker}</p><p>Edit this view’s filters, then return here with your selected mail intact.</p><button className="view-action" onClick={() => { setNotice(null); setReview({ preparation: { kind: "saved_view", viewId: target.id }, accountLabels: props.entry.accountLabels, returnContext: props.entry.returnContext }); }} type="button">Edit {target.name}</button></div> : null}
    {views?.length === 0 ? <p>No saved Views yet. Create a sender View from this selection.</p> : null}
    <div className="view-composer-actions"><button className="view-action" onClick={() => props.onCancel(props.entry.returnContext)} type="button">Cancel</button><button className="view-action" onClick={() => setReview(props.entry)} type="button">Create a new sender View</button><button className="view-action" disabled={!target || Boolean(blocker)} onClick={() => target && setReview({ ...props.entry, growthCurrentView: target, preparation: { ...preparation, targetView: { id: target.id, revision: target.revision } } })} type="button">Preview added senders</button></div>
  </section>;
}
