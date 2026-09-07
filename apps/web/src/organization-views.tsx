import { useEffect, useMemo, useRef, useState } from "react";
import {
  organizationContextQueryResponseSchema,
  organizationLaneConfigurationFixture,
  organizationViewDefinitionSchema,
  organizationViewCommitResponseSchema,
  organizationViewListResponseSchema,
  organizationViewPrepareResponseSchema,
  organizationViewPreparationInputSchema,
  organizationViewPreviewResponseSchema,
  organizationViewResultPageSchema,
  organizationViewSenderCandidatesResponseSchema,
  type OrganizationViewSenderCandidatesResponse,
  organizationViewDefinitionKind,
  summarizeOrganizationViewDefinition,
  organizationViewsFixture,
  organizationWeeklyViewResultsFixture,
  validateFacetScalarValue,
  type FacetDefinition,
  type FacetFilter,
  type FacetScalarValue,
  type OrganizationView,
  type OrganizationViewDefinition,
  type OrganizationViewDraftInput,
  type OrganizationViewPreviewResponse,
  type OrganizationViewPreparationInput,
  type OrganizationViewPrepareResponse,
  type OrganizationViewCommitResponse,
  type OrganizationViewResultItem,
  type OrganizationViewResultPage,
  type OrganizationViewDraftSource,
  type OrganizationViewUnsupportedClause,
  type OrganizationViewPreparationNotice,
} from "@orca/shared";
import { hydrateViewDraft, materializeViewDraft, type ViewDraftFields, type ClauseKind } from "./organization-view-draft";
import { FirstViewInvitation, ViewGettingStarted } from "./first-view-guidance";
import { OrganizationAuthorityProvider, useOrganizationAuthority } from "./organization-authority";

type LoadState = "loading" | "ready" | "saving" | "error";
type ComposerMode = "create" | "edit";
type DraftPreviewState = { status: "idle" | "loading" | "ready" | "error"; clientKey: string; response: OrganizationViewPreviewResponse | null; error: string | null };

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

export type ViewPreviewEvidenceState = "loading" | "ready" | "error" | "zero" | null;

export type OrganizationViewAuthoringEntry<TContext = unknown> = {
  preparation: OrganizationViewPreparationInput;
  returnContext: TContext;
};

function demoPreparationResponse(preparation: OrganizationViewPreparationInput): OrganizationViewPrepareResponse {
  const showSelfOmissionEvidence = import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("bre383Evidence") === "self-omission"
    && preparation.kind === "selected_senders";
  const saved = preparation.kind === "saved_view" ? organizationViewsFixture.find((view) => view.id === preparation.viewId) ?? organizationViewsFixture[0]! : null;
  const definition = preparation.kind === "typed_definition"
    ? preparation.definition
    : preparation.kind === "selected_senders"
      ? { revision: 1 as const, accountIds: ["account_gmail"], sender: { addresses: showSelfOmissionEvidence ? ["maya@example.com"] : unique([...organizationWeeklyViewResultsFixture.items, demoContinuationItem].slice(0, preparation.references.length).map((item) => item.sender.email.toLocaleLowerCase())) } }
      : saved!.definition;
  const source = preparation.kind === "typed_definition" || preparation.kind === "selected_senders" ? preparation.source : { kind: "saved_view" as const, label: saved!.name };
  const identity = preparation.kind === "typed_definition" || preparation.kind === "selected_senders"
    ? preparation.identity
    : { name: saved!.name, description: saved!.description, color: saved!.color, position: saved!.position };
  const unsupportedClauses = preparation.kind === "typed_definition" ? preparation.unsupportedClauses : [];
  const preparationNotices: OrganizationViewPreparationNotice[] = showSelfOmissionEvidence ? [{
    code: "self_sender_omitted",
    detail: "1 selected message was sent by this connected account and was omitted. The View will match only the external sender addresses shown below; your own address is not included.",
    omittedCount: 1,
  }] : [];
  const definitionKind = organizationViewDefinitionKind(definition);
  return organizationViewPrepareResponseSchema.parse({
    workspaceId: "workspace_demo",
    workspaceRevision: 1,
    draft: {
      mode: saved ? "update" : "create",
      viewId: saved?.id ?? null,
      viewRevision: saved?.revision ?? null,
      source,
      identity,
      definition,
      unsupportedClauses,
      preparationNotices,
      definitionDigest: `sha256:${"d".repeat(64)}`,
      definitionKind,
      effectiveAccountIds: definition.accountIds ?? ["account_gmail"],
      summary: summarizeOrganizationViewDefinition(definition),
      saveEligibility: unsupportedClauses.length ? { allowed: false, code: "unsupported_clauses", detail: "Replace or remove every unsupported clause before saving this View." }
        : definitionKind === "match_all" ? { allowed: false, code: "blank_definition", detail: "Add at least one complete filter before saving this View." }
          : { allowed: true, code: null, detail: "This reviewed definition is ready to save." },
    },
  });
}

export type OrganizationViewClauseReplacement = {
  clauseId: string;
  label: string;
  replace: (definition: OrganizationViewDefinition) => OrganizationViewDefinition;
};

type OrganizationViewsWorkspaceProps<TContext = unknown> = {
  correctionTarget?: OrganizationViewResultItem | null;
  compact?: boolean;
  dismissRef?: import("react").RefObject<(() => void) | null>;
  clauseReplacements?: readonly OrganizationViewClauseReplacement[];
  authoringEntry?: OrganizationViewAuthoringEntry<TContext> | null;
  demoMode?: boolean;
  onCancelAuthoring?: (context: TContext) => void;
  onCommitted?: (result: OrganizationViewCommitResponse, context: TContext) => void;
  onWorkspaceMutation?: () => void;
  previewEvidenceState?: ViewPreviewEvidenceState;
  refreshToken?: number;
};

