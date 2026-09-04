import { useEffect, useMemo, useRef, useState } from "react";
import {
  organizationContextQueryResponseSchema,
  organizationLaneConfigurationFixture,
  organizationViewDefinitionSchema,
  organizationViewListResponseSchema,
  organizationViewResultPageSchema,
  organizationViewsFixture,
  organizationWeeklyViewResultsFixture,
  validateFacetScalarValue,
  type FacetDefinition,
  type FacetFilter,
  type FacetScalarValue,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewResultItem,
  type OrganizationViewResultPage,
} from "@orca/shared";
import { useOrganizationAuthority } from "./organization-authority";

type LoadState = "loading" | "ready" | "saving" | "error";
type ComposerMode = "create" | "edit";
type ClauseKind = "account" | "lane" | "read" | "human" | "sender" | "subject" | "workflow" | "facet" | "context" | "date";
type NamedOption = { id: string; label: string };
type ContextCatalog = {
  types: NamedOption[];
  relationships: Array<NamedOption & { contextTypeId: string }>;
  contexts: Array<NamedOption & { contextTypeId: string }>;
};

const primaryClauseKinds: ClauseKind[] = ["account", "lane", "read", "human", "sender", "subject"];
const advancedClauseKinds: ClauseKind[] = ["workflow", "facet", "context", "date"];
const clauseMeta: Record<ClauseKind, { label: string; description: string; removeLabel: string }> = {
  account: { label: "Account", description: "Choose one or more connected accounts", removeLabel: "Remove account filter" },
  lane: { label: "Lane", description: "Choose where Threads are primarily placed", removeLabel: "Remove lane filter" },
  read: { label: "Read state", description: "Show read or unread Threads", removeLabel: "Remove read state filter" },
  human: { label: "Human Signal", description: "Set a minimum confidence score", removeLabel: "Remove Human Signal filter" },
  sender: { label: "Sender", description: "Match people or whole domains", removeLabel: "Remove sender filter" },
  subject: { label: "Subject", description: "Match words in the Thread subject", removeLabel: "Remove subject filter" },
  workflow: { label: "Workflow", description: "Choose one or more workflow states", removeLabel: "Remove workflow filter" },
  facet: { label: "Facet", description: "Match structured Organization metadata", removeLabel: "Remove facet filter" },
  context: { label: "Context", description: "Match a named project or customer context", removeLabel: "Remove context filter" },
  date: { label: "Date range", description: "Limit when messages were received", removeLabel: "Remove date filter" },
};

const demoFacets: FacetDefinition[] = [{
  id: "facet_urgency", name: "Urgency", position: 0, valueType: { kind: "enum", options: [
    { id: "urgent", label: "Urgent", position: 0, retiredAt: null },
    { id: "normal", label: "Normal", position: 1, retiredAt: null },
  ] }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null, retiredAt: null, revision: 1,
}];
const demoWorkflow: NamedOption[] = [{ id: "workflow_unresolved", label: "Unresolved" }, { id: "workflow_waiting", label: "Waiting" }];
const demoContexts: ContextCatalog = {
  types: [{ id: "context_type_project", label: "Project" }],
  relationships: [{ id: "relationship_concerns", contextTypeId: "context_type_project", label: "Concerns" }],
  contexts: [{ id: "context_orca", contextTypeId: "context_type_project", label: "Orca" }],
};

