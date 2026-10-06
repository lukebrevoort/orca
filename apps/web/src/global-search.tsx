import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  inboxClassificationResponseSchema,
  mailSearchPageSchema,
  parseMailSearch,
  prepareMailSearchView,
  mailAccountPageSchema,
  organizationCollectionPinQueryResponseSchema,
  pinFilterSchema,
  type Collection,
  type InboxMessage,
  type MailAccount,
  type PinFilter,
} from "@orca/shared";

import { resolveSearchCapabilities, expectedSearchHeaders, searchResponseMatchesMode, type ClientSearchCapabilities } from "./search-capabilities";
import { demoAccount, demoMessages } from "./demo-data";
import { parseDesktopDestination } from "./navigation";
import { readSurfaceLocation } from "./surface-history";
import { TopLayer } from "./top-layer";
import { OrganizationViewAuthoringWorkspace, type OrganizationViewAuthoringEntry } from "./organization-views";

type SearchReturnContext = { url: string; draft: string; scrollTop: number; loaded: number; focusHref: string | null };
const searchReturnKey = "orca:search-view-return:v1";
function savedSearchReturn(): SearchReturnContext | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(searchReturnKey) ?? "null");
    if (!value || value.url !== locationPath(window.location) || typeof value.draft !== "string" || value.draft.length > 200 || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || !Number.isInteger(value.loaded) || value.loaded < 0 || value.loaded > 10000 || value.focusHref !== null && typeof value.focusHref !== "string") return null;
    return value;
  } catch { return null; }
}

export type MailSearchMailbox = "inbox" | "focus" | "quiet" | "hidden" | "all";
export type MailSearchEvidence = "human" | "tideline" | "uncertain" | "all";

export type MailSearchState = {
  query: string;
  mailbox: MailSearchMailbox;
  evidence: MailSearchEvidence;
  accountId: string | null;
  collectionId: string | null;
  source: string;
  destinationId?: string;
  destinationName?: string;
  senderAddress?: string;
  attentionBehavior?: "notify" | "focus" | "normal" | "quiet" | "hidden";
};

export const mailSearchLocationEvent = "orca:mail-search-location";
export const mailSearchResultEvent = "orca:mail-search-result";
export type MailSearchResultEventDetail = { url: string };
const searchResultReaderKey = "searchResultReader";
const searchKeys = ["search", "searchQuery", "searchMailbox", "searchEvidence", "searchAccount", "searchSpace", "searchSource", "searchSender", "searchAttention", "searchDestination", "searchDestinationName", searchResultReaderKey] as const;
const mailboxes = new Set<MailSearchMailbox>(["inbox", "focus", "quiet", "hidden", "all"]);
const evidenceFilters = new Set<MailSearchEvidence>(["human", "tideline", "uncertain", "all"]);

function locationPath(location: Pick<Location, "pathname" | "search" | "hash">) {
  return `${location.pathname}${location.search}${location.hash}`;
}

const safeInboxReturn = "/?destination=inbox";
const knownStandaloneRoutes = new Set([
  "/login",
  "/onboarding",
  "/settings",
  "/settings/reading",
  "/settings/attention-views",
  "/settings/integrations/gmail",
  "/settings/integrations/gmail/labels",
  "/settings/integrations/calendar",
  "/dev/settings",
  "/dev/onboarding",
  "/dev/calendar",
  "/dev/reply-availability",
]);

function isKnownOrcaReturn(url: URL) {
  if (searchKeys.some((key) => url.searchParams.has(key))) return false;
  if (knownStandaloneRoutes.has(url.pathname)) return true;
  if (/^\/accounts\/[^/]+\/threads\/[^/]+$/.test(url.pathname)) return true;
  if (url.pathname !== "/" && url.pathname !== "/dev/inbox") return false;
  const destination = url.searchParams.get("destination");
  return destination === null || parseDesktopDestination(destination) !== null;
}

export function safeInternalSearchReturn(value: string | null, location: Pick<Location, "origin" | "pathname" | "search" | "hash">) {
  if (!value) return safeInboxReturn;
  try {
    const resolved = new URL(value, location.origin);
    if (resolved.origin !== location.origin || !isKnownOrcaReturn(resolved)) return safeInboxReturn;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return safeInboxReturn;
  }
}

