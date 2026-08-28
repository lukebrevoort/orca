import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { attentionViewSettingSchema, collectionSchema, mailAccountPageSchema, reminderViewSettingsSchema, syncStatusSchema, type MailAccount, type SyncStatus } from "@orca/shared";
import { DesktopDrawer } from "./desktop-drawer";
import { OrganizationLaneWorkspace } from "./organization-lanes";

export { DesktopDrawer } from "./desktop-drawer";

export type DesktopDestination = "inbox" | "drafts" | "focus" | "signals" | "quiet" | "later" | "all" | "organization" | "settings" | `space:${string}`;

export type WorkflowSpace = {
  id: string;
  label: string;
  description: string;
  count?: number;
  color?: string;
  custom?: boolean;
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

const icons = {
  inbox: <><path d="M3 5h14v10H3z"/><path d="m3 6 7 5 7-5"/></>,
  drafts: <><path d="M5 3h8l3 3v11H5z"/><path d="M8 10h5M8 13h4"/></>,
  organization: <><path d="m10 2.8 7 3.7v7L10 17.2 3 13.5v-7z"/><path d="M6.5 8.3h7M6.5 11.7h7"/></>,
  settings: <><circle cx="10" cy="10" r="3"/><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2"/></>,
  all: <><circle cx="10" cy="10" r="7"/><path d="M6 10h8M10 6v8"/></>,
};

function NavIcon({ name }: { name: keyof typeof icons }) {
  return <svg aria-hidden="true" className="desktop-nav-icon" viewBox="0 0 20 20">{icons[name]}</svg>;
}

function WaveMark() {
  return <svg aria-hidden="true" className="desktop-wave-mark" viewBox="0 0 28 28"><path d="M4 10c3-3 5.5-3 8.5 0s5.5 3 8.5 0M4 17c3-3 5.5-3 8.5 0s5.5 3 8.5 0"/></svg>;
}

function SidebarItem({ active, count, icon, label, onClick }: { active: boolean; count?: number; icon: ReactNode; label: string; onClick: () => void }) {
  return <button aria-current={active ? "page" : undefined} className="desktop-sidebar-item" onClick={onClick} type="button">
    {icon}<span>{label}</span>{count !== undefined ? <small>{count}</small> : null}
  </button>;
}

export function AppSidebar({ account, active, inboxCount, draftCount, spaces, theme, onCompose, onManageSpaces, onNavigate }: {
  account: SidebarAccount;
  active: DesktopDestination;
  inboxCount?: number;
  draftCount?: number;
  spaces: WorkflowSpace[];
  theme: "light" | "dark";
  onCompose: () => void;
  onManageSpaces: () => void;
  onNavigate: (destination: DesktopDestination) => void;
}) {
  const initials = account.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "O";
  return <aside aria-label="Primary" className="desktop-sidebar">
    <div className="desktop-brand"><span className="desktop-wordmark">orca</span>{theme === "dark" ? <img alt="" aria-hidden="true" className="desktop-orca-eye" src="/orca-black-mark.svg" /> : <WaveMark />}<span className="desktop-workspace-name">personal</span></div>
    <button aria-keyshortcuts="c" className="desktop-compose" onClick={onCompose} type="button">
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 15.5h3.2L15.8 6l-3-3L3 12.5v3zM10.9 4.9l3 3"/></svg><span>Compose</span><kbd>C</kbd>
    </button>
    <p className="desktop-sidebar-label">Anchors</p>
    <SidebarItem active={active === "inbox"} count={inboxCount} icon={<NavIcon name="inbox" />} label="Inbox" onClick={() => onNavigate("inbox")} />
    <SidebarItem active={active === "drafts"} count={draftCount} icon={<NavIcon name="drafts" />} label="Drafts" onClick={() => onNavigate("drafts")} />
    <div className="desktop-sidebar-section-head"><span>My spaces</span><button onClick={onManageSpaces} type="button">Manage</button></div>
    {spaces.filter((space) => !space.hidden).map((space) => <SidebarItem
      active={active === (space.custom ? `space:${space.id}` : space.id)}
      count={space.count}
      icon={<span aria-hidden="true" className={`desktop-space-mark desktop-space-${space.id}`} style={space.color ? { background: space.color } : undefined}/>}
      key={space.id}
      label={space.label}
      onClick={() => onNavigate(space.custom ? `space:${space.id}` : space.id as DesktopDestination)}
    />)}
    <SidebarItem active={active === "all"} icon={<NavIcon name="all" />} label="All Mail" onClick={() => onNavigate("all")} />
    <p className="desktop-sidebar-label">Workspace</p>
    <SidebarItem active={active === "organization"} icon={<NavIcon name="organization" />} label="Organization" onClick={() => onNavigate("organization")} />
    <SidebarItem active={active === "settings"} icon={<NavIcon name="settings" />} label="Settings" onClick={() => onNavigate("settings")} />
    <div className="desktop-sidebar-spacer"/>
    <button className="desktop-account" onClick={() => onNavigate("settings")} type="button">
      <span className="desktop-account-avatar">{account.avatar ?? initials}</span><span><strong>{account.displayName}</strong><small>{account.detail ?? `${account.accountCount} ${account.accountCount === 1 ? "account" : "accounts"} · ${account.health}`}</small></span><span aria-hidden="true">›</span>
    </button>
  </aside>;
}

export function WorkspaceHeader({ health, query, title, theme, onQueryChange, onQuerySubmit, onThemeChange }: {
  health: SidebarAccount["health"];
  query: string;
  title: string;
  theme: "light" | "dark";
  onQueryChange: (query: string) => void;
  onQuerySubmit?: (query: string) => void;
  onThemeChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <header className="desktop-workspace-header">
    <form className="desktop-global-search" onSubmit={(event) => { event.preventDefault(); onQuerySubmit?.(query); }} role="search"><label><span aria-hidden="true">⌕</span><input aria-label="Search mail, people, or rules" onChange={(event) => onQueryChange(event.target.value)} placeholder="Search mail, people, or rules" ref={inputRef} value={query}/><kbd>⌘ K</kbd></label></form>
    <span className="desktop-header-context">{title}</span>
    <span className={`desktop-health desktop-health-${health}`}><i/>{health}</span>
    <button aria-label={theme === "dark" ? "Switch to Light" : "Switch to Orca Black"} className="desktop-theme-toggle" onClick={onThemeChange} type="button">{theme === "dark" ? "Light" : "Black"}</button>
  </header>;
}

export function DesktopSettingsFrame({ children, theme, title, onThemeChange }: { children: ReactNode; theme: "light" | "dark"; title: string; onThemeChange: () => void }) {
  const defaultSpaces: WorkflowSpace[] = [
    { id: "focus", label: "Focus", description: "protected attention" },
    { id: "signals", label: "Signals", description: "important changes" },
    { id: "quiet", label: "Quiet", description: "low interruption" },
    { id: "later", label: "Later", description: "held intentionally" },
  ];
  const [spaces, setSpaces] = useState(defaultSpaces);
  const [account, setAccount] = useState<SidebarAccount>({ displayName: "Orca workspace", email: "", accountCount: 0, health: "unknown", detail: "Checking account status…" });
  const [query, setQuery] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function read(path: string) {
      const response = await fetch(path, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status}`);
      return response.json() as Promise<unknown>;
    }
    void Promise.allSettled([
      read("/v1/accounts"),
      read("/v1/sync/status"),
      read("/v1/attention/view-settings"),
      read("/v1/collections"),
      read("/v1/reminders/view-settings"),
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
      const accountItems: MailAccount[] = accounts?.success ? accounts.data.items : [];
      const syncValue: SyncStatus | null = sync?.success ? sync.data : null;
      const primary = accountItems[0];
      const syncStates = syncValue?.accounts.map((item) => item.state) ?? [];
      const health: SidebarAccount["health"] = !syncValue ? "unknown" : syncStates.some((state) => state === "syncing") ? "syncing" : syncStates.some((state) => state === "auth_needed" || state === "error") ? "attention" : "synced";
      setAccount({
        displayName: primary?.displayName ?? primary?.email ?? "Orca workspace",
        email: primary?.email ?? "",
        accountCount: accountItems.length,
        health,
        detail: !accounts?.success || !syncValue ? "Account status unavailable" : `${accountItems.length} ${accountItems.length === 1 ? "account" : "accounts"} · ${health}`,
      });
      const labelByBehavior = new Map(attention.map((setting) => [setting.behavior, setting.displayName]));
      setSpaces([
        { id: "focus", label: labelByBehavior.get("focus") ?? "Focus", description: "protected attention" },
        { id: "signals", label: labelByBehavior.get("notify") ?? "Signals", description: "important changes" },
        { id: "quiet", label: labelByBehavior.get("quiet") ?? "Quiet", description: "low interruption" },
        { id: "later", label: reminder?.success ? reminder.data.displayName : "Later", description: "held intentionally" },
        ...collections.sort((left, right) => left.position - right.position).map((item) => ({ id: item.id, label: item.name, description: "saved collection", color: item.color, custom: true })),
      ]);
    });
    return () => controller.abort();
  }, []);
  const navigate = (destination: DesktopDestination) => {
    if (destination === "settings") { window.location.assign("/settings"); return; }
    if (destination === "organization") { window.location.assign("/?destination=organization"); return; }
    window.location.assign(`/?destination=${encodeURIComponent(destination)}`);
  };
  return <div className="desktop-shell desktop-settings-frame">
    <AppSidebar
      account={account}
      active="settings"
      onCompose={() => window.location.assign("/?compose=1")}
      onManageSpaces={() => window.location.assign("/settings/attention-views")}
      onNavigate={navigate}
      spaces={spaces}
      theme={theme}
    />
    <section className="desktop-workspace"><WorkspaceHeader health={account.health} onQueryChange={setQuery} onQuerySubmit={(value) => { const search = value.trim(); window.location.assign(search ? `/?q=${encodeURIComponent(search)}` : "/"); }} onThemeChange={onThemeChange} query={query} theme={theme} title={title}/>{children}</section>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [onClose]);
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
  return <div className="desktop-dialog-layer" role="presentation"><button aria-label="Close Manage spaces" className="desktop-dialog-backdrop" onClick={onClose} tabIndex={-1} type="button"/><div aria-busy={busy || undefined} aria-labelledby="manage-spaces-title" aria-modal="true" className="desktop-spaces-dialog" ref={dialogRef} role="dialog">
    <header><div><span>Workspace preference</span><h2 id="manage-spaces-title">Manage spaces</h2><p>Names and supported positions sync with your account. Cross-type ordering and hidden visibility are saved on this device; hiding never changes a rule.</p></div><button aria-label="Close" disabled={busy} onClick={onClose} type="button">×</button></header>
    {error ? <p className="desktop-space-operation-error" role="alert">{error}</p> : null}
    <div className="desktop-space-list">{visible.map((space, index) => <article draggable={!busy} onDragStart={() => setDraggedId(space.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropOn(event, space)} key={space.id}>
      <span aria-hidden="true" className="desktop-drag-handle">⠿</span><span className="desktop-space-mark" style={space.color ? { background: space.color } : undefined}/><div><strong>{space.label}</strong><small>{space.description}</small></div>
      <div className="desktop-space-row-actions"><button aria-label={`Move ${space.label} up`} disabled={busy || index === 0} onClick={() => moveBy(space, -1)} type="button">↑</button><button aria-label={`Move ${space.label} down`} disabled={busy || index === visible.length - 1} onClick={() => moveBy(space, 1)} type="button">↓</button><button disabled={busy} onClick={() => { const name = window.prompt("Rename workflow space", space.label)?.trim(); if (name) void onRename(space, name); }} type="button">Rename</button><button disabled={busy} onClick={() => void onHide(space)} type="button">Hide</button></div>
    </article>)}</div>
    {hidden.length ? <section className="desktop-hidden-spaces"><h3>Hidden on this device</h3>{hidden.map((space) => <button disabled={busy} key={space.id} onClick={() => void onRestore(space)} type="button"><span>{space.label}</span><small>Rules intact</small><strong>Restore</strong></button>)}</section> : null}
    <footer>{creating ? <div className="desktop-create-space"><input aria-label="Workflow space name" autoFocus disabled={busy} maxLength={60} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void create(); }} placeholder="e.g. Launch watch" value={newName}/><button disabled={busy || !newName.trim()} onClick={() => void create()} type="button">{busy ? "Creating…" : "Create"}</button><button disabled={busy} onClick={() => setCreating(false)} type="button">Cancel</button></div> : <button className="desktop-create-space-button" disabled={busy} onClick={() => setCreating(true)} type="button">{busy ? "Saving…" : "+ Create a workflow space"}</button>}</footer>
  </div></div>;
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
type SimulationState = "idle" | "running" | "ready" | "stale";

export function OrganizationStudio({ interactivePreview = false }: { interactivePreview?: boolean }) {
  const [mode, setMode] = useState<OrganizationMode>("glass");
  const [simulation, setSimulation] = useState<SimulationState>("idle");
  const [activeRevision, setActiveRevision] = useState(17);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceTab, setTraceTab] = useState<"trace" | "audit">("trace");
  const [revertReview, setRevertReview] = useState(false);
  const [status, setStatus] = useState(interactivePreview
    ? "UI preview · local session only. No rule, provider mail, or audit record is changed or persisted."
    : "Read-only workspace. The current Organization contract supports describe and query; simulation, activation, revert, Trace, and Audit are unavailable.");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
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
  return <section className="organization-studio" aria-labelledby="organization-title">
    <OrganizationLaneWorkspace demoMode={interactivePreview} />
    <header className="organization-heading"><div><span>{interactivePreview ? `Organization UI preview · session ${activeRevision}` : "Organization · read-only"}</span><h1 id="organization-title">Production failures</h1><p>{interactivePreview ? "Local interaction preview for Focus · nothing is persisted" : "Workspace describe/query is available; mutation authority is not"}</p></div><div><button disabled={!interactivePreview} onClick={() => setTraceOpen(true)} type="button">{interactivePreview ? "Preview changes" : "History unavailable"}</button><button className="organization-primary" disabled={!interactivePreview} onClick={updateDraft} type="button">New rule</button></div></header>
    <div className="organization-grid"><section className="organization-editor"><nav aria-label="Rule authoring mode"><button aria-pressed={mode === "glass"} onClick={() => setMode("glass")} type="button">Glass Box</button><button aria-pressed={mode === "tide"} onClick={() => setMode("tide")} type="button">Tide Table</button></nav>
      {mode === "glass" ? <div className="glass-box"><label><span>When</span><textarea aria-label="When" defaultValue="A thread receives a new message" onChange={updateDraft} readOnly={!interactivePreview}/></label><i>→</i><label><span>If</span><textarea aria-label="If" defaultValue={'Sender is Vercel and subject contains “failed”'} onChange={updateDraft} readOnly={!interactivePreview}/></label><i>→</i><label><span>Then</span><textarea aria-label="Then" defaultValue="Move to Focus and notify immediately" onChange={updateDraft} readOnly={!interactivePreview}/></label><label className="glass-because"><span>Because</span><textarea aria-label="Because" defaultValue="A failed deploy blocks work and needs a human response" onChange={updateDraft} readOnly={!interactivePreview}/></label></div> : <label className="tide-table"><span>Advanced authoring · typed Orca language</span><textarea aria-label="Tide Table rule source" defaultValue={'rule production_failures on thread.message_received\n\nwhen sender.domain == "vercel.com"\n  and subject contains "failed"\n\nthen move thread to space("Focus")\n  notify immediately\n\nbecause "A failed deploy blocks work"\n\nauthority workspace.organization\nsafety never_hide'} onChange={updateDraft} readOnly={!interactivePreview}/></label>}
      <p aria-live="polite" className={`organization-status organization-status-${simulation}`}>{status}</p>
    </section><aside className="simulation-card" aria-busy={simulation === "running" || undefined}><span>{interactivePreview ? "Local sample preview" : "Simulation unavailable"}</span><h2>{simulation === "running" ? "Generating sample…" : simulation === "stale" ? "Sample is outdated" : interactivePreview ? "Preview impact" : "No mutation contract"}</h2><dl><div><dt>Sample messages</dt><dd>{simulation === "ready" ? "2,418" : "—"}</dd></div><div><dt>Would move to Focus</dt><dd>{simulation === "ready" ? "14" : "—"}</dd></div><div><dt>Would notify</dt><dd>{simulation === "ready" ? "3" : "—"}</dd></div><div><dt>Would hide</dt><dd>{simulation === "ready" ? "0" : "—"}</dd></div><div><dt>Sample risk</dt><dd>{simulation === "ready" ? "Low" : "Not calculated"}</dd></div><div><dt>Authority</dt><dd>Not checked</dd></div></dl><button disabled={!interactivePreview || simulation === "running"} onClick={runSimulation} type="button">{simulation === "running" ? "Generating…" : simulation === "stale" ? "Preview again" : "Preview sample"}</button><button className="organization-primary" disabled={!interactivePreview || simulation !== "ready"} onClick={activate} type="button">Change preview state</button></aside></div>
    {traceOpen && interactivePreview ? <DesktopDrawer ariaLabel="Local preview changes" className="trace-drawer" onClose={() => setTraceOpen(false)}><header><div><span>{traceTab === "trace" ? "UI explanation preview" : "Local session changes"}</span><h2>{traceTab === "trace" ? "Preview" : "Session"}</h2></div><button aria-label="Close preview changes" onClick={() => setTraceOpen(false)} type="button">×</button></header><div className="trace-tabs"><button aria-pressed={traceTab === "trace"} onClick={() => setTraceTab("trace")} type="button">Explanation</button><button aria-pressed={traceTab === "audit"} onClick={() => setTraceTab("audit")} type="button">Session changes</button></div>{traceTab === "trace" ? <ol><li><span>Sample only</span><strong>No server trace was requested.</strong></li><li><span>Authority</span><strong>Not checked.</strong></li><li className="trace-winner"><span>Preview rule</span><strong>Production failures · local state {activeRevision}.</strong></li><li><span>Persistence</span><strong>Reloading clears this preview.</strong></li></ol> : <ol className="audit-log"><li><span>Local state {activeRevision}</span><strong>Changed in this browser session</strong></li><li><span>Sample preview</span><strong>Illustrative counts · no production query</strong></li><li><span>Audit record</span><strong>None created</strong></li><li><span>Provider mail</span><strong>Not changed</strong></li></ol>}<section><span>Preview restore</span><h3>{revertReview ? `Restore local state ${Math.max(1, activeRevision - 1)}?` : "Changes only this local preview"}</h3><p>{revertReview ? "This updates local component state only. It does not create, rewrite, or preserve any server revision." : "The Organization API does not currently expose revert. This control exists only to review the intended interaction."}</p>{revertReview ? <div className="trace-revert-actions"><button onClick={() => setRevertReview(false)} type="button">Cancel</button><button className="trace-revert-apply" onClick={revert} type="button">Restore local preview</button></div> : <button onClick={() => setRevertReview(true)} type="button">Review local restore</button>}</section></DesktopDrawer> : null}
  </section>;
}
