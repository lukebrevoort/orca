import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { attentionViewSettingSchema, collectionSchema, inboxClassificationResponseSchema, mailAccountPageSchema, messageDraftSchema, orcaEvaluationTraceSchema, orcaHistoricalSimulationResponseSchema, reminderSchema, reminderViewSettingsSchema, syncStatusSchema, type Collection, type InboxMessage, type MailAccount, type MessageDraft, type OrcaCompiledAction, type OrcaEvaluationTrace, type OrcaHistoricalSimulationResponse, type Reminder, type SyncStatus } from "@orca/shared";
import { DesktopDrawer } from "./desktop-drawer";
import { GlobalMailSearch, openMailSearch } from "./global-search";
import { createSidebarNavigationProjection, desktopDestinationHref, destinationForSpace, readSpacePreferences, useOnlineStatus, type DesktopDestination, type SidebarAccount, type SidebarNavigationProjection, type WorkflowSpace } from "./navigation";
import { OrganizationAuthorityError, OrganizationAuthorityProvider, OrganizationRecoveryBanner, useOrganizationAuthority } from "./organization-authority";
import { OrganizationLaneWorkspace } from "./organization-lanes";
import { OrganizationViewsWorkspace } from "./organization-views";
import { createTidePreviewRequest, TideTableEditor, type TideCompileSuccess } from "./tide-table";
import { TopLayer, useTopLayerActive } from "./top-layer";

export { DesktopDrawer } from "./desktop-drawer";
export type { DesktopDestination, SidebarAccount, SidebarNavigationProjection, WorkflowSpace } from "./navigation";

const icons = {
  inbox: <><path d="M3 5h14v10H3z"/><path d="m3 6 7 5 7-5"/></>,
  drafts: <><path d="M5 3h8l3 3v11H5z"/><path d="M8 10h5M8 13h4"/></>,
  organization: <><path d="m10 2.8 7 3.7v7L10 17.2 3 13.5v-7z"/><path d="M6.5 8.3h7M6.5 11.7h7"/></>,
  settings: <><circle cx="10" cy="10" r="3"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2"/></>,
  all: <><circle cx="10" cy="10" r="7"/><path d="M6 10h8M10 6v8"/></>,
  compose: <><path d="M3 15.5h3.2L15.8 6l-3-3L3 12.5v3zM10.9 4.9l3 3"/></>,
  more: <><circle cx="5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15" cy="10" r="1"/></>,
};

function NavIcon({ name }: { name: keyof typeof icons }) {
  return <svg aria-hidden="true" className="desktop-nav-icon" viewBox="0 0 20 20">{icons[name]}</svg>;
}

function WaveMark() {
  return <svg aria-hidden="true" className="desktop-wave-mark" viewBox="0 0 28 28"><path d="M4 10c3-3 5.5-3 8.5 0s5.5 3 8.5 0M4 17c3-3 5.5-3 8.5 0s5.5 3 8.5 0"/></svg>;
}

function OrcaBlackMark() {
  return <svg aria-hidden="true" className="desktop-orca-eye" viewBox="0 0 30 30">
    <path d="M8 0h14c4.418 0 8 3.582 8 8v14c0 4.418-3.582 8-8 8H7c-3.866 0-7-3.134-7-7V8C0 3.582 3.582 0 8 0Z" fill="#f4f3ef"/>
    <path d="M15 8.1c4.142 0 7.5 3.089 7.5 6.9s-3.358 6.9-7.5 6.9S7.5 18.811 7.5 15 10.858 8.1 15 8.1Zm0 4.05c-1.712 0-3.1 1.276-3.1 2.85s1.388 2.85 3.1 2.85 3.1-1.276 3.1-2.85-1.388-2.85-3.1-2.85Z" fill="#050505" fillRule="evenodd"/>
  </svg>;
}

function SidebarItem({ active, count, icon, label, onClick }: { active: boolean; count?: number; icon: ReactNode; label: string; onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className="desktop-sidebar-item" onClick={onClick} type="button">
    {icon}<span>{label}</span>{count !== undefined ? <small>{count}</small> : null}
  </button>;
}

function MobileMenuItem({ active = false, count, icon, label, onClick }: { active?: boolean; count?: number; icon: ReactNode; label: string; onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className="desktop-mobile-menu-item" onClick={onClick} role="menuitem" type="button">
    {icon}<span>{label}</span>{count !== undefined ? <small>{count}</small> : null}
  </button>;
}

export function AppSidebar({ composeButtonRef, projection, theme, onCompose, onManageSpaces, onNavigate }: {
  projection: SidebarNavigationProjection;
  theme: "light" | "dark";
  composeButtonRef?: RefObject<HTMLButtonElement | null>;
  onCompose: () => void;
  onManageSpaces: () => void;
  onNavigate: (destination: DesktopDestination) => void;
}) {
  const { account, active, draftCount, inboxCount, spaces } = projection;
  const initials = account.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "O";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const visibleSpaces = spaces.filter((space) => !space.hidden);
  const activeSpace = spaces.find((space) => active === destinationForSpace(space));
  const mobileMenuOwnsCurrentDestination = active !== "inbox" && active !== "drafts";

  function navigateFromMobileMenu(destination: DesktopDestination) {
    setMobileMenuOpen(false);
    onNavigate(destination);
  }

  function moveMobileMenuFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1)
      : (current + 1) % items.length;
    items[next]?.focus();
  }

  return <div className="desktop-sidebar">
    <nav aria-label="Primary navigation" className="desktop-sidebar-content">
      <div className="desktop-brand"><span className="desktop-wordmark">orca</span>{theme === "dark" ? <OrcaBlackMark /> : <WaveMark />}<span className="desktop-workspace-name">personal</span></div>
      <button aria-keyshortcuts="c" className="desktop-compose" onClick={onCompose} ref={composeButtonRef} type="button">
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 15.5h3.2L15.8 6l-3-3L3 12.5v3zM10.9 4.9l3 3"/></svg><span>Compose</span><kbd>C</kbd>
      </button>
      <p className="desktop-sidebar-label">Anchors</p>
      <SidebarItem active={active === "inbox"} count={inboxCount} icon={<NavIcon name="inbox" />} label="Inbox" onClick={() => onNavigate("inbox")} />
      <SidebarItem active={active === "drafts"} count={draftCount} icon={<NavIcon name="drafts" />} label="Drafts" onClick={() => onNavigate("drafts")} />
      <div className="desktop-sidebar-section-head"><span>My spaces</span><button onClick={onManageSpaces} type="button">Manage</button></div>
      {visibleSpaces.map((space) => <SidebarItem
        active={active === destinationForSpace(space)}
        count={space.count}
        icon={<span aria-hidden="true" className={`desktop-space-mark desktop-space-${space.id}`} style={space.color ? { background: space.color } : undefined}/>}
        key={space.id}
        label={space.label}
        onClick={() => onNavigate(destinationForSpace(space))}
      />)}
      <SidebarItem active={active === "all"} icon={<NavIcon name="all" />} label="All Mail" onClick={() => onNavigate("all")} />
      <p className="desktop-sidebar-label">Workspace</p>
      <SidebarItem active={active === "organization"} icon={<NavIcon name="organization" />} label="Organization" onClick={() => onNavigate("organization")} />
      <SidebarItem active={active === "settings"} icon={<NavIcon name="settings" />} label="Settings" onClick={() => onNavigate("settings")} />
      <div className="desktop-sidebar-spacer"/>
      <button className="desktop-account" onClick={() => onNavigate("settings")} type="button">
        <span className="desktop-account-avatar">{account.avatar ?? initials}</span><span><strong>{account.displayName}</strong><small>{account.detail ?? `${account.accountCount} ${account.accountCount === 1 ? "account" : "accounts"} · ${account.health}`}</small></span><span aria-hidden="true">›</span>
      </button>
    </nav>
    <nav aria-label="Mobile primary" className="desktop-mobile-navigation">
      {mobileMenuOpen ? <TopLayer
        ariaLabel="Navigation menu"
        as="section"
        backdropAriaLabel="Close navigation menu"
        backdropClassName="desktop-mobile-menu-backdrop"
        className="desktop-mobile-menu"
        initialFocusSelector={'[aria-current="page"]'}
        layerClassName="desktop-mobile-menu-layer"
        onClose={() => setMobileMenuOpen(false)}
        returnFocusRef={mobileMenuTriggerRef}
        surfaceProps={{ id: "desktop-mobile-navigation-dialog" }}
      >
        <header><div><span>Orca workspace</span><h2>All destinations</h2></div><button aria-label="Close navigation menu" className="desktop-mobile-menu-close" onClick={() => setMobileMenuOpen(false)} type="button">×</button></header>
        <div aria-label="All Orca destinations" className="desktop-mobile-menu-list" id="desktop-mobile-navigation-menu" onKeyDown={moveMobileMenuFocus} role="menu">
          <div aria-label="Mail" role="group">
            <p aria-hidden="true" className="desktop-mobile-menu-label">Mail</p>
            <MobileMenuItem active={active === "inbox"} count={inboxCount} icon={<NavIcon name="inbox" />} label="Inbox" onClick={() => navigateFromMobileMenu("inbox")} />
            <MobileMenuItem active={active === "drafts"} count={draftCount} icon={<NavIcon name="drafts" />} label="Drafts" onClick={() => navigateFromMobileMenu("drafts")} />
            <MobileMenuItem active={active === "all"} icon={<NavIcon name="all" />} label="All Mail" onClick={() => navigateFromMobileMenu("all")} />
          </div>
          <div aria-label="My spaces" role="group">
            <p aria-hidden="true" className="desktop-mobile-menu-label">My spaces</p>
            {visibleSpaces.map((space) => <MobileMenuItem
              active={active === destinationForSpace(space)}
              count={space.count}
              icon={<span aria-hidden="true" className={`desktop-space-mark desktop-space-${space.id}`} style={space.color ? { background: space.color } : undefined}/>}
              key={space.id}
              label={space.label}
              onClick={() => navigateFromMobileMenu(destinationForSpace(space))}
            />)}
            <MobileMenuItem icon={<span aria-hidden="true" className="desktop-mobile-menu-symbol">±</span>} label="Manage spaces" onClick={onManageSpaces} />
          </div>
          <div aria-label="Workspace" role="group">
            <p aria-hidden="true" className="desktop-mobile-menu-label">Workspace</p>
            <MobileMenuItem active={active === "organization"} icon={<NavIcon name="organization" />} label="Organization" onClick={() => navigateFromMobileMenu("organization")} />
            <MobileMenuItem active={active === "settings"} icon={<NavIcon name="settings" />} label="Settings" onClick={() => navigateFromMobileMenu("settings")} />
            <MobileMenuItem icon={<span aria-hidden="true" className="desktop-account-avatar">{account.avatar ?? initials}</span>} label={`Account · ${account.displayName}`} onClick={() => navigateFromMobileMenu("settings")} />
          </div>
        </div>
      </TopLayer> : null}
      <button aria-keyshortcuts="c" className="desktop-mobile-nav-item desktop-mobile-compose" onClick={onCompose} type="button"><NavIcon name="compose"/><span>Compose</span></button>
      <button aria-current={active === "inbox" ? "page" : undefined} className="desktop-mobile-nav-item" onClick={() => onNavigate("inbox")} type="button"><NavIcon name="inbox"/><span>Inbox</span></button>
      <button aria-current={active === "drafts" ? "page" : undefined} className="desktop-mobile-nav-item" onClick={() => onNavigate("drafts")} type="button"><NavIcon name="drafts"/><span>Drafts</span></button>
      <button
        aria-controls="desktop-mobile-navigation-dialog"
        aria-expanded={mobileMenuOpen}
        aria-haspopup="dialog"
        aria-label={`Open all destinations${activeSpace ? `. Current destination: ${activeSpace.label}` : mobileMenuOwnsCurrentDestination ? `. Current destination: ${active === "all" ? "All Mail" : active.charAt(0).toUpperCase() + active.slice(1)}` : ""}`}
        className="desktop-mobile-nav-item desktop-mobile-more"
        data-has-current={mobileMenuOwnsCurrentDestination || undefined}
        onClick={() => setMobileMenuOpen((current) => !current)}
        ref={mobileMenuTriggerRef}
        type="button"
      ><NavIcon name="more"/><span>More</span></button>
    </nav>
  </div>;
}

