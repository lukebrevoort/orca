import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { organizationDescribeResponseSchema, type OrganizationDescribeResponse } from "@orca/shared";

export type OrganizationAuthorityKind = "loading" | "ready" | "offline" | "session_expired" | "no_access" | "partial" | "empty" | "error";
export type OrganizationOperation = "read" | "mutation";
export type OrganizationCapability = "query" | "simulate" | "apply" | "revert" | "correct";
export type OrganizationCapabilities = Record<OrganizationCapability, boolean>;

export type OrganizationAuthorityState = {
  kind: OrganizationAuthorityKind;
  canRead: boolean;
  canMutate: boolean;
  hasReliableData: boolean;
  title: string;
  detail: string;
  safe: string;
  action: "none" | "retry" | "reconnect" | "ask_owner" | "connect_account";
  actionLabel: string | null;
};

type OrganizationRequestOptions = {
  operation?: OrganizationOperation;
  capability?: OrganizationCapability;
  hasReliableData?: boolean;
};

type OrganizationAuthorityValue = {
  state: OrganizationAuthorityState;
  snapshot: OrganizationDescribeResponse | null;
  allows: OrganizationCapabilities;
  refreshToken: number;
  retry: () => void;
  response: (path: string, init?: RequestInit, options?: OrganizationRequestOptions) => Promise<Response>;
  request: (path: string, init?: RequestInit, options?: OrganizationRequestOptions) => Promise<unknown>;
};

const copy: Record<OrganizationAuthorityKind, Omit<OrganizationAuthorityState, "kind" | "hasReliableData">> = {
  loading: {
    canRead: true,
    canMutate: false,
    title: "Checking Organization authority",
    detail: "Orca is confirming the current Workspace revision, account scope, and mutation capability.",
    safe: "The Organization layout stays stable while authority is checked.",
    action: "none",
    actionLabel: null,
  },
  ready: {
    canRead: true,
    canMutate: true,
    title: "Organization is current",
    detail: "Current Workspace authority is available.",
    safe: "Reads and explicitly reviewed Organization changes are available.",
    action: "none",
    actionLabel: null,
  },
  offline: {
    canRead: true,
    canMutate: false,
    title: "Offline — Organization is read-only",
    detail: "Orca cannot confirm current revisions or mutation authority while this device is offline.",
    safe: "Last-known Views, Lanes, rules, and Trace evidence stay visible. No Organization change can run.",
    action: "retry",
    actionLabel: "Retry connection",
  },
  session_expired: {
    canRead: true,
    canMutate: false,
    title: "Session expired",
    detail: "Orca must reconnect your session before it can read current Organization evidence or authorize a change.",
    safe: "Last-known reliable Organization content stays visible. No mutation request will be sent.",
    action: "reconnect",
    actionLabel: "Reconnect session",
  },
  no_access: {
    canRead: true,
    canMutate: false,
    title: "Organization access is read-only",
    detail: "Your current Workspace authority does not include Organization control.",
    safe: "Reliable rules, Views, Lanes, and Trace evidence remain available to inspect. No mutation request will be sent.",
    action: "ask_owner",
    actionLabel: "Ask a Workspace owner",
  },
  partial: {
    canRead: true,
    canMutate: false,
    title: "Some Organization evidence is unavailable",
    detail: "One part of Organization could not be refreshed, so Orca cannot prove that every displayed revision is current.",
    safe: "Verified content remains visible and labeled. Changes stay paused until the missing portion is refreshed.",
    action: "retry",
    actionLabel: "Retry Organization",
  },
  empty: {
    canRead: true,
    canMutate: false,
    title: "No connected account scope",
    detail: "Organization has no connected mail account to describe, simulate, or change.",
    safe: "Nothing was removed or changed. Existing local mail and drafts remain available.",
    action: "connect_account",
    actionLabel: "Connect an account",
  },
  error: {
    canRead: false,
    canMutate: false,
    title: "Organization could not be reached",
    detail: "The server did not return a trustworthy Organization snapshot.",
    safe: "No causal claim or Organization change is shown as current, and no mutation request will be sent.",
    action: "retry",
    actionLabel: "Retry Organization",
  },
};

export function organizationAuthorityState(kind: OrganizationAuthorityKind, options: { detail?: string; hasReliableData?: boolean } = {}): OrganizationAuthorityState {
  return {
    kind,
    ...copy[kind],
    hasReliableData: options.hasReliableData ?? false,
    detail: options.detail ?? copy[kind].detail,
  };
}

