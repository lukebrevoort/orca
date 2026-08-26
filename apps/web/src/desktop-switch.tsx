import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { attentionViewSettingSchema, collectionSchema, mailAccountPageSchema, orcaEvaluationTraceSchema, reminderViewSettingsSchema, syncStatusSchema, type MailAccount, type OrcaCompiledAction, type OrcaEvaluationTrace, type SyncStatus } from "@orca/shared";
import { DesktopDrawer } from "./desktop-drawer";
import { OrganizationLaneWorkspace } from "./organization-lanes";
import { OrganizationViewsWorkspace } from "./organization-views";
import { createTidePreviewRequest, TideTableEditor } from "./tide-table";

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
  const winnerIds = new Set(trace.winners.map((winner) => winner.candidateId));
  const loserById = new Map(trace.losers.map((loser) => [loser.candidateId, loser]));
  const observedByField = new Map(trace.observedValues.map((value) => [value.field, value]));
  return <DesktopDrawer ariaLabel="Complete deterministic Trace" className="trace-drawer trace-drawer-complete" onClose={onClose}>
    <header><div><span>Authoritative debug chain</span><h2>Deterministic Trace</h2></div><button aria-label="Close Trace" onClick={onClose} type="button">×</button></header>
    <div className="trace-tabs"><button aria-pressed="true" type="button">Trace</button><button disabled type="button">Audit follows apply</button></div>

    <section className="trace-metadata">
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
  </DesktopDrawer>;
}