export function readMailSearchState(location: Pick<Location, "origin" | "pathname" | "search" | "hash">): MailSearchState | null {
  const params = new URLSearchParams(location.search);
  if (params.get("search") !== "mail") return null;
  if (isMailSearchResultReader(location)) return null;
  const mailbox = params.get("searchMailbox") as MailSearchMailbox | null;
  const evidence = params.get("searchEvidence") as MailSearchEvidence | null;
  return {
    query: (params.get("searchQuery") ?? "").slice(0, 200),
    mailbox: mailbox && mailboxes.has(mailbox) ? mailbox : "all",
    evidence: evidence && evidenceFilters.has(evidence) ? evidence : "all",
    accountId: params.get("searchAccount") || null,
    collectionId: params.get("searchSpace") || null,
    source: safeInternalSearchReturn(params.get("searchSource"), location),
    ...(params.get("searchDestination") ? { destinationId: params.get("searchDestination")!, destinationName: params.get("searchDestinationName") ?? "Selected space" } : {}),
    ...(params.get("searchSender") ? { senderAddress: params.get("searchSender")! } : {}),
    ...(["notify", "focus", "normal", "quiet", "hidden"].includes(params.get("searchAttention") ?? "") ? { attentionBehavior: params.get("searchAttention") as NonNullable<MailSearchState["attentionBehavior"]> } : {}),
  };
}