export class OrganizationAuthorityError extends Error {
  constructor(readonly kind: Exclude<OrganizationAuthorityKind, "loading" | "ready" | "empty">, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "OrganizationAuthorityError";
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || !("error" in value)) return fallback;
  const error = value.error;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

export function classifyOrganizationFailure(input: { status?: number; offline?: boolean; hasReliableData?: boolean; detail?: string }): OrganizationAuthorityState {
  const hasReliableData = input.hasReliableData ?? false;
  if (input.offline) return organizationAuthorityState("offline", { detail: input.detail, hasReliableData });
  if (input.status === 401) return organizationAuthorityState("session_expired", { detail: input.detail, hasReliableData });
  if (input.status === 403) return organizationAuthorityState("no_access", { detail: input.detail, hasReliableData });
  if (hasReliableData) return organizationAuthorityState("partial", { detail: input.detail, hasReliableData: true });
  return organizationAuthorityState("error", { detail: input.detail, hasReliableData: false });
}

export function authorityStateFromSnapshot(snapshot: OrganizationDescribeResponse): OrganizationAuthorityState {
  if (snapshot.accountIds.length === 0) return organizationAuthorityState("empty", { hasReliableData: true });
  const rest = snapshot.capabilities.surfaces.rest;
  if (!rest.describe || !rest.query || (!rest.apply && !rest.simulate && !rest.revert && !rest.correct)) {
    return organizationAuthorityState("no_access", { hasReliableData: true });
  }
  return {
    ...organizationAuthorityState("ready", { hasReliableData: true }),
    canMutate: rest.apply || rest.revert || rest.correct,
  };
}

const noCapabilities: OrganizationCapabilities = { query: false, simulate: false, apply: false, revert: false, correct: false };

const OrganizationAuthorityContext = createContext<OrganizationAuthorityValue | null>(null);

export function OrganizationAuthorityProvider({ children, previewMode = false }: { children: ReactNode; previewMode?: boolean }) {
  const [snapshot, setSnapshot] = useState<OrganizationDescribeResponse | null>(null);
  const [state, setState] = useState<OrganizationAuthorityState>(() => organizationAuthorityState(previewMode ? "ready" : "loading", { hasReliableData: previewMode }));
  const [probeToken, setProbeToken] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const stateRef = useRef(state);
  const snapshotRef = useRef(snapshot);
  const allows = useMemo<OrganizationCapabilities>(() => previewMode ? { query: true, simulate: true, apply: true, revert: true, correct: true } : snapshot ? {
    query: snapshot.capabilities.surfaces.rest.query,
    simulate: snapshot.capabilities.surfaces.rest.simulate,
    apply: snapshot.capabilities.surfaces.rest.apply,
    revert: snapshot.capabilities.surfaces.rest.revert,
    correct: snapshot.capabilities.surfaces.rest.correct,
  } : noCapabilities, [previewMode, snapshot]);
  const allowsRef = useRef(allows);
  stateRef.current = state;
  snapshotRef.current = snapshot;
  allowsRef.current = allows;

  const retry = useCallback(() => {
    if (previewMode) return;
    setState((current) => organizationAuthorityState("loading", { hasReliableData: current.hasReliableData }));
    setProbeToken((value) => value + 1);
  }, [previewMode]);

  const reportFailure = useCallback((failure: OrganizationAuthorityState) => {
    setState((current) => {
      if (failure.kind === "partial" && ["offline", "session_expired", "no_access"].includes(current.kind)) return current;
      return failure;
    });
  }, []);

  const authorityResponse = useCallback(async (path: string, init?: RequestInit, options: OrganizationRequestOptions = {}) => {
    const operation = options.operation ?? "read";
    const current = stateRef.current;
    const requiredCapability = options.capability;
    const mutationCapability = requiredCapability === "apply" || requiredCapability === "revert" || requiredCapability === "correct";
    if ((operation === "mutation" && (!mutationCapability || !current.canMutate)) || (requiredCapability && !allowsRef.current[requiredCapability])) {
      throw new OrganizationAuthorityError(current.kind === "ready" || current.kind === "loading" || current.kind === "empty" ? "no_access" : current.kind, `Organization operation blocked while authority is ${current.kind.replaceAll("_", " ")}.`);
    }
    const hasReliableData = options.hasReliableData ?? current.hasReliableData ?? Boolean(snapshotRef.current);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const failure = classifyOrganizationFailure({ offline: true, hasReliableData });
      reportFailure(failure);
      throw new OrganizationAuthorityError("offline", failure.detail);
    }
    try {
      const response = await fetch(path, { credentials: "include", ...init });
      if (!response.ok) {
        const body = await response.clone().json().catch(() => null) as unknown;
        const detail = errorMessage(body, `Organization request failed (${response.status})`);
        const failure = classifyOrganizationFailure({ status: response.status, hasReliableData, detail });
        if (response.status === 401 || response.status === 403 || response.status >= 500) reportFailure(failure);
        throw new OrganizationAuthorityError(failure.kind === "partial" ? "partial" : failure.kind as OrganizationAuthorityError["kind"], detail, response.status);
      }
      if (response.status === 206) reportFailure(organizationAuthorityState("partial", { detail: "The server returned only part of the requested Organization evidence.", hasReliableData: true }));
      return response;
    } catch (reason) {
      if (reason instanceof OrganizationAuthorityError || (reason instanceof Error && reason.name === "AbortError")) throw reason;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false || reason instanceof TypeError && /fetch|network|load/i.test(reason.message);
      const failure = classifyOrganizationFailure({ offline, hasReliableData, detail: reason instanceof Error ? reason.message : "Organization request failed" });
      reportFailure(failure);
      throw new OrganizationAuthorityError(failure.kind === "partial" ? "partial" : failure.kind as OrganizationAuthorityError["kind"], failure.detail);
    }
  }, [reportFailure]);