export function OrganizationViewsWorkspace<TContext = unknown>({ authoringEntry = null, correctionTarget = null, clauseReplacements = [], compact = false, dismissRef, demoMode = false, onCancelAuthoring, onCommitted, onWorkspaceMutation, previewEvidenceState = null, refreshToken = 0 }: OrganizationViewsWorkspaceProps<TContext>) {
  const [tuneOpen, setTuneOpen] = useState(!compact);
  const [discardPending, setDiscardPending] = useState(false);
  const [focusReplacement, setFocusReplacement] = useState(false);
  const tuneRef = useRef<HTMLButtonElement>(null);
  const seedIdentity = useRef("");
  const seedDefinition = useRef("");
  const [preparationRetry, setPreparationRetry] = useState(0);
  const [draftUndo, setDraftUndo] = useState<Array<{ fields: ViewDraftFields; unsupported: OrganizationViewUnsupportedClause[]; focus: HTMLElement | null }>>([]);
  const editingControl = useRef<EventTarget | null>(null);
  const seedFields = useRef("");
  const openerRef = useRef<HTMLElement | null>(null);
  const exitAfterDiscard = useRef<(() => void) | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  function focusEditor() { (workspaceRef.current?.querySelector<HTMLElement>(".view-composer h3") ?? tuneRef.current ?? workspaceRef.current?.querySelector<HTMLElement>(".view-chip[aria-pressed=true], .view-new"))?.focus(); }
  function focusSoon(target: HTMLElement | null) { window.setTimeout(() => { if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true }); else focusEditor(); }, 0); }
  const authority = useOrganizationAuthority();
  const evidenceState = demoMode ? previewEvidenceState : null;
  const [draftFields, setDraftFields] = useState<ViewDraftFields>(() => hydrateViewDraft(evidenceState ? { revision: 1, thread: { subjectContains: evidenceState === "zero" ? "no matching release" : "follow-up" } } : { revision: 1 }));
  const { editingDefinition, activeClauses, accountIds, laneIds, workflowStateIds, facetId, facetOperator, facetValue, contextTypeId, contextId, relationshipTypeId, minimumSignal, senderAddress, senderDomain, receivedAfter, receivedBefore, subjectContains, readState } = draftFields;
  const setEditingDefinition = (value: ViewDraftFields["editingDefinition"] | ((current: ViewDraftFields["editingDefinition"]) => ViewDraftFields["editingDefinition"])) => setDraftFields((current) => ({ ...current, editingDefinition: typeof value === "function" ? value(current.editingDefinition) : value }));
  const setActiveClauses = (value: ViewDraftFields["activeClauses"] | ((current: ViewDraftFields["activeClauses"]) => ViewDraftFields["activeClauses"])) => setDraftFields((current) => ({ ...current, activeClauses: typeof value === "function" ? value(current.activeClauses) : value }));
  const setAccountIds = (value: ViewDraftFields["accountIds"] | ((current: ViewDraftFields["accountIds"]) => ViewDraftFields["accountIds"])) => setDraftFields((current) => ({ ...current, accountIds: typeof value === "function" ? value(current.accountIds) : value }));
  const setLaneIds = (value: ViewDraftFields["laneIds"] | ((current: ViewDraftFields["laneIds"]) => ViewDraftFields["laneIds"])) => setDraftFields((current) => ({ ...current, laneIds: typeof value === "function" ? value(current.laneIds) : value }));
  const setWorkflowStateIds = (value: ViewDraftFields["workflowStateIds"] | ((current: ViewDraftFields["workflowStateIds"]) => ViewDraftFields["workflowStateIds"])) => setDraftFields((current) => ({ ...current, workflowStateIds: typeof value === "function" ? value(current.workflowStateIds) : value }));
  const setFacetId = (value: ViewDraftFields["facetId"] | ((current: ViewDraftFields["facetId"]) => ViewDraftFields["facetId"])) => setDraftFields((current) => ({ ...current, facetId: typeof value === "function" ? value(current.facetId) : value }));
  const setFacetOperator = (value: ViewDraftFields["facetOperator"] | ((current: ViewDraftFields["facetOperator"]) => ViewDraftFields["facetOperator"])) => setDraftFields((current) => ({ ...current, facetOperator: typeof value === "function" ? value(current.facetOperator) : value }));
  const setFacetValue = (value: ViewDraftFields["facetValue"] | ((current: ViewDraftFields["facetValue"]) => ViewDraftFields["facetValue"])) => setDraftFields((current) => ({ ...current, facetValue: typeof value === "function" ? value(current.facetValue) : value }));
  const setContextTypeId = (value: ViewDraftFields["contextTypeId"] | ((current: ViewDraftFields["contextTypeId"]) => ViewDraftFields["contextTypeId"])) => setDraftFields((current) => ({ ...current, contextTypeId: typeof value === "function" ? value(current.contextTypeId) : value }));
  const setContextId = (value: ViewDraftFields["contextId"] | ((current: ViewDraftFields["contextId"]) => ViewDraftFields["contextId"])) => setDraftFields((current) => ({ ...current, contextId: typeof value === "function" ? value(current.contextId) : value }));
  const setRelationshipTypeId = (value: ViewDraftFields["relationshipTypeId"] | ((current: ViewDraftFields["relationshipTypeId"]) => ViewDraftFields["relationshipTypeId"])) => setDraftFields((current) => ({ ...current, relationshipTypeId: typeof value === "function" ? value(current.relationshipTypeId) : value }));
  const setMinimumSignal = (value: ViewDraftFields["minimumSignal"] | ((current: ViewDraftFields["minimumSignal"]) => ViewDraftFields["minimumSignal"])) => setDraftFields((current) => ({ ...current, minimumSignal: typeof value === "function" ? value(current.minimumSignal) : value }));
  const setSenderAddress = (value: ViewDraftFields["senderAddress"] | ((current: ViewDraftFields["senderAddress"]) => ViewDraftFields["senderAddress"])) => setDraftFields((current) => ({ ...current, senderAddress: typeof value === "function" ? value(current.senderAddress) : value }));
  const setSenderDomain = (value: ViewDraftFields["senderDomain"] | ((current: ViewDraftFields["senderDomain"]) => ViewDraftFields["senderDomain"])) => setDraftFields((current) => ({ ...current, senderDomain: typeof value === "function" ? value(current.senderDomain) : value }));
  const setReceivedAfter = (value: ViewDraftFields["receivedAfter"] | ((current: ViewDraftFields["receivedAfter"]) => ViewDraftFields["receivedAfter"])) => setDraftFields((current) => ({ ...current, receivedAfter: typeof value === "function" ? value(current.receivedAfter) : value }));
  const setReceivedBefore = (value: ViewDraftFields["receivedBefore"] | ((current: ViewDraftFields["receivedBefore"]) => ViewDraftFields["receivedBefore"])) => setDraftFields((current) => ({ ...current, receivedBefore: typeof value === "function" ? value(current.receivedBefore) : value }));
  const setSubjectContains = (value: ViewDraftFields["subjectContains"] | ((current: ViewDraftFields["subjectContains"]) => ViewDraftFields["subjectContains"])) => setDraftFields((current) => ({ ...current, subjectContains: typeof value === "function" ? value(current.subjectContains) : value }));
  const setReadState = (value: ViewDraftFields["readState"] | ((current: ViewDraftFields["readState"]) => ViewDraftFields["readState"])) => setDraftFields((current) => ({ ...current, readState: typeof value === "function" ? value(current.readState) : value }));
  const [views, setViews] = useState<OrganizationView[]>(demoMode ? organizationViewsFixture : []);
  const [activeViewId, setActiveViewId] = useState(demoMode ? organizationViewsFixture[0]!.id : "");
  const [results, setResults] = useState<OrganizationViewResultPage | null>(demoMode ? organizationWeeklyViewResultsFixture : null);
  const [workspaceRevision, setWorkspaceRevision] = useState(1);
  const [status, setStatus] = useState<LoadState>(demoMode ? "ready" : "loading");
  const [pageStatus, setPageStatus] = useState<"idle" | "loading" | "error">("idle");
  const [pageError, setPageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(evidenceState ? "create" : null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [name, setName] = useState(evidenceState ? "Needs reply this week" : "");
  const [nameTouched, setNameTouched] = useState(Boolean(evidenceState));
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#70867d");
  const [draftPosition, setDraftPosition] = useState(0);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [filterMenuActiveIndex, setFilterMenuActiveIndex] = useState(0);
  const [contextCatalog, setContextCatalog] = useState<ContextCatalog | null>(demoMode ? demoContexts : null);
  const [contextLoadState, setContextLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [unevaluatedDemoViewIds, setUnevaluatedDemoViewIds] = useState<Set<string>>(() => new Set());
  const [draftPreview, setDraftPreview] = useState<DraftPreviewState>({ status: "idle", clientKey: "", response: null, error: null });
  const [previewRetry, setPreviewRetry] = useState(0);
  const [confirmedZeroDigest, setConfirmedZeroDigest] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState<OrganizationViewDraftSource>({ kind: "manual", label: "Manual View" });
  const [unsupportedClauses, setUnsupportedClauses] = useState<OrganizationViewUnsupportedClause[]>([]);
  // This notice describes only the authoritative latest refinement, never separate removal history.
  const removedUnsupportedClauses = draftUndo.at(-1)?.unsupported.filter((clause) => !unsupportedClauses.some((current) => current.id === clause.id)) ?? [];
  const [preparationNotices, setPreparationNotices] = useState<OrganizationViewPreparationNotice[]>([]);
  const [preparedViewIdentity, setPreparedViewIdentity] = useState<{ id: string; revision: number } | null>(null);
  const [preparedAuthoringKey, setPreparedAuthoringKey] = useState<string | null>(null);
  const [preparationState, setPreparationState] = useState<{ status: "idle" | "loading" | "ready" | "error"; error: string | null }>({ status: authoringEntry ? "loading" : "idle", error: null });
  const resultRequest = useRef(0);
  const previewRequest = useRef(0);
  const listRequest = useRef(0);
  const mutationRequest = useRef(0);
  useEffect(() => () => {
    // The server may already have accepted a write. Leaving this surface only
    // invalidates its response callbacks; it does not roll back that write.
    mutationRequest.current += 1; preparationRequest.current += 1; resultRequest.current += 1; previewRequest.current += 1;
  }, []);
  const lifecycleEnvelope = useRef<{ key: string; url: string; body?: string } | null>(null);
  const lifecycleInFlight = useRef(false);
  function announceMutation() { window.dispatchEvent(new Event("orca:views-changed")); onWorkspaceMutation?.(); }
  const commitEnvelope = useRef<string | null>(null);
  const commitRetryKey = useRef<string | null>(null);
  const commitRetryDraftKey = useRef<string>("");
  const commitInFlight = useRef(false);
  const preparationRequest = useRef(0);
  const authoringPreparation = authoringEntry ? organizationViewPreparationInputSchema.parse(authoringEntry.preparation) : null;
  const authoringPreparationKey = authoringPreparation ? JSON.stringify(authoringPreparation) : "";
  const currentAuthoringPreparationKey = useRef(authoringPreparationKey);
  currentAuthoringPreparationKey.current = authoringPreparationKey;
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [canonicalGeneration, setCanonicalGeneration] = useState(0);
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const canMutate = demoMode || authority.state.canMutate && authority.allows.apply;
  useEffect(() => {
    if (focusReplacement && canMutate) {
      document.querySelector<HTMLElement>('#search-view-tune [data-clause="subject"] [data-clause-editor], #search-view-tune [data-clause-editor]')?.focus();
      setFocusReplacement(false);
    }
  }, [focusReplacement, canMutate]);

  const accountOptions = useMemo(() => {
    const base = demoMode
      ? [{ id: "account_gmail", label: "Work Gmail" }, { id: "account_outlook", label: "Work Outlook" }]
      : (authority.snapshot?.accountIds ?? []).map((id) => ({ id, label: id }));
    const known = new Set(base.map((option) => option.id));
    return [...base, ...accountIds.filter((id) => !known.has(id)).map((id) => ({ id, label: id }))];
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
    if (demoMode || authoringEntry) return;
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
  }, [authoringEntry, authority.snapshot, demoMode, refreshToken]);

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

  useEffect(() => {
    if (!authoringEntry) return;
    if (!demoMode && !authority.snapshot) return;
    // Reconnecting the same source revalidates the edited draft in preview;
    // preparing the original seed again would discard the user's changes.
    if (preparedAuthoringKey === authoringPreparationKey && preparationState.status === "ready") {
      if (!commitRetryKey.current && authority.snapshot?.workspaceRevision !== undefined) setWorkspaceRevision(authority.snapshot.workspaceRevision);
      return;
    }
    const controller = new AbortController();
    const requestId = ++preparationRequest.current;
    previewRequest.current += 1;
    mutationRequest.current += 1;
    commitInFlight.current = false;
    commitRetryKey.current = null; commitEnvelope.current = null;
    commitRetryDraftKey.current = "";
    setPreparedAuthoringKey(null);
    setComposerMode(null);
    setDraftPreview({ status: "idle", clientKey: "", response: null, error: null });
    setConfirmedZeroDigest(null);
    setStatus("loading");
    setPreparationState({ status: "loading", error: null });
    const prepared = demoMode
      ? Promise.resolve(demoPreparationResponse(authoringPreparation!))
      : authority.request("/v1/organization/views/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(authoringPreparation),
        signal: controller.signal,
      }, { operation: "read", capability: "query", hasReliableData: false }).then((body) => organizationViewPrepareResponseSchema.parse(body));
    void prepared.then((response) => {
      if (controller.signal.aborted || requestId !== preparationRequest.current) return;
      setWorkspaceRevision(response.workspaceRevision);
      loadPreparedComposer(response.draft);
      setPreparedAuthoringKey(authoringPreparationKey);
      setStatus("ready");
      setPreparationState({ status: "ready", error: null });
    }).catch((reason) => {
      if (controller.signal.aborted || requestId !== preparationRequest.current) return;
      setStatus("ready");
      setPreparationState({ status: "error", error: reason instanceof Error ? reason.message : "Could not prepare this View" });
    });
    return () => controller.abort();
  }, [authoringPreparationKey, authority.snapshot, demoMode, preparationRetry]);

  const activeDemoViewIsUnevaluated = Boolean(demoMode && activeView && unevaluatedDemoViewIds.has(activeView.id));
  const accountCount = results?.accountIds.length || activeView?.definition.accountIds?.length || (demoMode ? 2 : 0);
  const items = !activeDemoViewIsUnevaluated && results?.viewId === activeViewId ? results.items : [];
  const activePredicates = useMemo(() => activeView ? predicateCount(activeView.definition) : 0, [activeView]);

  function selectView(view: OrganizationView) {
    if (composerMode) { exitAfterDiscard.current = () => selectViewNow(view); cancelComposer(); return; }
    selectViewNow(view);
  }
  function selectViewNow(view: OrganizationView) {
    preparationRequest.current += 1; mutationRequest.current += 1;
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

  async function loadComposer(view?: OrganizationView) {
    if (!canMutate || commitInFlight.current) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const generation = ++preparationRequest.current;
    setError(null); setComposerMode(null); setStatus("loading");
    const preparation: OrganizationViewPreparationInput = view ? { kind: "saved_view", viewId: view.id } : { kind: "typed_definition", source: { kind: "manual", label: "Manual View" }, identity: { name: "All messages", description: "", color: "#70867d", position: views.length }, definition: { revision: 1 }, unsupportedClauses: [] };
    try {
      const prepared = demoMode
        ? view ? { workspaceRevision, draft: { ...demoPreparationResponse({ kind: "saved_view", viewId: view.id }).draft, viewId: view.id, viewRevision: view.revision, definition: view.definition, identity: { name: view.name, description: view.description, color: view.color, position: view.position } } } : demoPreparationResponse(preparation)
        : organizationViewPrepareResponseSchema.parse(await authority.request("/v1/organization/views/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(preparation) }, { operation: "read", capability: "query", hasReliableData: true }));
      if (generation !== preparationRequest.current) return;
      setWorkspaceRevision(prepared.workspaceRevision); loadPreparedComposer(prepared.draft); setNameTouched(Boolean(view)); setStatus("ready");
      focusSoon(null);
    } catch (reason) { if (generation === preparationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not prepare this View. Try Edit again."); } }
  }

  function loadPreparedComposer(prepared: OrganizationViewPrepareResponse["draft"]) {
    censusGeneration.current += 1; setCorrection(null);
    const definition = prepared.definition;
    setDraftUndo([]); editingControl.current = null; seedFields.current = JSON.stringify(hydrateViewDraft(definition)); setDiscardPending(false); seedIdentity.current = JSON.stringify(prepared.identity); seedDefinition.current = JSON.stringify([prepared.definition, prepared.unsupportedClauses]);
    setComposerMode(prepared.mode === "update" ? "edit" : "create"); setPendingRemoveId(null); setError(null); setFilterMenuOpen(false); setMoreFiltersOpen(false);
    previewRequest.current += 1; setDraftPreview({ status: "idle", clientKey: "", response: null, error: null }); setConfirmedZeroDigest(null); commitRetryKey.current = null; commitEnvelope.current = null; commitRetryDraftKey.current = "";
    setEditingDefinition(definition); setActiveClauses(clauseKinds(definition)); setDraftSource(prepared.source); setUnsupportedClauses(prepared.unsupportedClauses); setPreparationNotices(prepared.preparationNotices); setPreparedViewIdentity(prepared.mode === "update" ? { id: prepared.viewId!, revision: prepared.viewRevision! } : null);
    setName(prepared.identity.name); setNameTouched(true); setDescription(prepared.identity.description); setColor(prepared.identity.color); setDraftPosition(prepared.identity.position);
    restoreDefinition(definition ?? { revision: 1 });
    if (definition.contextFilters?.length) void loadContextCatalog();
  }

  function rememberDraft(control: EventTarget | null = null) {
    if (control && editingControl.current === control) return;
    editingControl.current = control;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraftUndo([{ fields: draftFields, unsupported: [...unsupportedClauses], focus }]);
  }
  function restoreDefinition(definition: OrganizationViewDefinition) {
    setDraftFields(hydrateViewDraft(definition)); setConfirmedZeroDigest(null);
  }
  function undoDraft() {
    const previous = draftUndo.at(-1);
    if (!previous || status === "saving") return;
    setDraftFields(previous.fields); setUnsupportedClauses(previous.unsupported); setConfirmedZeroDigest(null);
    setDraftUndo([]); editingControl.current = null;
    focusSoon(previous.focus);
  }
  function replaceSourceClause(replacement: OrganizationViewClauseReplacement) {
    const next = organizationViewDefinitionSchema.parse(replacement.replace(draftDefinition()));
    rememberDraft(); restoreDefinition(next); setTuneOpen(true);
    setFocusReplacement(true);
    setUnsupportedClauses((current) => current.filter((clause) => clause.id !== replacement.clauseId));
  }

  function finishCancel() {
    censusGeneration.current += 1; setCorrection(null);
    mutationRequest.current += 1; preparationRequest.current += 1; previewRequest.current += 1;
    setDraftUndo([]); setDiscardPending(false); setComposerMode(null);
    const action = exitAfterDiscard.current; exitAfterDiscard.current = null;
    if (action) { action(); return; }
    if (authoringEntry && onCancelAuthoring) onCancelAuthoring(authoringEntry.returnContext);
    else focusSoon(openerRef.current);
  }
  function cancelComposer() {
    if (status === "saving") return;
    if (composerMode && seedDefinition.current && (seedFields.current !== JSON.stringify(draftFields) || seedDefinition.current !== JSON.stringify([draftDefinition(), unsupportedClauses]) || seedIdentity.current !== JSON.stringify({ name, description, color, position: draftPosition }))) {
      setDiscardPending(true); window.setTimeout(() => workspaceRef.current?.querySelector<HTMLElement>(".view-discard-keep")?.focus(), 0); return;
    }
    finishCancel();
  }
  function dismissComposer() {
    if (status === "saving") return;
    if (discardPending) { setDiscardPending(false); exitAfterDiscard.current = null; focusSoon(null); return; }
    if (correction && correction.key === censusKey) { censusGeneration.current += 1; setCorrection(null); focusSoon(null); return; }
    if (filterMenuOpen) { setFilterMenuOpen(false); filterTriggerRef.current?.focus(); return; }
    if (confirmedZeroDigest) { setConfirmedZeroDigest(null); focusSoon(workspaceRef.current?.querySelector<HTMLElement>(".view-save") ?? null); return; }
    if (compact && tuneOpen) { setTuneOpen(false); tuneRef.current?.focus(); return; }
    cancelComposer();
  }
  if (dismissRef) dismissRef.current = dismissComposer;

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
    rememberDraft();
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
    rememberDraft();
    setActiveClauses((current) => current.filter((item) => item !== kind));
    setError(null);
    window.setTimeout(() => filterTriggerRef.current?.focus(), 0);
  }

  function draftDefinition() { return materializeViewDraft(draftFields, facetDefinitions); }

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
    if (unsupportedClauses.length) return "Replace or remove every unsupported source clause before saving.";
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

  const draftInput: OrganizationViewDraftInput | null = composerMode ? {
    mode: composerMode === "edit" ? "update" : "create",
    viewId: composerMode === "edit" ? preparedViewIdentity?.id ?? activeView?.id ?? null : null,
    viewRevision: composerMode === "edit" ? preparedViewIdentity?.revision ?? activeView?.revision ?? null : null,
    source: draftSource,
    identity: { name: name.trim() || "Untitled View", description: description.trim(), color, position: draftPosition },
    definition: draft,
    unsupportedClauses,
  } : null;
  const draftClientKey = draftInput ? JSON.stringify(draftInput) : "";
  const [correction, setCorrection] = useState<{ key: string; item: OrganizationViewResultItem; status: "loading" | "ready" | "error"; response: OrganizationViewSenderCandidatesResponse | null; selected: string[]; error: string | null } | null>(null);
  const censusGeneration = useRef(0);
  const censusKey = `${draftClientKey}:${JSON.stringify(authority.snapshot)}:${authoringPreparationKey}:${canMutate}`;
  const currentCensusKey = useRef(censusKey); currentCensusKey.current = censusKey;
  useEffect(() => () => { censusGeneration.current += 1; }, []);
  async function correctSenders(item: OrganizationViewResultItem) {
    if (!draftInput || !canMutate || demoMode || status === "saving") return;
    const generation = ++censusGeneration.current;
    const key = censusKey;
    const expectedProvenance = draftPreview.response?.results.provenance;
    if (!expectedProvenance || draftPreview.clientKey !== draftClientKey) return;
    setCorrection({ key, item, status: "loading", response: null, selected: [], error: null });
    try {
      const response = organizationViewSenderCandidatesResponseSchema.parse(await authority.request("/v1/organization/views/sender-candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft: draftInput, target: { accountId: item.accountId, threadId: item.threadId } }) }, { operation: "read", capability: "query", hasReliableData: true }));
      if (generation !== censusGeneration.current || key !== currentCensusKey.current) return;
      if (response.target.accountId !== item.accountId || response.target.threadId !== item.threadId) throw new Error("Correction target changed. Retry the current conversation.");
      if (response.provenance.definitionDigest !== expectedProvenance.definitionDigest || response.provenance.authorizedScopeDigest !== expectedProvenance.authorizedScopeDigest) throw new Error("Definition or account access changed. Refresh the preview before correcting senders.");
      // No latest-sender inference: every address starts selected for an explicit manual correction.
      setCorrection({ key, item, status: "ready", response, selected: response.addresses, error: null });
      window.setTimeout(() => workspaceRef.current?.querySelector<HTMLElement>(".view-sender-correction h4")?.focus(), 0);
    } catch (reason) {
      if (generation === censusGeneration.current && key === currentCensusKey.current) setCorrection({ key, item, status: "error", response: null, selected: [], error: reason instanceof Error ? reason.message : "Sender census unavailable" });
    }
  }
  function applySenderCorrection() {
    if (!correction || correction.key !== censusKey || correction.response?.status !== "complete" || !correction.selected.length || !canMutate || status === "saving") return;
    if (correction.selected.some((address) => !correction.response!.addresses.includes(address))) return;
    rememberDraft();
    restoreDefinition({ ...draft, accountIds: draft.accountIds ?? [correction.response.accountId!], sender: { addresses: correction.selected } });
    setCorrection(null); setTuneOpen(true); focusSoon(null);
  }
  const preparationMatchesCurrentEntry = !authoringEntry || preparedAuthoringKey === authoringPreparationKey;
  const displayedPreparationState = authoringEntry && !preparationMatchesCurrentEntry && preparationState.status !== "error" ? { status: "loading" as const, error: null } : preparationState;
  const authoringSourceLabel = authoringPreparation && authoringPreparation.kind !== "saved_view" ? authoringPreparation.source.label : draftSource.label;
  const previewMatchesCurrentDraft = draftPreview.status === "ready" && draftPreview.clientKey === draftClientKey && draftPreview.response !== null;
  const externalPreparationBlocked = Boolean(authoringEntry && (!preparationMatchesCurrentEntry || displayedPreparationState.status !== "ready"));
  const liveSaveBlocked = externalPreparationBlocked || evidenceState === "loading" || evidenceState === "error" || !demoMode && (!previewMatchesCurrentDraft || draftPreview.response?.draft.saveEligibility.allowed !== true);
  const previewIsZero = evidenceState === "zero" || previewMatchesCurrentDraft && draftPreview.response?.results.state === "zero";
  const effectiveZeroDigest = evidenceState === "zero" ? "sha256:evidence-zero-match" : draftPreview.response?.draft.definitionDigest ?? null;
  const previewDisplayState = evidenceState ?? draftPreview.status;
  const invokedCorrectionTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!correctionTarget || !previewMatchesCurrentDraft || !canMutate) return;
    const targetKey = JSON.stringify([correctionTarget.accountId, correctionTarget.threadId]);
    if (invokedCorrectionTarget.current === targetKey) return;
    invokedCorrectionTarget.current = targetKey;
    void correctSenders(correctionTarget);
  }, [correctionTarget, previewMatchesCurrentDraft, canMutate]);


  useEffect(() => {
    if (demoMode || !composerMode || !draftInput || validationMessage || !canMutate) {
      previewRequest.current += 1;
      if (!demoMode) setDraftPreview({ status: "idle", clientKey: draftClientKey, response: null, error: null });
      return;
    }
    const controller = new AbortController();
    const requestId = ++previewRequest.current;
    if (commitRetryDraftKey.current !== draftClientKey) {
      commitRetryDraftKey.current = draftClientKey;
      commitRetryKey.current = null; commitEnvelope.current = null;
    }
    const previewFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmedZeroDigest(null);
    setDraftPreview({ status: "loading", clientKey: draftClientKey, response: null, error: null });
    void authority.request("/v1/organization/views/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: draftInput, page: { limit: 5 } }),
      signal: controller.signal,
    }, { operation: "read", capability: "query", hasReliableData: false }).then((body) => {
      const response = organizationViewPreviewResponseSchema.parse(body);
      if (controller.signal.aborted || requestId !== previewRequest.current) return;
      setDraftPreview({ status: "ready", clientKey: draftClientKey, response, error: null });
      if (previewFocus && !previewFocus.isConnected && document.activeElement === document.body) focusSoon(null);
    }).catch((reason) => {
      if (controller.signal.aborted || requestId !== previewRequest.current) return;
      setDraftPreview({ status: "error", clientKey: draftClientKey, response: null, error: reason instanceof Error ? reason.message : "Could not preview this View" });
    });
    return () => controller.abort();
  }, [authority.snapshot, canMutate, composerMode, demoMode, draftClientKey, previewRetry, validationMessage]);

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
    const committingPreparationKey = authoringEntry ? preparedAuthoringKey : null;
    const committingAuthoringEntry = authoringEntry;
    if (!canMutate || status === "saving" || commitInFlight.current || validationMessage || !draftInput || liveSaveBlocked || authoringEntry && committingPreparationKey !== authoringPreparationKey) return;
    const definition = organizationViewDefinitionSchema.parse(draft);
    if (previewIsZero && effectiveZeroDigest && confirmedZeroDigest !== effectiveZeroDigest) {
      setConfirmedZeroDigest(effectiveZeroDigest);
      window.setTimeout(() => document.querySelector<HTMLButtonElement>(".view-save")?.focus(), 0);
      return;
    }
    commitInFlight.current = true;
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      if (!demoMode) {
        const retryKey = commitRetryKey.current ?? mutationKey("view-commit");
        commitRetryKey.current = retryKey;
        const committed = organizationViewCommitResponseSchema.parse(await authority.request("/v1/organization/views/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: commitEnvelope.current ??= JSON.stringify({
            draft: draftPreview.response!.draft,
            expectedRevisions: { workspace: workspaceRevision, view: composerMode === "edit" ? preparedViewIdentity?.revision ?? activeView?.revision ?? null : null },
            retryKey,
            confirmedZeroMatchDigest: previewIsZero ? confirmedZeroDigest : null,
          }),
        }, { operation: "mutation", capability: "apply", hasReliableData: true }));
        if (requestId !== mutationRequest.current || committingPreparationKey && currentAuthoringPreparationKey.current !== committingPreparationKey) return;
        commitRetryKey.current = null; commitEnvelope.current = null;
        announceMutation();
        if (committingPreparationKey && committingAuthoringEntry && onCommitted) onCommitted(committed, committingAuthoringEntry.returnContext);
        else window.location.assign(committed.navigation.href);
        return;
      }
      if (composerMode === "edit" && activeView) {
        const updated = { ...activeView, name: name.trim(), description: description.trim(), color, definition, revision: activeView.revision + 1, updatedAt: new Date().toISOString() };
        if (requestId !== mutationRequest.current) return;
        setViews((current) => current.map((view) => view.id === updated.id ? updated : view)); setWorkspaceRevision((current) => current + 1);
        setResults(null);
        if (demoMode) setUnevaluatedDemoViewIds((current) => new Set(current).add(updated.id));
        setComposerMode(null); setStatus("ready");
        if (!demoMode) announceMutation();
      } else {
        const created = { id: `view_demo_${views.length + 1}`, workspaceId: "workspace_demo", name: name.trim(), description: description.trim(), color, position: views.length, definition, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as OrganizationView;
        if (requestId !== mutationRequest.current) return;
        setViews((current) => [...current, created]); setWorkspaceRevision((current) => current + 1); setActiveViewId(created.id); setResults(null); setComposerMode(null); setName(""); setStatus("ready");
        if (demoMode) setUnevaluatedDemoViewIds((current) => new Set(current).add(created.id));
        if (!demoMode) announceMutation();
      }
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : `Could not ${composerMode === "edit" ? "update" : "create"} View`); } }
    finally { if (requestId === mutationRequest.current) commitInFlight.current = false; }
  }

  async function moveView(view: OrganizationView, direction: -1 | 1) {
    const index = views.findIndex((candidate) => candidate.id === view.id); const other = views[index + direction];
    if (!other || status === "saving" || !canMutate || lifecycleInFlight.current || composerMode) return;
    lifecycleInFlight.current = true;
    const focused = document.activeElement as HTMLElement | null;
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      if (demoMode) {
        const updated = views.map((candidate) => candidate.id === view.id ? { ...candidate, position: other.position, revision: candidate.revision + 1 } : candidate.id === other.id ? { ...candidate, position: view.position, revision: candidate.revision + 1 } : candidate).sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
        setViews(updated);
      } else {
        const key = `reorder:${view.id}:${direction}`;
        if (lifecycleEnvelope.current?.key !== key) lifecycleEnvelope.current = { key, url: "/v1/organization/views/reorder", body: JSON.stringify({ idempotencyKey: mutationKey("reorder"), expectedWorkspaceRevision: workspaceRevision, items: [
          { id: view.id, expectedRevision: view.revision, position: other.position },
          { id: other.id, expectedRevision: other.revision, position: view.position },
        ] }) };
        const envelope = lifecycleEnvelope.current;
        await authority.request(envelope.url, { method: "POST", headers: { "content-type": "application/json" }, body: envelope.body }, { operation: "mutation", capability: "apply", hasReliableData: true });
        const parsed = organizationViewListResponseSchema.parse(await authority.request("/v1/organization/views", undefined, { operation: "read", capability: "query", hasReliableData: true }));
        if (requestId !== mutationRequest.current) return;
        setViews(parsed.items); setWorkspaceRevision(parsed.workspaceRevision);
      }
      if (requestId !== mutationRequest.current) return;
      lifecycleEnvelope.current = null; setStatus("ready"); focusSoon(focused);
      if (!demoMode) announceMutation();
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not reorder Views"); } }
    finally { lifecycleInFlight.current = false; }
  }

  async function removeView(view: OrganizationView) {
    if (!canMutate || lifecycleInFlight.current || status === "saving" || composerMode) return;
    lifecycleInFlight.current = true;
    const requestId = ++mutationRequest.current;
    setStatus("saving"); setError(null);
    try {
      let remaining: OrganizationView[];
      if (demoMode) {
        remaining = views.filter((candidate) => candidate.id !== view.id);
        setWorkspaceRevision((current) => current + 1);
        setUnevaluatedDemoViewIds((current) => { const next = new Set(current); next.delete(view.id); return next; });
      } else {
        const key = `remove:${view.id}`;
        if (lifecycleEnvelope.current?.key !== key) lifecycleEnvelope.current = { key, url: `/v1/organization/views/${encodeURIComponent(view.id)}?expectedRevision=${view.revision}&expectedWorkspaceRevision=${workspaceRevision}&idempotencyKey=${encodeURIComponent(mutationKey("remove"))}` };
        await authority.request(lifecycleEnvelope.current.url, { method: "DELETE" }, { operation: "mutation", capability: "apply", hasReliableData: true });
        const canonical = organizationViewListResponseSchema.parse(await authority.request("/v1/organization/views", undefined, { operation: "read", capability: "query", hasReliableData: true }));
        remaining = canonical.items;
        if (requestId !== mutationRequest.current) return;
        setWorkspaceRevision(canonical.workspaceRevision);
      }
      if (requestId !== mutationRequest.current) return;
      setViews(remaining); setPendingRemoveId(null); setComposerMode(null);
      if (activeViewId === view.id) {
        const next = remaining[Math.min(views.indexOf(view), remaining.length - 1)] ?? null;
        setActiveViewId(next?.id ?? ""); setResults(next && demoMode && !unevaluatedDemoViewIds.has(next.id) ? (next.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(next)) : null);
      }
      lifecycleEnvelope.current = null; setStatus("ready");
      window.setTimeout(() => workspaceRef.current?.querySelector<HTMLElement>(".view-chip[aria-pressed=true], .view-new")?.focus(), 0);
      if (!demoMode) announceMutation();
    } catch (reason) { if (requestId === mutationRequest.current) { setStatus("ready"); setError(reason instanceof Error ? reason.message : "Could not remove View"); } }
    finally { lifecycleInFlight.current = false; }
  }

  function renderClause(kind: ClauseKind) {
    const meta = clauseMeta[kind];
    const selectedFacet = facetDefinitions.find((facet) => facet.id === facetId);
    return <article className="view-clause" data-clause={kind} key={kind}>
      <header><div><span>{meta.label}</span><small>{meta.description}</small></div><button aria-label={meta.removeLabel} className="view-clause-remove" onClick={() => removeClause(kind)} type="button">Remove</button></header>
      {kind === "account" ? <div aria-label="Accounts" className="view-choice-list" role="group">{accountOptions.map((option, index) => <button aria-pressed={accountIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => { rememberDraft(); setAccountIds((current) => toggleValue(current, option.id)); }} type="button">{option.label}</button>)}</div> : null}
      {kind === "lane" ? <div aria-label="Lanes" className="view-choice-list" role="group">{laneOptions.map((option, index) => <button aria-pressed={laneIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => { rememberDraft(); setLaneIds((current) => toggleValue(current, option.id)); }} type="button">{option.label}</button>)}</div> : null}
      {kind === "read" ? <div aria-label="Read state" className="view-choice-list" role="group"><button aria-pressed={readState === "unread"} data-clause-editor onClick={() => { rememberDraft(); setReadState("unread"); }} type="button">Unread</button><button aria-pressed={readState === "read"} onClick={() => { rememberDraft(); setReadState("read"); }} type="button">Read</button></div> : null}
      {kind === "human" ? <label><span>Minimum score</span><select aria-label="Minimum Human Signal" data-clause-editor onChange={(event) => setMinimumSignal(event.target.value)} value={minimumSignal}><option value="">No minimum · preserve classifications</option>{Array.from({ length: 11 }, (_, score) => <option key={score} value={score}>{score}{score === 7 ? " · recommended" : ""}</option>)}</select></label> : null}
      {kind === "sender" ? <div className="view-inline-fields"><label><span>Email addresses</span><input aria-describedby="sender-hint" data-clause-editor inputMode="email" onChange={(event) => setSenderAddress(event.target.value)} placeholder="maya@example.com" value={senderAddress}/></label><label><span>Domains</span><input aria-describedby="sender-hint" onChange={(event) => setSenderDomain(event.target.value)} placeholder="example.com" value={senderDomain}/></label><small className="view-field-hint" id="sender-hint">Separate multiple values with commas.</small></div> : null}
      {kind === "subject" ? <label><span>Subject contains</span><input data-clause-editor maxLength={200} onInput={(event) => setSubjectContains(event.currentTarget.value)} placeholder="production failure" value={subjectContains}/></label> : null}
      {kind === "workflow" ? <div aria-label="Workflow states" className="view-choice-list" role="group">{workflowOptions.map((option, index) => <button aria-pressed={workflowStateIds.includes(option.id)} data-clause-editor={index === 0 ? "" : undefined} key={option.id} onClick={() => { rememberDraft(); setWorkflowStateIds((current) => toggleValue(current, option.id)); }} type="button">{option.label}</button>)}</div> : null}
      {kind === "facet" ? <div className="view-inline-fields view-inline-fields-three"><label><span>Facet</span><select aria-label="Facet" data-clause-editor onChange={(event) => { const next = facetDefinitions.find((item) => item.id === event.target.value); setFacetId(event.target.value); setFacetOperator("equals"); setFacetValue(next?.valueType.kind === "enum" ? next.valueType.options.find((item) => !item.retiredAt)?.id ?? "" : next?.valueType.kind === "boolean" ? "true" : ""); }} value={facetId}><option value="">Choose a Facet</option>{facetDefinitions.filter((facet) => !facet.retiredAt).map((facet) => <option key={facet.id} value={facet.id}>{facet.name}</option>)}</select></label><label><span>Condition</span><select aria-label="Facet condition" onChange={(event) => setFacetOperator(event.target.value as typeof facetOperator)} value={facetOperator}>{facetOperators(selectedFacet).map((operator) => <option key={operator} value={operator}>{facetOperatorLabel(operator).replace(/^./, (letter) => letter.toUpperCase())}</option>)}</select></label>{facetOperator === "equals" || facetOperator === "contains" ? <label><span>Value</span>{selectedFacet?.valueType.kind === "enum" ? <select aria-label="Facet value" onChange={(event) => setFacetValue(event.target.value)} value={facetValue}>{selectedFacet.valueType.options.filter((item) => !item.retiredAt).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select> : selectedFacet?.valueType.kind === "boolean" ? <select aria-label="Facet value" onChange={(event) => setFacetValue(event.target.value)} value={facetValue}><option value="true">Yes</option><option value="false">No</option></select> : <input aria-label="Facet value" inputMode={selectedFacet?.valueType.kind === "number" ? "decimal" : selectedFacet?.valueType.kind === "email" ? "email" : "text"} max={selectedFacet?.valueType.kind === "number" ? selectedFacet.valueType.maximum : undefined} maxLength={selectedFacet?.valueType.kind === "text" ? selectedFacet.valueType.maxLength : undefined} min={selectedFacet?.valueType.kind === "number" ? selectedFacet.valueType.minimum : undefined} onInput={(event) => setFacetValue(event.currentTarget.value)} placeholder={selectedFacet?.valueType.kind === "datetime" ? "2026-09-04T14:30:00-06:00" : selectedFacet?.valueType.kind === "duration" ? "PT45M" : selectedFacet?.valueType.kind === "domain" ? "example.com" : undefined} step={selectedFacet?.valueType.kind === "number" && selectedFacet.valueType.integer ? 1 : undefined} type={selectedFacet?.valueType.kind === "number" ? "number" : selectedFacet?.valueType.kind === "email" && !selectedFacet.valueType.allowDisplayName ? "email" : "text"} value={facetValue}/>}</label> : null}</div> : null}
      {kind === "context" ? <div className="view-context-editor"><div className="view-inline-fields view-inline-fields-three"><label><span>Type</span><select aria-label="Context type" data-clause-editor onFocus={() => void loadContextCatalog()} onChange={(event) => { const nextType = event.target.value; setContextTypeId(nextType); setContextId((contextCatalog?.contexts ?? []).find((item) => item.contextTypeId === nextType)?.id ?? ""); setRelationshipTypeId((contextCatalog?.relationships ?? []).find((item) => item.contextTypeId === nextType)?.id ?? ""); }} value={contextTypeId}><option value="">Choose a type</option>{contextTypeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label><span>Named context</span><select aria-label="Named Context" onFocus={() => void loadContextCatalog()} onChange={(event) => setContextId(event.target.value)} value={contextId}><option value="">Choose a Context</option>{contextOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label><span>Relationship</span><select aria-label="Context relationship" onFocus={() => void loadContextCatalog()} onChange={(event) => setRelationshipTypeId(event.target.value)} value={relationshipTypeId}><option value="">Choose a relationship</option>{relationshipOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label></div>{contextLoadState === "loading" ? <small className="view-context-status" role="status">Loading named Contexts…</small> : null}{contextLoadState === "error" ? <div className="view-context-status view-context-error" role="alert"><span>Named Contexts could not be loaded. Saved IDs remain preserved.</span><button className="view-action" onClick={() => void loadContextCatalog()} type="button">Retry Contexts</button></div> : null}</div> : null}
      {kind === "date" ? <div className="view-inline-fields"><label><span>Received after · UTC day start</span><input data-clause-editor onChange={(event) => setReceivedAfter(event.target.value)} type="date" value={receivedAfter}/></label><label><span>Received before · UTC day end</span><input onChange={(event) => setReceivedBefore(event.target.value)} type="date" value={receivedBefore}/></label></div> : null}
    </article>;
  }

  return <section ref={workspaceRef} onKeyDown={(event) => { if (event.key === "Escape" && composerMode && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); dismissComposer(); } }} className={`views-workspace${authoringEntry ? " views-workspace-external-authoring" : ""}`} aria-labelledby="views-title">
    {!authoringEntry && !composerMode ? <><ViewGettingStarted/><FirstViewInvitation/></> : null}
    <header className="views-header"><div><span>{authoringEntry ? authoringSourceLabel : "Workspace queries · unlimited"}</span><h2 data-dialog-initial-focus={authoringEntry ? true : undefined} id="views-title" tabIndex={authoringEntry ? -1 : undefined}>{authoringEntry ? "Review this live View" : "Live Views"}</h2><p>{authoringEntry ? "Confirm the exact account and filters before saving." : "One Thread can appear in every useful perspective while keeping one primary Lane."}</p></div>{!authoringEntry ? <button className="view-action view-new" disabled={!canMutate && composerMode !== "create"} onClick={() => composerMode ? cancelComposer() : loadComposer()} type="button">{composerMode === "create" ? "Close builder" : "+ New View"}</button> : null}</header>
    {discardPending ? <section className="view-preparation-state" role="alert"><strong>Discard changes to this draft?</strong><span>Your saved View, source and mail stay unchanged.</span><button className="view-action view-discard-keep" onClick={() => { exitAfterDiscard.current = null; setDiscardPending(false); focusSoon(null); }} type="button">Keep editing</button><button className="view-action" onClick={finishCancel} type="button">Discard draft</button></section> : null}
    <div className="views-live-note"><i aria-hidden="true"/><strong>Live from current Thread organization</strong><span>No membership list is stored.</span></div>
    {authoringEntry && !demoMode && !canMutate && authority.state.kind !== "loading" ? <section className="view-preparation-state" role="alert"><strong>{authority.state.title}</strong><span>{authority.state.detail}</span><button className="view-action" onClick={authority.retry} type="button">Retry connection</button><button className="view-action" onClick={cancelComposer} type="button">Return to source</button></section> : null}
    {authoringEntry && (demoMode || authority.snapshot || authority.state.kind === "loading") && displayedPreparationState.status === "loading" ? <section className="view-preparation-state" role="status"><strong>Preparing this live View…</strong><span>Orca is validating the source against current stored mail and Workspace authority.</span></section> : null}
    {authoringEntry && displayedPreparationState.status === "error" ? <section className="view-preparation-state view-preparation-error" role="alert"><strong>Could not prepare this View.</strong><span>{displayedPreparationState.error}</span><button className="view-action" onClick={() => setPreparationRetry((value) => value + 1)} type="button">Retry preparation</button><button className="view-action" onClick={cancelComposer} type="button">Return to source</button></section> : null}
    {composerMode && preparationMatchesCurrentEntry ? <form className="view-composer" hidden={discardPending} data-authority={canMutate ? "available" : "paused"} data-preview-evidence={evidenceState ?? undefined} onInputCapture={(event) => { if ((event.target as HTMLElement).closest("[data-clause]")) rememberDraft(event.target); }} onChangeCapture={(event) => { if ((event.target as HTMLElement).matches("select") && (event.target as HTMLElement).closest("[data-clause]")) rememberDraft(); }} onBlurCapture={() => { editingControl.current = null; }} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !(event.target as HTMLElement).matches('input,textarea,select,[contenteditable="true"]')) { event.preventDefault(); undoDraft(); } if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={(event) => { event.preventDefault(); void saveView(); }}>
      <header><div><span>Perspective builder</span><h3 tabIndex={-1}>{composerMode === "edit" ? "Edit live perspective" : "Build a live perspective"}</h3></div><div className="view-composer-actions">{confirmedZeroDigest ? <button className="view-action" onClick={() => setConfirmedZeroDigest(null)} type="button">Cancel zero-match confirmation</button> : null}{draftUndo.length ? <button className="view-action" onClick={undoDraft} type="button">Undo draft change</button> : null}<button className="view-action" onClick={cancelComposer} type="button">Cancel</button><button className="view-action view-save" disabled={!canMutate || status === "saving" || Boolean(validationMessage) || liveSaveBlocked} type="submit">{status === "saving" ? "Saving View…" : previewDisplayState === "loading" ? "Checking draft…" : previewIsZero && confirmedZeroDigest !== effectiveZeroDigest ? "Review zero matches" : previewIsZero ? "Confirm zero-match save" : composerMode === "edit" ? "Save changes" : "Save View"}</button></div></header>
      <fieldset className="view-builder-fieldset" disabled={!canMutate || status === "saving"}>
        <div className="view-identity"><label><span>View name</span><input autoFocus={!authoringEntry} maxLength={120} onInput={(event) => { setNameTouched(true); setName(event.currentTarget.value); }} value={name}/><small>{composerMode === "create" && !nameTouched ? `Suggested from your filters · ${suggestedName}` : "A short name shown in your workspace."}</small></label><label><span>Description <i>optional</i></span><input maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="What this perspective is for" value={description}/></label><label className="view-color-field"><span>Color</span><input aria-label="View color" onChange={(event) => setColor(event.target.value)} type="color" value={color}/></label></div>
        <section className="view-scope-sentence"><span>Current scope</span><p>{scopeSummary}</p>{preservedConstraintDetails.length ? <details className="view-preserved-constraints" open><summary>Preserved constraints · {preservedConstraintDetails.length}</summary><ul>{preservedConstraintDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul></details> : null}</section>
        {preparationNotices.length ? <section className="view-preparation-notices" aria-label="Preparation notices" role="status"><span>Selection adjusted</span>{preparationNotices.map((notice) => <div key={notice.code}><strong>{notice.detail}</strong>{notice.code === "self_sender_omitted" ? <small>Included external senders · {draft.sender?.addresses?.join(", ") ?? "None"}</small> : null}</div>)}</section> : null}
        {unsupportedClauses.length || removedUnsupportedClauses.length ? <section className="view-unsupported-clauses" aria-label="Unsupported source clauses"><header><div><span>Needs review</span><strong>{unsupportedClauses.length ? "Replace or remove unsupported clauses" : "Unsupported clauses resolved"}</strong></div></header>{unsupportedClauses.length ? <ul>{unsupportedClauses.map((clause) => <li key={clause.id}><div><strong>{clause.label}</strong><span>{clause.reason}</span></div>{clauseReplacements.filter((replacement) => replacement.clauseId === clause.id).map((replacement) => <button className="view-action" key={replacement.label} onClick={() => replaceSourceClause(replacement)} type="button">{replacement.label}</button>)}<button className="view-action" onClick={() => { rememberDraft(); setUnsupportedClauses((current) => current.filter((item) => item.id !== clause.id)); }} type="button">Remove blocker</button></li>)}</ul> : <p>Add an equivalent supported filter if the removed meaning still matters.</p>}</section> : null}
        {compact ? <button aria-expanded={tuneOpen} aria-controls="search-view-tune" className="view-action" ref={tuneRef} onClick={() => { setTuneOpen((value) => !value); if (!tuneOpen) window.setTimeout(() => document.querySelector<HTMLElement>('#search-view-tune [data-clause-editor], #search-view-tune button')?.focus(), 0); }} type="button">Tune</button> : null}
        <div hidden={compact && !tuneOpen} id={compact ? "search-view-tune" : undefined}>
        <div className="view-clause-heading"><div><span>Filters</span><small>Every filter narrows the same live result.</small></div><div className="view-add-filter"><button aria-controls={filterMenuOpen ? "view-filter-menu" : undefined} aria-expanded={filterMenuOpen} aria-haspopup="menu" className="view-action view-filter-trigger" onClick={() => { if (filterMenuOpen) { setFilterMenuOpen(false); setMoreFiltersOpen(false); } else { setMoreFiltersOpen(false); openFilterMenu(); } }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setMoreFiltersOpen(false); openFilterMenu(); } }} ref={filterTriggerRef} type="button">Add filter <b aria-hidden="true">＋</b></button>{filterMenuOpen ? <div aria-label="Add a filter" className="view-filter-menu" id="view-filter-menu" onBlur={(event) => { const next = event.relatedTarget; if (!(next instanceof Node) || (!filterMenuRef.current?.contains(next) && next !== filterTriggerRef.current)) { setFilterMenuOpen(false); setMoreFiltersOpen(false); } }} onKeyDown={handleFilterMenuKeyDown} ref={filterMenuRef} role="menu"><span>Common filters</span>{primaryClauseKinds.map((kind, index) => <button data-menu-index={index} disabled={activeSet.has(kind)} key={kind} onClick={() => void addClause(kind)} onFocus={() => setFilterMenuActiveIndex(index)} role="menuitem" tabIndex={!activeSet.has(kind) && filterMenuActiveIndex === index ? 0 : -1} type="button"><strong>{clauseMeta[kind].label}</strong><small>{activeSet.has(kind) ? "Added" : clauseMeta[kind].description}</small></button>)}<button aria-expanded={moreFiltersOpen} className="view-more-filters" data-menu-index={primaryClauseKinds.length} onClick={() => setMoreFiltersOpen((open) => !open)} onFocus={() => setFilterMenuActiveIndex(primaryClauseKinds.length)} role="menuitem" tabIndex={filterMenuActiveIndex === primaryClauseKinds.length ? 0 : -1} type="button"><strong>More filters</strong><small>Workflow, Facet, Context, and date <b aria-hidden="true">{moreFiltersOpen ? "−" : "+"}</b></small></button>{moreFiltersOpen ? advancedClauseKinds.map((kind, index) => { const menuIndex = primaryClauseKinds.length + 1 + index; return <button data-menu-index={menuIndex} disabled={activeSet.has(kind)} key={kind} onClick={() => void addClause(kind)} onFocus={() => setFilterMenuActiveIndex(menuIndex)} role="menuitem" tabIndex={!activeSet.has(kind) && filterMenuActiveIndex === menuIndex ? 0 : -1} type="button"><strong>{clauseMeta[kind].label}</strong><small>{activeSet.has(kind) ? "Added" : clauseMeta[kind].description}</small></button>; }) : null}</div> : null}</div></div>
        {activeClauses.length ? <div className="view-clause-list">{activeClauses.map(renderClause)}</div> : <div className="view-no-clauses"><strong>Any message can match.</strong><span>Add a filter only when it helps this perspective.</span></div>}
      </div></fieldset>
      <footer className="view-builder-footer"><div className="view-draft-preview"><span>{demoMode && !evidenceState ? "Local preview" : "Stored-mail preview"}</span><strong>{draftPredicateCount ? `${draftPredicateCount} predicate ${draftPredicateCount === 1 ? "family" : "families"} · combined with AND` : "All current and future messages"}</strong><small>{status === "saving" ? "Saving this reviewed definition…" : evidenceState === "loading" ? "Checking the latest stored mail…" : evidenceState === "error" ? "Preview failed. Saving stays disabled until this exact draft is checked." : evidenceState === "zero" ? "0 exact matches · no preview state is persisted." : evidenceState === "ready" ? "5 shown · no preview state is persisted." : demoMode ? "Local preview does not evaluate sample mail. Saving preserves the definition and clears stale sample results." : draftPreview.status === "loading" ? "Checking the latest stored mail…" : draftPreview.status === "error" ? "Preview failed. Saving stays disabled until this exact draft is checked." : previewMatchesCurrentDraft ? `${draftPreview.response!.results.count.value} ${draftPreview.response!.results.count.kind === "shown" ? "shown" : "exact matches"} · no preview state is persisted.` : "Edit a complete filter to preview it."}</small>{previewDisplayState === "error" ? <button className="view-action view-preview-retry" onClick={() => setPreviewRetry((value) => value + 1)} type="button">Retry preview</button> : null}</div><p aria-live="polite" className={validationMessage || previewDisplayState === "error" ? "view-validation" : "view-validation view-validation-ready"} role={validationMessage || previewDisplayState === "error" ? "alert" : "status"}>{!canMutate ? `Editing paused · ${authority.state.detail}` : validationMessage ? validationMessage : evidenceState === "loading" ? "Waiting for the current preview. Saving is disabled." : evidenceState === "error" ? "The stored-mail preview could not be loaded. Retry this exact draft before saving." : evidenceState === "zero" && confirmedZeroDigest === effectiveZeroDigest ? "Zero matches confirmed for this exact definition. Save again to continue." : evidenceState === "zero" ? "This filtered View matches zero Threads. Review, then confirm if that is intentional." : evidenceState === "ready" ? "Preview is current. Ready to save this perspective." : demoMode ? "Ready to save this perspective." : draftPreview.status === "error" ? draftPreview.error : previewIsZero && confirmedZeroDigest === draftPreview.response?.draft.definitionDigest ? "Zero matches confirmed for this exact definition. Save again to continue." : previewIsZero ? "This filtered View matches zero Threads. Review, then confirm if that is intentional." : previewMatchesCurrentDraft ? "Preview is current. Ready to save this perspective." : "Waiting for a current preview."}</p></footer>
      {correction && correction.key === censusKey ? <section className="view-sender-correction" aria-label="Correct matching senders"><h4 tabIndex={-1}>Keep only these senders</h4><p>Correcting “{correction.item.subject}” in {correction.item.accountEmail}. Conversation {correction.item.threadId}.</p><p>This is a positive allowlist for this account only; accounts connected later are not included. Omitted and new senders stay outside this View until you add them. Exact addresses replace any existing domain filters. Mail stays unchanged.</p>{correction.status === "loading" ? <p role="status">Checking all authorized matching messages…</p> : correction.status === "error" ? <p role="alert">{correction.error} Use the labeled filters for manual correction.</p> : correction.response ? <><p>{correction.response.detail}</p>{correction.response.status === "complete" ? <><p>Complete bounded set: {correction.response.addresses.length} addresses in {correction.item.accountEmail}, evaluated {correction.response.provenance.evaluatedAt}. Future mail is evaluated against the addresses you keep.</p><p>Proven matching senders in this conversation: {correction.response.witnessAddresses.join(", ")}. No sender is removed automatically; a conversation can contain more than one matching sender.</p><div>{correction.response.addresses.map((address) => <label key={address}><input type="checkbox" checked={correction.selected.includes(address)} onChange={(event) => setCorrection((current) => current ? { ...current, selected: event.target.checked ? current.response!.addresses.filter((candidate) => candidate === address || current.selected.includes(candidate)) : current.selected.filter((candidate) => candidate !== address) } : null)}/><span>{address}</span></label>)}</div>{!correction.selected.length ? <p role="alert">Keep at least one sender. An empty set cannot be applied.</p> : null}<button className="view-action" disabled={!canMutate || !correction.selected.length || status === "saving"} onClick={applySenderCorrection} type="button">Preview these senders</button></> : <p>No partial sender list can be applied. Use the labeled filters for manual correction.</p>}</> : null}<button className="view-action" onClick={() => { censusGeneration.current += 1; setCorrection(null); focusSoon(null); }} type="button">Cancel sender correction</button></section> : null}
      {!demoMode && previewMatchesCurrentDraft && draftPreview.response!.results.items.length ? <section aria-label="Draft View results" className="view-preview-results"><header><span>Unsaved result sample</span><strong>{draftPreview.response!.results.count.value} {draftPreview.response!.results.count.kind === "shown" ? "shown" : "matches"}</strong></header><div className="view-thread-list">{draftPreview.response!.results.items.map((item) => <div key={`${item.accountId}:${item.threadId}`}><ViewThreadRow item={item}/><button className="view-action" disabled={!canMutate || status === "saving"} onClick={() => void correctSenders(item)} type="button">Correct senders for {item.subject}</button></div>)}</div></section> : null}
      {error ? <p className="view-state view-state-error view-composer-error" role="alert">Could not change this View. {error}</p> : null}
    </form> : null}
    {!authoringEntry ? <div className="views-layout"><nav aria-label="Saved live Views" className="view-list">{views.map((view, index) => <div className="view-list-item" key={view.id}><button aria-pressed={view.id === activeViewId} className="view-chip" onClick={() => selectView(view)} type="button"><i aria-hidden="true" style={{ background: view.color }}/><span><strong>{view.name}</strong><small>{predicateCount(view.definition)} predicate families</small></span><b>›</b></button><div className="view-order-controls"><button aria-label={`Move ${view.name} up`} className="view-icon-action" disabled={!canMutate || Boolean(composerMode) || index === 0 || status === "saving"} onClick={() => void moveView(view, -1)} type="button">↑</button><button aria-label={`Move ${view.name} down`} className="view-icon-action" disabled={!canMutate || Boolean(composerMode) || index === views.length - 1 || status === "saving"} onClick={() => void moveView(view, 1)} type="button">↓</button></div></div>)}</nav>
      <section aria-busy={status === "loading" || status === "saving" || undefined} className="view-results"><header><div><span>{accountCount} {accountCount === 1 ? "account" : "accounts"} · {activePredicates} predicate families</span><h3>{activeView?.name ?? "Choose a View"}</h3><p>{activeView?.description || "Results re-evaluate whenever the underlying Thread changes."}</p></div><div className="view-lifecycle-actions"><button className="view-action" disabled={!canMutate || Boolean(composerMode) || !activeView || status !== "ready"} onClick={() => activeView && loadComposer(activeView)} type="button">Edit definition</button>{pendingRemoveId === activeView?.id ? <><button className="view-action" onClick={() => setPendingRemoveId(null)} type="button">Cancel</button><button className="view-action view-danger view-confirm" disabled={!canMutate || status === "saving"} onClick={() => activeView && void removeView(activeView)} type="button">Confirm remove</button></> : <button className="view-action view-danger" disabled={!canMutate || Boolean(composerMode) || !activeView || status !== "ready"} onClick={() => activeView && setPendingRemoveId(activeView.id)} type="button">Remove View</button>}</div></header>
      {!composerMode && error ? <p className="view-state view-state-error" role="alert">Could not change this View. {error}</p> : null}
      {status === "loading" ? <p className="view-state" role="status">Running the current View…</p> : null}
      {status === "ready" && !activeView ? <p className="view-state">No saved Views yet. Build one when Organization change authority is available.</p> : null}
      {status === "ready" && activeView && activeDemoViewIsUnevaluated ? <p className="view-state">Sample results have not been evaluated for this saved local definition. Connect to Organization to run its current filters.</p> : null}
      {status === "ready" && activeView && !activeDemoViewIsUnevaluated && items.length === 0 ? <p className="view-state">No Threads match right now. The definition stays ready for the next underlying change.</p> : null}
      {items.length ? <div className="view-thread-list">{items.map((item) => <ViewThreadRow item={item} key={`${item.accountId}:${item.threadId}`}/>)}</div> : null}
      {items.length ? <div className="view-continuation"><button className="view-action" disabled={!results?.nextCursor || pageStatus === "loading"} onClick={() => void loadMore()} type="button">{pageStatus === "loading" ? "Loading more Threads…" : results?.nextCursor ? "Load more" : "All matching Threads loaded"}</button>{pageError ? <p className="view-state view-state-error" role="alert">Could not load more Threads. {pageError}</p> : null}</div> : null}
      </section></div> : null}
  </section>;
}