export function mailSearchUrl(location: Pick<Location, "origin" | "pathname" | "search" | "hash">, state: MailSearchState) {
  const url = new URL(locationPath(location), location.origin);
  url.searchParams.delete(searchResultReaderKey);
  url.searchParams.set("search", "mail");
  url.searchParams.set("searchQuery", state.query.trim().slice(0, 200));
  url.searchParams.set("searchMailbox", state.mailbox);
  url.searchParams.set("searchEvidence", state.evidence);
  url.searchParams.set("searchSource", safeInternalSearchReturn(state.source, location));
  if (state.destinationId) { url.searchParams.set("searchDestination", state.destinationId); url.searchParams.set("searchDestinationName", state.destinationName ?? "Selected space"); } else { url.searchParams.delete("searchDestination"); url.searchParams.delete("searchDestinationName"); }
  if (state.senderAddress) url.searchParams.set("searchSender", state.senderAddress); else url.searchParams.delete("searchSender");
  if (state.attentionBehavior) url.searchParams.set("searchAttention", state.attentionBehavior); else url.searchParams.delete("searchAttention");
  if (state.accountId) url.searchParams.set("searchAccount", state.accountId);
  else url.searchParams.delete("searchAccount");
  if (state.collectionId) url.searchParams.set("searchSpace", state.collectionId);
  else url.searchParams.delete("searchSpace");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function openMailSearch(query = "") {
  const current = readMailSearchState(window.location);
  const source = current?.source ?? locationPath(window.location);
  const state: MailSearchState = current
    ? { ...current, query }
    : { query, mailbox: "all", evidence: "all", accountId: null, collectionId: null, source };
  const next = mailSearchUrl(window.location, state);
  if (current) window.history.replaceState({ ...window.history.state, orcaMailSearch: true }, "", next);
  else window.history.pushState({ ...window.history.state, orcaMailSearch: true }, "", next);
  window.dispatchEvent(new Event(mailSearchLocationEvent));
}

export function updateMailSearchLocation(state: MailSearchState) {
  window.history.replaceState({ ...window.history.state, orcaMailSearch: true }, "", mailSearchUrl(window.location, state));
  window.dispatchEvent(new Event(mailSearchLocationEvent));
}

export function closeMailSearch() {
  const state = readMailSearchState(window.location);
  if (!state) return;
  if (window.history.state?.orcaMailSearch === true) {
    window.history.back();
    return;
  }
  window.history.replaceState(window.history.state, "", state.source);
  window.dispatchEvent(new Event(mailSearchLocationEvent));
}

export function hasMailSearchConstraint(state: MailSearchState) {
  return Boolean(state.destinationId || state.senderAddress || state.attentionBehavior || state.query.trim() || state.mailbox !== "all" || state.evidence !== "all" || state.accountId || state.collectionId);
}

export function mailSearchRequest(state: MailSearchState, cursor?: string | null, capabilities?: ClientSearchCapabilities | null) {
  const indexed = Boolean(state.query.trim()) && capabilities?.mode !== "legacy-metadata";
  const params = new URLSearchParams({ limit: state.query.trim() ? "10" : "100", classification: state.evidence });
  if (indexed || state.mailbox !== "inbox") params.set("view", state.mailbox);
  if (state.query.trim()) params.set("query", state.query.trim());
  if (state.destinationId) { params.set("destinationId", state.destinationId); params.set("view", "all"); }
  if (state.senderAddress) params.set("senderAddress", state.senderAddress);
  if (state.attentionBehavior) params.set("attentionBehavior", state.attentionBehavior);
  if (state.accountId) params.set("accountId", state.accountId);
  if (state.collectionId) params.set("collectionId", state.collectionId);
  if (cursor) params.set("cursor", cursor);
  return `${indexed ? "/v1/mail/search" : "/v1/inbox"}?${params}`;
}

export function mailSearchPinFilter(state: MailSearchState): PinFilter {
  return pinFilterSchema.parse({
    mailbox: state.mailbox,
    attention: state.attentionBehavior ?? "all",
    classification: state.evidence,
    person: state.senderAddress ?? null,
    query: state.query,
    accountId: state.accountId,
    collectionId: state.collectionId,
    dataSource: "stored_mail",
  });
}

export function openMailSearchFilter(filter: PinFilter, destination?: { destinationId: string; destinationName: string }) {
  const source = locationPath(window.location);
  const state: MailSearchState = {
    query: filter.query,
    mailbox: filter.mailbox,
    evidence: filter.classification ?? "all",
    accountId: filter.accountId ?? null,
    collectionId: filter.collectionId ?? null,
    source,
    ...destination,
    ...(filter.person ? { senderAddress: filter.person } : {}),
    ...(filter.attention !== "all" ? { attentionBehavior: filter.attention } : {}),
  };
  window.history.pushState({ ...window.history.state, orcaMailSearch: true }, "", mailSearchUrl(window.location, state));
  window.dispatchEvent(new Event(mailSearchLocationEvent));
}

function isDemoSearch() {
  return typeof window !== "undefined" && import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "1";
}

function matchesDemoSearch(message: InboxMessage, state: MailSearchState) {
  const needle = state.query.trim().toLocaleLowerCase();
  const haystack = `${message.from.name ?? ""} ${message.from.email} ${message.subject} ${message.snippet}`.toLocaleLowerCase();
  const evidence = message.humanClassification?.effective.classification ?? "unclassified";
  const evidenceMatches = state.evidence === "all"
    || (state.evidence === "human" && evidence === "likely_human")
    || (state.evidence === "tideline" && evidence === "automated_or_bulk")
    || (state.evidence === "uncertain" && (evidence === "uncertain" || evidence === "unclassified"));
  const mailboxMatches = state.mailbox === "all"
    || (state.mailbox === "inbox" && message.attentionBehavior !== "quiet" && message.attentionBehavior !== "hidden")
    || (state.mailbox === "focus" && (message.attentionBehavior === "focus" || message.attentionBehavior === "notify"))
    || message.attentionBehavior === state.mailbox;
  return (!needle || haystack.includes(needle))
    && (!state.accountId || message.accountId === state.accountId)
    && !state.collectionId
    && evidenceMatches
    && mailboxMatches;
}

function searchError(value: unknown) {
  if (typeof value !== "object" || value === null || !("error" in value)) return "Search could not be completed.";
  const error = value.error;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Search could not be completed.";
}

class SearchRequestError extends Error {
  constructor(message: string, readonly code: string | null) { super(message); }
}
function responseSearchCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value) || !value.error || typeof value.error !== "object" || !("code" in value.error)) return null;
  return typeof value.error.code === "string" ? value.error.code : null;
}
function parseSearchPage(value: unknown, state: MailSearchState, capabilities: ClientSearchCapabilities | null) {
  if (state.query.trim() && capabilities?.mode === "indexed") {
    const page = mailSearchPageSchema.parse(value);
    if (page.coverage !== "stored-plaintext") throw new SearchRequestError("Search returned an unexpected coverage. Please retry.", "search_failed");
    return page;
  }
  const result = inboxClassificationResponseSchema.parse(value);
  return { ...result, continuation: result.nextCursor ? "matches" as const : "none" as const, snapshot: capabilities ? `legacy:${capabilities.epoch}:${result.freshness?.revision ?? "compatible-server"}` : null };
}
async function readJson(response: Response, capabilities: ClientSearchCapabilities | null = null) {
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new SearchRequestError(searchError(value), responseSearchCode(value));
  if (!searchResponseMatchesMode(response, capabilities)) throw new SearchRequestError("Search mode changed. Restart to use the current search coverage.", "search_mode_changed");
  return value;
}

function evidenceLabel(message: InboxMessage) {
  const classification = message.humanClassification?.effective.classification;
  if (classification === "likely_human") return "Likely human";
  if (classification === "automated_or_bulk") return "Automated or bulk";
  return "Needs review";
}

function searchResultDate(receivedAt: string) {
  const received = new Date(receivedAt);
  const includeYear = received.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" as const } : {}) }).format(received);
}

function scopeLabel(state: MailSearchState, accounts: MailAccount[], collections: Collection[]) {
  const mailbox = state.mailbox === "all" ? "All mail" : state.mailbox.charAt(0).toUpperCase() + state.mailbox.slice(1);
  const evidence = state.evidence === "all" ? "Any evidence" : state.evidence === "human" ? "Likely human evidence" : state.evidence === "tideline" ? "Automated or bulk evidence" : "Needs review";
  const account = accounts.find((item) => item.id === state.accountId)?.email ?? state.accountId ?? undefined;
  const collection = collections.find((item) => item.id === state.collectionId)?.name ?? state.collectionId ?? undefined;
  return [state.destinationId ? state.destinationName ?? "Selected space" : mailbox, evidence, account, collection, state.senderAddress, state.attentionBehavior].filter(Boolean).join(" · ");
}