  const request = useCallback(async (path: string, init?: RequestInit, options?: OrganizationRequestOptions) => {
    const response = await authorityResponse(path, init, options);
    return response.json().catch(() => null) as Promise<unknown>;
  }, [authorityResponse]);

  useEffect(() => {
    if (previewMode) return;
    const controller = new AbortController();
    const hasReliableData = Boolean(snapshotRef.current);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      reportFailure(classifyOrganizationFailure({ offline: true, hasReliableData }));
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/v1/organization/describe", { credentials: "include", signal: controller.signal });
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const detail = errorMessage(body, `Organization authority request failed (${response.status})`);
          reportFailure(classifyOrganizationFailure({ status: response.status, hasReliableData, detail }));
          return;
        }
        const parsed = organizationDescribeResponseSchema.parse(body);
        if (controller.signal.aborted) return;
        setSnapshot(parsed);
        setState(response.status === 206
          ? organizationAuthorityState("partial", { detail: "The server returned only part of the Organization authority snapshot.", hasReliableData: true })
          : authorityStateFromSnapshot(parsed));
        if (probeToken > 0) setRefreshToken((value) => value + 1);
      } catch (reason) {
        if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) return;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false || reason instanceof TypeError && /fetch|network|load/i.test(reason.message);
        reportFailure(classifyOrganizationFailure({ offline, hasReliableData, detail: reason instanceof Error ? reason.message : "Organization authority request failed" }));
      }
    })();
    return () => controller.abort();
  }, [previewMode, probeToken, reportFailure]);

  useEffect(() => {
    if (previewMode || typeof window === "undefined") return;
    const offline = () => reportFailure(classifyOrganizationFailure({ offline: true, hasReliableData: stateRef.current.hasReliableData }));
    const online = () => { if (stateRef.current.kind === "offline") retry(); };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); };
  }, [previewMode, reportFailure, retry]);

  const value = useMemo<OrganizationAuthorityValue>(() => ({ state, snapshot, allows, refreshToken, retry, response: authorityResponse, request }), [state, snapshot, allows, refreshToken, retry, authorityResponse, request]);
  return <OrganizationAuthorityContext.Provider value={value}>{children}</OrganizationAuthorityContext.Provider>;
}

export function useOrganizationAuthority() {
  const value = useContext(OrganizationAuthorityContext);
  if (!value) throw new Error("Organization surfaces must be rendered inside OrganizationAuthorityProvider");
  return value;
}

export function OrganizationRecoveryBanner() {
  const { state, retry } = useOrganizationAuthority();
  if (state.kind === "ready") return null;
  return <section aria-live="polite" className={`organization-recovery organization-recovery-${state.kind}`} data-organization-authority={state.kind} role={state.kind === "loading" ? "status" : "alert"}>
    <div><span>Organization authority</span><h2>{state.title}</h2><p>{state.detail}</p><p className="organization-recovery-safe"><strong>Safe now ·</strong> {state.safe}</p></div>
    {state.action === "retry" ? <button onClick={retry} type="button">{state.actionLabel}</button> : null}
    {state.action === "reconnect" ? <a href="/login?returnTo=%2F%3Fdestination%3Dorganization">{state.actionLabel}</a> : null}
    {state.action === "ask_owner" ? <a href="mailto:?subject=Request%20Orca%20Organization%20access">{state.actionLabel}</a> : null}
    {state.action === "connect_account" ? <a href="/settings/integrations/gmail">{state.actionLabel}</a> : null}
  </section>;
}