export function WorkspaceHeader({ health, query, title, theme, onQuerySubmit, onThemeChange }: {
  health: SidebarAccount["health"];
  query: string;
  title: string;
  theme: "light" | "dark";
  onQuerySubmit?: (query: string) => void;
  onThemeChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);
  const topLayerActive = useTopLayerActive();
  useEffect(() => setDraft(query), [query]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!topLayerActive && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openMailSearch(draft); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, topLayerActive]);
  return <header className="desktop-workspace-header">
    <form className="desktop-global-search" onSubmit={(event) => { event.preventDefault(); onQuerySubmit?.(draft); openMailSearch(draft); }} role="search"><label><span aria-hidden="true">⌕</span><input aria-label="Search mail" maxLength={200} onChange={(event) => setDraft(event.target.value)} placeholder="Search mail" ref={inputRef} value={draft}/><kbd>⌘ K</kbd></label></form>
    <span className="desktop-header-context">{title}</span>
    <span className={`desktop-health desktop-health-${health}`}><i/>{health}</span>
    <button aria-label={theme === "dark" ? "Switch to Light" : "Switch to Orca Black"} className="desktop-theme-toggle" onClick={onThemeChange} type="button">{theme === "dark" ? "Light" : "Black"}</button>
    <GlobalMailSearch returnFocusRef={inputRef}/>
  </header>;
}

type SettingsNavigationSource = {
  account: Omit<SidebarAccount, "health">;
  accountId: string | null;
  attention: boolean;
  collections: Collection[];
  counts: Partial<Record<"focus" | "signals" | "quiet" | "later", number>>;
  draftCount?: number;
  inboxCount?: number;
  known: boolean;
  labels: Record<string, string>;
  syncing: boolean;
};

export type SettingsNavigationPreview = SettingsNavigationSource & { complete?: boolean };

const emptySettingsNavigationSource: SettingsNavigationSource = {
  account: { displayName: "Orca workspace", email: "", accountCount: 0, detail: "Checking account status…" },
  accountId: null,
  attention: false,
  collections: [],
  counts: {},
  known: false,
  labels: {},
  syncing: false,
};