function returnContextLabel(source: string) {
  const url = new URL(source, "http://orca.local");
  if (url.pathname.startsWith("/settings")) return "Settings";
  if (/^\/accounts\/[^/]+\/threads\/[^/]+$/.test(url.pathname) || url.searchParams.has("thread")) return "message";
  const destination = parseDesktopDestination(url.searchParams.get("destination")) ?? "inbox";
  if (destination.startsWith("space:")) return "space";
  if (destination === "all") return "All Mail";
  return destination.charAt(0).toUpperCase() + destination.slice(1);
}

export function mailSearchReaderUrl(message: Pick<InboxMessage, "accountId" | "threadId">, location: Pick<Location, "origin" | "pathname" | "search" | "hash"> = window.location) {
  const target = new URL(locationPath(location), location.origin);
  target.pathname = "/";
  target.searchParams.set("destination", "inbox");
  target.searchParams.set("thread", message.threadId);
  target.searchParams.set("accountId", message.accountId);
  target.searchParams.set(searchResultReaderKey, "1");
  target.searchParams.delete("compose");
  target.searchParams.delete("draft");
  target.searchParams.delete("zen");
  target.searchParams.delete("returnTo");
  return `${target.pathname}${target.search}${target.hash}`;
}

export function isMailSearchResultReader(location: Pick<Location, "pathname" | "search">) {
  return new URLSearchParams(location.search).get(searchResultReaderKey) === "1" && Boolean(readSurfaceLocation(location).reader);
}

export function openMailSearchResult(message: Pick<InboxMessage, "accountId" | "threadId">) {
  const url = mailSearchReaderUrl(message);
  const handled = !window.dispatchEvent(new CustomEvent<MailSearchResultEventDetail>(mailSearchResultEvent, {
    cancelable: true,
    detail: { url },
  }));
  if (handled) {
    window.dispatchEvent(new Event(mailSearchLocationEvent));
    return;
  }
  window.location.assign(url);
}

type SearchStatus = "idle" | "loading" | "ready" | "error";

