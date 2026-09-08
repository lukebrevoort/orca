import { useSyncExternalStore, type ReactNode } from "react";
import type { Collection, OrganizationView } from "@orca/shared";

export type DesktopDestination = "inbox" | "drafts" | "focus" | "signals" | "quiet" | "later" | "all" | "organization" | "settings" | `space:${string}` | `view:${string}`;

export type WorkflowSpace = {
  id: string;
  label: string;
  description: string;
  count?: number;
  color?: string;
  custom?: boolean;
  kind?: "built_in" | "collection" | "view";
  hidden?: boolean;
};

export type SidebarAccount = {
  displayName: string;
  email: string;
  accountCount: number;
  health: "synced" | "syncing" | "offline" | "attention" | "unknown";
  detail?: string;
  avatar?: ReactNode;
};

export type StoredSpacePreferences = {
  revision: 1;
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
};

export type SidebarNavigationProjection = {
  account: SidebarAccount;
  active: DesktopDestination;
  draftCount?: number;
  inboxCount?: number;
  online: boolean;
  spaces: WorkflowSpace[];
};

type BuiltInSpaceId = "focus" | "signals" | "quiet" | "later";

const builtInSpaceIds: BuiltInSpaceId[] = ["focus", "signals", "quiet", "later"];
const rootDestinations = new Set<DesktopDestination>(["inbox", "drafts", "focus", "signals", "quiet", "later", "all", "organization"]);

const builtInSpaces: Record<BuiltInSpaceId, Omit<WorkflowSpace, "count" | "hidden">> = {
  focus: { id: "focus", label: "Focus", description: "protected attention" },
  signals: { id: "signals", label: "Signals", description: "important changes" },
  quiet: { id: "quiet", label: "Quiet", description: "low interruption" },
  later: { id: "later", label: "Later", description: "held intentionally" },
};

export function spacePreferencesKey(accountId: string) {
  return `orca:space-preferences:v1:${accountId}`;
}

export function readSpacePreferences(accountId: string, storage?: Pick<Storage, "getItem">): StoredSpacePreferences | null {
  const source = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!source) return null;
  try {
    const value = JSON.parse(source.getItem(spacePreferencesKey(accountId)) ?? "null") as Partial<StoredSpacePreferences> | null;
    if (!value || value.revision !== 1 || !Array.isArray(value.order) || !Array.isArray(value.hidden) || !value.labels || typeof value.labels !== "object") return null;
    return {
      revision: 1,
      order: value.order.filter((id): id is string => typeof id === "string"),
      hidden: value.hidden.filter((id): id is string => typeof id === "string"),
      labels: Object.fromEntries(Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    };
  } catch {
    return null;
  }
}

export function writeSpacePreferences(accountId: string, preferences: StoredSpacePreferences, storage?: Pick<Storage, "setItem">) {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  target?.setItem(spacePreferencesKey(accountId), JSON.stringify(preferences));
}

export function parseDesktopDestination(value: string | null | undefined): DesktopDestination | null {
  if (!value) return null;
  if (rootDestinations.has(value as DesktopDestination)) return value as DesktopDestination;
  if (value === "settings") return "settings";
  if (value.startsWith("space:") && value.slice("space:".length).trim()) return value as `space:${string}`;
  if (value.startsWith("view:") && value.slice("view:".length).trim()) return value as `view:${string}`;
  return null;
}

export function desktopDestinationFromLocation(location: Pick<Location, "pathname" | "search">): DesktopDestination {
  if (location.pathname === "/settings" || location.pathname.startsWith("/settings/") || location.pathname === "/dev/settings") return "settings";
  return parseDesktopDestination(new URLSearchParams(location.search).get("destination")) ?? "inbox";
}

export function desktopDestinationHref(destination: DesktopDestination, sourcePathname = "/") {
  if (destination === "settings") return "/settings";
  const rootPath = sourcePathname.startsWith("/dev/") ? "/dev/inbox" : "/";
  return `${rootPath}?destination=${encodeURIComponent(destination)}`;
}

