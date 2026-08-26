import { useEffect, useMemo, useState } from "react";
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

const emptyResults = (view: OrganizationView): OrganizationViewResultPage => ({ viewId: view.id, viewRevision: view.revision, accountIds: view.definition.accountIds ?? [], items: [], nextCursor: null, limit: 25 });

export function OrganizationViewsWorkspace({ demoMode = false }: { demoMode?: boolean }) {
  const [views, setViews] = useState<OrganizationView[]>(demoMode ? organizationViewsFixture : []);
  const [activeViewId, setActiveViewId] = useState(demoMode ? organizationViewsFixture[0]!.id : "");
  const [results, setResults] = useState<OrganizationViewResultPage | null>(demoMode ? organizationWeeklyViewResultsFixture : null);
  const [status, setStatus] = useState<LoadState>(demoMode ? "ready" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [name, setName] = useState("");
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

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    setStatus("loading");
    void readJson("/v1/organization/views", { signal: controller.signal }).then((body) => {
      if (controller.signal.aborted) return;
      const parsed = organizationViewListResponseSchema.parse(body);
      setViews(parsed.items); setActiveViewId((current) => current || parsed.items[0]?.id || ""); setStatus("ready");
    }).catch((reason) => { if (!controller.signal.aborted) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not load Views"); } });
    return () => controller.abort();
  }, [demoMode]);

  useEffect(() => {
    if (demoMode || !activeViewId) return;
    const controller = new AbortController();
    setStatus("loading");
    void readJson(`/v1/organization/views/${encodeURIComponent(activeViewId)}/results?limit=25`, { signal: controller.signal }).then((body) => {
      if (!controller.signal.aborted) { setResults(organizationViewResultPageSchema.parse(body)); setStatus("ready"); }
    }).catch((reason) => { if (!controller.signal.aborted) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not run View"); } });
    return () => controller.abort();
  }, [activeViewId, demoMode]);

  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const accountCount = results?.accountIds.length || activeView?.definition.accountIds?.length || (demoMode ? 2 : 0);
  const items = results?.viewId === activeViewId ? results.items : [];
  const activePredicates = useMemo(() => activeView ? predicateCount(activeView.definition) : 0, [activeView]);

  function selectView(view: OrganizationView) {
    setActiveViewId(view.id); setError(null);
    if (demoMode) setResults(view.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(view));
  }

  async function createView() {
    const accountIds = splitList(accounts); const laneIds = splitList(lanes); const stateIds = splitList(workflowStates);
    const definition: OrganizationViewDefinition = {
      revision: 1,
      ...(accountIds.length ? { accountIds } : {}), ...(laneIds.length ? { laneIds } : {}), ...(stateIds.length ? { workflowStateIds: stateIds } : {}),
      ...(facetId.trim() && facetValue.trim() ? { facetFilters: [{ facetId: facetId.trim(), operator: "equals", value: facetValue.trim() }] } : {}),
      ...(contextTypeId.trim() && contextId.trim() && relationshipTypeId.trim() ? { contextFilters: [{ context: { contextTypeId: contextTypeId.trim(), contextId: contextId.trim() }, relationshipTypeId: relationshipTypeId.trim() }] } : {}),
      ...(minimumSignal ? { humanSignal: { minimumScore: Number(minimumSignal) } } : {}),
      ...(senderAddress.trim() || senderDomain.trim() ? { sender: { ...(senderAddress.trim() ? { addresses: [senderAddress.trim()] } : {}), ...(senderDomain.trim() ? { domains: [senderDomain.trim()] } : {}) } } : {}),
      ...(receivedAfter ? { date: { receivedAfter: new Date(receivedAfter).toISOString() } } : {}),
      ...(subjectContains.trim() || readState !== "any" ? { thread: { ...(subjectContains.trim() ? { subjectContains: subjectContains.trim() } : {}), ...(readState !== "any" ? { readState } : {}) } } : {}),
    };
    setStatus("saving"); setError(null);
    try {
      const created = demoMode
        ? { id: `view_demo_${views.length + 1}`, workspaceId: "workspace_demo", name: name.trim(), description: "Local preview View", color: "#70867d", position: views.length, definition, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as OrganizationView
        : organizationViewListResponseSchema.shape.items.element.parse(await readJson("/v1/organization/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), description: "", color: "#70867d", position: views.length, definition }) }));
      setViews((current) => [...current, created]); setActiveViewId(created.id); setResults(emptyResults(created)); setComposerOpen(false); setName(""); setStatus("ready");
    } catch (reason) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not create View"); }
  }

  return <section className="views-workspace" aria-labelledby="views-title">
    <header className="views-header"><div><span>Workspace queries · unlimited</span><h2 id="views-title">Live Views</h2><p>One Thread can appear in every useful perspective while keeping one primary Lane.</p></div><button className="view-action view-new" onClick={() => setComposerOpen((value) => !value)} type="button">{composerOpen ? "Close composer" : "+ Compose View"}</button></header>
    <div className="views-live-note"><i aria-hidden="true"/><strong>Live from current Thread organization</strong><span>No membership list is stored.</span></div>
    {composerOpen ? <form className="view-composer" onSubmit={(event) => { event.preventDefault(); void createView(); }}>
      <header><div><span>And-composed predicates</span><h3>Compose a live perspective</h3></div><button className="view-action" disabled={status === "saving" || !name.trim()} type="submit">{status === "saving" ? "Saving View…" : "Save View"}</button></header>
      <label><span>View name</span><input autoFocus maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Weekly review" value={name}/></label>
      <div className="view-predicate-grid"><label><span>Accounts</span><input onChange={(event) => setAccounts(event.target.value)} placeholder="account_gmail, account_outlook" value={accounts}/></label><label><span>Primary Lanes</span><input onChange={(event) => setLanes(event.target.value)} placeholder="lane_focus" value={lanes}/></label><label><span>Facet</span><input onChange={(event) => setFacetId(event.target.value)} placeholder="facet_urgency" value={facetId}/></label><label><span>Facet value</span><input onChange={(event) => setFacetValue(event.target.value)} placeholder="urgent" value={facetValue}/></label><label><span>Context type</span><input onChange={(event) => setContextTypeId(event.target.value)} placeholder="context_type_project" value={contextTypeId}/></label><label><span>Context</span><input onChange={(event) => setContextId(event.target.value)} placeholder="context_orca" value={contextId}/></label><label><span>Relationship</span><input onChange={(event) => setRelationshipTypeId(event.target.value)} placeholder="relationship_concerns" value={relationshipTypeId}/></label><label><span>Workflow States</span><input onChange={(event) => setWorkflowStates(event.target.value)} placeholder="workflow_unresolved" value={workflowStates}/></label><label><span>Human Signal ≥</span><input max="10" min="0" onChange={(event) => setMinimumSignal(event.target.value)} placeholder="7" type="number" value={minimumSignal}/></label><label><span>Sender address</span><input onChange={(event) => setSenderAddress(event.target.value)} placeholder="ops@example.com" type="email" value={senderAddress}/></label><label><span>Sender domain</span><input onChange={(event) => setSenderDomain(event.target.value)} placeholder="example.com" value={senderDomain}/></label><label><span>Received after</span><input onChange={(event) => setReceivedAfter(event.target.value)} type="date" value={receivedAfter}/></label><label><span>Thread subject</span><input onChange={(event) => setSubjectContains(event.target.value)} placeholder="production failure" value={subjectContains}/></label><label><span>Thread read state</span><select onChange={(event) => setReadState(event.target.value as typeof readState)} value={readState}><option value="any">Any</option><option value="unread">Unread</option><option value="read">Read</option></select></label></div>
    </form> : null}
    <div className="views-layout"><nav aria-label="Saved live Views" className="view-list">{views.map((view) => <button aria-pressed={view.id === activeViewId} className="view-chip" key={view.id} onClick={() => selectView(view)} type="button"><i aria-hidden="true" style={{ background: view.color }}/><span><strong>{view.name}</strong><small>{predicateCount(view.definition)} predicate families</small></span><b>›</b></button>)}</nav>
      <section aria-busy={status === "loading" || status === "saving" || undefined} className="view-results"><header><div><span>{accountCount} {accountCount === 1 ? "account" : "accounts"} · {activePredicates} predicate families</span><h3>{activeView?.name ?? "Choose a View"}</h3><p>{activeView?.description || "Results re-evaluate whenever the underlying Thread changes."}</p></div><button className="view-action" disabled={!activeView || status !== "ready"} type="button">Edit definition</button></header>
      {error ? <p className="view-state view-state-error" role="alert">Could not load this View. {error}</p> : null}
      {status === "loading" ? <p className="view-state" role="status">Running the current View…</p> : null}
      {status === "ready" && activeView && items.length === 0 ? <p className="view-state">No Threads match right now. The definition stays ready for the next underlying change.</p> : null}
      {items.length ? <div className="view-thread-list">{items.map((item) => <ViewThreadRow item={item} key={`${item.accountId}:${item.threadId}`}/>)}</div> : null}
      </section></div>
  </section>;
}

function ViewThreadRow({ item }: { item: OrganizationViewResultItem }) {
  return <article className="view-thread-row"><span aria-hidden="true" className="view-thread-signal">{item.humanSignal ?? "·"}</span><div><strong>{item.subject}</strong><small>{item.sender.name ?? item.sender.email} · {item.accountEmail}</small></div><span className="view-thread-lane">{laneLabel(item.primaryLaneId)}</span><time dateTime={item.latestReceivedAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.latestReceivedAt))}</time></article>;
}