export function GlobalMailSearch({ returnFocusRef }: { returnFocusRef: RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<MailSearchState | null>(() => typeof window === "undefined" ? null : readMailSearchState(window.location));
  const [draft, setDraft] = useState(state?.query ?? "");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [accounts, setAccounts] = useState<MailAccount[]>(() => isDemoSearch() ? [demoAccount] : []);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [continuation, setContinuation] = useState<"matches" | "scan" | "none">("none");
  const snapshotRef = useRef<string | null>(null);
  const [capabilities, setCapabilities] = useState<ClientSearchCapabilities | null>(null);
  const capabilitiesRef = useRef<ClientSearchCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [authoring, setAuthoring] = useState<OrganizationViewAuthoringEntry<SearchReturnContext> | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const authoringDismissRef = useRef<(() => void) | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => Boolean(state && (state.mailbox !== "all" || state.evidence !== "all" || state.accountId || state.collectionId)));
  const inputRef = useRef<HTMLInputElement>(null);
  const resultListRef = useRef<HTMLOListElement>(null);
  const resultRegionRef = useRef<HTMLElement>(null);
  const lastResultFocus = useRef<string | null>(null);
  const restoringSearch = useRef<SearchReturnContext | null>(typeof window === "undefined" ? null : savedSearchReturn());
  const requestGenerationRef = useRef(0);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  function invalidateSave() { setAuthoring(null); }

  useEffect(() => {
    const synchronize = () => {
      invalidateSave();
      restoringSearch.current = savedSearchReturn();
      const next = readMailSearchState(window.location);
      setStatus(next && hasMailSearchConstraint(next) ? "loading" : "idle");
      setState(next);
      if (next) {
        setDraft(next.query);
        setFiltersOpen(Boolean(next.mailbox !== "all" || next.evidence !== "all" || next.accountId || next.collectionId));
      }
    };
    window.addEventListener("pageshow", synchronize);
    window.addEventListener("popstate", synchronize);
    window.addEventListener(mailSearchLocationEvent, synchronize);
    return () => {
      window.removeEventListener("pageshow", synchronize);
      window.removeEventListener("popstate", synchronize);
      window.removeEventListener(mailSearchLocationEvent, synchronize);
    };
  }, []);


  useEffect(() => {
    if (!state || isDemoSearch()) return;
    const controller = new AbortController();
    void Promise.all([
      fetch("/v1/accounts", { credentials: "include", signal: controller.signal }).then(response => readJson(response)).then((value) => mailAccountPageSchema.parse(value).items),
      fetch("/v1/organization/collections-pins/query", { credentials: "include", signal: controller.signal }).then(response => readJson(response)).then((value) => organizationCollectionPinQueryResponseSchema.parse(value).collections),
    ]).then(([nextAccounts, nextCollections]) => {
      if (controller.signal.aborted) return;
      setAccounts(nextAccounts);
      setCollections(nextCollections);
    }).catch(() => {
      // Search itself remains useful if optional filter metadata is unavailable.
    });
    return () => controller.abort();
  }, [Boolean(state)]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setLoadingMore(false);
    if (!state || !hasMailSearchConstraint(state)) {
      setStatus("idle");
      setMessages([]);
      setNextCursor(null);
      setError(null); setCapabilities(null); capabilitiesRef.current = null;
      return;
    }
    setStatus("loading");
    setMessages([]);
    setNextCursor(null);
    setError(null);
    capabilitiesRef.current = null;
    setCapabilities(null);
    snapshotRef.current = null;
    setContinuation("none");
    if (isDemoSearch()) {
      const sampleMode: ClientSearchCapabilities = { version: 1, mode: "legacy-metadata", epoch: "demo", ownerId: "demo", coverage: "stored-metadata", semantics: "legacy-substring-v1", verified: false };
      capabilitiesRef.current = sampleMode; setCapabilities(sampleMode);
      const matches = demoMessages.filter((message) => matchesDemoSearch(message, state));
      setMessages(matches);
      setAccounts([demoAccount]);
      setStatus("ready");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const selected = state.query.trim() ? await resolveSearchCapabilities(controller.signal) : null;
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      capabilitiesRef.current = selected; setCapabilities(selected);
      if (selected?.mode === "indexed") parseMailSearch(state.query);
      const response = await fetch(mailSearchRequest(state, undefined, selected), { credentials: "include", signal: controller.signal, headers: expectedSearchHeaders(selected) });
      const result = parseSearchPage(await readJson(response, selected), state, selected);
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setAccounts(result.accounts); setMessages(result.messages); setNextCursor(result.nextCursor);
      setContinuation(result.continuation); snapshotRef.current = result.snapshot; setStatus("ready");
    })().catch(async (caught) => {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setMessages([]); setNextCursor(null); setContinuation("none"); snapshotRef.current = null;
      setStatus("error"); setError(caught instanceof Error ? caught.message : "Search could not be completed.");
      if (caught instanceof SearchRequestError && ["search_mode_changed", "search_not_activated"].includes(caught.code ?? "")) {
        try {
          const selected = await resolveSearchCapabilities(controller.signal);
          if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
          capabilitiesRef.current = selected; setCapabilities(selected);
        } catch { /* Never downgrade on capability errors. Retry is explicit. */ }
      }
    });
    return () => controller.abort();
  }, [state, retryKey]);

  useEffect(() => {
    if (!state || draft === state.query || authoring) return;
    const timer = window.setTimeout(() => commit({ ...state, query: draft }), 300);
    return () => window.clearTimeout(timer);
  }, [draft, state, authoring]);

  useEffect(() => {
    const context = restoringSearch.current;
    if (!context || status !== "ready" || authoring || loadingMore) return;
    if (messages.length < context.loaded && nextCursor && !error) { void loadMore(); return; }
    restoringSearch.current = null;
    try { window.sessionStorage.removeItem(searchReturnKey); } catch { /* The source URL remains usable. */ }
    setDraft(context.draft);
    const generation = requestGenerationRef.current;
    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        if (generation !== requestGenerationRef.current || locationPath(window.location) !== context.url) return;
        if (resultRegionRef.current) resultRegionRef.current.scrollTop = context.scrollTop;
        const anchor = [...(resultListRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].find((item) => item.getAttribute("href") === context.focusHref);
        (anchor ?? saveButtonRef.current)?.focus({ preventScroll: true });
      });
    });
    return () => { window.cancelAnimationFrame(outerFrame); if (innerFrame) window.cancelAnimationFrame(innerFrame); };
  }, [status, messages, nextCursor, loadingMore, error, authoring]);

  const scope = useMemo(() => state ? scopeLabel(state, accounts, collections) : "All mail", [accounts, collections, state]);
  if (!state) return null;
  const selectedAccountMissing = Boolean(state.accountId && !accounts.some((item) => item.id === state.accountId));
  const selectedCollectionMissing = Boolean(state.collectionId && !collections.some((item) => item.id === state.collectionId));
  const legacyExactScope = Boolean(state.destinationId || state.senderAddress || state.attentionBehavior);
  const filterCount = Number(legacyExactScope) + Number(state.mailbox !== "all") + Number(state.evidence !== "all") + Number(Boolean(state.accountId)) + Number(Boolean(state.collectionId));
  const returnLabel = returnContextLabel(state.source);

  function commit(next: MailSearchState) {
    requestGenerationRef.current += 1;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    invalidateSave();
    setLoadingMore(false);
    setStatus(hasMailSearchConstraint(next) ? "loading" : "idle");
    setMessages([]);
    setNextCursor(null);
    setError(null);
    setState(next);
    updateMailSearchLocation(next);
  }

  function close() {
    invalidateSave();
    closeMailSearch();
  }

  function focusFirstResult() {
    resultListRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }

  function moveResultFocus(event: import("react").KeyboardEvent<HTMLOListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a")];
    const current = event.target instanceof HTMLElement && event.target.matches("a") ? links.indexOf(event.target as HTMLAnchorElement) : -1;
    if (current < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && current === 0) {
      inputRef.current?.focus();
      return;
    }
    const next = event.key === "ArrowDown" ? Math.min(current + 1, links.length - 1) : Math.max(current - 1, 0);
    links[next]?.focus();
  }

  async function loadMore() {
    if (!state || !nextCursor || loadingMore || isDemoSearch()) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const selected = state.query.trim() ? capabilitiesRef.current : null;
      if (state.query.trim() && !selected) throw new SearchRequestError("Restart this search to check its coverage.", "search_mode_changed");
      const response = await fetch(mailSearchRequest(state, nextCursor, selected), { credentials: "include", signal: controller.signal, headers: expectedSearchHeaders(selected) });
      const result = parseSearchPage(await readJson(response, selected), state, selected);
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      if (result.nextCursor !== null && result.nextCursor === nextCursor) throw new SearchRequestError("Search did not advance. Restart to load consistent results.", "search_invalid_cursor");
      if (result.snapshot !== snapshotRef.current) throw new SearchRequestError("Stored mail changed. Restart this search to load consistent results.", "search_cursor_stale");
      setMessages((current) => [...current, ...result.messages.filter((message) => !current.some((item) => item.id === message.id && item.accountId === message.accountId))]);
      setNextCursor(result.nextCursor);
      setContinuation(result.continuation);
    } catch (caught) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      if (caught instanceof SearchRequestError && ["invalid_cursor", "search_cursor_stale", "search_invalid_cursor", "search_index_updating", "search_index_blocked", "search_index_unavailable", "search_mode_changed", "search_not_activated"].includes(caught.code ?? "")) {
        setMessages([]); setNextCursor(null); setContinuation("none"); snapshotRef.current = null; setStatus("error");
      }
      setError(caught instanceof Error ? caught.message : "More results could not be loaded.");
      if (caught instanceof SearchRequestError && ["search_mode_changed", "search_not_activated"].includes(caught.code ?? "")) {
        try {
          const selected = await resolveSearchCapabilities(controller.signal);
          if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
          capabilitiesRef.current = selected; setCapabilities(selected);
        } catch { /* An indexed read failure never chooses metadata compatibility. */ }
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  function saveSearch() {
    if (!state || legacyExactScope || status !== "ready" || draft.trim() !== state.query.trim() || !hasMailSearchConstraint(state)) return;
    loadMoreControllerRef.current?.abort();
    const context: SearchReturnContext = { url: locationPath(window.location), draft, scrollTop: resultRegionRef.current?.scrollTop ?? 0, loaded: messages.length, focusHref: lastResultFocus.current };
    setAuthoring({ preparation: prepareMailSearchView(state, context.url), returnContext: context });
  }

  function returnFromAuthoring(context: SearchReturnContext) {
    setAuthoring(null);
    setDraft(context.draft);
    const generation = requestGenerationRef.current;
    window.requestAnimationFrame(() => {
      if (generation !== requestGenerationRef.current || locationPath(window.location) !== context.url) return;
      const region = resultListRef.current?.closest(".global-mail-search-results");
      if (region) region.scrollTop = context.scrollTop;
      saveButtonRef.current?.focus({ preventScroll: true });
    });
  }

  return <><TopLayer
    ariaBusy={status === "loading"}
    ariaLabelledBy="global-mail-search-title"
    as="section"
    backdropAccessible={false}
    backdropClassName="global-mail-search-backdrop"
    className="global-mail-search"
    initialFocusRef={inputRef}
    layerClassName="global-mail-search-layer"
    onClose={close}
    returnFocusRef={returnFocusRef}
  >
    <header className="global-mail-search-heading">
      <div><span aria-hidden="true">⌕</span><h1 id="global-mail-search-title">Search mail</h1><p>Stored messages</p></div>
      <div className="global-mail-search-return"><kbd>Esc</kbd><span>Back to {returnLabel}</span></div>
      <button aria-label={`Close Search mail and return to ${returnLabel}`} onClick={close} type="button">×</button>
    </header>
    <form className="global-mail-search-form" onSubmit={(event) => { event.preventDefault(); commit({ ...state, query: draft }); }} role="search">
      <label><span aria-hidden="true">⌕</span><input aria-label="Search stored mail" autoComplete="off" maxLength={200} onInput={(event) => { const value = event.currentTarget.value; if (value === state.query) { setDraft(value); commit({ ...state }); return; } requestGenerationRef.current += 1; loadMoreControllerRef.current?.abort(); setDraft(value); setStatus("loading"); setMessages([]); setNextCursor(null); }} onKeyDown={(event) => { if (event.key === "ArrowDown" && messages.length > 0) { event.preventDefault(); focusFirstResult(); } }} placeholder={capabilities?.mode === "legacy-metadata" ? "Sender, subject, or preview" : "Search stored mail"} ref={inputRef} value={draft}/><kbd>Enter</kbd></label>
      <button type="submit">Search</button>
    </form>
    <p className="global-mail-search-coverage">{capabilities?.mode === "indexed"
      ? "Indexed search covers all stored senders, subjects, previews and plain-text bodies in this scope. HTML-only bodies and attachments are excluded. Use words or quoted phrases; short terms can accompany a longer word, such as AI update."
      : capabilities?.mode === "legacy-metadata" ? "Metadata-only search: matches the text as entered in stored senders, subjects and previews, in mailbox order. Body search is not enabled."
      : "Search coverage is checked before your query runs. Your query and scope stay in place."}</p>
    <div className="global-mail-search-toolbar">
      <div className="global-mail-search-scope"><span>Scope</span><strong>{scope}</strong></div>
      <button aria-controls="global-mail-search-filters" aria-expanded={filtersOpen} className="global-mail-filter-toggle" onClick={() => setFiltersOpen((open) => !open)} type="button"><span aria-hidden="true">≡</span> Filters{filterCount ? <b>{filterCount}</b> : null}</button>
      <button className="global-mail-save" ref={saveButtonRef} disabled={legacyExactScope || !hasMailSearchConstraint(state) || status !== "ready" || draft.trim() !== state.query.trim()} onClick={saveSearch} title="Review this search as a live conversation View" type="button">Save as View</button>
    </div>
    {legacyExactScope ? <p className="global-mail-search-exact-scope">Exact filter: {[state.destinationName, state.senderAddress, state.attentionBehavior].filter(Boolean).join(" · ")}. <button onClick={() => commit({ ...state, query: draft, destinationId: undefined, destinationName: undefined, senderAddress: undefined, attentionBehavior: undefined })} type="button">Clear exact filters</button> Clear these filters before saving a View.</p> : null}
    <div aria-label="Search scope filters" className="global-mail-search-filters" hidden={!filtersOpen} id="global-mail-search-filters" role="group">
      <label><span>Mailbox</span><select onChange={(event) => commit({ ...state, query: draft, destinationId: undefined, destinationName: undefined, mailbox: event.target.value as MailSearchMailbox })} value={state.mailbox}><option value="all">All mail</option><option value="inbox">Inbox</option><option value="focus">Focus</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></label>
      <label><span>Evidence</span><select onChange={(event) => commit({ ...state, query: draft, evidence: event.target.value as MailSearchEvidence })} value={state.evidence}><option value="all">Any evidence</option><option value="human">Likely human</option><option value="tideline">Automated or bulk</option><option value="uncertain">Needs review</option></select></label>
      <label><span>Account</span><select onChange={(event) => commit({ ...state, query: draft, accountId: event.target.value || null, collectionId: state.collectionId && collections.find((item) => item.id === state.collectionId)?.accountId !== event.target.value ? null : state.collectionId })} value={state.accountId ?? ""}><option value="">Every connected account</option>{selectedAccountMissing ? <option value={state.accountId!}>{state.accountId}</option> : null}{accounts.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
      <label><span>Space</span><select onChange={(event) => { const collectionId = event.target.value || null; const selected = collections.find((item) => item.id === collectionId); commit({ ...state, query: draft, collectionId, accountId: selected?.accountId ?? state.accountId }); }} value={state.collectionId ?? ""}><option value="">Every space</option>{selectedCollectionMissing ? <option value={state.collectionId!}>{state.collectionId}</option> : null}{collections.filter((item) => !state.accountId || item.accountId === state.accountId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>

    <section aria-live="polite" className="global-mail-search-results" ref={resultRegionRef}>
      {status === "idle" ? <div className="global-mail-search-state"><p>Search all stored mail</p><h2>Find a person, subject, or phrase.</h2><span>Results open here without losing {returnLabel}.</span></div> : null}
      {status === "loading" ? <div className="global-mail-search-state global-mail-search-loading"><p>Searching</p><h2>Looking through stored mail…</h2><span>Your query and scope stay in place.</span><i aria-hidden="true" /></div> : null}
      {status === "error" ? <div className="global-mail-search-state global-mail-search-error" role="alert"><p>Search unavailable</p><h2>Search needs attention.</h2><span>{error} Your query and scope are unchanged.</span><button onClick={() => setRetryKey((key) => key + 1)} type="button">Try again</button></div> : null}
      {status === "ready" && messages.length === 0 && !nextCursor ? <div className="global-mail-search-state"><p>No matches</p><h2>Nothing found for “{state.query.trim() || scope}”.</h2><span>{filterCount ? "Try the full stored mailbox without changing your query." : "Try another person, subject, or phrase."}</span><button onClick={() => { if (filterCount) commit({ ...state, query: draft, mailbox: "all", evidence: "all", accountId: null, collectionId: null, destinationId: undefined, destinationName: undefined, senderAddress: undefined, attentionBehavior: undefined }); else { setDraft(""); commit({ ...state, query: "" }); } }} type="button">{filterCount ? "Clear filters" : "Clear query"}</button></div> : null}
      {status === "ready" && messages.length > 0 ? <><header className="global-mail-result-count"><strong>Results</strong><span>{messages.length} shown · {state.query.trim() ? capabilities?.mode === "indexed" ? "ranked by relevance" : "metadata · mailbox order" : "stored mail"} · ↓ to browse</span></header><ol className="global-mail-result-list" onFocus={(event) => { lastResultFocus.current = (event.target as HTMLElement).closest("a")?.getAttribute("href") ?? lastResultFocus.current; }} onKeyDown={moveResultFocus} ref={resultListRef}>{messages.map((message) => <li key={`${message.accountId}:${message.id}`}><a href={mailSearchReaderUrl(message)} onClick={(event) => {
        event.preventDefault();
        const context: SearchReturnContext = { url: locationPath(window.location), draft, scrollTop: resultRegionRef.current?.scrollTop ?? 0,
          loaded: messages.length, focusHref: mailSearchReaderUrl(message) };
        try { window.sessionStorage.setItem(searchReturnKey, JSON.stringify(context)); } catch { /* Query and scope remain in the URL. */ }
        openMailSearchResult(message);
      }}><span className="global-mail-result-sender">{message.from.name ?? message.from.email}</span><time dateTime={message.receivedAt}>{searchResultDate(message.receivedAt)}</time><strong>{message.subject || "(no subject)"}</strong><span className="global-mail-result-snippet">{message.snippet || "No preview available."}</span><small>{evidenceLabel(message)}</small></a></li>)}</ol></> : null}
      {status === "ready" && nextCursor ? <div className="global-mail-search-continuation">{continuation === "scan" ? <p>More of the index remains to be checked in this scope.</p> : null}<button className="global-mail-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? "Loading more…" : "Load more"}</button></div> : null}
      {status === "ready" && error ? <p className="global-mail-search-inline-error" role="alert">{error}</p> : null}
    </section>
  </TopLayer>{authoring ? <TopLayer ariaLabelledBy="views-title" as="section" backdropAccessible={false} backdropClassName="selected-view-authoring-backdrop" className="selected-view-authoring search-view-authoring" layerClassName="selected-view-authoring-layer" onClose={() => authoringDismissRef.current?.()} returnFocusRef={saveButtonRef}>
    <p className="search-view-transition">Previewing conversations for this View. Search message order and counts may differ. Your original search stays unchanged.</p>
    <OrganizationViewAuthoringWorkspace entry={authoring} demoMode={isDemoSearch()} dismissRef={authoringDismissRef} compact
      clauseReplacements={authoring.preparation.kind === "typed_definition" && state.query.trim() ? [{ clauseId: "search.query", label: `Replace with subject contains “${state.query.trim()}”`, replace: (definition) => ({ ...definition, thread: { ...definition.thread, subjectContains: state.query.trim() } }) }] : []}
      onCancel={returnFromAuthoring} onCommitted={(result, context) => {
        try { window.sessionStorage.setItem(searchReturnKey, JSON.stringify(context)); } catch { /* Back still restores the Search URL if storage is unavailable. */ }
        window.location.assign(result.navigation.href);
      }}/>
  </TopLayer> : null}</>;
}

export function stripMailSearchParams(url: URL) {
  for (const key of searchKeys) url.searchParams.delete(key);
  return url;
}
