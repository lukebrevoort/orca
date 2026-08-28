import { useEffect, useMemo, useRef, useState } from "react";
import {
  organizationViewListResponseSchema,
  organizationViewResultPageSchema,
  organizationViewsFixture,
  organizationWeeklyViewResultsFixture,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewResultItem,
  type OrganizationViewResultPage,
} from "@orca/shared";

type LoadState = "loading" | "ready" | "saving" | "error";
type ComposerMode = "create" | "edit";

async function readJson(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function splitList(value: string) { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function predicateCount(definition: OrganizationViewDefinition) {
  return [definition.accountIds, definition.laneIds, definition.facetFilters, definition.contextFilters, definition.workflowStateIds, definition.humanSignal, definition.sender, definition.date, definition.thread].filter(Boolean).length;
}
function laneLabel(id: string) { return id === "lane_everything_else" ? "Everything else" : id.replace(/^lane_/, "").replaceAll("_", " "); }
function mutationKey(kind: string) { return `orca_web:${kind}:${crypto.randomUUID()}`; }

const emptyResults = (view: OrganizationView): OrganizationViewResultPage => ({ viewId: view.id, viewRevision: view.revision, accountIds: view.definition.accountIds ?? [], items: [], nextCursor: null, limit: 25 });
const demoContinuationItem: OrganizationViewResultItem = {
  accountId: "account_outlook", accountEmail: "work@outlook.example", provider: "outlook", threadId: "thread_customer_followup",
  subject: "Customer follow-up after production recovery", latestReceivedAt: "2026-08-25T17:40:00.000Z", messageCount: 2,
  readState: "mixed", primaryLaneId: "lane_focus", sender: { name: "Ari Ops", email: "ops@acme.example" },
  humanSignal: 9, humanClassification: "likely_human",
};

export function OrganizationViewsWorkspace({ demoMode = false }: { demoMode?: boolean }) {
  const [views, setViews] = useState<OrganizationView[]>(demoMode ? organizationViewsFixture : []);
  const [activeViewId, setActiveViewId] = useState(demoMode ? organizationViewsFixture[0]!.id : "");
  const [results, setResults] = useState<OrganizationViewResultPage | null>(demoMode ? organizationWeeklyViewResultsFixture : null);
  const [workspaceRevision, setWorkspaceRevision] = useState(1);
  const [status, setStatus] = useState<LoadState>(demoMode ? "ready" : "loading");
  const [pageStatus, setPageStatus] = useState<"idle" | "loading" | "error">("idle");
  const [pageError, setPageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(null);
  const [editingDefinition, setEditingDefinition] = useState<OrganizationViewDefinition | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#70867d");
  const [accounts, setAccounts] = useState("");
  const [lanes, setLanes] = useState("");
  const [workflowStates, setWorkflowStates] = useState("");
  const [facetId, setFacetId] = useState("");
  const [facetValue, setFacetValue] = useState("");
  const [contextTypeId, setContextTypeId] = useState("");
  const [contextId, setContextId] = useState("");
  const [relationshipTypeId, setRelationshipTypeId] = useState("");
  const [minimumSignal, setMinimumSignal] = useState("");
  const [senderAddress, setSenderAddress] = useState("");
  const [senderDomain, setSenderDomain] = useState("");
  const [receivedAfter, setReceivedAfter] = useState("");
  const [subjectContains, setSubjectContains] = useState("");
  const [readState, setReadState] = useState<"any" | "read" | "unread">("any");
  const resultRequest = useRef(0);
  const activeView = views.find((view) => view.id === activeViewId) ?? null;

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    setStatus("loading");
    void readJson("/v1/organization/views", { signal: controller.signal }).then((body) => {
      if (controller.signal.aborted) return;
      const parsed = organizationViewListResponseSchema.parse(body);
      setViews(parsed.items); setWorkspaceRevision(parsed.workspaceRevision); setActiveViewId((current) => current || parsed.items[0]?.id || ""); setStatus("ready");
    }).catch((reason) => { if (!controller.signal.aborted) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not load Views"); } });
    return () => controller.abort();
  }, [demoMode]);

  useEffect(() => {
    if (demoMode || !activeViewId || !activeView) return;
    const controller = new AbortController();
    const requestId = ++resultRequest.current;
    const revision = activeView.revision;
    setStatus("loading");
    setPageStatus("idle"); setPageError(null); setResults(null);
    void readJson(`/v1/organization/views/${encodeURIComponent(activeViewId)}/results?limit=25`, { signal: controller.signal }).then((body) => {
      const parsed = organizationViewResultPageSchema.parse(body);
      if (!controller.signal.aborted && requestId === resultRequest.current && parsed.viewId === activeViewId && parsed.viewRevision === revision) { setResults(parsed); setStatus("ready"); }
    }).catch((reason) => { if (!controller.signal.aborted) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not run View"); } });
    return () => controller.abort();
  }, [activeViewId, activeView?.revision, demoMode]);

  const accountCount = results?.accountIds.length || activeView?.definition.accountIds?.length || (demoMode ? 2 : 0);
  const items = results?.viewId === activeViewId ? results.items : [];
  const activePredicates = useMemo(() => activeView ? predicateCount(activeView.definition) : 0, [activeView]);

  function selectView(view: OrganizationView) {
    resultRequest.current += 1;
    setActiveViewId(view.id); setError(null); setPageError(null); setPageStatus("idle"); setComposerMode(null); setPendingRemoveId(null);
    if (demoMode) setResults(view.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(view));
  }

  async function loadMore() {
    if (!activeView || !results?.nextCursor || pageStatus === "loading") return;
    if (demoMode) {
      setPageStatus("loading"); setPageError(null);
      await Promise.resolve();
      setResults((current) => current ? { ...current, items: [...current.items, demoContinuationItem], nextCursor: null } : current);
      setPageStatus("idle");
      return;
    }
    const requestId = ++resultRequest.current;
    const viewId = activeView.id; const revision = activeView.revision; const cursor = results.nextCursor;
    setPageStatus("loading"); setPageError(null);
    try {
      const page = organizationViewResultPageSchema.parse(await readJson(`/v1/organization/views/${encodeURIComponent(viewId)}/results?limit=${results.limit}&cursor=${encodeURIComponent(cursor)}`));
      if (requestId !== resultRequest.current || activeViewId !== viewId || page.viewId !== viewId || page.viewRevision !== revision) return;
      setResults((current) => {
        if (!current || current.viewId !== viewId || current.viewRevision !== revision) return current;
        const seen = new Set(current.items.map((item) => `${item.accountId}:${item.threadId}`));
        return { ...page, items: [...current.items, ...page.items.filter((item) => !seen.has(`${item.accountId}:${item.threadId}`))] };
      });
      setPageStatus("idle");
    } catch (reason) {
      if (requestId === resultRequest.current) { setPageStatus("error"); setPageError(reason instanceof Error ? reason.message : "Could not load more Threads"); }
    }
  }

  function loadComposer(view?: OrganizationView) {
    const definition = view?.definition;
    setComposerMode(view ? "edit" : "create"); setPendingRemoveId(null); setError(null);
    setEditingDefinition(definition ?? null);
    setName(view?.name ?? ""); setDescription(view?.description ?? ""); setColor(view?.color ?? "#70867d");
    setAccounts(definition?.accountIds?.join(", ") ?? ""); setLanes(definition?.laneIds?.join(", ") ?? ""); setWorkflowStates(definition?.workflowStateIds?.join(", ") ?? "");
    const facet = definition?.facetFilters?.[0]; setFacetId(facet?.facetId ?? ""); setFacetValue(facet && "value" in facet ? String(facet.value) : "");
    const context = definition?.contextFilters?.[0]; setContextTypeId(context?.context.contextTypeId ?? ""); setContextId(context?.context.contextId ?? ""); setRelationshipTypeId(context?.relationshipTypeId ?? "");
    setMinimumSignal(definition?.humanSignal?.minimumScore?.toString() ?? ""); setSenderAddress(definition?.sender?.addresses?.join(", ") ?? ""); setSenderDomain(definition?.sender?.domains?.join(", ") ?? "");
    setReceivedAfter(definition?.date?.receivedAfter?.slice(0, 10) ?? ""); setSubjectContains(definition?.thread?.subjectContains ?? ""); setReadState(definition?.thread?.readState ?? "any");
  }

  function draftDefinition() {
    const accountIds = splitList(accounts); const laneIds = splitList(lanes); const stateIds = splitList(workflowStates);
    const original = composerMode === "edit" ? editingDefinition : null;
    const definition: OrganizationViewDefinition = { revision: 1 };
    if (accountIds.length) definition.accountIds = accountIds;
    if (laneIds.length) definition.laneIds = laneIds;
    if (stateIds.length) definition.workflowStateIds = stateIds;
    if (facetId.trim()) {
      const current = original?.facetFilters?.[0];
      const first = facetValue.trim()
        ? { facetId: facetId.trim(), operator: current && "value" in current ? current.operator : "equals", value: facetValue.trim() } as NonNullable<OrganizationViewDefinition["facetFilters"]>[number]
        : current && !("value" in current) ? { ...current, facetId: facetId.trim() } : null;
      if (first) definition.facetFilters = [first, ...(original?.facetFilters?.slice(1) ?? [])];
    }
    if (contextTypeId.trim() && contextId.trim() && relationshipTypeId.trim()) {
      definition.contextFilters = [{ context: { contextTypeId: contextTypeId.trim(), contextId: contextId.trim() }, relationshipTypeId: relationshipTypeId.trim(), ...(original?.contextFilters?.[0]?.direction ? { direction: original.contextFilters[0].direction } : {}) }, ...(original?.contextFilters?.slice(1) ?? [])];
    }
    const humanSignal = { ...(original?.humanSignal ?? {}) };
    if (minimumSignal) humanSignal.minimumScore = Number(minimumSignal); else delete humanSignal.minimumScore;
    if (Object.keys(humanSignal).length) definition.humanSignal = humanSignal;
    const addresses = splitList(senderAddress); const domains = splitList(senderDomain);
    if (addresses.length || domains.length) definition.sender = { ...(addresses.length ? { addresses } : {}), ...(domains.length ? { domains } : {}) };
    const date = { ...(original?.date ?? {}) };
    if (receivedAfter) date.receivedAfter = new Date(receivedAfter).toISOString(); else delete date.receivedAfter;
    if (Object.keys(date).length) definition.date = date;
    const thread = { ...(original?.thread ?? {}) };
    if (subjectContains.trim()) thread.subjectContains = subjectContains.trim(); else delete thread.subjectContains;
    if (readState !== "any") thread.readState = readState; else delete thread.readState;
    if (Object.keys(thread).length) definition.thread = thread;
    return definition;
  }

  async function saveView() {
    const definition = draftDefinition();
    setStatus("saving"); setError(null);
    try {
      if (composerMode === "edit" && activeView) {
        const updated = demoMode
          ? { ...activeView, name: name.trim(), description: description.trim(), color, definition, revision: activeView.revision + 1, updatedAt: new Date().toISOString() }
          : organizationViewListResponseSchema.shape.items.element.parse(await readJson(`/v1/organization/views/${encodeURIComponent(activeView.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("update"), expectedWorkspaceRevision: workspaceRevision, expectedRevision: activeView.revision, patch: { name: name.trim(), description: description.trim(), color, definition } }) }));
        setViews((current) => current.map((view) => view.id === updated.id ? updated : view)); setWorkspaceRevision((current) => current + 1);
        setResults((current) => demoMode && current?.viewId === updated.id ? { ...current, viewRevision: updated.revision } : null);
        setComposerMode(null); setStatus("ready");
      } else {
        const created = demoMode
          ? { id: `view_demo_${views.length + 1}`, workspaceId: "workspace_demo", name: name.trim(), description: description.trim(), color, position: views.length, definition, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as OrganizationView
          : organizationViewListResponseSchema.shape.items.element.parse(await readJson("/v1/organization/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("create"), expectedWorkspaceRevision: workspaceRevision, name: name.trim(), description: description.trim(), color, position: views.length, definition }) }));
        setViews((current) => [...current, created]); setWorkspaceRevision((current) => current + 1); setActiveViewId(created.id); setResults(null); setComposerMode(null); setName(""); setStatus("ready");
      }
    } catch (reason) { setStatus("ready"); setError(reason instanceof Error ? reason.message : `Could not ${composerMode === "edit" ? "update" : "create"} View`); }
  }

  async function moveView(view: OrganizationView, direction: -1 | 1) {
    const index = views.findIndex((candidate) => candidate.id === view.id); const other = views[index + direction];
    if (!other || status === "saving") return;
    setStatus("saving"); setError(null);
    try {
      if (demoMode) {
        const updated = views.map((candidate) => candidate.id === view.id ? { ...candidate, position: other.position, revision: candidate.revision + 1 } : candidate.id === other.id ? { ...candidate, position: view.position, revision: candidate.revision + 1 } : candidate).sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
        setViews(updated);
      } else {
        const body = await readJson("/v1/organization/views/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("reorder"), expectedWorkspaceRevision: workspaceRevision, items: [
          { id: view.id, expectedRevision: view.revision, position: other.position },
          { id: other.id, expectedRevision: other.revision, position: view.position },
        ] }) });
        const parsed = organizationViewListResponseSchema.parse(body); setViews(parsed.items); setWorkspaceRevision(parsed.workspaceRevision);
      }
      setStatus("ready");
    } catch (reason) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not reorder Views"); }
  }

  async function removeView(view: OrganizationView) {
    setStatus("saving"); setError(null);
    try {
      let remaining: OrganizationView[];
      if (demoMode) {
        remaining = views.filter((candidate) => candidate.id !== view.id);
        setWorkspaceRevision((current) => current + 1);
      } else {
        await readJson(`/v1/organization/views/${encodeURIComponent(view.id)}?expectedRevision=${view.revision}&expectedWorkspaceRevision=${workspaceRevision}&idempotencyKey=${encodeURIComponent(mutationKey("remove"))}`, { method: "DELETE" });
        const canonical = organizationViewListResponseSchema.parse(await readJson("/v1/organization/views"));
        remaining = canonical.items;
        setWorkspaceRevision(canonical.workspaceRevision);
      }
      setViews(remaining); setPendingRemoveId(null); setComposerMode(null);
      if (activeViewId === view.id) {
        const next = remaining[Math.min(views.indexOf(view), remaining.length - 1)] ?? null;
        setActiveViewId(next?.id ?? ""); setResults(next && demoMode ? (next.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(next)) : null);
      }
      setStatus("ready");
    } catch (reason) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not remove View"); }
  }

  return <section className="views-workspace" aria-labelledby="views-title">
    <header className="views-header"><div><span>Workspace queries · unlimited</span><h2 id="views-title">Live Views</h2><p>One Thread can appear in every useful perspective while keeping one primary Lane.</p></div><button className="view-action view-new" onClick={() => composerMode === "create" ? setComposerMode(null) : loadComposer()} type="button">{composerMode === "create" ? "Close composer" : "+ Compose View"}</button></header>
    <div className="views-live-note"><i aria-hidden="true"/><strong>Live from current Thread organization</strong><span>No membership list is stored.</span></div>
    {composerMode ? <form className="view-composer" onSubmit={(event) => { event.preventDefault(); void saveView(); }}>
      <header><div><span>And-composed predicates</span><h3>{composerMode === "edit" ? "Edit live perspective" : "Compose a live perspective"}</h3></div><div className="view-composer-actions">{composerMode === "edit" ? <button className="view-action" onClick={() => setComposerMode(null)} type="button">Cancel</button> : null}<button className="view-action" disabled={status === "saving" || !name.trim()} type="submit">{status === "saving" ? "Saving View…" : composerMode === "edit" ? "Save changes" : "Save View"}</button></div></header>
      <label><span>View name</span><input autoFocus maxLength={120} onInput={(event) => setName(event.currentTarget.value)} placeholder="Weekly review" value={name}/></label>
      <div className="view-predicate-grid"><label><span>Description</span><input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="What this perspective is for" value={description}/></label><label><span>Color</span><input aria-label="View color" onChange={(event) => setColor(event.target.value)} type="color" value={color}/></label><label><span>Accounts</span><input onChange={(event) => setAccounts(event.target.value)} placeholder="account_gmail, account_outlook" value={accounts}/></label><label><span>Primary Lanes</span><input onChange={(event) => setLanes(event.target.value)} placeholder="lane_focus" value={lanes}/></label><label><span>Facet</span><input onChange={(event) => setFacetId(event.target.value)} placeholder="facet_urgency" value={facetId}/></label><label><span>Facet value</span><input onChange={(event) => setFacetValue(event.target.value)} placeholder="urgent" value={facetValue}/></label><label><span>Context type</span><input onChange={(event) => setContextTypeId(event.target.value)} placeholder="context_type_project" value={contextTypeId}/></label><label><span>Context</span><input onChange={(event) => setContextId(event.target.value)} placeholder="context_orca" value={contextId}/></label><label><span>Relationship</span><input onChange={(event) => setRelationshipTypeId(event.target.value)} placeholder="relationship_concerns" value={relationshipTypeId}/></label><label><span>Workflow States</span><input onChange={(event) => setWorkflowStates(event.target.value)} placeholder="workflow_unresolved" value={workflowStates}/></label><label><span>Human Signal ≥</span><input max="10" min="0" onChange={(event) => setMinimumSignal(event.target.value)} placeholder="7" type="number" value={minimumSignal}/></label><label><span>Sender addresses</span><input onChange={(event) => setSenderAddress(event.target.value)} placeholder="ops@example.com, owner@example.com" value={senderAddress}/></label><label><span>Sender domains</span><input onChange={(event) => setSenderDomain(event.target.value)} placeholder="example.com" value={senderDomain}/></label><label><span>Received after</span><input onChange={(event) => setReceivedAfter(event.target.value)} type="date" value={receivedAfter}/></label><label><span>Thread subject</span><input onInput={(event) => setSubjectContains(event.currentTarget.value)} placeholder="production failure" value={subjectContains}/></label><label><span>Thread read state</span><select onChange={(event) => setReadState(event.target.value as typeof readState)} value={readState}><option value="any">Any</option><option value="unread">Unread</option><option value="read">Read</option></select></label></div>
    </form> : null}
    <div className="views-layout"><nav aria-label="Saved live Views" className="view-list">{views.map((view, index) => <div className="view-list-item" key={view.id}><button aria-pressed={view.id === activeViewId} className="view-chip" onClick={() => selectView(view)} type="button"><i aria-hidden="true" style={{ background: view.color }}/><span><strong>{view.name}</strong><small>{predicateCount(view.definition)} predicate families</small></span><b>›</b></button><div className="view-order-controls"><button aria-label={`Move ${view.name} up`} className="view-icon-action" disabled={index === 0 || status === "saving"} onClick={() => void moveView(view, -1)} type="button">↑</button><button aria-label={`Move ${view.name} down`} className="view-icon-action" disabled={index === views.length - 1 || status === "saving"} onClick={() => void moveView(view, 1)} type="button">↓</button></div></div>)}</nav>
      <section aria-busy={status === "loading" || status === "saving" || undefined} className="view-results"><header><div><span>{accountCount} {accountCount === 1 ? "account" : "accounts"} · {activePredicates} predicate families</span><h3>{activeView?.name ?? "Choose a View"}</h3><p>{activeView?.description || "Results re-evaluate whenever the underlying Thread changes."}</p></div><div className="view-lifecycle-actions"><button className="view-action" disabled={!activeView || status !== "ready"} onClick={() => activeView && loadComposer(activeView)} type="button">Edit definition</button>{pendingRemoveId === activeView?.id ? <><button className="view-action" onClick={() => setPendingRemoveId(null)} type="button">Cancel</button><button className="view-action view-danger view-confirm" disabled={status === "saving"} onClick={() => activeView && void removeView(activeView)} type="button">Confirm remove</button></> : <button className="view-action view-danger" disabled={!activeView || status !== "ready"} onClick={() => activeView && setPendingRemoveId(activeView.id)} type="button">Remove View</button>}</div></header>
      {error ? <p className="view-state view-state-error" role="alert">Could not change this View. {error}</p> : null}
      {status === "loading" ? <p className="view-state" role="status">Running the current View…</p> : null}
      {status === "ready" && activeView && items.length === 0 ? <p className="view-state">No Threads match right now. The definition stays ready for the next underlying change.</p> : null}
      {items.length ? <div className="view-thread-list">{items.map((item) => <ViewThreadRow item={item} key={`${item.accountId}:${item.threadId}`}/>)}</div> : null}
      {items.length ? <div className="view-continuation"><button className="view-action" disabled={!results?.nextCursor || pageStatus === "loading"} onClick={() => void loadMore()} type="button">{pageStatus === "loading" ? "Loading more Threads…" : results?.nextCursor ? "Load more" : "All matching Threads loaded"}</button>{pageError ? <p className="view-state view-state-error" role="alert">Could not load more Threads. {pageError}</p> : null}</div> : null}
      </section></div>
  </section>;
}

function ViewThreadRow({ item }: { item: OrganizationViewResultItem }) {
  return <article className="view-thread-row"><span aria-hidden="true" className="view-thread-signal">{item.humanSignal ?? "·"}</span><div><strong>{item.subject}</strong><small>{item.sender.name ?? item.sender.email} · {item.accountEmail}</small></div><span className="view-thread-lane">{laneLabel(item.primaryLaneId)}</span><time dateTime={item.latestReceivedAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.latestReceivedAt))}</time></article>;
}