export function desktopDestinationUrl(currentHref: string, destination: Exclude<DesktopDestination, "settings">) {
  const url = new URL(currentHref, "http://orca.local");
  url.pathname = url.pathname === "/dev/inbox" ? "/dev/inbox" : "/";
  url.searchParams.set("destination", destination);
  url.searchParams.delete("thread");
  url.searchParams.delete("accountId");
  url.searchParams.delete("compose");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function destinationForSpace(space: Pick<WorkflowSpace, "custom" | "id" | "kind">): DesktopDestination {
  if (space.kind === "view") return `view:${space.id}`;
  return space.custom ? `space:${space.id}` : parseDesktopDestination(space.id) ?? "inbox";
}

export function projectWorkflowSpaces({ collections, views = [], counts = {}, hidden = [], labels = {}, order = builtInSpaceIds }: {
  collections: readonly Collection[];
  views?: readonly OrganizationView[];
  counts?: Partial<Record<BuiltInSpaceId, number>>;
  hidden?: readonly string[];
  labels?: Readonly<Record<string, string>>;
  order?: readonly string[];
}) {
  const customSpaces = new Map(collections
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((collection) => [collection.id, {
      id: collection.id,
      label: labels[collection.id] ?? collection.name,
      description: "custom collection",
      count: collection.threadIds.length,
      color: collection.color,
      custom: true,
      kind: "collection" as const,
    } satisfies WorkflowSpace]));
  const knownIds = new Set([...builtInSpaceIds, ...customSpaces.keys()]);
  const canonicalOrder = [...new Set(order.filter((id) => knownIds.has(id)))];
  for (const id of builtInSpaceIds) if (!canonicalOrder.includes(id)) canonicalOrder.push(id);
  for (const id of customSpaces.keys()) if (!canonicalOrder.includes(id)) canonicalOrder.push(id);
  const hiddenIds = new Set(hidden.filter((id) => knownIds.has(id)));

  return canonicalOrder.flatMap<WorkflowSpace>((id) => {
    const builtIn = builtInSpaces[id as BuiltInSpaceId];
    const space = builtIn
      ? { ...builtIn, label: labels[id] ?? builtIn.label, count: counts[id as BuiltInSpaceId] }
      : customSpaces.get(id);
    return space ? [{ ...space, kind: space.kind ?? "built_in", hidden: hiddenIds.has(id) }] : [];
  }).concat(views.slice().sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)).map((view) => ({
    id: view.id,
    label: view.name,
    description: "live View",
    color: view.color,
    kind: "view" as const,
    hidden: false,
  })));
}

export function deriveSidebarHealth({ attention = false, known = true, online, syncing = false }: {
  attention?: boolean;
  known?: boolean;
  online: boolean;
  syncing?: boolean;
}): SidebarAccount["health"] {
  if (!online) return "offline";
  if (syncing) return "syncing";
  if (attention) return "attention";
  return known ? "synced" : "unknown";
}

export function createSidebarNavigationProjection({ account, active, attention = false, collections, views = [], counts, draftCount, hidden, inboxCount, known = true, labels, online, order, syncing = false }: {
  account: Omit<SidebarAccount, "health">;
  active: DesktopDestination;
  attention?: boolean;
  collections: readonly Collection[];
  views?: readonly OrganizationView[];
  counts?: Partial<Record<BuiltInSpaceId, number>>;
  draftCount?: number;
  hidden?: readonly string[];
  inboxCount?: number;
  known?: boolean;
  labels?: Readonly<Record<string, string>>;
  online: boolean;
  order?: readonly string[];
  syncing?: boolean;
}): SidebarNavigationProjection {
  const health = deriveSidebarHealth({ attention, known, online, syncing });
  return {
    account: {
      ...account,
      health,
      detail: health === "offline" ? "Offline · cached mail and drafts available" : account.detail,
    },
    active,
    draftCount,
    inboxCount,
    online,
    spaces: projectWorkflowSpaces({ collections, views, counts, hidden, labels, order }),
  };
}

function subscribeToConnectivity(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function connectivitySnapshot() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function useOnlineStatus() {
  return useSyncExternalStore(subscribeToConnectivity, connectivitySnapshot, () => true);
}
