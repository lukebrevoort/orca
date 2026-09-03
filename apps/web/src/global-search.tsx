import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  inboxClassificationResponseSchema,
  mailAccountPageSchema,
  organizationCollectionPinQueryResponseSchema,
  pinFilterSchema,
  type Collection,
  type InboxMessage,
  type MailAccount,
  type PinFilter,
} from "@orca/shared";

import { demoAccount, demoMessages } from "./demo-data";
import { parseDesktopDestination } from "./navigation";
import { readSurfaceLocation } from "./surface-history";
import { TopLayer } from "./top-layer";

export type MailSearchMailbox = "inbox" | "focus" | "quiet" | "hidden" | "all";
export type MailSearchEvidence = "human" | "tideline" | "uncertain" | "all";

export type MailSearchState = {
  query: string;
  mailbox: MailSearchMailbox;
  evidence: MailSearchEvidence;
  accountId: string | null;
  collectionId: string | null;
  source: string;
};

export const mailSearchLocationEvent = "orca:mail-search-location";
export const mailSearchResultEvent = "orca:mail-search-result";
export type MailSearchResultEventDetail = { url: string };
const searchResultReaderKey = "searchResultReader";
const searchKeys = ["search", "searchQuery", "searchMailbox", "searchEvidence", "searchAccount", "searchSpace", "searchSource", searchResultReaderKey] as const;
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
  return Boolean(state.query.trim() || state.mailbox !== "all" || state.evidence !== "all" || state.accountId || state.collectionId);
}

export function mailSearchRequest(state: MailSearchState, cursor?: string | null) {
  const params = new URLSearchParams({ limit: "100", classification: state.evidence });
  if (state.mailbox !== "inbox") params.set("view", state.mailbox);
  if (state.query.trim()) params.set("query", state.query.trim());
  if (state.accountId) params.set("accountId", state.accountId);
  if (state.collectionId) params.set("collectionId", state.collectionId);
  if (cursor) params.set("cursor", cursor);
  return `/v1/inbox?${params}`;
}

export function mailSearchPinFilter(state: MailSearchState): PinFilter {
  return pinFilterSchema.parse({
    mailbox: state.mailbox,
    attention: "all",
    classification: state.evidence,
    person: null,
    query: state.query,
    accountId: state.accountId,
    collectionId: state.collectionId,
    dataSource: "stored_mail",
  });
}