export function OrganizationViewAuthoringWorkspace<TContext>({ entry, demoMode = false, onCancel, onCommitted, clauseReplacements, compact, dismissRef }: {
  entry: OrganizationViewAuthoringEntry<TContext>;
  compact?: boolean;
  dismissRef?: import("react").RefObject<(() => void) | null>;
  clauseReplacements?: readonly OrganizationViewClauseReplacement[];
  demoMode?: boolean;
  onCancel: (context: TContext) => void;
  onCommitted: (result: OrganizationViewCommitResponse, context: TContext) => void;
}) {
  return <OrganizationAuthorityProvider previewMode={demoMode}><OrganizationViewsWorkspace authoringEntry={entry} compact={compact} dismissRef={dismissRef} clauseReplacements={clauseReplacements} demoMode={demoMode} onCancelAuthoring={onCancel} onCommitted={onCommitted}/></OrganizationAuthorityProvider>;
}

function ViewThreadRow({ item, onOpen }: { item: OrganizationViewResultItem; onOpen?: (item: OrganizationViewResultItem) => void }) {
  const content = <><span aria-hidden="true" className="view-thread-signal">{item.humanSignal ?? "·"}</span><div><strong>{item.subject}</strong><small>{item.sender.name ?? item.sender.email} · {item.accountEmail}</small></div><span className="view-thread-lane">{laneLabel(item.primaryLaneId)}</span><time dateTime={item.latestReceivedAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(item.latestReceivedAt))}</time></>;
  return onOpen ? <button className="view-thread-row view-thread-open" onClick={() => onOpen(item)} type="button">{content}</button> : <article className="view-thread-row">{content}</article>;
}