export function DesktopSettingsFrame({ children, navigationPreview, theme, title, onThemeChange }: { children: ReactNode; navigationPreview?: SettingsNavigationPreview; theme: "light" | "dark"; title: string; onThemeChange: () => void }) {
  const online = useOnlineStatus();
  const [source, setSource] = useState<SettingsNavigationSource>(() => navigationPreview
    ? navigationPreview
    : emptySettingsNavigationSource);
  const query = "";
  useEffect(() => {
    if (navigationPreview?.complete) {
      setSource(navigationPreview);
      return;
    }
    const controller = new AbortController();
    async function read(path: string) {
      const response = await fetch(path, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<unknown>;
    }
    void Promise.allSettled([
      navigationPreview ? Promise.resolve(null) : read("/v1/accounts"),
      navigationPreview ? Promise.resolve(null) : read("/v1/sync/status"),
      read("/v1/attention/view-settings"),
      read("/v1/collections"),
      read("/v1/reminders/view-settings"),
      read("/v1/inbox?view=all&classification=all&limit=100"),
      read("/v1/drafts"),
      read("/v1/reminders"),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      const accounts = results[0]?.status === "fulfilled" ? mailAccountPageSchema.safeParse(results[0].value) : null;
      const sync = results[1]?.status === "fulfilled" ? syncStatusSchema.safeParse(results[1].value) : null;
      const attention = results[2]?.status === "fulfilled" && Array.isArray(results[2].value)
        ? results[2].value.map((item) => attentionViewSettingSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)
        : [];
      const collections = results[3]?.status === "fulfilled" && Array.isArray(results[3].value)
        ? results[3].value.map((item) => collectionSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)
        : [];
      const reminder = results[4]?.status === "fulfilled" ? reminderViewSettingsSchema.safeParse(results[4].value) : null;
      const inbox = results[5]?.status === "fulfilled" ? inboxClassificationResponseSchema.safeParse(results[5].value) : null;
      const drafts: MessageDraft[] = results[6]?.status === "fulfilled" && Array.isArray(results[6].value)
        ? results[6].value.map((item) => messageDraftSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)
        : [];
      const reminders: Reminder[] = results[7]?.status === "fulfilled" && Array.isArray(results[7].value)
        ? results[7].value.map((item) => reminderSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)
        : [];
      const accountItems: MailAccount[] = accounts?.success ? accounts.data.items : [];
      const syncValue: SyncStatus | null = sync?.success ? sync.data : null;
      const messages: InboxMessage[] = inbox?.success ? inbox.data.messages : [];
      const primary = accountItems[0];
      const syncStates = syncValue?.accounts.map((item) => item.state) ?? [];
      const labelByBehavior = new Map(attention.map((setting) => [setting.behavior, setting.displayName]));
      setSource({
        account: navigationPreview?.account ?? {
          displayName: primary?.displayName ?? primary?.email ?? "Orca workspace",
          email: primary?.email ?? "",
          accountCount: accountItems.length,
          detail: !accounts?.success || !syncValue ? "Account status unavailable" : undefined,
        },
        accountId: navigationPreview?.accountId ?? primary?.id ?? null,
        attention: navigationPreview?.attention ?? syncStates.some((state) => state === "auth_needed" || state === "error"),
        collections: collections.length ? collections : navigationPreview?.collections ?? [],
        counts: {
          focus: inbox?.success ? messages.filter((message) => message.attentionBehavior === "focus").length : navigationPreview?.counts.focus,
          signals: inbox?.success ? messages.filter((message) => message.attentionBehavior === "notify").length : navigationPreview?.counts.signals,
          quiet: inbox?.success ? messages.filter((message) => message.attentionBehavior === "quiet").length : navigationPreview?.counts.quiet,
          later: results[7]?.status === "fulfilled" ? new Set(reminders.filter((item) => item.status === "scheduled" || item.status === "resurfaced").map((item) => item.threadId)).size : navigationPreview?.counts.later,
        },
        draftCount: results[6]?.status === "fulfilled" ? drafts.filter((draft) => draft.deliveryStatus === "draft").length : navigationPreview?.draftCount,
        inboxCount: inbox?.success ? messages.length : navigationPreview?.inboxCount,
        known: navigationPreview?.known ?? Boolean(accounts?.success && syncValue),
        labels: {
          ...navigationPreview?.labels,
          ...(labelByBehavior.has("focus") ? { focus: labelByBehavior.get("focus")! } : {}),
          ...(labelByBehavior.has("notify") ? { signals: labelByBehavior.get("notify")! } : {}),
          ...(labelByBehavior.has("quiet") ? { quiet: labelByBehavior.get("quiet")! } : {}),
          ...(reminder?.success ? { later: reminder.data.displayName } : {}),
        },
        syncing: navigationPreview?.syncing ?? syncStates.some((state) => state === "syncing"),
      });
    });
    return () => controller.abort();
  }, [navigationPreview]);
  const stored = source.accountId ? readSpacePreferences(source.accountId) : null;
  const projection = createSidebarNavigationProjection({
    account: source.account,
    active: "settings",
    attention: source.attention,
    collections: source.collections,
    counts: source.counts,
    draftCount: source.draftCount,
    hidden: stored?.hidden,
    inboxCount: source.inboxCount,
    known: source.known,
    labels: { ...stored?.labels, ...source.labels },
    online,
    order: stored?.order,
    syncing: source.syncing,
  });
  const navigate = (destination: DesktopDestination) => {
    if (destination === "settings") return;
    window.location.assign(desktopDestinationHref(destination, window.location.pathname));
  };
  return <div className="desktop-shell desktop-settings-frame">
    <AppSidebar
      onCompose={() => window.location.assign("/?compose=1")}
      onManageSpaces={() => window.location.assign("/settings/attention-views")}
      onNavigate={navigate}
      projection={projection}
      theme={theme}
    />
    <section className="desktop-workspace"><WorkspaceHeader health={projection.account.health} onThemeChange={onThemeChange} query={query} theme={theme} title={title}/><ConnectivityNotice onOpenDrafts={() => navigate("drafts")} online={online}/>{children}</section>
  </div>;
}

export function ConnectivityNotice({ online, onOpenDrafts }: { online: boolean; onOpenDrafts: () => void }) {
  if (online) return null;
  return <div className="desktop-connectivity-notice" role="status">
    <div><strong>Orca is offline</strong><span>Cached mail stays readable, local triage is preserved, and drafts remain available. Provider changes will sync after you reconnect.</span></div>
    <button onClick={onOpenDrafts} type="button">Open drafts</button>
  </div>;
}

export function ManageSpacesDialog({ busy = false, error = null, spaces, onClose, onCreate, onHide, onReorder, onRename, onRestore }: {
  busy?: boolean;
  error?: string | null;
  spaces: WorkflowSpace[];
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
  onHide: (space: WorkflowSpace) => Promise<void> | void;
  onReorder: (order: string[]) => Promise<void> | void;
  onRename: (space: WorkflowSpace, name: string) => Promise<void> | void;
  onRestore: (space: WorkflowSpace) => Promise<void> | void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  async function dropOn(event: DragEvent, target: WorkflowSpace) {
    event.preventDefault();
    if (!draggedId || draggedId === target.id) return;
    await onReorder(moveSpaceOrder(spaces.map((space) => space.id), draggedId, target.id));
    setDraggedId(null);
  }
  function moveBy(space: WorkflowSpace, direction: -1 | 1) {
    const index = visible.findIndex((item) => item.id === space.id);
    const target = visible[index + direction];
    if (!target) return;
    void onReorder(moveSpaceOrder(spaces.map((item) => item.id), space.id, target.id));
  }
  async function create() {
    const name = newName.trim();
    if (!name) return;
    await onCreate(name); setNewName(""); setCreating(false);
  }
  const visible = spaces.filter((space) => !space.hidden);
  const hidden = spaces.filter((space) => space.hidden);
  return <TopLayer ariaBusy={busy} ariaLabelledBy="manage-spaces-title" backdropAriaLabel="Close Manage spaces" backdropClassName="desktop-dialog-backdrop" className="desktop-spaces-dialog" dismissible={!busy} layerClassName="desktop-dialog-layer" onClose={onClose}>
    <header><div><span>Workspace preference</span><h2 id="manage-spaces-title">Manage spaces</h2><p>Names and supported positions sync with your account. Cross-type ordering and hidden visibility are saved on this device; hiding never changes a rule.</p></div><button aria-label="Close" disabled={busy} onClick={onClose} type="button">×</button></header>
    {error ? <p className="desktop-space-operation-error" role="alert">{error}</p> : null}
    <div className="desktop-space-list">{visible.map((space, index) => <article draggable={!busy} onDragStart={() => setDraggedId(space.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropOn(event, space)} key={space.id}>
      <span aria-hidden="true" className="desktop-drag-handle">⠿</span><span className="desktop-space-mark" style={space.color ? { background: space.color } : undefined}/><div><strong>{space.label}</strong><small>{space.description}</small></div>
      <div className="desktop-space-row-actions"><button aria-label={`Move ${space.label} up`} disabled={busy || index === 0} onClick={() => moveBy(space, -1)} type="button">↑</button><button aria-label={`Move ${space.label} down`} disabled={busy || index === visible.length - 1} onClick={() => moveBy(space, 1)} type="button">↓</button><button disabled={busy} onClick={() => { const name = window.prompt("Rename workflow space", space.label)?.trim(); if (name) void onRename(space, name); }} type="button">Rename</button><button disabled={busy} onClick={() => void onHide(space)} type="button">Hide</button></div>
    </article>)}</div>
    {hidden.length ? <section className="desktop-hidden-spaces"><h3>Hidden on this device</h3>{hidden.map((space) => <button disabled={busy} key={space.id} onClick={() => void onRestore(space)} type="button"><span>{space.label}</span><small>Rules intact</small><strong>Restore</strong></button>)}</section> : null}
    <footer>{creating ? <div className="desktop-create-space"><input aria-label="Workflow space name" autoFocus disabled={busy} maxLength={60} onInput={(event) => setNewName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="e.g. Launch watch" value={newName}/><button disabled={busy || !newName.trim()} onClick={() => void create()} type="button">{busy ? "Creating…" : "Create"}</button><button disabled={busy} onClick={() => setCreating(false)} type="button">Cancel</button></div> : <button className="desktop-create-space-button" disabled={busy} onClick={() => setCreating(true)} type="button">{busy ? "Saving…" : "+ Create a workflow space"}</button>}</footer>
  </TopLayer>;
}

export function moveSpaceOrder(order: string[], draggedId: string, targetId: string) {
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  const targetIndex = next.indexOf(targetId);
  next.splice(from < to ? targetIndex + 1 : targetIndex, 0, draggedId);
  return next;
}

type OrganizationMode = "glass" | "tide";
type OrganizationSection = "overview" | "views" | "lanes" | "rules";
type SimulationState = "idle" | "running" | "ready" | "stale";
type RuleLifecycleState = "proposed" | "simulated" | "active" | "conflicted" | "reverted";
type LifecycleOperationState = "ready" | "loading" | "unavailable" | "no_access" | "offline" | "transaction_failure" | "conflict" | "active" | "reverted";
type LifecycleBinding = TideCompileSuccess & { accountIds: string[] };
type LifecycleChangeSet = {
  changeSetId: string;
  status: "active" | "reverted" | "conflicted";
  operation: "apply" | "revert";
  ruleId: string;
  revisionId: string;
  simulationId: string;
  revertsChangeSetId: string | null;
  workspaceRevisionBefore: number;
  workspaceRevisionAfter: number;
  ruleSetRevisionAfter: number;
  traceCount: number;
  risk: string;
  conflicts: Array<{ resourceId: string; expectedRevision: number; actualRevision: number | null }>;
};
type LifecycleExplanation = {
  changeSet: {
    id: string;
    operation: "apply" | "revert";
    status: string;
    simulationId: string | null;
    risk: string;
    revertsChangeId: string | null;
    revertedByChangeId: string | null;
    workspaceRevisionBefore: number;
    workspaceRevisionAfter: number;
    authorityTrace: Record<string, unknown>;
    createdAt: string;
  };
  trace: OrcaEvaluationTrace[];
  actions: Array<{ position: number; kind: string; resourceFamily: string; resourceId: string; before: unknown; after: unknown }>;
  inverse: unknown;
  resultingRevisions: Record<string, unknown>;
};

class LifecycleRequestError extends Error {
  constructor(readonly state: Exclude<LifecycleOperationState, "ready" | "loading" | "active" | "reverted">, message: string) {
    super(message);
  }
}

function isLifecycleChangeSet(value: unknown): value is LifecycleChangeSet {
  return typeof value === "object" && value !== null
    && "changeSetId" in value && typeof value.changeSetId === "string"
    && "workspaceRevisionAfter" in value && typeof value.workspaceRevisionAfter === "number";
}

function lifecycleErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null || !("error" in value)) return fallback;
  const error = value.error;
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : fallback;
}

function lifecycleFailureState(status: number): LifecycleRequestError["state"] {
  if (status === 401 || status === 403) return "no_access";
  if (status === 409 || status === 412) return "conflict";
  if (status === 404 || status === 405 || status === 501 || status === 503) return "unavailable";
  if (status >= 500) return "transaction_failure";
  return "unavailable";
}

async function requireLifecycleResponse(response: Response, fallback: string): Promise<unknown> {
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) throw new LifecycleRequestError(lifecycleFailureState(response.status), lifecycleErrorMessage(body, fallback));
  return body;
}

function lifecycleCaughtState(error: unknown): LifecycleOperationState {
  if (error instanceof OrganizationAuthorityError) {
    if (error.status === 409 || error.status === 412) return "conflict";
    if (error.kind === "offline") return "offline";
    if (error.kind === "session_expired" || error.kind === "no_access") return "no_access";
    return "unavailable";
  }
  if (error instanceof LifecycleRequestError) return error.state;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return error instanceof TypeError ? "offline" : "transaction_failure";
}

function evaluationActionLabel(action: OrcaCompiledAction): string {
  switch (action.kind) {
    case "route_lane": return `Route to ${action.laneId}`;
    case "set_workflow_state": return `Set workflow to ${action.stateId}`;
    case "set_facet": return `Set ${action.facetId} to ${String(action.value)}`;
    case "unset_facet": return `Unset ${action.facetId}`;
    case "add_collection": return `Add to ${action.collectionId}`;
    case "remove_collection": return `Remove from ${action.collectionId}`;
    case "link_context": return `Link ${action.contextId}`;
    case "unlink_context": return `Unlink ${action.contextId}`;
    case "notify": return action.urgency === "immediate" ? "Proposal · Notify immediately" : "Proposal · Add to digest";
    case "suppress_interruption": return "Proposal · Suppress interruption";
    case "schedule_review": return `Proposal · Review after ${action.duration}`;
    case "propose_retention": return action.mode === "keep" ? "Proposal · Keep" : `Proposal · Review retention after ${action.days} days`;
    case "propose_provider_deletion": return "Proposal · Provider deletion (approval required)";
  }
}

function observedValueLabel(value: OrcaEvaluationTrace["observedValues"][number]): string {
  return value.present ? `${value.field} = ${String(value.value)}` : `${value.field} is missing`;
}

function tracePrimaryWinner(trace: OrcaEvaluationTrace): OrcaEvaluationTrace["winners"][number] | undefined {
  return trace.winners.find((winner) => winner.slot === "lane") ?? trace.winners[0];
}

function traceTitle(trace: OrcaEvaluationTrace): string {
  const laneWinner = trace.winners.find((winner) => winner.slot === "lane");
  if (!laneWinner) {
    const winner = trace.winners[0];
    return winner ? evaluationActionLabel(winner.action) : "Latest evaluation";
  }
  if (laneWinner.precedence === "safety_lock") return "Safety Lock";
  if (laneWinner.precedence === "manual_override") return "Manual Override";
  if (laneWinner.precedence === "lane_policy") return "Lane Policy";
  if (laneWinner.precedence === "workspace_fallback") return "Workspace Fallback";
  const revision = trace.consideredRevisions.find((item) => item.revisionId === laneWinner.revisionId);
  return revision ? `Rule · ${revision.ruleId}` : `Rule revision · ${laneWinner.revisionId ?? laneWinner.candidateId}`;
}

function traceBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function traceWords(value: string): string {
  return value.replaceAll("_", " ");
}

function CompleteTraceDrawer({ onClose, trace }: { onClose: () => void; trace: OrcaEvaluationTrace }) {
  const [tab, setTab] = useState<"trace" | "audit">("trace");
  const winnerIds = new Set(trace.winners.map((winner) => winner.candidateId));
  const loserById = new Map(trace.losers.map((loser) => [loser.candidateId, loser]));
  const observedByField = new Map(trace.observedValues.map((value) => [value.field, value]));
  return <DesktopDrawer ariaLabel="Complete deterministic Trace" className="trace-drawer trace-drawer-complete" onClose={onClose}>
    <header><div><span>Authoritative debug chain</span><h2>Deterministic Trace</h2></div><button aria-label="Close Trace" onClick={onClose} type="button">×</button></header>
    <div className="trace-tabs"><button aria-pressed={tab === "trace"} onClick={() => setTab("trace")} type="button">Trace</button><button aria-pressed={tab === "audit"} onClick={() => setTab("audit")} type="button">Evaluation audit</button></div>

    {tab === "audit" ? <>
      <section className="trace-metadata">
        <span>Immutable evaluation record</span>
        <h3>{trace.id}</h3>
        <dl>
          <div><dt>Event ·</dt>{" "}<dd>{trace.event.id} · {trace.event.kind} · {trace.event.cause}</dd></div>
          <div><dt>Actor ·</dt>{" "}<dd>{trace.actor.type} · {trace.actor.id}</dd></div>
          <div><dt>Capability ·</dt>{" "}<dd>{trace.capabilities.id} · revision {trace.capabilities.revision}</dd></div>
          <div><dt>Scope ·</dt>{" "}<dd>{trace.event.workspaceId} · {trace.event.accountId ?? "no Account"} · {trace.event.threadId}</dd></div>
          <div><dt>Rule Set ·</dt>{" "}<dd>{trace.ruleSet.id} · revision {trace.ruleSet.revision}</dd></div>
          <div><dt>Recorded ·</dt>{" "}<dd>{trace.logicalTime}</dd></div>
        </dl>
      </section>
      <section className="trace-authority">
        <span>Authority and boundary</span>
        <h3>{trace.capabilities.operations.join(" · ") || "No mutation operation"}</h3>
        <p>Resource families · {trace.capabilities.resourceFamilies.join(" · ") || "none"}</p>
        <p>Action families · {trace.capabilities.actionFamilies.join(" · ") || "none"}</p>
        <p>Provider send and provider delete remain outside this evaluation capability.</p>
      </section>
      <section className="trace-authority">
        <span>Resolution record</span>
        <h3>{trace.winners.length} winners · {trace.losers.length} losers</h3>
        <p>All candidate identities and winner links remain available on the Trace tab. This evaluation audit does not imply a Change Set was applied.</p>
      </section>
    </> : <><section className="trace-metadata">
      <span>Evaluation identity</span>
      <h3>{trace.id}</h3>
      <dl>
        <div><dt>Event ·</dt>{" "}<dd>{trace.event.kind} · {trace.event.cause}</dd></div>
        <div><dt>Event ID ·</dt>{" "}<dd>{trace.event.id}</dd></div>
        <div><dt>Logical time ·</dt>{" "}<dd>{trace.logicalTime}</dd></div>
        <div><dt>Occurred at ·</dt>{" "}<dd>{trace.event.occurredAt}</dd></div>
        <div><dt>Top-level Actor ·</dt>{" "}<dd>{trace.actor.type} · {trace.actor.id}</dd></div>
        <div><dt>Reason ·</dt>{" "}<dd>{trace.reason}</dd></div>
        <div><dt>Rule Set ·</dt>{" "}<dd>{trace.ruleSet.id} · revision {trace.ruleSet.revision}</dd></div>
        <div><dt>Workspace Schema ·</dt>{" "}<dd>revision {trace.workspaceSchemaRevision}</dd></div>
        <div><dt>Workspace ·</dt>{" "}<dd>{trace.event.workspaceId}</dd></div>
        <div><dt>Account ·</dt>{" "}<dd>{trace.event.accountId ?? "not supplied"}</dd></div>
        <div><dt>Thread ·</dt>{" "}<dd>{trace.event.threadId}</dd></div>
        <div><dt>Message ·</dt>{" "}<dd>{trace.event.messageId ?? "not supplied"}</dd></div>
      </dl>
    </section>

    <section className="trace-chain-section">
      <span>1 · Considered Rule revisions</span>
      <ol>{trace.consideredRevisions.map((revision) => <li className={revision.reason === "matched" ? "trace-winner" : undefined} key={revision.revisionId}>
        <span>Rule {revision.ruleId} · revision {revision.revision} · order {revision.order}</span>
        <strong>{revision.revisionId}</strong>
        <p>Event matched {traceBoolean(revision.eventMatched)} · Predicate matched {traceBoolean(revision.predicateMatched)} · Authorized {traceBoolean(revision.authorized)}</p>
        <p>Result · {traceWords(revision.reason)}</p>
      </li>)}</ol>
    </section>

    <section className="trace-chain-section">
      <span>2 · Predicate observations</span>
      <ul className="trace-observed-values">{trace.observedValues.map((value) => <li key={value.field}>{observedValueLabel(value)}</li>)}</ul>
      <ol>{trace.predicateResults.map((result, index) => <li className={result.result ? "trace-winner" : undefined} key={`${result.revisionId}:${result.predicate}:${index}`}>
        <span>{result.revisionId}</span>
        <strong>{result.predicate} · {result.kind} · {String(result.result)}</strong>
        <p>{result.observedFields.length ? `Observed · ${result.observedFields.map((field) => observedValueLabel(observedByField.get(field) ?? { field, present: false })).join(" · ")}` : "Observed · no direct fields"}</p>
      </li>)}</ol>
    </section>

    <section className="trace-chain-section trace-candidates">
      <span>3 · Candidate resolution</span>
      <p>{trace.candidates.length} candidates · {trace.winners.length} winners · {trace.losers.length} losers</p>
      <ol>{trace.candidates.map((candidate) => {
        const loser = loserById.get(candidate.candidateId);
        const resolution = winnerIds.has(candidate.candidateId) ? "Winner" : loser ? "Loser" : "Unresolved";
        return <li className={resolution === "Winner" ? "trace-winner" : undefined} key={candidate.candidateId}>
          <span>{candidate.candidateId} · {resolution}</span>
          <strong>{evaluationActionLabel(candidate.action)}</strong>
          <p>Slot {candidate.slot} · Source {traceWords(candidate.precedence)}</p>
          <p>{candidate.revisionId ? `revision ${candidate.revisionId} · ` : ""}rule order {candidate.ruleOrder} · action order {candidate.actionOrder}</p>
          <p>Actor · {candidate.actor.type} · {candidate.actor.id}</p>
          <p>Authorization {candidate.authorized ? "allowed" : "denied"}{candidate.missingCapabilities?.length ? ` · missing ${candidate.missingCapabilities.join(" · ")}` : ""}</p>
          <p>Candidate reason · {candidate.reason}</p>
          {loser ? <p>Loser reason · {traceWords(loser.reason)}{loser.winnerCandidateId ? ` · Winner link · ${loser.winnerCandidateId}` : ""}</p> : <p>Winner reason · {candidate.reason}</p>}
        </li>;
      })}</ol>
    </section>

    <section className="trace-authority">
      <span>4 · Capability Snapshot</span>
      <h3>Snapshot {trace.capabilities.id} · revision {trace.capabilities.revision}</h3>
      <p>Snapshot Actor · {trace.capabilities.actor.type} · {trace.capabilities.actor.id}</p>
      <p>Scope workspace {trace.capabilities.scope.workspaceId} · accounts {trace.capabilities.scope.accountIds.length ? trace.capabilities.scope.accountIds.join(" · ") : "none"}</p>
      <p>Operations · {trace.capabilities.operations.length ? trace.capabilities.operations.join(" · ") : "none"}</p>
      <p>Resource families · {trace.capabilities.resourceFamilies.length ? trace.capabilities.resourceFamilies.join(" · ") : "none"}</p>
      <p>Action families · {trace.capabilities.actionFamilies.length ? trace.capabilities.actionFamilies.join(" · ") : "none"}</p>
      <p>{trace.budget.predicateSteps.toLocaleString()} / {trace.budget.maximumPredicateSteps.toLocaleString()} predicate steps · {trace.budget.candidates.toLocaleString()} / {trace.budget.maximumCandidates.toLocaleString()} candidates · exhausted {traceBoolean(trace.budget.exhausted)}</p>
    </section>
    </>}
  </DesktopDrawer>;
}

function RuleLifecycleSummary({ state, operationState, simulation, changeSet, explanation, busy, controlsEnabled = true, revertReview, onSimulate, onActivate, onReviewRevert, onCancelRevert, onRevert }: {
  state: RuleLifecycleState;
  operationState: LifecycleOperationState;
  simulation: OrcaHistoricalSimulationResponse | null;
  changeSet: LifecycleChangeSet | null;
  explanation: LifecycleExplanation | null;
  busy: boolean;
  controlsEnabled?: boolean;
  revertReview: boolean;
  onSimulate: () => void;
  onActivate: () => void;
  onReviewRevert: () => void;
  onCancelRevert: () => void;
  onRevert: () => void;
}) {
  const operationCopy: Partial<Record<LifecycleOperationState, string>> = {
    loading: "The operation is in progress. Controls remain labeled and temporarily disabled.",
    unavailable: "This operation is unavailable on the current surface. No production data changed.",
    no_access: "Your current authority does not allow this operation. No production data changed.",
    offline: "Orca is offline. The proposal is preserved locally; retry after reconnecting.",
    transaction_failure: "The atomic transaction failed. No partial Organization change was kept.",
    conflict: "Newer state conflicts with this proposal. Re-simulate against the current revisions.",
    active: "The exact simulated Change Set is active for historical and subsequently arriving mail.",
    reverted: "A compensating Change Set restored prior state while preserving the audit record.",
  };
  const nextAction = operationState === "loading" ? "Wait for the current operation to finish."
    : operationState === "unavailable" ? "Retry after Organization operations become available."
    : operationState === "no_access" ? "Ask a Workspace owner for Organization control access."
    : operationState === "offline" ? "Reconnect, then retry from the preserved proposal."
    : operationState === "transaction_failure" ? "Review the failure, then retry the atomic transaction."
    : operationState === "conflict" ? "Re-simulate against the latest Workspace revisions."
    : operationState === "active" ? "Review a compensating revert if the active outcome is wrong."
    : operationState === "reverted" ? "Review the preserved audit before creating a new proposal."
    : state === "proposed" ? "Run mutation-free historical Simulation."
    : state === "simulated" ? "Review the proposal, then activate its exact Change Set."
    : state === "active" ? "Review a compensating revert if the active outcome is wrong."
    : state === "conflicted" ? "Re-simulate against the latest Workspace revisions."
    : "Review the preserved audit before creating a new proposal.";
  return <div className={`rule-lifecycle rule-lifecycle-${state} rule-lifecycle-operation-${operationState}`} data-lifecycle-state={state} data-operation-state={operationState}>
    <div className="rule-lifecycle-state-overview"><div className="rule-lifecycle-heading"><span>Atomic Change Set</span><strong>{operationState === "ready" ? state : operationState.replaceAll("_", " ")}</strong></div>
      {operationCopy[operationState] ? <p className="rule-lifecycle-operation" role="status">{operationCopy[operationState]}</p> : null}
      <p className="rule-lifecycle-next-action" data-next-action><strong>Next action ·</strong> {nextAction}</p>
    </div>
    {simulation ? <dl>
      <div><dt>Historical Threads</dt><dd>{simulation.counts.evaluatedThreads.toLocaleString()}</dd></div>
      <div><dt>Affected</dt><dd>{simulation.counts.affectedThreads.toLocaleString()}</dd></div>
      <div><dt>Conflicts</dt><dd>{simulation.counts.conflicts.toLocaleString()}</dd></div>
      <div><dt>Risk</dt><dd>{simulation.risk}</dd></div>
      <div><dt>Attention</dt><dd>{simulation.attentionImpact.estimatedMinutesSaved} min</dd></div>
      <div><dt>Binding</dt><dd>Workspace r{simulation.binding.workspaceRevision}</dd></div>
    </dl> : <p>Immutable Rule revision ready for mutation-free historical Simulation.</p>}
    {simulation?.representativeThreads.length ? <section className="rule-lifecycle-review" aria-label="Representative Thread review">
      <div className="rule-lifecycle-section-heading"><span>Representative Threads</span><strong>{simulation.representativeThreads.length} of {simulation.counts.affectedThreads}</strong></div>
      {simulation.representativeThreads.map((thread) => {
        const review = simulation.reviews?.find((item) => item.accountId === thread.accountId && item.threadId === thread.threadId);
        return <details key={`${thread.accountId}:${thread.threadId}`} open={simulation.representativeThreads.length <= 3}>
          <summary><span>{thread.subject}</span><small>{thread.accountId} · {thread.threadId}</small></summary>
          <p>{thread.lane ? `Lane · ${thread.lane.before} → ${thread.lane.after}` : "Lane · unchanged"} · {thread.facets.length} Facet change{thread.facets.length === 1 ? "" : "s"} · {thread.conflictCount} conflict{thread.conflictCount === 1 ? "" : "s"}</p>
          {review ? <div className="rule-lifecycle-trace-review">
            <p><strong>Exact winner</strong> · {review.trace.winners.map((winner) => `${winner.candidateId} (${traceWords(winner.precedence)} · ${winner.reason})`).join(" · ") || "none"}</p>
            <p><strong>Losers</strong> · {review.trace.losers.map((loser) => `${loser.candidateId} → ${loser.winnerCandidateId ?? "no winner"} (${traceWords(loser.reason)})`).join(" · ") || "none"}</p>
            <p><strong>Authority</strong> · {review.trace.capabilities.id} · {review.trace.actor.type} {review.trace.actor.id}</p>
          </div> : <p>Trace identity · {thread.traceId}</p>}
        </details>;
      })}
    </section> : null}
    {simulation?.conflicts.length ? <section className="rule-lifecycle-conflicts" aria-label="Simulation conflicts"><div className="rule-lifecycle-section-heading"><span>Conflicts</span><strong>{simulation.conflicts.length}</strong></div>{simulation.conflicts.map((conflict) => <p key={`${conflict.accountId}:${conflict.threadId}:${conflict.slot}`}><strong>{conflict.slot}</strong> · winner {conflict.winningCandidateId} · losers {conflict.losingCandidateIds.join(" · ")}</p>)}</section> : null}
    {simulation?.losingRules.length ? <p className="rule-lifecycle-evidence">Losing Rule revisions · {simulation.losingRules.map((rule) => `${rule.ruleId}/${rule.revisionId} (${rule.losses})`).join(" · ")}</p> : null}
    {explanation ? <section className="rule-lifecycle-audit" aria-label="Applied Change Set audit">
      <div className="rule-lifecycle-section-heading"><span>Ordered actions &amp; audit</span><strong>{explanation.actions.length} actions</strong></div>
      <p>Change Set {explanation.changeSet.id} · {explanation.changeSet.operation} · {explanation.changeSet.status} · risk {explanation.changeSet.risk} · Workspace r{explanation.changeSet.workspaceRevisionBefore} → r{explanation.changeSet.workspaceRevisionAfter}</p>
      <ol>{explanation.actions.map((action) => <li key={`${action.position}:${action.resourceFamily}:${action.resourceId}`}><span>{action.position + 1} · {action.kind}</span><strong>{action.resourceFamily} · {action.resourceId}</strong><small>Before {JSON.stringify(action.before)} · After {JSON.stringify(action.after)}</small></li>)}</ol>
      <details><summary>Inverse operations</summary><pre>{JSON.stringify(explanation.inverse, null, 2)}</pre></details>
      <details><summary>Resulting revisions</summary><pre>{JSON.stringify(explanation.resultingRevisions, null, 2)}</pre></details>
      <details><summary>Authority &amp; approval evidence</summary><pre>{JSON.stringify(explanation.changeSet.authorityTrace, null, 2)}</pre></details>
      <p className="rule-lifecycle-evidence">{explanation.trace.length} complete Trace{explanation.trace.length === 1 ? "" : "s"} · created {explanation.changeSet.createdAt}</p>
    </section> : null}
    {state === "reverted" ? <p className="rule-lifecycle-evidence">Audit history preserved · compensating Change Set {changeSet?.changeSetId}</p> : null}
    {controlsEnabled && (state === "proposed" || state === "conflicted") ? <button disabled={busy} onClick={onSimulate} type="button">{busy ? "Simulating…" : "Simulate history"}</button> : null}
    {controlsEnabled && state === "simulated" ? <button className="organization-primary" disabled={busy} onClick={onActivate} type="button">{busy ? "Activating…" : "Activate Change Set"}</button> : null}
    {controlsEnabled && state === "active" && !revertReview ? <button disabled={busy} onClick={onReviewRevert} type="button">Review revert</button> : null}
    {controlsEnabled && state === "active" && revertReview ? <div className="trace-revert-actions"><button disabled={busy} onClick={onCancelRevert} type="button">Cancel</button><button className="trace-revert-apply" disabled={busy} onClick={onRevert} type="button">{busy ? "Reverting…" : "Apply compensating revert"}</button></div> : null}
  </div>;
}

function Bre320ReleaseEvidence({ operationState }: { operationState: LifecycleOperationState }) {
  const [trace, setTrace] = useState<OrcaEvaluationTrace | null>(null);
  const [loadState, setLoadState] = useState<{ status: "loading" | "ready" | "unavailable" | "error"; detail: string }>(() => ({ status: "loading", detail: "Reading the deterministic Trace fixture before any release-state claim is shown." }));
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setTrace(null);
    setLoadState({ status: "loading", detail: "Reading the deterministic Trace fixture before any release-state claim is shown." });
    void (async () => {
      try {
        const response = await fetch("/docs/assets/bre-315-trace-fixture.json", { signal: controller.signal });
        if (!response.ok) {
          if (!controller.signal.aborted) setLoadState({ status: "unavailable", detail: `Trace fixture request failed (${response.status})` });
          return;
        }
        const body = await response.json() as unknown;
        const parsed = orcaEvaluationTraceSchema.safeParse(typeof body === "object" && body !== null && "trace" in body ? body.trace : null);
        if (!parsed.success) throw new Error("Trace fixture did not match the Orca evaluation contract");
        if (controller.signal.aborted) return;
        setTrace(parsed.data);
        setLoadState({ status: "ready", detail: "Deterministic Trace evidence loaded." });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        setLoadState({ status: "error", detail: error instanceof Error ? error.message : "Trace fixture request failed" });
      }
    })();
    return () => controller.abort();
  }, [loadAttempt]);
  if (!trace || loadState.status !== "ready") return <section className={`bre320-release-evidence bre320-release-evidence-${loadState.status}`} aria-label="BRE-320 deterministic operational-state evidence" data-evidence-load-state={loadState.status}>
    <header><span>BRE-320 deterministic state fixture</span><strong>Provider send · absent&nbsp;&nbsp; Provider delete · absent</strong></header>
    <div className="bre320-evidence-load-state" role="status">
      <span>{loadState.status === "loading" ? "Loading review evidence" : loadState.status === "unavailable" ? "Review evidence unavailable" : "Review evidence failed"}</span>
      <strong>{loadState.detail}</strong>
      <p>{loadState.status === "loading" ? "No release-state claim is shown until the Trace contract is validated." : "No simulated or applied claim is shown without validated Trace evidence."}</p>
      {loadState.status === "unavailable" || loadState.status === "error" ? <button onClick={() => setLoadAttempt((attempt) => attempt + 1)} type="button">Retry review evidence</button> : null}
    </div>
  </section>;
  const historicalTrace = { ...structuredClone(trace), id: "bre320-trace-historical", event: { ...structuredClone(trace.event), id: "bre320-event-historical", accountId: "bre320-account", threadId: "bre320-thread-production-checkout" } };
  const liveTrace = { ...structuredClone(trace), id: "bre320-trace-live", event: { ...structuredClone(trace.event), id: "bre320-event-live", accountId: "bre320-account", threadId: "bre320-thread-production-live" } };
  const simulation: OrcaHistoricalSimulationResponse = {
    simulationId: `sha256:${"b".repeat(64)}`, state: operationState === "conflict" ? "conflicted" : "simulated",
    binding: { ruleId: "bre320-rule-production-failures", revisionId: "bre320-rule-revision-1", ruleRevision: 1, sourceDigest: `sha256:${"c".repeat(64)}`, workspaceSchemaRevision: 17, workspaceRevision: 24, ruleSetRevision: 5 },
    scope: { accountIds: ["bre320-account"], maximumThreads: 500 },
    counts: { evaluatedThreads: 148, affectedThreads: 2, candidateActions: 14, conflicts: operationState === "conflict" ? 1 : 0 },
    laneChanges: [{ fromLaneId: "bre320-lane-everything", toLaneId: "bre320-lane-production", count: 2 }], facetChanges: [{ facetId: "bre320-facet-incident-kind", operation: "set", count: 2 }],
    representativeThreads: [
      { accountId: "bre320-account", threadId: "bre320-thread-production-checkout", subject: "Production checkout failed", lane: { before: "bre320-lane-everything", after: "bre320-lane-production" }, facets: [{ facetId: "bre320-facet-incident-kind", before: null, after: "production_failure" }], conflictCount: operationState === "conflict" ? 1 : 0, traceId: historicalTrace.id },
      { accountId: "bre320-account", threadId: "bre320-thread-production-live", subject: "Production payments failed", lane: { before: "bre320-lane-everything", after: "bre320-lane-production" }, facets: [{ facetId: "bre320-facet-incident-kind", before: null, after: "production_failure" }], conflictCount: 0, traceId: liveTrace.id },
    ],
    reviews: [{ accountId: "bre320-account", threadId: "bre320-thread-production-checkout", trace: historicalTrace }, { accountId: "bre320-account", threadId: "bre320-thread-production-live", trace: liveTrace }],
    conflicts: operationState === "conflict" ? [{ accountId: "bre320-account", threadId: "bre320-thread-production-checkout", slot: "lane", winningCandidateId: "safety-lock:lane", losingCandidateIds: ["rule:bre320-rule-production-failures:0"] }] : [],
    losingRules: operationState === "conflict" ? [{ ruleId: "bre320-rule-production-failures", revisionId: "bre320-rule-revision-1", losses: 1 }] : [], risk: "medium",
    attentionImpact: { notifications: 0, interruptionsSuppressed: 2, estimatedMinutesSaved: 10 },
  };
  const changeSet: LifecycleChangeSet = { changeSetId: "bre320-change-set-apply", status: operationState === "reverted" ? "reverted" : "active", operation: operationState === "reverted" ? "revert" : "apply", ruleId: simulation.binding.ruleId, revisionId: simulation.binding.revisionId, simulationId: simulation.simulationId, revertsChangeSetId: operationState === "reverted" ? "bre320-change-set-apply" : null, workspaceRevisionBefore: 24, workspaceRevisionAfter: 25, ruleSetRevisionAfter: 6, traceCount: 2, risk: "medium", conflicts: [] };
  const explanation: LifecycleExplanation = {
    changeSet: { id: changeSet.changeSetId, operation: changeSet.operation, status: changeSet.status, simulationId: simulation.simulationId, risk: "medium", revertsChangeId: changeSet.revertsChangeSetId, revertedByChangeId: operationState === "reverted" ? "bre320-change-set-revert" : null, workspaceRevisionBefore: 24, workspaceRevisionAfter: 25, authorityTrace: { decision: "approved", actor: { type: "human", id: "bre320-reviewer" }, capability: "organization-control", providerSend: false, providerDelete: false }, createdAt: "2026-08-26T18:30:00.000Z" },
    trace: [historicalTrace, liveTrace],
    actions: [
      { position: 0, kind: "activate_rule_revision", resourceFamily: "rule", resourceId: simulation.binding.ruleId, before: { activeRevisionId: null }, after: { activeRevisionId: simulation.binding.revisionId } },
      { position: 1, kind: "route_lane", resourceFamily: "thread", resourceId: "bre320-thread-production-checkout", before: { laneId: "bre320-lane-everything" }, after: { laneId: "bre320-lane-production" } },
      { position: 2, kind: "add_view_membership", resourceFamily: "view", resourceId: "bre320-view-weekly-review", before: null, after: { derivedFromLane: "bre320-lane-production" } },
    ],
    inverse: { actions: [{ kind: "restore_lane", threadId: "bre320-thread-production-checkout", laneId: "bre320-lane-everything" }, { kind: "deactivate_rule_revision", revisionId: simulation.binding.revisionId }] },
    resultingRevisions: { workspace: 25, ruleSet: 6, threads: { "bre320-thread-production-checkout": 3, "bre320-thread-production-live": 2 } },
  };
  const lifecycleState: RuleLifecycleState = operationState === "reverted" ? "reverted" : operationState === "conflict" ? "conflicted" : operationState === "active" ? "active" : operationState === "ready" ? "simulated" : "proposed";
  const reviewSimulation = operationState === "ready" || operationState === "active" || operationState === "reverted" || operationState === "conflict" ? simulation : null;
  const appliedChangeSet = operationState === "active" || operationState === "reverted" ? changeSet : null;
  const appliedExplanation = operationState === "active" || operationState === "reverted" ? explanation : null;
  return <section className="bre320-release-evidence" aria-label="BRE-320 deterministic operational-state evidence">
    <header><span>BRE-320 deterministic state fixture</span><strong>Provider send · absent&nbsp;&nbsp; Provider delete · absent</strong></header>
    <div className="bre320-state-matrix" aria-label="Operational state matrix" role="list">{(["ready", "loading", "unavailable", "no_access", "offline", "transaction_failure", "conflict", "active", "reverted"] as LifecycleOperationState[]).map((state) => <span aria-current={state === operationState ? "true" : undefined} key={state} role="listitem">{state.replaceAll("_", " ")}</span>)}</div>
    <RuleLifecycleSummary state={lifecycleState} operationState={operationState} simulation={reviewSimulation} changeSet={appliedChangeSet} explanation={appliedExplanation} busy={operationState === "loading"} controlsEnabled={false} revertReview={false} onSimulate={() => {}} onActivate={() => {}} onReviewRevert={() => {}} onCancelRevert={() => {}} onRevert={() => {}} />
  </section>;
}