export function OrganizationStudio({ interactivePreview = false }: { interactivePreview?: boolean }) {
  const [mode, setMode] = useState<OrganizationMode>("glass");
  const [simulation, setSimulation] = useState<SimulationState>("idle");
  const [activeRevision, setActiveRevision] = useState(17);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceTab, setTraceTab] = useState<"trace" | "audit">("trace");
  const [revertReview, setRevertReview] = useState(false);
  const [organizationInvalidation, setOrganizationInvalidation] = useState(0);
  const [liveTrace, setLiveTrace] = useState<OrcaEvaluationTrace | null>(null);
  const [traceState, setTraceState] = useState<"loading" | "ready" | "empty" | "error">(interactivePreview ? "empty" : "loading");
  const [status, setStatus] = useState(interactivePreview
    ? "UI preview · local session only. No rule, provider mail, or audit record is changed or persisted."
    : "Loading the latest complete Trace…");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceRequestGenerationRef = useRef(0);
  const previewTideRequest = useMemo(() => createTidePreviewRequest(), []);
  const invalidateOrganization = useCallback(() => {
    if (!interactivePreview) setOrganizationInvalidation((current) => current + 1);
  }, [interactivePreview]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    const requestGeneration = ++traceRequestGenerationRef.current;
    if (interactivePreview) return;
    const controller = new AbortController();
    setLiveTrace(null);
    setTraceState("loading");
    setStatus("Loading the latest complete Trace…");
    void fetch("/v1/organization/evaluations/latest", { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Trace request failed (${response.status})`);
        const body = await response.json() as { trace?: unknown };
        const parsed = orcaEvaluationTraceSchema.nullable().safeParse(body.trace ?? null);
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
  }, [interactivePreview]);
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
  const displayTrace = !interactivePreview && traceState === "ready" ? liveTrace : null;
  return <section className="organization-studio" aria-labelledby="organization-title">
    <OrganizationViewsWorkspace demoMode={interactivePreview} onWorkspaceMutation={invalidateOrganization} refreshToken={organizationInvalidation} />
    <OrganizationLaneWorkspace demoMode={interactivePreview} onWorkspaceMutation={invalidateOrganization} refreshToken={organizationInvalidation} />
    <header className="organization-heading"><div><span>{interactivePreview ? `Organization UI preview · session ${activeRevision}` : displayTrace ? `Live evaluation · Rule Set ${displayTrace.ruleSet.revision}` : "Organization · deterministic evaluation"}</span><h1 id="organization-title">{displayTrace ? traceTitle(displayTrace) : "Production failures"}</h1><p>{interactivePreview ? "Local interaction preview for Focus · nothing is persisted" : displayTrace ? `${displayTrace.event.kind} · Thread ${displayTrace.event.threadId} · ${new Date(displayTrace.logicalTime).toLocaleString()}` : traceState === "loading" ? "Loading the latest complete Trace…" : traceState === "error" ? "The latest Trace could not be read" : "No Rule evaluation has been recorded yet"}</p></div><div><button className="organization-trace-trigger" disabled={!interactivePreview && !displayTrace} onClick={() => setTraceOpen(true)} type="button">{interactivePreview ? "Preview changes" : "Open complete Trace"}</button><button className="organization-primary" disabled={!interactivePreview} onClick={updateDraft} type="button">{interactivePreview ? "New rule" : "Use Tide Table"}</button></div></header>
    <div className="organization-grid"><section className="organization-editor"><nav aria-label="Rule authoring mode"><button aria-pressed={mode === "glass"} onClick={() => setMode("glass")} type="button">Glass Box</button><button aria-pressed={mode === "tide"} onClick={() => setMode("tide")} type="button">Tide Table</button></nav>
      {mode === "glass" ? displayTrace ? <div className="glass-box glass-live-trace"><article><span>When</span><strong>{displayTrace.event.kind}</strong><small>{displayTrace.event.cause} Event · {displayTrace.event.id}</small></article><i>→</i><article><span>If</span><ul>{displayTrace.observedValues.map((value) => <li key={value.field}>{observedValueLabel(value)}</li>)}</ul><small>{displayTrace.predicateResults.filter((result) => result.result).length} Predicate results were true</small></article><i>→</i><article><span>Then</span><ul>{displayTrace.winners.map((winner) => <li key={winner.candidateId}>{evaluationActionLabel(winner.action)}</li>)}</ul><small>{displayTrace.losers.length} lower candidate{displayTrace.losers.length === 1 ? "" : "s"} preserved in Trace</small></article><article className="glass-because"><span>Because</span><strong>{tracePrimaryWinner(displayTrace)?.reason ?? displayTrace.reason}</strong><small>{(tracePrimaryWinner(displayTrace)?.actor ?? displayTrace.actor).type} Actor · {(tracePrimaryWinner(displayTrace)?.actor ?? displayTrace.actor).id}</small></article></div> : <div className={`glass-trace-state glass-trace-state-${traceState}`} role="status"><span>{traceState === "loading" ? "Reading Trace" : traceState === "error" ? "Trace unavailable" : "No evaluation yet"}</span><strong>{traceState === "loading" ? "Following the latest message.received path…" : traceState === "error" ? "Orca kept the interface honest: no causal claim is shown without its Trace." : "A complete When → If → Then → Because explanation will appear after the first evaluation."}</strong></div> : <TideTableEditor onCompiled={invalidateOrganization} previewMode={interactivePreview} request={interactivePreview ? previewTideRequest : undefined} />}
      <p aria-live="polite" className={`organization-status organization-status-${interactivePreview ? simulation : traceState}`}>{status}</p>
    </section><aside className="simulation-card" aria-busy={simulation === "running" || undefined}><span>{interactivePreview ? "Local sample preview" : displayTrace ? "Latest evaluation" : "Trace status"}</span><h2>{interactivePreview ? simulation === "running" ? "Generating sample…" : simulation === "stale" ? "Sample is outdated" : "Preview impact" : displayTrace ? "Resolved deterministically" : traceState === "loading" ? "Reading evidence…" : "No complete Trace"}</h2><dl>{displayTrace ? <><div><dt>Rules considered</dt><dd>{displayTrace.consideredRevisions.length}</dd></div><div><dt>Candidates</dt><dd>{displayTrace.candidates.length}</dd></div><div><dt>Winners</dt><dd>{displayTrace.winners.length}</dd></div><div><dt>Losers</dt><dd>{displayTrace.losers.length}</dd></div><div><dt>Budget</dt><dd>{displayTrace.budget.exhausted ? "Exhausted" : "Within bounds"}</dd></div><div><dt>Authority</dt><dd>{displayTrace.capabilities.id}</dd></div></> : <><div><dt>Sample messages</dt><dd>{simulation === "ready" ? "2,418" : "—"}</dd></div><div><dt>Would move to Focus</dt><dd>{simulation === "ready" ? "14" : "—"}</dd></div><div><dt>Would notify</dt><dd>{simulation === "ready" ? "3" : "—"}</dd></div><div><dt>Would hide</dt><dd>{simulation === "ready" ? "0" : "—"}</dd></div><div><dt>Sample risk</dt><dd>{simulation === "ready" ? "Low" : "Not calculated"}</dd></div><div><dt>Authority</dt><dd>Not checked</dd></div></>}</dl>{displayTrace ? <button className="organization-trace-trigger" onClick={() => setTraceOpen(true)} type="button">Inspect candidates</button> : <><button disabled={!interactivePreview || simulation === "running"} onClick={runSimulation} type="button">{simulation === "running" ? "Generating…" : simulation === "stale" ? "Preview again" : "Preview sample"}</button><button className="organization-primary" disabled={!interactivePreview || simulation !== "ready"} onClick={activate} type="button">Change preview state</button></>}</aside></div>
    {traceOpen && displayTrace ? <CompleteTraceDrawer onClose={() => setTraceOpen(false)} trace={displayTrace} /> : null}
    {traceOpen && interactivePreview ? <DesktopDrawer ariaLabel="Local preview changes" className="trace-drawer" onClose={() => setTraceOpen(false)}><header><div><span>{traceTab === "trace" ? "UI explanation preview" : "Local session changes"}</span><h2>{traceTab === "trace" ? "Preview" : "Session"}</h2></div><button aria-label="Close preview changes" onClick={() => setTraceOpen(false)} type="button">×</button></header><div className="trace-tabs"><button aria-pressed={traceTab === "trace"} onClick={() => setTraceTab("trace")} type="button">Explanation</button><button aria-pressed={traceTab === "audit"} onClick={() => setTraceTab("audit")} type="button">Session changes</button></div>{traceTab === "trace" ? <ol><li><span>Sample only</span><strong>No server trace was requested.</strong></li><li><span>Authority</span><strong>Not checked.</strong></li><li className="trace-winner"><span>Preview rule</span><strong>Production failures · local state {activeRevision}.</strong></li><li><span>Persistence</span><strong>Reloading clears this preview.</strong></li></ol> : <ol className="audit-log"><li><span>Local state {activeRevision}</span><strong>Changed in this browser session</strong></li><li><span>Sample preview</span><strong>Illustrative counts · no production query</strong></li><li><span>Audit record</span><strong>None created</strong></li><li><span>Provider mail</span><strong>Not changed</strong></li></ol>}<section><span>Preview restore</span><h3>{revertReview ? `Restore local state ${Math.max(1, activeRevision - 1)}?` : "Changes only this local preview"}</h3><p>{revertReview ? "This updates local component state only. It does not create, rewrite, or preserve any server revision." : "The Organization API does not currently expose revert. This control exists only to review the intended interaction."}</p>{revertReview ? <div className="trace-revert-actions"><button onClick={() => setRevertReview(false)} type="button">Cancel</button><button className="trace-revert-apply" onClick={revert} type="button">Restore local preview</button></div> : <button onClick={() => setRevertReview(true)} type="button">Review local restore</button>}</section></DesktopDrawer> : null}
  </section>;
}