function appendUniqueViewResults(current: readonly OrganizationViewResultItem[], incoming: readonly OrganizationViewResultItem[]) {
  const identities = new Set(current.map((item) => `${item.accountId}:${item.threadId}`));
  return [...current, ...incoming.filter((item) => {
    const identity = `${item.accountId}:${item.threadId}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  })];
}

function SavedOrganizationViewContent({ demoMode = false, onManage, onOpenThread, viewId }: { demoMode?: boolean; onManage: () => void; onOpenThread: (target: { accountId: string; threadId: string }) => void; viewId: string }) {
  const authority = useOrganizationAuthority();
  const previewView = demoMode ? organizationViewsFixture.find((candidate) => candidate.id === viewId) ?? null : null;
  const [view, setView] = useState<OrganizationView | null>(previewView);
  const [page, setPage] = useState<OrganizationViewResultPage | null>(previewView ? previewView.id === organizationWeeklyViewResultsFixture.viewId ? organizationWeeklyViewResultsFixture : emptyResults(previewView) : null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">(demoMode ? previewView ? "ready" : "missing" : "loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const continuation = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedViewId = useRef<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedCorrectionTarget, setSavedCorrectionTarget] = useState<OrganizationViewResultItem | null>(null);
  const [savedRefresh, setSavedRefresh] = useState(0);
  const savedEditOpener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (status !== "loading" && focusedViewId.current !== viewId) { headingRef.current?.focus(); focusedViewId.current = viewId; }
  }, [status, viewId]);
  const activeViewId = useRef(viewId);
  activeViewId.current = viewId;

  useEffect(() => {
    if (demoMode) return;
    if (!authority.snapshot && authority.state.kind !== "ready") return;
    continuation.current?.abort();
    continuation.current = null;
    const controller = new AbortController();
    const requestId = ++request.current;
    setStatus("loading"); setLoadingMore(false); setError(null); setPage(null);
    void authority.request("/v1/organization/views", { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: false }).then(async (body) => {
      const listed = organizationViewListResponseSchema.parse(body);
      const selected = listed.items.find((candidate) => candidate.id === viewId);
      if (!selected) {
        if (!controller.signal.aborted && requestId === request.current) { setView(null); setStatus("missing"); }
        return;
      }
      const resultBody = await authority.request(`/v1/organization/views/${encodeURIComponent(viewId)}/results?limit=25`, { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: false });
      const results = organizationViewResultPageSchema.parse(resultBody);
      if (!controller.signal.aborted && requestId === request.current && results.viewRevision === selected.revision) {
        setView(selected); setPage(results); setStatus("ready");
      }
    }).catch((reason) => {
      if (!controller.signal.aborted && requestId === request.current) { setStatus("error"); setError(reason instanceof Error ? reason.message : "Could not open this View"); }
    });
    return () => { controller.abort(); continuation.current?.abort(); };
  }, [authority.snapshot, demoMode, viewId, savedRefresh]);

  async function loadMore() {
    if (!view || !page?.nextCursor || loadingMore) return;
    const requestId = request.current;
    const requestedViewId = view.id;
    const requestedViewRevision = view.revision;
    const controller = new AbortController();
    continuation.current?.abort();
    continuation.current = controller;
    setLoadingMore(true); setError(null);
    if (demoMode) {
      await Promise.resolve();
      setPage((current) => current ? { ...current, items: appendUniqueViewResults(current.items, [demoContinuationItem]), nextCursor: null } : current);
      continuation.current = null;
      setLoadingMore(false);
      return;
    }
    try {
      const next = organizationViewResultPageSchema.parse(await authority.request(`/v1/organization/views/${encodeURIComponent(requestedViewId)}/results?limit=${page.limit}&cursor=${encodeURIComponent(page.nextCursor)}`, { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: true }));
      if (controller.signal.aborted || requestId !== request.current || requestedViewId !== activeViewId.current) return;
      if (next.viewId !== requestedViewId || next.viewRevision !== requestedViewRevision) throw new Error("This View changed. Reload it to continue.");
      setPage((current) => current && current.viewId === requestedViewId && current.viewRevision === requestedViewRevision
        ? { ...next, items: appendUniqueViewResults(current.items, next.items) }
        : current);
    } catch (reason) {
      if (!controller.signal.aborted && requestId === request.current && requestedViewId === activeViewId.current) {
        setError(reason instanceof Error ? reason.message : "Could not load more matches");
      }
    } finally {
      if (continuation.current === controller) continuation.current = null;
      if (requestId === request.current && requestedViewId === activeViewId.current) setLoadingMore(false);
    }
  }

  if (editing) return <OrganizationViewsWorkspace correctionTarget={savedCorrectionTarget} authoringEntry={{ preparation: { kind: "saved_view", viewId }, returnContext: viewId }} demoMode={demoMode} onCancelAuthoring={() => { setEditing(false); window.setTimeout(() => savedEditOpener.current?.focus(), 0); }} onCommitted={() => { setEditing(false); setSavedRefresh((value) => value + 1); focusedViewId.current = null; }}/>;

  return <section aria-busy={status === "loading" || undefined} aria-labelledby="saved-view-title" className="views-workspace saved-view-workspace">
    <header className="views-header"><div><span>My spaces · live View</span><h2 id="saved-view-title" ref={headingRef} tabIndex={-1}>{view?.name ?? (status === "missing" ? "View unavailable" : "Opening View…")}</h2><p>{view?.description || (status === "missing" ? "This View no longer exists or is outside your current access." : "Evaluating current stored mail with the saved definition.")}</p></div><div><button className="view-action" disabled={status !== "ready"} ref={savedEditOpener} onClick={() => { setSavedCorrectionTarget(null); setEditing(true); }} type="button">Edit or rename View</button><button className="view-action" onClick={onManage} type="button">Manage in Organization</button></div></header>
    {status === "loading" ? <p className="view-state" role="status">Loading the saved definition and current results…</p> : null}
    {status === "missing" ? <p className="view-state">The durable link is valid, but this View is not available to this workspace.</p> : null}
    {status === "error" ? <div className="view-state view-state-error" role="alert"><p>Could not open this View. {error}</p><button className="view-action" onClick={() => { request.current += 1; window.location.reload(); }} type="button">Reload View</button></div> : null}
    {status === "ready" && page ? <section className="view-results saved-view-results"><header><div><span>{page.accountIds.length} {page.accountIds.length === 1 ? "account" : "accounts"} · {page.nextCursor ? `${page.items.length} shown` : `${page.items.length} matches`}</span><h3>Current results</h3><p>Membership is evaluated live; opening a Thread preserves its account identity.</p></div></header>
      {page.items.length ? <div className="view-thread-list">{page.items.map((item) => <div key={`${item.accountId}:${item.threadId}`}><ViewThreadRow item={item} onOpen={() => onOpenThread({ accountId: item.accountId, threadId: item.threadId })}/><button className="view-action" onClick={() => { setSavedCorrectionTarget(item); setEditing(true); }} type="button">Correct senders for {item.subject}</button></div>)}</div> : <p className="view-state">No Threads match this filtered View right now. The View remains ready for future mail.</p>}
      {page.items.length ? <div className="view-continuation"><button className="view-action" disabled={!page.nextCursor || loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? "Loading more Threads…" : page.nextCursor ? "Load more" : "All matching Threads loaded"}</button>{error ? <p className="view-state view-state-error" role="alert">{error}</p> : null}</div> : null}
    </section> : null}
  </section>;
}

export function SavedOrganizationViewWorkspace({ demoMode = false, previewMode = false, ...props }: { demoMode?: boolean; onManage: () => void; onOpenThread: (target: { accountId: string; threadId: string }) => void; previewMode?: boolean; viewId: string }) {
  return <OrganizationAuthorityProvider previewMode={previewMode}><SavedOrganizationViewContent {...props} demoMode={demoMode}/></OrganizationAuthorityProvider>;
}