export function openMailSearchFilter(filter: PinFilter) {
  const source = locationPath(window.location);
  const state: MailSearchState = {
    query: filter.query,
    mailbox: filter.mailbox,
    evidence: filter.classification ?? "all",
    accountId: filter.accountId ?? null,
    collectionId: filter.collectionId ?? null,
    source,
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

async function readJson(response: Response) {
  const value = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new Error(searchError(value));
  return value;
}

function evidenceLabel(message: InboxMessage) {
  const classification = message.humanClassification?.effective.classification;
  if (classification === "likely_human") return "Likely human";
  if (classification === "automated_or_bulk") return "Automated or bulk";
  return "Needs review";
}

function scopeLabel(state: MailSearchState, accounts: MailAccount[], collections: Collection[]) {
  const mailbox = state.mailbox === "all" ? "All mail" : state.mailbox.charAt(0).toUpperCase() + state.mailbox.slice(1);
  const evidence = state.evidence === "all" ? "Any evidence" : state.evidence === "human" ? "Likely human evidence" : state.evidence === "tideline" ? "Automated or bulk evidence" : "Needs review";
  const account = accounts.find((item) => item.id === state.accountId)?.email ?? state.accountId ?? undefined;
  const collection = collections.find((item) => item.id === state.collectionId)?.name ?? state.collectionId ?? undefined;
  return [mailbox, evidence, account, collection].filter(Boolean).join(" · ");
}

function savedSearchLabel(state: MailSearchState, scope: string) {
  const query = state.query.trim();
  return (query ? `Search · ${query}` : scope).slice(0, 120);
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
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "confirm-zero" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const requestGenerationRef = useRef(0);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const saveGenerationRef = useRef(0);
  const saveControllerRef = useRef<AbortController | null>(null);

  function invalidateSave() {
    saveGenerationRef.current += 1;
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
    setSaveStatus("idle");
    setSaveMessage("");
  }

  useEffect(() => {
    const synchronize = () => {
      invalidateSave();
      const next = readMailSearchState(window.location);
      setState(next);
      if (next) setDraft(next.query);
    };
    window.addEventListener("popstate", synchronize);
    window.addEventListener(mailSearchLocationEvent, synchronize);
    return () => {
      window.removeEventListener("popstate", synchronize);
      window.removeEventListener(mailSearchLocationEvent, synchronize);
    };
  }, []);

  useEffect(() => () => {
    saveGenerationRef.current += 1;
    saveControllerRef.current?.abort();
    saveControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!state || isDemoSearch()) return;
    const controller = new AbortController();
    void Promise.all([
      fetch("/v1/accounts", { credentials: "include", signal: controller.signal }).then(readJson).then((value) => mailAccountPageSchema.parse(value).items),
      fetch("/v1/organization/collections-pins/query", { credentials: "include", signal: controller.signal }).then(readJson).then((value) => organizationCollectionPinQueryResponseSchema.parse(value).collections),
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
      setError(null);
      return;
    }
    setSaveStatus("idle");
    setSaveMessage("");
    setStatus("loading");
    setMessages([]);
    setNextCursor(null);
    setError(null);
    if (isDemoSearch()) {
      const matches = demoMessages.filter((message) => matchesDemoSearch(message, state));
      setMessages(matches);
      setAccounts([demoAccount]);
      setStatus("ready");
      return;
    }
    const controller = new AbortController();
    void fetch(mailSearchRequest(state), { credentials: "include", signal: controller.signal })
      .then(readJson)
      .then((value) => inboxClassificationResponseSchema.parse(value))
      .then((result) => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
        setAccounts(result.accounts);
        setMessages(result.messages);
        setNextCursor(result.nextCursor);
        setStatus("ready");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "Search could not be completed.");
      });
    return () => controller.abort();
  }, [state, retryKey]);

  const scope = useMemo(() => state ? scopeLabel(state, accounts, collections) : "All mail", [accounts, collections, state]);
  if (!state) return null;
  const selectedAccountMissing = Boolean(state.accountId && !accounts.some((item) => item.id === state.accountId));
  const selectedCollectionMissing = Boolean(state.collectionId && !collections.some((item) => item.id === state.collectionId));

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

  async function loadMore() {
    if (!state || !nextCursor || loadingMore || isDemoSearch()) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);
    setError(null);
    try {
      const result = inboxClassificationResponseSchema.parse(await readJson(await fetch(mailSearchRequest(state, nextCursor), { credentials: "include", signal: controller.signal })));
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setMessages((current) => [...current, ...result.messages.filter((message) => !current.some((item) => item.id === message.id && item.accountId === message.accountId))]);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
      setError(caught instanceof Error ? caught.message : "More results could not be loaded.");
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  async function saveSearch() {
    const activeState = state;
    if (!activeState || !hasMailSearchConstraint(activeState) || status !== "ready" || saveStatus === "saving") return;
    if (messages.length === 0 && saveStatus !== "confirm-zero") {
      setSaveStatus("confirm-zero");
      setSaveMessage("This exact scope currently has zero matches. Saving it will keep watching for future mail.");
      return;
    }
    setSaveStatus("saving");
    setSaveMessage("");
    const label = savedSearchLabel(activeState, scope);
    const generation = ++saveGenerationRef.current;
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;
    try {
      if (!isDemoSearch()) {
        const response = await fetch("/v1/pins", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ kind: "filter", targetId: JSON.stringify(mailSearchPinFilter(activeState)), label, icon: "search", color: "#70867d" }),
        });
        await readJson(response);
      }
      if (controller.signal.aborted || generation !== saveGenerationRef.current) return;
      setSaveStatus("saved");
      setSaveMessage(`Saved “${label}” with this exact account, space, mailbox, and evidence scope.`);
    } catch (caught) {
      if (controller.signal.aborted || generation !== saveGenerationRef.current) return;
      setSaveStatus("error");
      setSaveMessage(caught instanceof Error ? caught.message : "This search could not be saved.");
    } finally {
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
    }
  }

  return <TopLayer
    ariaBusy={status === "loading"}
    ariaLabelledBy="global-mail-search-title"
    as="section"
    backdropAriaLabel="Close Search mail"
    backdropClassName="global-mail-search-backdrop"
    className="global-mail-search"
    initialFocusRef={inputRef}
    layerClassName="global-mail-search-layer"
    onClose={close}
    returnFocusRef={returnFocusRef}
  >
    <header className="global-mail-search-heading">
      <div><p>Across stored messages</p><h1 id="global-mail-search-title">Search mail</h1><span>Searches synced mail beyond the rows currently loaded on screen.</span></div>
      <button aria-label="Close Search mail" onClick={close} type="button">×</button>
    </header>
    <form className="global-mail-search-form" onSubmit={(event) => { event.preventDefault(); commit({ ...state, query: draft }); }} role="search">
      <label><span aria-hidden="true">⌕</span><input aria-label="Search stored mail" autoComplete="off" maxLength={200} onChange={(event) => setDraft(event.target.value)} placeholder="Sender, subject, or phrase" ref={inputRef} value={draft}/><kbd>Enter</kbd></label>
      <button type="submit">Search</button>
    </form>
    <div aria-label="Search scope" className="global-mail-search-filters" role="group">
      <label><span>Mailbox</span><select onChange={(event) => commit({ ...state, mailbox: event.target.value as MailSearchMailbox })} value={state.mailbox}><option value="all">All mail</option><option value="inbox">Inbox</option><option value="focus">Focus</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></label>
      <label><span>Evidence</span><select onChange={(event) => commit({ ...state, evidence: event.target.value as MailSearchEvidence })} value={state.evidence}><option value="all">Any evidence</option><option value="human">Likely human</option><option value="tideline">Automated or bulk</option><option value="uncertain">Needs review</option></select></label>
      <label><span>Account</span><select onChange={(event) => commit({ ...state, accountId: event.target.value || null, collectionId: state.collectionId && collections.find((item) => item.id === state.collectionId)?.accountId !== event.target.value ? null : state.collectionId })} value={state.accountId ?? ""}><option value="">Every connected account</option>{selectedAccountMissing ? <option value={state.accountId!}>{state.accountId}</option> : null}{accounts.map((item) => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label>
      <label><span>Space</span><select onChange={(event) => { const collectionId = event.target.value || null; const selected = collections.find((item) => item.id === collectionId); commit({ ...state, collectionId, accountId: selected?.accountId ?? state.accountId }); }} value={state.collectionId ?? ""}><option value="">Every space</option>{selectedCollectionMissing ? <option value={state.collectionId!}>{state.collectionId}</option> : null}{collections.filter((item) => !state.accountId || item.accountId === state.accountId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    <div className="global-mail-search-scope"><span>Active scope</span><strong>{scope}</strong></div>
    <section aria-live="polite" className="global-mail-search-results">
      {status === "idle" ? <div className="global-mail-search-state"><p>Ready when you are</p><h2>Type a query or choose a narrower scope.</h2><span>Your source route is safe. Escape returns without changing it.</span></div> : null}
      {status === "loading" ? <div className="global-mail-search-state"><p>Searching stored mail</p><h2>Looking beyond this screen…</h2><span>Your query and filters remain visible.</span></div> : null}
      {status === "error" ? <div className="global-mail-search-state global-mail-search-error" role="alert"><p>Search unavailable</p><h2>Nothing about your scope was lost.</h2><span>{error}</span><button onClick={() => setRetryKey((key) => key + 1)} type="button">Try again</button></div> : null}
      {status === "ready" && messages.length === 0 ? <div className="global-mail-search-state"><p>No exact matches</p><h2>Nothing found in this scope.</h2><span>Keep this zero-match search, or remove one constraint and try again.</span><button onClick={() => commit({ ...state, mailbox: "all", evidence: "all", accountId: null, collectionId: null })} type="button">Search all mail</button></div> : null}
      {status === "ready" && messages.length > 0 ? <><header className="global-mail-result-count"><strong>{messages.length}{nextCursor ? "+" : ""} matching {messages.length === 1 && !nextCursor ? "message" : "messages"}</strong><span>{scope}</span></header><ol className="global-mail-result-list">{messages.map((message) => <li key={`${message.accountId}:${message.id}`}><a href={mailSearchReaderUrl(message)} onClick={(event) => { event.preventDefault(); openMailSearchResult(message); }}><span className="global-mail-result-sender">{message.from.name ?? message.from.email}</span><strong>{message.subject || "(no subject)"}</strong><span>{message.snippet || "No preview available."}</span><small><b>{evidenceLabel(message)}</b><time dateTime={message.receivedAt}>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(message.receivedAt))}</time></small></a></li>)}</ol>{nextCursor ? <button className="global-mail-load-more" disabled={loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? "Loading more…" : "Load more matches"}</button> : null}</> : null}
      {status === "ready" && error ? <p className="global-mail-search-inline-error" role="alert">{error}</p> : null}
    </section>
    <footer className="global-mail-search-actions">
      <div aria-live="polite">{saveMessage || "Saved searches keep this exact scope, including zero matches."}</div>
      <button onClick={close} type="button">Return to source</button>
      <button className="global-mail-save" disabled={!hasMailSearchConstraint(state) || status !== "ready" || saveStatus === "saving" || saveStatus === "saved"} onClick={() => void saveSearch()} type="button">{saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : saveStatus === "confirm-zero" ? "Save zero-match search" : "Save this search"}</button>
    </footer>
  </TopLayer>;
}

export function stripMailSearchParams(url: URL) {
  for (const key of searchKeys) url.searchParams.delete(key);
  return url;
}