function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function humanizeId(id: string) {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) return "Saved selection";
  const value = id.replace(/^(?:account|lane|facet|workflow|state|context_type|context|relationship)_/i, "").replaceAll(/[_-]+/g, " ").trim();
  return value ? value.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Current value";
}
function withCurrent(options: NamedOption[], ids: string[]) {
  const known = new Set(options.map((option) => option.id));
  return [...options, ...ids.filter((id) => !known.has(id)).map((id) => ({ id, label: humanizeId(id) }))];
}
function optionLabel(id: string, options: NamedOption[]) { return options.find((option) => option.id === id)?.label ?? humanizeId(id); }
function humanClassificationLabel(value: string) { return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function facetOperators(definition: FacetDefinition | undefined) {
  const operators = ["equals", "present", "missing"] as const;
  return definition && ["text", "email", "domain"].includes(definition.valueType.kind)
    ? [operators[0], "contains" as const, operators[1], operators[2]]
    : operators;
}
function facetOperatorLabel(operator: FacetFilter["operator"]) {
  return operator === "equals" ? "is" : operator === "contains" ? "contains" : operator === "present" ? "is present" : "is missing";
}
function facetScalarFromInput(definition: FacetDefinition | undefined, value: string): FacetScalarValue {
  if (definition?.valueType.kind === "number") return Number(value);
  if (definition?.valueType.kind === "boolean") return value === "true";
  return value;
}
function facetValueLabel(filter: FacetFilter, definition: FacetDefinition | undefined) {
  if (!("value" in filter)) return "";
  if (definition?.valueType.kind === "enum" && typeof filter.value === "string") {
    return definition.valueType.options.find((option) => option.id === filter.value)?.label ?? humanizeId(filter.value);
  }
  if (definition?.valueType.kind === "boolean") return filter.value === true ? "Yes" : "No";
  return String(filter.value);
}
function facetFilterSummary(filter: FacetFilter, definitions: readonly FacetDefinition[]) {
  const definition = definitions.find((candidate) => candidate.id === filter.facetId);
  const value = facetValueLabel(filter, definition);
  return `${definition?.name ?? humanizeId(filter.facetId)} ${facetOperatorLabel(filter.operator)}${value ? ` ${value}` : ""}`;
}
function predicateCount(definition: OrganizationViewDefinition) {
  return [definition.accountIds, definition.laneIds, definition.facetFilters, definition.contextFilters, definition.workflowStateIds, definition.humanSignal, definition.sender, definition.date, definition.thread].filter(Boolean).length;
}
function laneLabel(id: string) { return id === "lane_everything_else" ? "Everything else" : humanizeId(id); }
function mutationKey(kind: string) { return `orca_web:${kind}:${crypto.randomUUID()}`; }
function toggleValue(values: string[], value: string) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function clauseKinds(definition?: OrganizationViewDefinition): ClauseKind[] {
  if (!definition) return [];
  return [
    definition.accountIds?.length ? "account" : null,
    definition.laneIds?.length ? "lane" : null,
    definition.thread?.readState ? "read" : null,
    definition.humanSignal ? "human" : null,
    definition.sender ? "sender" : null,
    definition.thread?.subjectContains ? "subject" : null,
    definition.workflowStateIds?.length ? "workflow" : null,
    definition.facetFilters?.length ? "facet" : null,
    definition.contextFilters?.length ? "context" : null,
    definition.date ? "date" : null,
  ].filter((kind): kind is ClauseKind => kind !== null);
}
function dateValue(value?: string) { return value?.slice(0, 10) ?? ""; }
function isoDate(value: string, end = false) { return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString(); }

const emptyResults = (view: OrganizationView): OrganizationViewResultPage => ({ viewId: view.id, viewRevision: view.revision, accountIds: view.definition.accountIds ?? [], items: [], nextCursor: null, limit: 25 });
const demoContinuationItem: OrganizationViewResultItem = {
  accountId: "account_outlook", accountEmail: "work@outlook.example", provider: "outlook", threadId: "thread_customer_followup",
  subject: "Customer follow-up after production recovery", latestReceivedAt: "2026-08-25T17:40:00.000Z", messageCount: 2,
  readState: "mixed", primaryLaneId: "lane_focus", sender: { name: "Ari Ops", email: "ops@acme.example" },
  humanSignal: 9, humanClassification: "likely_human",
};

export function OrganizationViewsWorkspace({ demoMode = false, onWorkspaceMutation, refreshToken = 0 }: { demoMode?: boolean; onWorkspaceMutation?: () => void; refreshToken?: number }) {
  const authority = useOrganizationAuthority();
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
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#70867d");
  const [activeClauses, setActiveClauses] = useState<ClauseKind[]>([]);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [laneIds, setLaneIds] = useState<string[]>([]);
  const [workflowStateIds, setWorkflowStateIds] = useState<string[]>([]);
  const [facetId, setFacetId] = useState("");
  const [facetOperator, setFacetOperator] = useState<"missing" | "present" | "equals" | "contains">("equals");
  const [facetValue, setFacetValue] = useState("");
  const [contextTypeId, setContextTypeId] = useState("");
  const [contextId, setContextId] = useState("");
  const [relationshipTypeId, setRelationshipTypeId] = useState("");
  const [minimumSignal, setMinimumSignal] = useState("");
  const [senderAddress, setSenderAddress] = useState("");
  const [senderDomain, setSenderDomain] = useState("");
  const [receivedAfter, setReceivedAfter] = useState("");
  const [receivedBefore, setReceivedBefore] = useState("");
  const [subjectContains, setSubjectContains] = useState("");
  const [readState, setReadState] = useState<"read" | "unread">("unread");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [filterMenuActiveIndex, setFilterMenuActiveIndex] = useState(0);
  const [contextCatalog, setContextCatalog] = useState<ContextCatalog | null>(demoMode ? demoContexts : null);
  const [contextLoadState, setContextLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [unevaluatedDemoViewIds, setUnevaluatedDemoViewIds] = useState<Set<string>>(() => new Set());
  const resultRequest = useRef(0);
  const listRequest = useRef(0);
  const mutationRequest = useRef(0);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [canonicalGeneration, setCanonicalGeneration] = useState(0);
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const canMutate = demoMode || authority.state.canMutate && authority.allows.apply;

  const accountOptions = useMemo(() => {
    const base = demoMode
      ? [{ id: "account_gmail", label: "Work Gmail" }, { id: "account_outlook", label: "Work Outlook" }]
      : (authority.snapshot?.accountIds ?? []).map((id, index) => ({ id, label: `Connected account ${index + 1}` }));
    const known = new Set(base.map((option) => option.id));
    return [...base, ...accountIds.filter((id) => !known.has(id)).map((id, index) => ({ id, label: `Saved account ${index + 1}` }))];
  }, [accountIds, authority.snapshot?.accountIds, demoMode]);
  const laneOptions = useMemo(() => withCurrent(
    (demoMode ? organizationLaneConfigurationFixture : authority.snapshot?.laneConfiguration)?.lanes.filter((lane) => !lane.retiredAt).map((lane) => ({ id: lane.id, label: lane.name })) ?? [],
    laneIds,
  ), [authority.snapshot?.laneConfiguration, demoMode, laneIds]);
  const facetDefinitions = useMemo(() => {
    const current = editingDefinition?.facetFilters?.[0]?.facetId;
    const definitions = demoMode ? demoFacets : (authority.snapshot?.facetDefinitions ?? []);
    return current && !definitions.some((facet) => facet.id === current)
      ? [...definitions, { ...demoFacets[0]!, id: current, name: humanizeId(current), valueType: { kind: "text", maxLength: 200 } } as FacetDefinition]
      : definitions;
  }, [authority.snapshot?.facetDefinitions, demoMode, editingDefinition]);
  const workflowOptions = useMemo(() => withCurrent(
    demoMode ? demoWorkflow : (authority.snapshot?.workflowStates ?? []).filter((state) => !state.retiredAt).map((state) => ({ id: state.id, label: state.name })),
    workflowStateIds,
  ), [authority.snapshot?.workflowStates, demoMode, workflowStateIds]);
  const contextTypeOptions = withCurrent(contextCatalog?.types ?? authority.snapshot?.contexts?.contextTypes.filter((item) => !item.retiredAt).map((item) => ({ id: item.id, label: item.name })) ?? [], contextTypeId ? [contextTypeId] : []);
  const contextOptions = withCurrent((contextCatalog?.contexts ?? []).filter((item) => !contextTypeId || item.contextTypeId === contextTypeId), contextId ? [contextId] : []);
  const relationshipOptions = withCurrent((contextCatalog?.relationships ?? authority.snapshot?.contexts?.relationshipTypes.map((item) => ({ id: item.id, label: item.name, contextTypeId: item.contextTypeId })) ?? []).filter((item) => !contextTypeId || item.contextTypeId === contextTypeId), relationshipTypeId ? [relationshipTypeId] : []);
  const activeSet = new Set(activeClauses);

  useEffect(() => {
    if (demoMode) return;
    if (!authority.snapshot && authority.state.kind !== "ready") return;
    const controller = new AbortController();
    const requestId = ++listRequest.current;
    resultRequest.current += 1;
    mutationRequest.current += 1;
    setStatus("loading");
    setPageStatus("idle"); setPageError(null); setError(null);
    void authority.request("/v1/organization/views", { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: views.length > 0 }).then((body) => {
      if (controller.signal.aborted || requestId !== listRequest.current) return;
      const parsed = organizationViewListResponseSchema.parse(body);
      setViews(parsed.items); setWorkspaceRevision(parsed.workspaceRevision); setActiveViewId((current) => parsed.items.some((item) => item.id === current) ? current : parsed.items[0]?.id ?? ""); setCanonicalGeneration((current) => current + 1);
      if (parsed.items.length === 0) { setResults(null); setStatus("ready"); }
    }).catch((reason) => { if (!controller.signal.aborted && requestId === listRequest.current) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not load Views"); } });
    return () => controller.abort();
  }, [authority.snapshot, demoMode, refreshToken]);

  useEffect(() => {
    if (demoMode || !activeViewId || !activeView) return;
    const controller = new AbortController();
    const requestId = ++resultRequest.current;
    const revision = activeView.revision;
    setStatus("loading");
    setPageStatus("idle"); setPageError(null);
    void authority.request(`/v1/organization/views/${encodeURIComponent(activeViewId)}/results?limit=25`, { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: Boolean(results) }).then((body) => {
      const parsed = organizationViewResultPageSchema.parse(body);
      if (!controller.signal.aborted && requestId === resultRequest.current && parsed.viewId === activeViewId && parsed.viewRevision === revision) { setResults(parsed); setStatus("ready"); }
    }).catch((reason) => { if (!controller.signal.aborted) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not run View"); } });
    return () => controller.abort();
  }, [activeViewId, activeView?.revision, canonicalGeneration, demoMode]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    function closeFilterMenuOnOutsideMouseDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node) || filterMenuRef.current?.contains(target) || filterTriggerRef.current?.contains(target)) return;
      setFilterMenuOpen(false);
      setMoreFiltersOpen(false);
    }
    document.addEventListener("mousedown", closeFilterMenuOnOutsideMouseDown);
    return () => document.removeEventListener("mousedown", closeFilterMenuOnOutsideMouseDown);
  }, [filterMenuOpen]);

  const activeDemoViewIsUnevaluated = Boolean(demoMode && activeView && unevaluatedDemoViewIds.has(activeView.id));
  const accountCount = results?.accountIds.length || activeView?.definition.accountIds?.length || (demoMode ? 2 : 0);
  const items = !activeDemoViewIsUnevaluated && results?.viewId === activeViewId ? results.items : [];
  const activePredicates = useMemo(() => activeView ? predicateCount(activeView.definition) : 0, [activeView]);

  function selectView(view: OrganizationView) {
    resultRequest.current += 1;
    setActiveViewId(view.id); setError(null); setPageError(null); setPageStatus("idle"); setComposerMode(null); setPendingRemoveId(null);
    if (demoMode) setResults(unevaluatedDemoViewIds.has(view.id) ? null : view.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(view));
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
      const page = organizationViewResultPageSchema.parse(await authority.request(`/v1/organization/views/${encodeURIComponent(viewId)}/results?limit=${results.limit}&cursor=${encodeURIComponent(cursor)}`, undefined, { operation: "read", capability: "query", hasReliableData: true }));
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
    if (!canMutate) return;
    const definition = view?.definition;
    setComposerMode(view ? "edit" : "create"); setPendingRemoveId(null); setError(null); setFilterMenuOpen(false); setMoreFiltersOpen(false);
    setEditingDefinition(definition ?? null); setActiveClauses(clauseKinds(definition));
    setName(view?.name ?? "All messages"); setNameTouched(Boolean(view)); setDescription(view?.description ?? ""); setColor(view?.color ?? "#70867d");
    setAccountIds(definition?.accountIds ?? []); setLaneIds(definition?.laneIds ?? []); setWorkflowStateIds(definition?.workflowStateIds ?? []);
    const facet = definition?.facetFilters?.[0]; setFacetId(facet?.facetId ?? ""); setFacetOperator(facet?.operator ?? "equals"); setFacetValue(facet && "value" in facet ? String(facet.value) : "");
    const context = definition?.contextFilters?.[0]; setContextTypeId(context?.context.contextTypeId ?? ""); setContextId(context?.context.contextId ?? ""); setRelationshipTypeId(context?.relationshipTypeId ?? "");
    setMinimumSignal(definition?.humanSignal?.minimumScore?.toString() ?? ""); setSenderAddress(definition?.sender?.addresses?.join(", ") ?? ""); setSenderDomain(definition?.sender?.domains?.join(", ") ?? "");
    setReceivedAfter(dateValue(definition?.date?.receivedAfter)); setReceivedBefore(dateValue(definition?.date?.receivedBefore)); setSubjectContains(definition?.thread?.subjectContains ?? ""); setReadState(definition?.thread?.readState ?? "unread");
    if (definition?.contextFilters?.length) void loadContextCatalog();
  }

  async function loadContextCatalog() {
    if (demoMode || contextCatalog || contextLoadState === "loading") return contextCatalog;
    setContextLoadState("loading");
    try {
      const parsed = organizationContextQueryResponseSchema.parse(await authority.request("/v1/organization/contexts/query?limit=100", undefined, { operation: "read", capability: "query", hasReliableData: true }));
      const next: ContextCatalog = {
        types: parsed.contextTypes.filter((item) => !item.retiredAt).map((item) => ({ id: item.id, label: item.name })),
        relationships: parsed.relationshipTypes.filter((item) => !item.retiredAt).map((item) => ({ id: item.id, label: item.name, contextTypeId: item.contextTypeId })),
        contexts: parsed.contexts.filter((item) => !item.retiredAt).map((item) => ({ id: item.id, label: item.name, contextTypeId: item.contextTypeId })),
      };
      setContextCatalog(next); setContextLoadState("idle");
      return next;
    } catch {
      setContextLoadState("error");
      return null;
    }
  }

  function activateClause(kind: ClauseKind, catalog = contextCatalog) {
    setActiveClauses((current) => current.includes(kind) ? current : [...current, kind]);
    if (kind === "account" && accountIds.length === 0 && accountOptions[0]) setAccountIds([accountOptions[0].id]);
    if (kind === "lane" && laneIds.length === 0 && laneOptions[0]) setLaneIds([laneOptions[0].id]);
    if (kind === "workflow" && workflowStateIds.length === 0 && workflowOptions[0]) setWorkflowStateIds([workflowOptions[0].id]);
    if (kind === "human") setMinimumSignal("7");
    if (kind === "facet" && !facetId && facetDefinitions[0]) {
      setFacetId(facetDefinitions[0].id);
      const type = facetDefinitions[0].valueType;
      if (type.kind === "enum") setFacetValue(type.options.find((item) => !item.retiredAt)?.id ?? "");
      else if (type.kind === "boolean") setFacetValue("true");
    }
    if (kind === "context") {
      const type = catalog?.types[0];
      const context = catalog?.contexts.find((item) => item.contextTypeId === type?.id);
      const relationship = catalog?.relationships.find((item) => item.contextTypeId === type?.id);
      if (type && !contextTypeId) setContextTypeId(type.id);
      if (context && !contextId) setContextId(context.id);
      if (relationship && !relationshipTypeId) setRelationshipTypeId(relationship.id);
    }
    setFilterMenuOpen(false); setMoreFiltersOpen(false);
    window.setTimeout(() => (document.querySelector(`[data-clause="${kind}"] [data-clause-editor]`) as HTMLElement | null)?.focus(), 0);
  }

  async function addClause(kind: ClauseKind) {
    if (kind === "context" && !contextCatalog) activateClause(kind, await loadContextCatalog());
    else activateClause(kind);
  }

  function removeClause(kind: ClauseKind) {
    setActiveClauses((current) => current.filter((item) => item !== kind));
    setError(null);
    window.setTimeout(() => filterTriggerRef.current?.focus(), 0);
  }

  function draftDefinition() {
    const original = composerMode === "edit" ? editingDefinition : null;
    const definition: OrganizationViewDefinition = { revision: 1 };
    if (activeSet.has("account") && accountIds.length) definition.accountIds = unique(accountIds);
    if (activeSet.has("lane") && laneIds.length) definition.laneIds = unique(laneIds);
    if (activeSet.has("workflow") && workflowStateIds.length) definition.workflowStateIds = unique(workflowStateIds);
    if (activeSet.has("facet") && facetId && (facetOperator === "missing" || facetOperator === "present" || facetValue !== "")) {
      const current = original?.facetFilters?.[0];
      let typedValue: string | number | boolean = facetValue;
      const selected = facetDefinitions.find((facet) => facet.id === facetId);
      typedValue = facetScalarFromInput(selected, facetValue);
      const first = facetOperator === "missing" || facetOperator === "present"
        ? { facetId, operator: facetOperator }
        : { facetId, operator: facetOperator, value: typedValue };
      definition.facetFilters = [first, ...(current ? original?.facetFilters?.slice(1) ?? [] : [])];
    }
    if (activeSet.has("context") && contextTypeId && contextId && relationshipTypeId) {
      definition.contextFilters = [{ context: { contextTypeId, contextId }, relationshipTypeId, ...(original?.contextFilters?.[0]?.direction ? { direction: original.contextFilters[0].direction } : {}) }, ...(original?.contextFilters?.slice(1) ?? [])];
    }
    if (activeSet.has("human")) {
      const humanSignal = { ...(original?.humanSignal ?? {}) };
      if (minimumSignal) humanSignal.minimumScore = Number(minimumSignal); else delete humanSignal.minimumScore;
      if (Object.keys(humanSignal).length) definition.humanSignal = humanSignal;
    }
    if (activeSet.has("sender")) {
      const addresses = unique(senderAddress.split(",").map((item) => item.trim()));
      const domains = unique(senderDomain.split(",").map((item) => item.trim().toLocaleLowerCase()));
      if (addresses.length || domains.length) definition.sender = { ...(addresses.length ? { addresses } : {}), ...(domains.length ? { domains } : {}) };
    }
    if (activeSet.has("date")) {
      const date = { ...(original?.date ?? {}) };
      if (receivedAfter) date.receivedAfter = receivedAfter === dateValue(original?.date?.receivedAfter) ? original!.date!.receivedAfter : isoDate(receivedAfter); else delete date.receivedAfter;
      if (receivedBefore) date.receivedBefore = receivedBefore === dateValue(original?.date?.receivedBefore) ? original!.date!.receivedBefore : isoDate(receivedBefore, true); else delete date.receivedBefore;
      if (Object.keys(date).length) definition.date = date;
    }
    const thread = { ...(original?.thread ?? {}) };
    if (activeSet.has("subject") && subjectContains.trim()) thread.subjectContains = subjectContains.trim(); else delete thread.subjectContains;
    if (activeSet.has("read")) thread.readState = readState; else delete thread.readState;
    if (Object.keys(thread).length) definition.thread = thread;
    return definition;
  }

  const draft = draftDefinition();
  const draftPredicateCount = predicateCount(draft);
  const selectedFacet = facetDefinitions.find((facet) => facet.id === facetId);
  const facetValidationMessage = (() => {
    if (!activeSet.has("facet") || !selectedFacet || facetOperator === "missing" || facetOperator === "present" || !facetValue) return null;
    if (facetOperator === "contains" && !["text", "email", "domain"].includes(selectedFacet.valueType.kind)) return `${selectedFacet.name} does not support Contains.`;
    const issue = validateFacetScalarValue(selectedFacet.valueType, facetScalarFromInput(selectedFacet, facetValue));
    return issue ? `${selectedFacet.name} ${issue}.` : null;
  })();
  const validationMessage = (() => {
    if (!name.trim()) return "Give this View a short name before saving.";
    if (activeSet.has("account") && accountIds.length === 0) return "Choose at least one account.";
    if (activeSet.has("lane") && laneIds.length === 0) return "Choose at least one lane.";
    if (activeSet.has("workflow") && workflowStateIds.length === 0) return "Choose at least one workflow state.";
    if (activeSet.has("facet") && (!facetId || ((facetOperator === "equals" || facetOperator === "contains") && !facetValue))) return "Finish choosing the Facet condition.";
    if (facetValidationMessage) return facetValidationMessage;
    if (activeSet.has("context") && (!contextTypeId || !contextId || !relationshipTypeId)) return contextLoadState === "error" ? "Named Contexts could not be loaded. Remove this filter or try again." : "Finish choosing the Context relationship.";
    if (activeSet.has("human") && !draft.humanSignal) return "Choose a minimum Human Signal score.";
    if (activeSet.has("sender") && !senderAddress.trim() && !senderDomain.trim()) return "Enter a sender address or domain.";
    if (activeSet.has("date") && !receivedAfter && !receivedBefore) return "Choose a start date, an end date, or both.";
    if (activeSet.has("subject") && !subjectContains.trim()) return "Enter words to match in the subject.";
    const parsed = organizationViewDefinitionSchema.safeParse(draft);
    return parsed.success ? null : parsed.error.issues[0]?.message ?? "One filter needs attention.";
  })();

  const scopeSummary = (() => {
    const parts: string[] = [];
    if (draft.thread?.readState) parts.push(draft.thread.readState === "unread" ? "that are unread" : "that are read");
    if (draft.humanSignal?.minimumScore !== undefined) parts.push(`with Human Signal ${draft.humanSignal.minimumScore}+`);
    if (draft.humanSignal?.maximumScore !== undefined) parts.push(`with Human Signal at most ${draft.humanSignal.maximumScore}`);
    if (draft.humanSignal?.classifications?.length) parts.push(`classified ${draft.humanSignal.classifications.map(humanClassificationLabel).join(" or ")}`);
    if (draft.humanSignal?.evidenceReasonCodes?.length) parts.push(`with evidence ${draft.humanSignal.evidenceReasonCodes.map(humanizeId).join(" or ")}`);
    if (draft.sender) parts.push(`from ${[...(draft.sender.addresses ?? []), ...(draft.sender.domains ?? [])].join(" or ")}`);
    if (draft.thread?.subjectContains) parts.push(`with “${draft.thread.subjectContains}” in the subject`);
    if (draft.thread?.ids?.length) parts.push(`among ${draft.thread.ids.length} exact Threads`);
    parts.push(draft.accountIds ? `from ${draft.accountIds.map((id) => optionLabel(id, accountOptions)).join(" or ")}` : "from any account");
    parts.push(draft.laneIds ? `in ${draft.laneIds.map((id) => optionLabel(id, laneOptions)).join(" or ")}` : "in any lane");
    if (draft.workflowStateIds) parts.push(`in ${draft.workflowStateIds.map((id) => optionLabel(id, workflowOptions)).join(" or ")} workflow`);
    for (const filter of draft.facetFilters ?? []) parts.push(`where ${facetFilterSummary(filter, facetDefinitions)}`);
    for (const filter of draft.contextFilters ?? []) parts.push(`linked to ${optionLabel(filter.context.contextId, contextCatalog?.contexts ?? [])} as ${optionLabel(filter.relationshipTypeId, contextCatalog?.relationships ?? [])}${filter.direction ? ` (${humanizeId(filter.direction)})` : ""}`);
    if (draft.date) parts.push(draft.date.receivedAfter && draft.date.receivedBefore ? `received ${dateValue(draft.date.receivedAfter)} through ${dateValue(draft.date.receivedBefore)}` : draft.date.receivedAfter ? `received after ${dateValue(draft.date.receivedAfter)}` : `received before ${dateValue(draft.date.receivedBefore)}`);
    return `Show messages ${parts.join(" ")}.`;
  })();

  const preservedConstraintDetails = (() => {
    const details: string[] = [];
    if (draft.thread?.ids?.length) details.push(`${draft.thread.ids.length} exact Threads · ${draft.thread.ids.map(humanizeId).join(", ")}`);
    const additionalFacets = draft.facetFilters?.slice(1) ?? [];
    if (additionalFacets.length) details.push(`${additionalFacets.length} additional Facet ${additionalFacets.length === 1 ? "filter" : "filters"} · ${additionalFacets.map((filter) => facetFilterSummary(filter, facetDefinitions)).join("; ")}`);
    const additionalContexts = draft.contextFilters?.slice(1) ?? [];
    if (additionalContexts.length) details.push(`${additionalContexts.length} additional Context ${additionalContexts.length === 1 ? "filter" : "filters"} · ${additionalContexts.map((filter) => `${optionLabel(filter.context.contextId, contextCatalog?.contexts ?? [])} · ${optionLabel(filter.relationshipTypeId, contextCatalog?.relationships ?? [])}${filter.direction ? ` · ${humanizeId(filter.direction)}` : ""}`).join("; ")}`);
    if (draft.humanSignal?.maximumScore !== undefined) details.push(`Human Signal maximum · ${draft.humanSignal.maximumScore}`);
    if (draft.humanSignal?.classifications?.length) details.push(`Human classifications · ${draft.humanSignal.classifications.map(humanClassificationLabel).join(", ")}`);
    if (draft.humanSignal?.evidenceReasonCodes?.length) details.push(`Human evidence · ${draft.humanSignal.evidenceReasonCodes.map(humanizeId).join(", ")}`);
    return details;
  })();

  const suggestedName = (() => {
    const words: string[] = [];
    if (activeSet.has("read")) words.push(readState === "unread" ? "Unread" : "Read");
    if (activeSet.has("human")) words.push("high-signal");
    if (activeSet.has("workflow") && workflowStateIds[0]) words.push(optionLabel(workflowStateIds[0], workflowOptions));
    else if (activeSet.has("lane") && laneIds[0]) words.push(optionLabel(laneIds[0], laneOptions));
    else if (activeSet.has("sender") && senderDomain.trim()) words.push(senderDomain.trim());
    else if (activeSet.has("subject") && subjectContains.trim()) words.push(subjectContains.trim());
    return words.length ? `${words.slice(0, 3).join(" ")} messages` : "All messages";
  })();

  useEffect(() => {
    if (composerMode === "create" && !nameTouched) setName(suggestedName);
  }, [composerMode, nameTouched, suggestedName]);

  function handleFilterMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = [...(filterMenuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); setFilterMenuOpen(false); filterTriggerRef.current?.focus(); return; }
    if (event.key === "Tab") { setFilterMenuOpen(false); setMoreFiltersOpen(false); return; }
    if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? buttons[0]
        : event.key === "End" ? buttons.at(-1)
        : buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
      if (next) {
        setFilterMenuActiveIndex(Number(next.dataset.menuIndex));
        next.focus();
      }
    }
  }

  function openFilterMenu() {
    const firstCommonIndex = primaryClauseKinds.findIndex((kind) => !activeSet.has(kind));
    setFilterMenuActiveIndex(firstCommonIndex === -1 ? primaryClauseKinds.length : firstCommonIndex);
    setFilterMenuOpen(true);
    window.setTimeout(() => filterMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"][tabindex="0"]')?.focus(), 0);
  }

  async function saveView() {
    if (!canMutate || validationMessage) return;
    const definition = organizationViewDefinitionSchema.parse(draft);
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      if (composerMode === "edit" && activeView) {
        const updated = demoMode
          ? { ...activeView, name: name.trim(), description: description.trim(), color, definition, revision: activeView.revision + 1, updatedAt: new Date().toISOString() }
          : organizationViewListResponseSchema.shape.items.element.parse(await authority.request(`/v1/organization/views/${encodeURIComponent(activeView.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("update"), expectedWorkspaceRevision: workspaceRevision, expectedRevision: activeView.revision, patch: { name: name.trim(), description: description.trim(), color, definition } }) }, { operation: "mutation", capability: "apply", hasReliableData: true }));
        if (requestId !== mutationRequest.current) return;
        setViews((current) => current.map((view) => view.id === updated.id ? updated : view)); setWorkspaceRevision((current) => current + 1);
        setResults(null);
        if (demoMode) setUnevaluatedDemoViewIds((current) => new Set(current).add(updated.id));
        setComposerMode(null); setStatus("ready");
        if (!demoMode) onWorkspaceMutation?.();
      } else {
        const created = demoMode
          ? { id: `view_demo_${views.length + 1}`, workspaceId: "workspace_demo", name: name.trim(), description: description.trim(), color, position: views.length, definition, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as OrganizationView
          : organizationViewListResponseSchema.shape.items.element.parse(await authority.request("/v1/organization/views", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("create"), expectedWorkspaceRevision: workspaceRevision, name: name.trim(), description: description.trim(), color, position: views.length, definition }) }, { operation: "mutation", capability: "apply", hasReliableData: true }));
        if (requestId !== mutationRequest.current) return;
        setViews((current) => [...current, created]); setWorkspaceRevision((current) => current + 1); setActiveViewId(created.id); setResults(null); setComposerMode(null); setName(""); setStatus("ready");
        if (demoMode) setUnevaluatedDemoViewIds((current) => new Set(current).add(created.id));
        if (!demoMode) onWorkspaceMutation?.();
      }
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : `Could not ${composerMode === "edit" ? "update" : "create"} View`); } }
  }

  async function moveView(view: OrganizationView, direction: -1 | 1) {
    const index = views.findIndex((candidate) => candidate.id === view.id); const other = views[index + direction];
    if (!other || status === "saving" || !canMutate) return;
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      if (demoMode) {
        const updated = views.map((candidate) => candidate.id === view.id ? { ...candidate, position: other.position, revision: candidate.revision + 1 } : candidate.id === other.id ? { ...candidate, position: view.position, revision: candidate.revision + 1 } : candidate).sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
        setViews(updated);
      } else {
        const body = await authority.request("/v1/organization/views/reorder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: mutationKey("reorder"), expectedWorkspaceRevision: workspaceRevision, items: [
          { id: view.id, expectedRevision: view.revision, position: other.position },
          { id: other.id, expectedRevision: other.revision, position: view.position },
        ] }) }, { operation: "mutation", capability: "apply", hasReliableData: true });
        const parsed = organizationViewListResponseSchema.parse(body);
        if (requestId !== mutationRequest.current) return;
        setViews(parsed.items); setWorkspaceRevision(parsed.workspaceRevision);
      }
      if (requestId !== mutationRequest.current) return;
      setStatus("ready");
      if (!demoMode) onWorkspaceMutation?.();
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not reorder Views"); } }
  }

  async function removeView(view: OrganizationView) {
    if (!canMutate) return;
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      let remaining: OrganizationView[];
      if (demoMode) {
        remaining = views.filter((candidate) => candidate.id !== view.id);
        setWorkspaceRevision((current) => current + 1);
        setUnevaluatedDemoViewIds((current) => { const next = new Set(current); next.delete(view.id); return next; });
      } else {
        await authority.request(`/v1/organization/views/${encodeURIComponent(view.id)}?expectedRevision=${view.revision}&expectedWorkspaceRevision=${workspaceRevision}&idempotencyKey=${encodeURIComponent(mutationKey("remove"))}`, { method: "DELETE" }, { operation: "mutation", capability: "apply", hasReliableData: true });
        const canonical = organizationViewListResponseSchema.parse(await authority.request("/v1/organization/views", undefined, { operation: "read", capability: "query", hasReliableData: true }));
        remaining = canonical.items;
        setWorkspaceRevision(canonical.workspaceRevision);
      }
      if (requestId !== mutationRequest.current) return;
      setViews(remaining); setPendingRemoveId(null); setComposerMode(null);
      if (activeViewId === view.id) {
        const next = remaining[Math.min(views.indexOf(view), remaining.length - 1)] ?? null;
        setActiveViewId(next?.id ?? ""); setResults(next && demoMode && !unevaluatedDemoViewIds.has(next.id) ? (next.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(next)) : null);
      }
      setStatus("ready");
      if (!demoMode) onWorkspaceMutation?.();
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not remove View"); } }
  }

  function renderClause(kind: ClauseKind) {
    const meta = clauseMeta[kind];
    const selectedFacet = facetDefinitions.find((facet) => facet.id === facetId);
    return <article className="view-clause" data-clause={kind} key={kind}>
      <header><div><span>{meta.label}</span><small>{meta.description}</small></div><button aria-label={meta.removeLabel} className="view-clause-remove" onClick={() => removeClause(kind)} type="button">Remove</button></header>
      {kind === "account" ? <div aria-label="Accounts" className="view-choice-list" role="group">{accountOptions.map((option, index) => <button aria-pressed={accountIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => setAccountIds((current) => toggleValue(current, option.id))} type="button">{option.label}</button>)}</div> : null}
      {kind === "lane" ? <div aria-label="Lanes" className="view-choice-list" role="group">{laneOptions.map((option, index) => <button aria-pressed={laneIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => setLaneIds((current) => toggleValue(current, option.id))} type="button">{option.label}</button>)}</div> : null}
      {kind === "read" ? <div aria-label="Read state" className="view-choice-list" role="group"><button aria-pressed={readState === "unread"} data-clause-editor onClick={() => setReadState("unread")} type="button">Unread</button><button aria-pressed={readState === "read"} onClick={() => setReadState("read")} type="button">Read</button></div> : null}
      {kind === "human" ? <label><span>Minimum score</span><select aria-label="Minimum Human Signal" data-clause-editor onChange={(event) => setMinimumSignal(event.target.value)} value={minimumSignal}><option value="">No minimum · preserve classifications</option>{Array.from({ length: 11 }, (_, score) => <option key={score} value={score}>{score}{score === 7 ? " · recommended" : ""}</option>)}</select></label> : null}
      {kind === "sender" ? <div className="view-inline-fields"><label><span>Email addresses</span><input aria-describedby="sender-hint" data-clause-editor inputMode="email" onChange={(event) => setSenderAddress(event.target.value)} placeholder="maya@example.com" value={senderAddress}/></label><label><span>Domains</span><input aria-describedby="sender-hint" onChange={(event) => setSenderDomain(event.target.value)} placeholder="example.com" value={senderDomain}/></label><small className="view-field-hint" id="sender-hint">Separate multiple values with commas.</small></div> : null}
      {kind === "subject" ? <label><span>Subject contains</span><input data-clause-editor maxLength={200} onInput={(event) => setSubjectContains(event.currentTarget.value)} placeholder="production failure" value={subjectContains}/></label> : null}
      {kind === "workflow" ? <div aria-label="Workflow states" className="view-choice-list" role="group">{workflowOptions.map((option, index) => <button aria-pressed={workflowStateIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => setWorkflowStateIds((current) => toggleValue(current, option.id))} type="button">{option.label}</button>)}</div> : null}
      {kind === "facet" ? <div className="view-inline-fields view-inline-fields-three"><label><span>Facet</span><select aria-label="Facet" data-clause-editor onChange={(event) => { const next = facetDefinitions.find((item) => item.id === event.target.value); setFacetId(event.target.value); setFacetOperator("equals"); setFacetValue(next?.valueType.kind === "enum" ? next.valueType.options.find((item) => !item.retiredAt)?.id ?? "" : next?.valueType.kind === "boolean" ? "true" : ""); }} value={facetId}><option value="">Choose a Facet</option>{facetDefinitions.filter((facet) => !facet.retiredAt).map((facet) => <option key={facet.id} value={facet.id}>{facet.name}</option>)}</select></label><label><span>Condition</span><select aria-label="Facet condition" onChange={(event) => setFacetOperator(event.target.value as typeof facetOperator)} value={facetOperator}>{facetOperators(selectedFacet).map((operator) => <option key={operator} value={operator}>{facetOperatorLabel(operator).replace(/^./, (letter) => letter.toUpperCase())}</option>)}</select></label>{facetOperator === "equals" || facetOperator === "contains" ? <label><span>Value</span>{selectedFacet?.valueType.kind === "enum" ? <select aria-label="Facet value" onChange={(event) => setFacetValue(event.target.value)} value={facetValue}>{selectedFacet.valueType.options.filter((item) => !item.retiredAt).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : selectedFacet?.valueType.kind === "boolean" ? <select aria-label="Facet value" onChange={(event) => setFacetValue(event.target.value)} value={facetValue}><option value="true">Yes</option><option value="false">No</option></select> : <input aria-label="Facet value" inputMode={selectedFacet?.valueType.kind === "number" ? "decimal" : selectedFacet?.valueType.kind === "email" ? "email" : "text"} max={selectedFacet?.valueType.kind === "number" ? selectedFacet.valueType.maximum : undefined} maxLength={selectedFacet?.valueType.kind === "text" ? selectedFacet.valueType.maxLength : undefined} min={selectedFacet?.valueType.kind === "number" ? selectedFacet.valueType.minimum : undefined} onInput={(event) => setFacetValue(event.currentTarget.value)} placeholder={selectedFacet?.valueType.kind === "datetime" ? "2026-09-04T14:30:00-06:00" : selectedFacet?.valueType.kind === "duration" ? "PT45M" : selectedFacet?.valueType.kind === "domain" ? "example.com" : undefined} step={selectedFacet?.valueType.kind === "number" && selectedFacet.valueType.integer ? 1 : undefined} type={selectedFacet?.valueType.kind === "number" ? "number" : selectedFacet?.valueType.kind === "email" && !selectedFacet.valueType.allowDisplayName ? "email" : "text"} value={facetValue}/>}</label> : null}</div> : null}
      {kind === "context" ? <div className="view-context-editor"><div className="view-inline-fields view-inline-fields-three"><label><span>Type</span><select aria-label="Context type" data-clause-editor onFocus={() => void loadContextCatalog()} onChange={(event) => { const nextType = event.target.value; setContextTypeId(nextType); setContextId((contextCatalog?.contexts ?? []).find((item) => item.contextTypeId === nextType)?.id ?? ""); setRelationshipTypeId((contextCatalog?.relationships ?? []).find((item) => item.contextTypeId === nextType)?.id ?? ""); }} value={contextTypeId}><option value="">Choose a type</option>{contextTypeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label><span>Named context</span><select aria-label="Named Context" onFocus={() => void loadContextCatalog()} onChange={(event) => setContextId(event.target.value)} value={contextId}><option value="">Choose a Context</option>{contextOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label><span>Relationship</span><select aria-label="Context relationship" onFocus={() => void loadContextCatalog()} onChange={(event) => setRelationshipTypeId(event.target.value)} value={relationshipTypeId}><option value="">Choose a relationship</option>{relationshipOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label></div>{contextLoadState === "loading" ? <small className="view-context-status" role="status">Loading named Contexts…</small> : null}{contextLoadState === "error" ? <div className="view-context-status view-context-error" role="alert"><span>Named Contexts could not be loaded. Saved IDs remain preserved.</span><button className="view-action" onClick={() => void loadContextCatalog()} type="button">Retry Contexts</button></div> : null}</div> : null}
      {kind === "date" ? <div className="view-inline-fields"><label><span>Received after</span><input data-clause-editor onChange={(event) => setReceivedAfter(event.target.value)} type="date" value={receivedAfter}/></label><label><span>Received before</span><input onChange={(event) => setReceivedBefore(event.target.value)} type="date" value={receivedBefore}/></label></div> : null}
    </article>;
  }

  return <section className="views-workspace" aria-labelledby="views-title">
    <header className="views-header"><div><span>Workspace queries · unlimited</span><h2 id="views-title">Live Views</h2><p>One Thread can appear in every useful perspective while keeping one primary Lane.</p></div><button className="view-action view-new" disabled={!canMutate && composerMode !== "create"} onClick={() => composerMode === "create" ? setComposerMode(null) : loadComposer()} type="button">{composerMode === "create" ? "Close builder" : "+ New View"}</button></header>
    <div className="views-live-note"><i aria-hidden="true"/><strong>Live from current Thread organization</strong><span>No membership list is stored.</span></div>
    {composerMode ? <form className="view-composer" data-authority={canMutate ? "available" : "paused"} onSubmit={(event) => { event.preventDefault(); void saveView(); }}>
      <header><div><span>Perspective builder</span><h3>{composerMode === "edit" ? "Edit live perspective" : "Build a live perspective"}</h3></div><div className="view-composer-actions"><button className="view-action" onClick={() => setComposerMode(null)} type="button">Cancel</button><button className="view-action view-save" disabled={!canMutate || status === "saving" || Boolean(validationMessage)} type="submit">{status === "saving" ? "Saving View…" : composerMode === "edit" ? "Save changes" : "Save View"}</button></div></header>
      <fieldset className="view-builder-fieldset" disabled={!canMutate || status === "saving"}>
        <div className="view-identity"><label><span>View name</span><input autoFocus maxLength={120} onInput={(event) => { setNameTouched(true); setName(event.currentTarget.value); }} value={name}/><small>{composerMode === "create" && !nameTouched ? `Suggested from your filters · ${suggestedName}` : "A short name shown in your workspace."}</small></label><label><span>Description <i>optional</i></span><input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="What this perspective is for" value={description}/></label><label className="view-color-field"><span>Color</span><input aria-label="View color" onChange={(event) => setColor(event.target.value)} type="color" value={color}/></label></div>
        <section className="view-scope-sentence"><span>Current scope</span><p>{scopeSummary}</p>{preservedConstraintDetails.length ? <details className="view-preserved-constraints" open><summary>Preserved constraints · {preservedConstraintDetails.length}</summary><ul>{preservedConstraintDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul></details> : null}</section>
        <div className="view-clause-heading"><div><span>Filters</span><small>Every filter narrows the same live result.</small></div><div className="view-add-filter"><button aria-controls={filterMenuOpen ? "view-filter-menu" : undefined} aria-expanded={filterMenuOpen} aria-haspopup="menu" className="view-action view-filter-trigger" onClick={() => { if (filterMenuOpen) { setFilterMenuOpen(false); setMoreFiltersOpen(false); } else { setMoreFiltersOpen(false); openFilterMenu(); } }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setMoreFiltersOpen(false); openFilterMenu(); } }} ref={filterTriggerRef} type="button">Add filter <b aria-hidden="true">＋</b></button>{filterMenuOpen ? <div aria-label="Add a filter" className="view-filter-menu" id="view-filter-menu" onBlur={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || (!filterMenuRef.current?.contains(next) && next !== filterTriggerRef.current)) { setFilterMenuOpen(false); setMoreFiltersOpen(false); } }} onKeyDown={handleFilterMenuKeyDown} ref={filterMenuRef} role="menu"><span>Common filters</span>{primaryClauseKinds.map((kind, index) => <button data-menu-index={index} disabled={activeSet.has(kind)} key={kind} onClick={() => void addClause(kind)} onFocus={() => setFilterMenuActiveIndex(index)} role="menuitem" tabIndex={!activeSet.has(kind) && filterMenuActiveIndex === index ? 0 : -1} type="button"><strong>{clauseMeta[kind].label}</strong><small>{activeSet.has(kind) ? "Added" : clauseMeta[kind].description}</small></button>)}<button aria-expanded={moreFiltersOpen} className="view-more-filters" data-menu-index={primaryClauseKinds.length} onClick={() => setMoreFiltersOpen((open) => !open)} onFocus={() => setFilterMenuActiveIndex(primaryClauseKinds.length)} role="menuitem" tabIndex={filterMenuActiveIndex === primaryClauseKinds.length ? 0 : -1} type="button"><strong>More filters</strong><small>Workflow, Facet, Context, and date <b aria-hidden="true">{moreFiltersOpen ? "−" : "+"}</b></small></button>{moreFiltersOpen ? advancedClauseKinds.map((kind, index) => { const menuIndex = primaryClauseKinds.length + 1 + index; return <button data-menu-index={menuIndex} disabled={activeSet.has(kind)} key={kind} onClick={() => void addClause(kind)} onFocus={() => setFilterMenuActiveIndex(menuIndex)} role="menuitem" tabIndex={!activeSet.has(kind) && filterMenuActiveIndex === menuIndex ? 0 : -1} type="button"><strong>{clauseMeta[kind].label}</strong><small>{activeSet.has(kind) ? "Added" : clauseMeta[kind].description}</small></button>; }) : null}</div> : null}</div></div>
        {activeClauses.length ? <div className="view-clause-list">{activeClauses.map(renderClause)}</div> : <div className="view-no-clauses"><strong>Any message can match.</strong><span>Add a filter only when it helps this perspective.</span></div>}
      </fieldset>
      <footer className="view-builder-footer"><div className="view-draft-preview"><span>{demoMode ? "Local preview" : "Definition preview"}</span><strong>{draftPredicateCount ? `${draftPredicateCount} predicate ${draftPredicateCount === 1 ? "family" : "families"} · combined with AND` : "All current and future messages"}</strong><small>{status === "saving" ? "Saving this definition…" : demoMode ? "Local preview does not evaluate sample mail. Saving preserves the definition and clears stale sample results." : "No live query has run for this draft. Save to refresh results."}</small></div><p aria-live="polite" className={validationMessage ? "view-validation" : "view-validation view-validation-ready"} role={validationMessage ? "alert" : "status"}>{!canMutate ? `Editing paused · ${authority.state.detail}` : validationMessage ? validationMessage : "Ready to save this perspective."}</p></footer>
      {error ? <p className="view-state view-state-error view-composer-error" role="alert">Could not change this View. {error}</p> : null}
    </form> : null}
    <div className="views-layout"><nav aria-label="Saved live Views" className="view-list">{views.map((view, index) => <div className="view-list-item" key={view.id}><button aria-pressed={view.id === activeViewId} className="view-chip" onClick={() => selectView(view)} type="button"><i aria-hidden="true" style={{ background: view.color }}/><span><strong>{view.name}</strong><small>{predicateCount(view.definition)} predicate families</small></span><b>›</b></button><div className="view-order-controls"><button aria-label={`Move ${view.name} up`} className="view-icon-action" disabled={!canMutate || index === 0 || status === "saving"} onClick={() => void moveView(view, -1)} type="button">↑</button><button aria-label={`Move ${view.name} down`} className="view-icon-action" disabled={!canMutate || index === views.length - 1 || status === "saving"} onClick={() => void moveView(view, 1)} type="button">↓</button></div></div>)}</nav>
      <section aria-busy={status === "loading" || status === "saving" || undefined} className="view-results"><header><div><span>{accountCount} {accountCount === 1 ? "account" : "accounts"} · {activePredicates} predicate families</span><h3>{activeView?.name ?? "Choose a View"}</h3><p>{activeView?.description || "Results re-evaluate whenever the underlying Thread changes."}</p></div><div className="view-lifecycle-actions"><button className="view-action" disabled={!canMutate || !activeView || status !== "ready"} onClick={() => activeView && loadComposer(activeView)} type="button">Edit definition</button>{pendingRemoveId === activeView?.id ? <><button className="view-action" onClick={() => setPendingRemoveId(null)} type="button">Cancel</button><button className="view-action view-danger view-confirm" disabled={!canMutate || status === "saving"} onClick={() => activeView && void removeView(activeView)} type="button">Confirm remove</button></> : <button className="view-action view-danger" disabled={!canMutate || !activeView || status !== "ready"} onClick={() => activeView && setPendingRemoveId(activeView.id)} type="button">Remove View</button>}</div></header>
      {!composerMode && error ? <p className="view-state view-state-error" role="alert">Could not change this View. {error}</p> : null}
      {status === "loading" ? <p className="view-state" role="status">Running the current View…</p> : null}
      {status === "ready" && !activeView ? <p className="view-state">No saved Views yet. Build one when Organization change authority is available.</p> : null}
      {status === "ready" && activeView && activeDemoViewIsUnevaluated ? <p className="view-state">Sample results have not been evaluated for this saved local definition. Connect to Organization to run its current filters.</p> : null}
      {status === "ready" && activeView && !activeDemoViewIsUnevaluated && items.length === 0 ? <p className="view-state">No Threads match right now. The definition stays ready for the next underlying change.</p> : null}
      {items.length ? <div className="view-thread-list">{items.map((item) => <ViewThreadRow item={item} key={`${item.accountId}:${item.threadId}`}/>)}</div> : null}
      {items.length ? <div className="view-continuation"><button className="view-action" disabled={!results?.nextCursor || pageStatus === "loading"} onClick={() => void loadMore()} type="button">{pageStatus === "loading" ? "Loading more Threads…" : results?.nextCursor ? "Load more" : "All matching Threads loaded"}</button>{pageError ? <p className="view-state view-state-error" role="alert">Could not load more Threads. {pageError}</p> : null}</div> : null}
      </section></div>
  </section>;
}

function ViewThreadRow({ item }: { item: OrganizationViewResultItem }) {
  return <article className="view-thread-row"><span aria-hidden="true" className="view-thread-signal">{item.humanSignal ?? "·"}</span><div><strong>{item.subject}</strong><small>{item.sender.name ?? item.sender.email} · {item.accountEmail}</small></div><span className="view-thread-lane">{laneLabel(item.primaryLaneId)}</span><time dateTime={item.latestReceivedAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.latestReceivedAt))}</time></article>;
}