function OrganizationStudioContent({ interactivePreview = false, releaseEvidenceState = null }: { interactivePreview?: boolean; releaseEvidenceState?: LifecycleOperationState | null }) {
  const organizationAuthority = useOrganizationAuthority();
  const [section, setSection] = useState<OrganizationSection>("overview");
  const [mode, setMode] = useState<OrganizationMode>("glass");
  const [simulation, setSimulation] = useState<SimulationState>("idle");
  const [activeRevision, setActiveRevision] = useState(17);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceTab, setTraceTab] = useState<"trace" | "audit">("trace");
  const [revertReview, setRevertReview] = useState(false);
  const [liveTrace, setLiveTrace] = useState<OrcaEvaluationTrace | null>(null);
  const [traceState, setTraceState] = useState<"loading" | "ready" | "empty" | "error">(interactivePreview ? "empty" : "loading");
  const [lifecycleBinding, setLifecycleBinding] = useState<LifecycleBinding | null>(null);
  const [lifecycleState, setLifecycleState] = useState<RuleLifecycleState>("proposed");
  const [lifecycleOperationState, setLifecycleOperationState] = useState<LifecycleOperationState>("ready");
  const [historicalSimulation, setHistoricalSimulation] = useState<OrcaHistoricalSimulationResponse | null>(null);
  const [lifecycleChangeSet, setLifecycleChangeSet] = useState<LifecycleChangeSet | null>(null);
  const [lifecycleExplanation, setLifecycleExplanation] = useState<LifecycleExplanation | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [status, setStatus] = useState(interactivePreview
    ? "UI preview · local session only. No rule, provider mail, or audit record is changed or persisted."
    : "Loading the latest complete Trace…");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceRequestGenerationRef = useRef(0);
  const rulesNavigationRef = useRef<HTMLButtonElement>(null);
  const focusRulesNavigationRef = useRef(false);
  const previewTideRequest = useMemo(() => createTidePreviewRequest(), []);
  const tideRequest = useCallback((path: string, init?: RequestInit) => organizationAuthority.response(path, init, {
    operation: init?.method && init.method !== "GET" ? "mutation" : "read",
    capability: init?.method && init.method !== "GET" ? "apply" : undefined,
    hasReliableData: Boolean(organizationAuthority.snapshot),
  }), [organizationAuthority]);
  const invalidateOrganization = useCallback(() => {
    if (!interactivePreview) organizationAuthority.retry();
  }, [interactivePreview, organizationAuthority]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    if (section !== "rules" || !focusRulesNavigationRef.current) return;
    focusRulesNavigationRef.current = false;
    rulesNavigationRef.current?.focus();
  }, [section]);
  useEffect(() => {
    const requestGeneration = ++traceRequestGenerationRef.current;
    if (interactivePreview) return;
    if (!organizationAuthority.snapshot) return;
    const controller = new AbortController();
    setTraceState("loading");
    setStatus("Loading the latest complete Trace…");
    void organizationAuthority.request("/v1/organization/evaluations/latest", { signal: controller.signal }, { operation: "read", capability: "query", hasReliableData: Boolean(liveTrace || organizationAuthority.snapshot) })
      .then(async (body) => {
        const result = body as { trace?: unknown };
        const parsed = orcaEvaluationTraceSchema.nullable().safeParse(result.trace ?? null);
        if (!parsed.success) throw new Error("Latest Trace did not match the Orca evaluation contract");
        if (controller.signal.aborted || requestGeneration !== traceRequestGenerationRef.current) return;
        setLiveTrace(parsed.data);
        setTraceState(parsed.data ? "ready" : "empty");
        if (parsed.data) {
          setStatus(`Complete Trace ${parsed.data.id} loaded for Thread ${parsed.data.event.threadId}. ${parsed.data.winners.length} winners and ${parsed.data.losers.length} losers resolved deterministically.`);
        } else {
          setStatus("No complete Trace is available. No Rule evaluation has been recorded yet.");
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestGeneration === traceRequestGenerationRef.current) {
          setTraceState("error");
          const detail = error instanceof Error ? error.message : "Latest Trace is unavailable";
          setStatus(`Complete Trace unavailable. ${detail}. No causal claim is shown without evidence.`);
        }
      });
    return () => controller.abort();
  }, [interactivePreview, organizationAuthority.refreshToken, organizationAuthority.request, organizationAuthority.snapshot]);
  async function handleCompiled(success: TideCompileSuccess) {
    invalidateOrganization();
    if (interactivePreview) return;
    setLifecycleBusy(true);
    setLifecycleOperationState("loading");
    try {
      const accountIds = organizationAuthority.snapshot?.accountIds;
      if (!organizationAuthority.state.canMutate || !organizationAuthority.allows.apply || !accountIds?.length) {
        throw new Error("The current Account scope is unavailable.");
      }
      setLifecycleBinding({ ...success, accountIds });
      setHistoricalSimulation(null);
      setLifecycleChangeSet(null);
      setLifecycleExplanation(null);
      setLifecycleState("proposed");
      setLifecycleOperationState("ready");
      setStatus(`Proposed immutable Rule revision ${success.ruleRevision}. Simulate historical production mail before activation.`);
    } catch (error) {
      setLifecycleOperationState(lifecycleCaughtState(error));
      setStatus(error instanceof Error ? error.message : "The compiled Rule could not be prepared for Simulation.");
    } finally {
      setLifecycleBusy(false);
    }
  }
  async function runHistoricalSimulation() {
    if (!lifecycleBinding) return;
    setLifecycleBusy(true);
    setLifecycleOperationState("loading");
    setStatus("Running mutation-free historical Simulation with production semantics…");
    try {
      const response = await organizationAuthority.response(`/v1/organization/rules/${encodeURIComponent(lifecycleBinding.ruleId)}/simulate`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ruleId: lifecycleBinding.ruleId,
          revisionId: lifecycleBinding.revisionId,
          workspaceSchemaRevision: lifecycleBinding.workspaceSchemaRevision,
          accountIds: lifecycleBinding.accountIds,
          maximumThreads: 500,
        }),
      }, { operation: "read", capability: "simulate", hasReliableData: true });
      const body = await requireLifecycleResponse(response, "Simulation failed");
      const parsed = orcaHistoricalSimulationResponseSchema.parse(body);
      setHistoricalSimulation(parsed);
      setLifecycleState(parsed.state);
      setLifecycleOperationState(parsed.state === "conflicted" ? "conflict" : "ready");
      setStatus(parsed.state === "simulated"
        ? `Simulation ${parsed.simulationId} is bound to Workspace r${parsed.binding.workspaceRevision}; activation is now eligible.`
        : `${parsed.counts.conflicts} conflict${parsed.counts.conflicts === 1 ? "" : "s"} must be resolved before activation.`);
    } catch (error) {
      setLifecycleOperationState(lifecycleCaughtState(error));
      setStatus(error instanceof Error ? error.message : "Historical Simulation failed closed.");
    } finally {
      setLifecycleBusy(false);
    }
  }
  async function activateLifecycle() {
    if (!lifecycleBinding || !historicalSimulation || historicalSimulation.state !== "simulated") return;
    setLifecycleBusy(true);
    setLifecycleOperationState("loading");
    setStatus("Authorizing and atomically committing the simulated Change Set…");
    try {
      const response = await organizationAuthority.response(`/v1/organization/rules/${encodeURIComponent(lifecycleBinding.ruleId)}/activate`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ruleId: lifecycleBinding.ruleId,
          revisionId: lifecycleBinding.revisionId,
          simulationId: historicalSimulation.simulationId,
          accountIds: lifecycleBinding.accountIds,
          maximumThreads: historicalSimulation.scope.maximumThreads,
          expectedWorkspaceRevision: historicalSimulation.binding.workspaceRevision,
          expectedRuleRevision: historicalSimulation.binding.ruleRevision,
          expectedRuleSetRevision: historicalSimulation.binding.ruleSetRevision,
          idempotencyKey: `rule-activate:${crypto.randomUUID()}`,
        }),
      }, { operation: "mutation", capability: "apply", hasReliableData: true });
      const body = await requireLifecycleResponse(response, "Activation failed");
      if (!isLifecycleChangeSet(body)) throw new LifecycleRequestError("transaction_failure", "Activation response was incomplete");
      setLifecycleChangeSet(body);
      setLifecycleState("active");
      setLifecycleOperationState("active");
      setRevertReview(false);
      const explanationResponse = await organizationAuthority.response(`/v1/organization/change-sets/${encodeURIComponent(body.changeSetId)}`, undefined, { operation: "read", capability: "query", hasReliableData: true });
      const explanation = explanationResponse.ok ? await explanationResponse.json() as LifecycleExplanation : null;
      setLifecycleExplanation(explanation);
      setStatus(`Active Change Set ${body.changeSetId} committed atomically at Workspace r${body.workspaceRevisionAfter}.`);
      invalidateOrganization();
    } catch (error) {
      const operationState = lifecycleCaughtState(error);
      setLifecycleOperationState(operationState);
      if (operationState === "conflict") setLifecycleState("conflicted");
      setStatus(error instanceof Error ? error.message : "Activation failed closed with no partial write.");
    } finally {
      setLifecycleBusy(false);
    }
  }
  async function revertLifecycle() {
    if (!lifecycleBinding || !lifecycleChangeSet || lifecycleState !== "active") return;
    setLifecycleBusy(true);
    setLifecycleOperationState("loading");
    setStatus("Checking newer state and applying a compensating Change Set…");
    try {
      const response = await organizationAuthority.response(`/v1/organization/change-sets/${encodeURIComponent(lifecycleChangeSet.changeSetId)}/revert`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changeSetId: lifecycleChangeSet.changeSetId,
          accountIds: lifecycleBinding.accountIds,
          expectedWorkspaceRevision: lifecycleChangeSet.workspaceRevisionAfter,
          idempotencyKey: `rule-revert:${crypto.randomUUID()}`,
        }),
      }, { operation: "mutation", capability: "revert", hasReliableData: true });
      const body = await requireLifecycleResponse(response, "Revert conflicted");
      if (!isLifecycleChangeSet(body)) throw new LifecycleRequestError("transaction_failure", "Revert response was incomplete");
      setLifecycleChangeSet(body);
      setLifecycleState("reverted");
      setLifecycleOperationState("reverted");
      setRevertReview(false);
      const explanationResponse = await organizationAuthority.response(`/v1/organization/change-sets/${encodeURIComponent(body.changeSetId)}`, undefined, { operation: "read", capability: "query", hasReliableData: true });
      if (explanationResponse.ok) setLifecycleExplanation(await explanationResponse.json() as LifecycleExplanation);
      setStatus(`Compensating Change Set ${body.changeSetId} applied. Audit history preserved at Workspace r${body.workspaceRevisionAfter}.`);
      invalidateOrganization();
    } catch (error) {
      const operationState = lifecycleCaughtState(error);
      setLifecycleOperationState(operationState);
      if (operationState === "conflict") setLifecycleState("conflicted");
      setRevertReview(false);
      setStatus(error instanceof Error ? error.message : "Newer state conflicts with this compensation.");
    } finally {
      setLifecycleBusy(false);
    }
  }
  function updateDraft() {
    if (!interactivePreview) return;
    setSimulation("stale");
    setStatus("Preview draft changed locally. The sample impact is stale; preview it again before changing session state.");
  }
  function runSimulation() {
    if (!interactivePreview) return;
    setSimulation("running"); setStatus("Generating a local sample preview…");
    timerRef.current = setTimeout(() => { setSimulation("ready"); setStatus("Sample preview ready. Authority was not checked and no production data changed."); }, 450);
  }
  function activate() { if (!interactivePreview || simulation !== "ready") return; setActiveRevision((value) => value + 1); setSimulation("idle"); setStatus("Preview state changed for this local session. No revision was authorized, persisted, or audited."); setTraceTab("trace"); setTraceOpen(true); }
  function revert() { if (!interactivePreview) return; setActiveRevision((value) => value + 1); setRevertReview(false); setStatus("Local preview state restored. No server history or production behavior changed."); }
  const displayTrace = !interactivePreview ? liveTrace : null;
  const authorityHeadline = interactivePreview ? "Local preview"
    : organizationAuthority.state.kind === "ready" ? "Organization controls available"
    : organizationAuthority.state.title;
  const authorityDetail = interactivePreview ? "Nothing is saved or applied"
    : organizationAuthority.state.kind === "ready" ? "Authority is current · provider mail stays untouched"
    : organizationAuthority.state.kind === "loading" ? "Confirming Workspace authority"
    : organizationAuthority.state.canRead ? "Read-only · provider mail untouched"
    : "Changes are paused";
  return <section aria-label="Organization" className="organization-studio">
    <OrganizationRecoveryBanner />
    <header className="organization-intro">
      <div><h1 id="organization-page-title">Organization</h1><p>See where messages go, then tune the rules behind each decision.</p></div>
      <div className="organization-intro-status" data-authority={organizationAuthority.state.kind}><span><i aria-hidden="true"/>{authorityHeadline}</span><small>{authorityDetail}</small></div>
    </header>
    <nav aria-label="Organization sections" className="organization-section-nav">
      {(["overview", "views", "lanes", "rules"] as OrganizationSection[]).map((item) => <button aria-controls={`organization-${item}`} aria-current={section === item ? "page" : undefined} key={item} onClick={() => setSection(item)} ref={item === "rules" ? rulesNavigationRef : undefined} type="button">{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}
    </nav>
    <section aria-labelledby="organization-overview-title" className="organization-overview" hidden={section !== "overview"} id="organization-overview">
      <div className="organization-overview-heading">
        <div><span>Example rule</span><h2 id="organization-overview-title">Production failures</h2></div>
        <small>{interactivePreview ? "Local example" : "Illustration"}</small>
      </div>
      <ol aria-label="Example Organization rule" className="organization-overview-rule">
        <li className="organization-rule-when"><span>When</span><strong>A message arrives</strong></li>
        <li className="organization-rule-if"><span>If</span><strong>Production has failed</strong></li>
        <li className="organization-rule-then"><span>Then</span><strong>Place it in Focus</strong></li>
        <li className="organization-rule-because"><span>Because</span><strong>A person needs to respond now</strong></li>
      </ol>
      <footer className="organization-overview-action">
        <p>{interactivePreview ? "Preview only · nothing is saved or applied." : "Production changes require simulation and approval."}</p>
        <button className="organization-overview-primary" onClick={() => { focusRulesNavigationRef.current = true; setSection("rules"); }} type="button"><span>Open Rules</span><b aria-hidden="true">→</b></button>
      </footer>
    </section>
    <div hidden={section !== "views"} id="organization-views"><OrganizationViewsWorkspace demoMode={interactivePreview} onWorkspaceMutation={invalidateOrganization} refreshToken={organizationAuthority.refreshToken} /></div>
    <div hidden={section !== "lanes"} id="organization-lanes"><OrganizationLaneWorkspace demoMode={interactivePreview} onWorkspaceMutation={invalidateOrganization} refreshToken={organizationAuthority.refreshToken} /></div>
    <div hidden={section !== "rules"} id="organization-rules">
    {releaseEvidenceState ? <Bre320ReleaseEvidence operationState={releaseEvidenceState} /> : null}
    <header className="organization-heading"><div><span>{interactivePreview ? `Organization UI preview · session ${activeRevision}` : displayTrace ? `Live evaluation · Rule Set ${displayTrace.ruleSet.revision}` : "Organization · deterministic evaluation"}</span><h2 id="organization-rule-title">{displayTrace ? traceTitle(displayTrace) : interactivePreview ? "Production failures" : "Rules"}</h2><p>{interactivePreview ? "Local interaction preview for Focus · nothing is persisted" : displayTrace ? `${displayTrace.event.kind} · Thread ${displayTrace.event.threadId} · ${new Date(displayTrace.logicalTime).toLocaleString()}${traceState === "error" ? " · last-known reliable Trace" : ""}` : traceState === "loading" ? "Loading the latest complete Trace…" : traceState === "error" ? "The latest Trace could not be read" : "No Rule evaluation has been recorded yet"}</p></div><div><button className="organization-trace-trigger" disabled={!interactivePreview && !displayTrace} onClick={() => setTraceOpen(true)} type="button">{interactivePreview ? "Preview changes" : "Open complete Trace"}</button>{interactivePreview ? <button className="organization-primary" onClick={updateDraft} type="button">New rule</button> : null}</div></header>
    <div className="organization-grid"><section className="organization-editor"><nav aria-label="Rule authoring mode"><button aria-pressed={mode === "glass"} onClick={() => setMode("glass")} type="button">Glass Box</button><button aria-pressed={mode === "tide"} onClick={() => setMode("tide")} type="button">Tide Table</button></nav>
      {mode === "glass" ? displayTrace ? <div className="glass-box glass-live-trace"><article><span>When</span><strong>{displayTrace.event.kind}</strong><small>{displayTrace.event.cause} Event · {displayTrace.event.id}</small></article><i>→</i><article><span>If</span><ul>{displayTrace.observedValues.map((value) => <li key={value.field}>{observedValueLabel(value)}</li>)}</ul><small>{displayTrace.predicateResults.filter((result) => result.result).length} Predicate results were true</small></article><i>→</i><article><span>Then</span><ul>{displayTrace.winners.map((winner) => <li key={winner.candidateId}>{evaluationActionLabel(winner.action)}</li>)}</ul><small>{displayTrace.losers.length} lower candidate{displayTrace.losers.length === 1 ? "" : "s"} preserved in Trace</small></article><article className="glass-because"><span>Because</span><strong>{tracePrimaryWinner(displayTrace)?.reason ?? displayTrace.reason}</strong><small>{(tracePrimaryWinner(displayTrace)?.actor ?? displayTrace.actor).type} Actor · {(tracePrimaryWinner(displayTrace)?.actor ?? displayTrace.actor).id}</small></article></div> : <div className={`glass-trace-state glass-trace-state-${traceState}`} role="status"><span>{traceState === "loading" ? "Reading Trace" : traceState === "error" ? "Trace unavailable" : "No evaluation yet"}</span><strong>{traceState === "loading" ? "Following the latest message.received path…" : traceState === "error" ? "Orca kept the interface honest: no causal claim is shown without its Trace." : "A complete When → If → Then → Because explanation will appear after the first evaluation."}</strong></div> : <TideTableEditor canCompile={interactivePreview || organizationAuthority.state.canMutate && organizationAuthority.allows.apply} disabledReason={organizationAuthority.state.detail} onCompiled={(success) => void handleCompiled(success)} previewMode={interactivePreview} request={interactivePreview ? previewTideRequest : tideRequest} />}
      {!interactivePreview && lifecycleBinding ? <RuleLifecycleSummary state={lifecycleState} operationState={lifecycleOperationState} simulation={historicalSimulation} changeSet={lifecycleChangeSet} explanation={lifecycleExplanation} busy={lifecycleBusy} controlsEnabled={organizationAuthority.state.kind === "ready" && (lifecycleState === "proposed" || lifecycleState === "conflicted" ? organizationAuthority.allows.simulate : lifecycleState === "simulated" ? organizationAuthority.allows.apply : lifecycleState === "active" ? organizationAuthority.allows.revert : false)} revertReview={revertReview} onSimulate={() => void runHistoricalSimulation()} onActivate={() => void activateLifecycle()} onReviewRevert={() => setRevertReview(true)} onCancelRevert={() => setRevertReview(false)} onRevert={() => void revertLifecycle()} /> : null}
      <p aria-live="polite" className={`organization-status organization-status-${interactivePreview ? simulation : traceState}`}>{status}</p>
    </section><aside className="simulation-card" aria-busy={simulation === "running" || undefined}><span>{interactivePreview ? "Local sample preview" : displayTrace ? "Latest evaluation" : "Trace status"}</span><h2>{interactivePreview ? simulation === "running" ? "Generating sample…" : simulation === "stale" ? "Sample is outdated" : "Preview impact" : displayTrace ? "Resolved deterministically" : traceState === "loading" ? "Reading evidence…" : "No complete Trace"}</h2><dl>{displayTrace ? <><div><dt>Rules considered</dt><dd>{displayTrace.consideredRevisions.length}</dd></div><div><dt>Candidates</dt><dd>{displayTrace.candidates.length}</dd></div><div><dt>Winners</dt><dd>{displayTrace.winners.length}</dd></div><div><dt>Losers</dt><dd>{displayTrace.losers.length}</dd></div><div><dt>Budget</dt><dd>{displayTrace.budget.exhausted ? "Exhausted" : "Within bounds"}</dd></div><div><dt>Authority</dt><dd>{displayTrace.capabilities.id}</dd></div></> : interactivePreview ? <><div><dt>Sample messages</dt><dd>{simulation === "ready" ? "2,418" : "—"}</dd></div><div><dt>Would move to Focus</dt><dd>{simulation === "ready" ? "14" : "—"}</dd></div><div><dt>Would notify</dt><dd>{simulation === "ready" ? "3" : "—"}</dd></div><div><dt>Would hide</dt><dd>{simulation === "ready" ? "0" : "—"}</dd></div><div><dt>Sample risk</dt><dd>{simulation === "ready" ? "Low" : "Not calculated"}</dd></div><div><dt>Authority</dt><dd>Not checked</dd></div></> : null}</dl>{displayTrace ? <button className="organization-trace-trigger" onClick={() => setTraceOpen(true)} type="button">Inspect candidates</button> : interactivePreview ? <><button disabled={simulation === "running"} onClick={runSimulation} type="button">{simulation === "running" ? "Generating…" : simulation === "stale" ? "Preview again" : "Preview sample"}</button><button className="organization-primary" disabled={simulation !== "ready"} onClick={activate} type="button">Change preview state</button></> : <p className="simulation-card-empty">No illustrative metrics are shown in production. Run a real Tide Table Simulation to create reviewable impact evidence.</p>}</aside></div>
    </div>
    {traceOpen && displayTrace ? <CompleteTraceDrawer onClose={() => setTraceOpen(false)} trace={displayTrace} /> : null}
    {traceOpen && interactivePreview ? <DesktopDrawer ariaLabel="Local preview changes" className="trace-drawer" onClose={() => setTraceOpen(false)}><header><div><span>{traceTab === "trace" ? "UI explanation preview" : "Local session changes"}</span><h2>{traceTab === "trace" ? "Preview" : "Session"}</h2></div><button aria-label="Close preview changes" onClick={() => setTraceOpen(false)} type="button">×</button></header><div className="trace-tabs"><button aria-pressed={traceTab === "trace"} onClick={() => setTraceTab("trace")} type="button">Explanation</button><button aria-pressed={traceTab === "audit"} onClick={() => setTraceTab("audit")} type="button">Session changes</button></div>{traceTab === "trace" ? <ol><li><span>Sample only</span><strong>No server trace was requested.</strong></li><li><span>Authority</span><strong>Not checked.</strong></li><li className="trace-winner"><span>Preview rule</span><strong>Production failures · local state {activeRevision}.</strong></li><li><span>Persistence</span><strong>Reloading clears this preview.</strong></li></ol> : <ol className="audit-log"><li><span>Local state {activeRevision}</span><strong>Changed in this browser session</strong></li><li><span>Sample preview</span><strong>Illustrative counts · no production query</strong></li><li><span>Audit record</span><strong>None created</strong></li><li><span>Provider mail</span><strong>Not changed</strong></li></ol>}<section><span>Preview restore</span><h3>{revertReview ? `Restore local state ${Math.max(1, activeRevision - 1)}?` : "Changes only this local preview"}</h3><p>{revertReview ? "This updates local component state only. It does not create, rewrite, or preserve any server revision." : "This local preview skips the server. Production revert creates an audited compensating Change Set and reports newer-state conflicts."}</p>{revertReview ? <div className="trace-revert-actions"><button onClick={() => setRevertReview(false)} type="button">Cancel</button><button className="trace-revert-apply" onClick={revert} type="button">Restore local preview</button></div> : <button onClick={() => setRevertReview(true)} type="button">Review local restore</button>}</section></DesktopDrawer> : null}
  </section>;
}

export function OrganizationStudio(props: { interactivePreview?: boolean; releaseEvidenceState?: LifecycleOperationState | null }) {
  return <OrganizationAuthorityProvider previewMode={props.interactivePreview}><OrganizationStudioContent {...props} /></OrganizationAuthorityProvider>;
}
