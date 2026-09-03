export const ORCA_SURFACE_HISTORY_KEY = "__orcaSurfaceHistoryV1";

export type SurfaceReturnTarget =
  | { kind: "message"; id: string }
  | { kind: "agent-event"; id: string };

export type SurfaceReturnContext = {
  workspaceX: number;
  workspaceY: number;
  target: SurfaceReturnTarget | null;
};

export type SurfaceLocation = {
  destination: string;
  query: string;
  reader: { threadId: string; accountId: string | null } | null;
  composer: { draftId: string | null; zen: boolean } | null;
};

type OrcaSurfaceHistoryMetadata = {
  version: 1;
  signature: string;
  canDismiss: boolean;
  returnContext: SurfaceReturnContext | null;
};

type SurfaceHistoryWindow = Pick<Window, "history" | "location">;

const THREAD_PATH = /^\/accounts\/([^/]+)\/threads\/([^/]+)$/;
const SURFACE_PARAMETERS = ["thread", "accountId", "compose", "draft", "zen"] as const;

function decodeThreadPath(pathname: string) {
  const match = pathname.match(THREAD_PATH);
  if (!match) return null;
  try {
    return { accountId: decodeURIComponent(match[1]!), threadId: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

export function readInitialThreadSelection(location: { pathname: string; search: string }) {
  const query = new URLSearchParams(location.search);
  const queryThreadId = query.get("thread");
  const queryAccountId = query.get("accountId");
  if (queryThreadId || queryAccountId) return { threadId: queryThreadId, accountId: queryAccountId };
  return decodeThreadPath(location.pathname) ?? { threadId: null, accountId: null };
}

export function readSurfaceLocation(location: { pathname: string; search: string }): SurfaceLocation {
  const params = new URLSearchParams(location.search);
  const selection = readInitialThreadSelection(location);
  const compose = params.get("compose") === "1";
  return {
    destination: params.get("destination") ?? "inbox",
    query: params.get("q") ?? "",
    reader: selection.threadId ? { threadId: selection.threadId, accountId: selection.accountId } : null,
    composer: compose ? { draftId: params.get("draft"), zen: params.get("zen") === "1" } : null,
  };
}

export function surfaceLocationSignature(location: SurfaceLocation) {
  return JSON.stringify({
    destination: location.destination,
    query: location.query,
    reader: location.reader,
    composer: location.composer,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readSurfaceHistoryMetadata(state: unknown): OrcaSurfaceHistoryMetadata | null {
  if (!isRecord(state)) return null;
  const value = state[ORCA_SURFACE_HISTORY_KEY];
  if (!isRecord(value) || value.version !== 1 || typeof value.signature !== "string" || typeof value.canDismiss !== "boolean") return null;
  const context = value.returnContext;
  const returnContext = isRecord(context)
    && typeof context.workspaceX === "number"
    && typeof context.workspaceY === "number"
    ? {
        workspaceX: context.workspaceX,
        workspaceY: context.workspaceY,
        target: isRecord(context.target)
          && (context.target.kind === "message" || context.target.kind === "agent-event")
          && typeof context.target.id === "string"
          ? { kind: context.target.kind, id: context.target.id }
          : null,
      } satisfies SurfaceReturnContext
    : null;
  return { version: 1, signature: value.signature, canDismiss: value.canDismiss, returnContext };
}

function historyStateWithMetadata(
  existing: unknown,
  location: SurfaceLocation,
  canDismiss: boolean,
  returnContext: SurfaceReturnContext | null,
) {
  return {
    ...(isRecord(existing) ? existing : {}),
    [ORCA_SURFACE_HISTORY_KEY]: {
      version: 1,
      signature: surfaceLocationSignature(location),
      canDismiss,
      returnContext,
    } satisfies OrcaSurfaceHistoryMetadata,
  };
}

function relativeUrl(url: URL) {
  return `${url.pathname}${url.search}${url.hash}`;
}

function clearSurfaceParameters(url: URL) {
  for (const parameter of SURFACE_PARAMETERS) url.searchParams.delete(parameter);
  if (THREAD_PATH.test(url.pathname)) url.pathname = "/";
  return url;
}

function hasSurface(location: SurfaceLocation) {
  return Boolean(location.reader || location.composer);
}

export type SurfaceDismissResult =
  | { mode: "back"; location: null }
  | { mode: "replace"; location: SurfaceLocation };

export class SurfaceHistory {
  readonly browser: SurfaceHistoryWindow;
  private readerReturnContext: SurfaceReturnContext | null = null;
  private readerReturnTarget: SurfaceReturnTarget | null = null;

  constructor(browser: SurfaceHistoryWindow) {
    this.browser = browser;
  }

  read() {
    return readSurfaceLocation(this.browser.location);
  }

  metadata() {
    return readSurfaceHistoryMetadata(this.browser.history.state);
  }

  initialize(options: { defaultComposerZen?: boolean } = {}) {
    this.browser.history.scrollRestoration = "manual";
    const visibleUrl = new URL(this.browser.location.href);
    if (options.defaultComposerZen && readSurfaceLocation(visibleUrl).composer && visibleUrl.searchParams.get("zen") !== "1") {
      visibleUrl.searchParams.set("zen", "1");
    }
    const current = readSurfaceLocation(visibleUrl);
    const metadata = this.metadata();
    const signature = surfaceLocationSignature(current);
    if (metadata?.signature === signature
      && !metadata.returnContext
      && relativeUrl(visibleUrl) === relativeUrl(new URL(this.browser.location.href))) return current;

    if (!hasSurface(current)) {
      this.browser.history.replaceState(
        historyStateWithMetadata(this.browser.history.state, current, false, null),
        "",
        relativeUrl(visibleUrl),
      );
      return current;
    }

    const baseUrl = clearSurfaceParameters(new URL(visibleUrl));
    const baseLocation = readSurfaceLocation(baseUrl);
    this.browser.history.replaceState(
      historyStateWithMetadata(this.browser.history.state, baseLocation, false, null),
      "",
      relativeUrl(baseUrl),
    );
    if (current.reader && current.composer) {
      const readerUrl = new URL(visibleUrl);
      readerUrl.searchParams.delete("compose");
      readerUrl.searchParams.delete("draft");
      readerUrl.searchParams.delete("zen");
      const readerLocation = readSurfaceLocation(readerUrl);
      this.browser.history.pushState(
        historyStateWithMetadata({}, readerLocation, true, null),
        "",
        relativeUrl(readerUrl),
      );
    }
    if (current.composer?.zen) {
      const composerUrl = new URL(visibleUrl);
      composerUrl.searchParams.delete("zen");
      const composerLocation = readSurfaceLocation(composerUrl);
      this.browser.history.pushState(
        historyStateWithMetadata({}, composerLocation, true, null),
        "",
        relativeUrl(composerUrl),
      );
    }
    this.browser.history.pushState(historyStateWithMetadata({}, current, true, null), "", relativeUrl(visibleUrl));
    return current;
  }

  consumeReturnContext() {
    const returnContext = this.readerReturnContext;
    this.readerReturnContext = null;
    return returnContext;
  }

  armReturnContext(returnContext: SurfaceReturnContext) {
    this.readerReturnContext = returnContext;
    this.readerReturnTarget = returnContext.target;
  }

  lastReturnTarget() {
    return this.readerReturnTarget;
  }

  openReader(reader: { threadId: string; accountId: string | null }, returnContext: SurfaceReturnContext) {
    this.armReturnContext(returnContext);
    const url = clearSurfaceParameters(new URL(this.browser.location.href));
    url.searchParams.set("thread", reader.threadId);
    if (reader.accountId) url.searchParams.set("accountId", reader.accountId);
    this.push(url, null);
  }

  openComposer(composer: { draftId: string | null; zen: boolean }) {
    const url = new URL(this.browser.location.href);
    url.searchParams.set("compose", "1");
    if (composer.draftId) url.searchParams.set("draft", composer.draftId);
    else url.searchParams.delete("draft");
    url.searchParams.delete("zen");
    this.push(url, null);
    if (composer.zen) {
      url.searchParams.set("zen", "1");
      this.push(url, null);
    }
  }

  openZen() {
    const url = new URL(this.browser.location.href);
    url.searchParams.set("compose", "1");
    url.searchParams.set("zen", "1");
    this.push(url, null);
  }

  navigate(destination: string) {
    const url = clearSurfaceParameters(new URL(this.browser.location.href));
    url.searchParams.set("destination", destination);
    this.push(url, null);
    return this.read();
  }

  replaceDestination(destination: string) {
    const url = clearSurfaceParameters(new URL(this.browser.location.href));
    url.searchParams.set("destination", destination);
    const next = readSurfaceLocation(url);
    this.browser.history.replaceState(
      historyStateWithMetadata(this.browser.history.state, next, false, null),
      "",
      relativeUrl(url),
    );
    return next;
  }

  replaceQuery(query: string) {
    const url = new URL(this.browser.location.href);
    if (query) url.searchParams.set("q", query);
    else url.searchParams.delete("q");
    const next = readSurfaceLocation(url);
    const metadata = this.metadata();
    this.browser.history.replaceState(
      historyStateWithMetadata(
        this.browser.history.state,
        next,
        metadata?.canDismiss ?? false,
        null,
      ),
      "",
      relativeUrl(url),
    );
    return next;
  }

  dismiss(surface: "zen" | "composer" | "reader"): SurfaceDismissResult {
    const current = this.read();
    const metadata = this.metadata();
    const surfaceIsActive = surface === "zen"
      ? Boolean(current.composer?.zen)
      : surface === "composer"
        ? Boolean(current.composer)
        : Boolean(current.reader);
    if (!surfaceIsActive) return { mode: "replace", location: current };
    const url = new URL(this.browser.location.href);
    if (surface === "zen") url.searchParams.delete("zen");
    if (surface === "composer") {
      url.searchParams.delete("compose");
      url.searchParams.delete("draft");
      url.searchParams.delete("zen");
    }
    if (surface === "reader") {
      url.searchParams.delete("thread");
      url.searchParams.delete("accountId");
      if (THREAD_PATH.test(url.pathname)) url.pathname = "/";
    }

    if (metadata?.canDismiss) {
      if (surface === "composer" && current.composer?.zen) this.browser.history.go(-2);
      else this.browser.history.back();
      return { mode: "back", location: null };
    }

    const next = readSurfaceLocation(url);
    this.browser.history.replaceState(
      historyStateWithMetadata(this.browser.history.state, next, false, null),
      "",
      relativeUrl(url),
    );
    return { mode: "replace", location: next };
  }

  private push(url: URL, returnContext: SurfaceReturnContext | null) {
    const next = readSurfaceLocation(url);
    if (surfaceLocationSignature(next) === surfaceLocationSignature(this.read())) return;
    this.browser.history.pushState(
      historyStateWithMetadata({}, next, true, returnContext),
      "",
      relativeUrl(url),
    );
  }
}

export function getDesktopWorkspace(root: ParentNode = document) {
  return root.querySelector<HTMLElement>(".desktop-workspace");
}

export function captureSurfaceReturnContext(target: SurfaceReturnTarget | null, root: ParentNode = document): SurfaceReturnContext {
  const workspace = getDesktopWorkspace(root);
  return {
    workspaceX: workspace?.scrollLeft ?? 0,
    workspaceY: workspace?.scrollTop ?? 0,
    target,
  };
}

export function canRestoreSurfaceFocus(
  element: HTMLElement | null | undefined,
  getStyle: (target: Element) => CSSStyleDeclaration = (target) => window.getComputedStyle(target),
) {
  if (!element || !element.isConnected || element.matches(":disabled, [aria-disabled=true]") || element.closest("[inert], [aria-hidden=true]")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return false;
    const style = getStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

export function restoreWorkspaceScroll(context: SurfaceReturnContext, root: ParentNode = document) {
  const workspace = getDesktopWorkspace(root);
  if (!workspace) return false;
  workspace.scrollLeft = context.workspaceX;
  workspace.scrollTop = context.workspaceY;
  return true;
}
