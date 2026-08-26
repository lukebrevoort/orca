import { useEffect, useMemo, useRef, useState } from "react";
import {
  organizationDescribeResponseSchema,
  organizationFallbackPlacementFixture,
  organizationLaneApplyResponseSchema,
  organizationLaneConfigurationFixture,
  organizationQueryResponseSchema,
  type Lane,
  type LanePolicy,
  type OrganizationLaneAction,
  type OrganizationLaneConfiguration,
  type ThreadLanePlacement,
} from "@orca/shared";

type LoadState = "loading" | "ready" | "saving" | "error";

async function readJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { credentials: "include", ...init });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed with ${response.status}`);
  return body;
}

function nextId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function policySummary(policy: LanePolicy) {
  const retention = policy.retention.mode === "keep" ? "keep in Orca" : `review after ${policy.retention.days} days`;
  return `${policy.visibility} · ${policy.interruption} · ${policy.review} · ${retention}`;
}

function applyDemoActions(configuration: OrganizationLaneConfiguration, actions: OrganizationLaneAction[]): OrganizationLaneConfiguration {
  const next = structuredClone(configuration);
  for (const action of actions) {
    if (action.kind === "define_lane_policy") {
      next.policies.push({
        id: action.id,
        visibility: action.visibility,
        interruption: action.interruption,
        review: action.review,
        retention: action.retention,
        providerDeletion: false,
        revision: 1,
      } satisfies LanePolicy);
    }
    if (action.kind === "define_lane") next.lanes.push({ id: action.id, name: action.name, position: action.position, defaultPolicyId: action.defaultPolicyId, retiredAt: null, revision: 1 });
    if (action.kind === "update_lane") {
      const lane = next.lanes.find((item) => item.id === action.laneId); if (!lane) continue;
      if (action.name !== undefined) lane.name = action.name;
      if (action.position !== undefined) lane.position = action.position;
      if (action.retired !== undefined) lane.retiredAt = action.retired ? new Date().toISOString() : null;
      lane.revision += 1;
    }
    if (action.kind === "update_lane_policy") {
      const policy = next.policies.find((item) => item.id === action.policyId); if (!policy) continue;
      if (action.visibility) policy.visibility = action.visibility;
      if (action.interruption) policy.interruption = action.interruption;
      if (action.review) policy.review = action.review;
      if (action.retention) policy.retention = action.retention;
      policy.revision += 1;
    }
    if (action.kind === "set_fallback_lane") next.fallbackLaneId = action.laneId;
  }
  next.workspaceRevision += 1;
  next.lanes.sort((left, right) => left.position - right.position);
  return next;
}

export function OrganizationLaneWorkspace({ demoMode = false }: { demoMode?: boolean }) {
  const [configuration, setConfiguration] = useState<OrganizationLaneConfiguration | null>(demoMode ? organizationLaneConfigurationFixture : null);
  const [state, setState] = useState<LoadState>(demoMode ? "ready" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [newLaneName, setNewLaneName] = useState("");
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(demoMode ? organizationLaneConfigurationFixture.lanes[0]!.id : null);

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    void readJson("/v1/organization/describe", { signal: controller.signal }).then((body) => {
      const parsed = organizationDescribeResponseSchema.parse(body);
      setConfiguration(parsed.laneConfiguration);
      setSelectedLaneId(parsed.laneConfiguration.lanes.find((lane) => !lane.retiredAt)?.id ?? null);
      setState("ready");
    }).catch((reason) => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Lanes are unavailable"); setState("error"); } });
    return () => controller.abort();
  }, [demoMode]);

  const selectedLane = configuration?.lanes.find((lane) => lane.id === selectedLaneId) ?? null;
  const selectedPolicy = configuration?.policies.find((policy) => policy.id === selectedLane?.defaultPolicyId) ?? null;

  async function apply(actions: OrganizationLaneAction[]) {
    if (!configuration || state === "saving") return;
    setState("saving"); setError(null);
    try {
      if (demoMode) {
        setConfiguration(applyDemoActions(configuration, actions));
      } else {
        const body = await readJson("/v1/organization/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: nextId(), idempotencyKey: `web:lanes:${nextId()}`, expectedWorkspaceRevision: configuration.workspaceRevision, actions }) });
        setConfiguration(organizationLaneApplyResponseSchema.parse(body).laneConfiguration);
      }
      setState("ready");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nothing changed"); setState("error"); }
  }

  async function createLane() {
    if (!configuration || !newLaneName.trim()) return;
    const policyId = nextId(); const laneId = nextId();
    await apply([
      { kind: "define_lane_policy", id: policyId, visibility: "standard", interruption: "badge", review: "daily", retention: { mode: "keep", days: null } },
      { kind: "define_lane", id: laneId, name: newLaneName.trim(), position: configuration.lanes.length, defaultPolicyId: policyId },
    ]);
    setNewLaneName(""); setSelectedLaneId(laneId);
  }

  function reorder(lane: Lane, direction: -1 | 1) {
    if (!configuration) return;
    const active = configuration.lanes.filter((item) => !item.retiredAt).sort((left, right) => left.position - right.position);
    const index = active.findIndex((item) => item.id === lane.id); const target = active[index + direction];
    if (!target) return;
    void apply([
      { kind: "update_lane", laneId: lane.id, position: target.position, expectedRevision: lane.revision },
      { kind: "update_lane", laneId: target.id, position: lane.position, expectedRevision: target.revision },
    ]);
  }

  const activeLanes = configuration?.lanes.filter((lane) => !lane.retiredAt) ?? [];
  return <section className="lane-workspace" aria-labelledby="lane-workspace-title" aria-busy={state === "loading" || state === "saving" || undefined}>
    <header><div><span>Writable Organization · Workspace scope</span><h1 id="lane-workspace-title">Lanes set the current.</h1><p>One calm destination per Thread, across every connected Account. Names can change; Lane identity and audit history stay put.</p></div><strong>{configuration ? `Workspace r${configuration.workspaceRevision}` : "Loading…"}</strong></header>
    {error ? <div className="lane-error" role="alert"><strong>Nothing changed.</strong><span>{error}</span></div> : null}
    {state === "loading" ? <div className="lane-loading" role="status">Getting Workspace Lanes…</div> : configuration ? <div className="lane-workspace-grid">
      <section className="lane-list" aria-label="Workspace Lanes"><div className="lane-list-heading"><span>Primary destinations</span><small>{activeLanes.length} active · exactly one fallback</small></div>
        {activeLanes.map((lane, index) => {
          const policy = configuration.policies.find((item) => item.id === lane.defaultPolicyId)!;
          const fallback = lane.id === configuration.fallbackLaneId;
          return <article className={`lane-card${selectedLaneId === lane.id ? " lane-card-selected" : ""}`} key={lane.id}>
            <button aria-pressed={selectedLaneId === lane.id} className="lane-card-main" onClick={() => setSelectedLaneId(lane.id)} type="button"><i aria-hidden="true"/><span><strong>{lane.name}</strong><small>{fallback ? "Workspace Fallback · " : ""}{policySummary(policy)}</small></span><code>{lane.id.slice(0, 8)}</code></button>
            <div className="lane-card-actions"><button aria-label={`Move ${lane.name} up`} disabled={state === "saving" || index === 0} onClick={() => reorder(lane, -1)} type="button">↑</button><button aria-label={`Move ${lane.name} down`} disabled={state === "saving" || index === activeLanes.length - 1} onClick={() => reorder(lane, 1)} type="button">↓</button><button aria-pressed={fallback} disabled={state === "saving" || fallback} onClick={() => void apply([{ kind: "set_fallback_lane", laneId: lane.id }])} type="button">{fallback ? "Fallback" : "Make fallback"}</button></div>
          </article>;
        })}
        <form className="lane-create" onSubmit={(event) => { event.preventDefault(); void createLane(); }}><label><span>New Lane</span><input aria-label="New Lane name" maxLength={120} onChange={(event) => setNewLaneName(event.target.value)} placeholder="e.g. Waiting on me" value={newLaneName}/></label><button disabled={state === "saving" || !newLaneName.trim()} type="submit">Create Lane</button></form>
      </section>
      <aside className="lane-policy-panel" aria-label="Selected Lane Policy">{selectedLane && selectedPolicy ? <>
        <span>Lane identity · {selectedLane.id.slice(0, 8)}</span><div className="lane-name-edit"><input aria-label="Lane name" defaultValue={selectedLane.name} key={`${selectedLane.id}:${selectedLane.revision}`} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== selectedLane.name) void apply([{ kind: "update_lane", laneId: selectedLane.id, name, expectedRevision: selectedLane.revision }]); }}/></div>
        <h2>Default Lane Policy</h2><p>Defaults guide attention in this Lane. They never grant provider deletion.</p>
        <label>Visibility<select value={selectedPolicy.visibility} onChange={(event) => void apply([{ kind: "update_lane_policy", policyId: selectedPolicy.id, visibility: event.target.value as LanePolicy["visibility"], expectedRevision: selectedPolicy.revision }])}><option value="prominent">Prominent</option><option value="standard">Standard</option><option value="muted">Muted</option></select></label>
        <label>Interruption<select value={selectedPolicy.interruption} onChange={(event) => void apply([{ kind: "update_lane_policy", policyId: selectedPolicy.id, interruption: event.target.value as LanePolicy["interruption"], expectedRevision: selectedPolicy.revision }])}><option value="notify">Notify</option><option value="badge">Badge only</option><option value="quiet">Quiet</option></select></label>
        <label>Review<select value={selectedPolicy.review} onChange={(event) => void apply([{ kind: "update_lane_policy", policyId: selectedPolicy.id, review: event.target.value as LanePolicy["review"], expectedRevision: selectedPolicy.revision }])}><option value="continuous">Continuous</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="manual">Manual</option></select></label>
        <label>Retention<select value={selectedPolicy.retention.mode === "keep" ? "keep" : String(selectedPolicy.retention.days)} onChange={(event) => void apply([{ kind: "update_lane_policy", policyId: selectedPolicy.id, retention: event.target.value === "keep" ? { mode: "keep", days: null } : { mode: "review_after", days: Number(event.target.value) }, expectedRevision: selectedPolicy.revision }])}><option value="keep">Keep in Orca</option><option value="30">Review after 30 days</option><option value="90">Review after 90 days</option></select></label>
        <div className="lane-provider-boundary"><span aria-hidden="true">✓</span><p><strong>Provider mail stays untouched.</strong> Lane retention is an Orca review default; deletion authority is always false.</p></div>
        <button className="lane-retire" disabled={state === "saving" || selectedLane.id === configuration.fallbackLaneId} onClick={() => void apply([{ kind: "update_lane", laneId: selectedLane.id, retired: true, expectedRevision: selectedLane.revision }])} type="button">Retire Lane</button>
      </> : <p>Select a Lane to inspect its stable identity and Policy.</p>}</aside>
    </div> : null}
  </section>;
}

function demoPlacement(accountId: string, threadId: string): ThreadLanePlacement {
  return { ...structuredClone(organizationFallbackPlacementFixture), accountId, threadId, revision: 1 };
}

export function ThreadLaneControls({ accountId, threadId, demoMode = false }: { accountId: string; threadId: string; demoMode?: boolean }) {
  const [configuration, setConfiguration] = useState<OrganizationLaneConfiguration | null>(demoMode ? organizationLaneConfigurationFixture : null);
  const [placement, setPlacement] = useState<ThreadLanePlacement | null>(demoMode ? demoPlacement(accountId, threadId) : null);
  const [state, setState] = useState<LoadState>(demoMode ? "ready" : "loading");
  const [drawer, setDrawer] = useState<"controls" | "evidence" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (demoMode) { setPlacement(demoPlacement(accountId, threadId)); return; }
    const controller = new AbortController();
    void readJson(`/v1/organization/query?accountId=${encodeURIComponent(accountId)}&threadId=${encodeURIComponent(threadId)}&attention=all&classification=all&limit=1`, { signal: controller.signal }).then((body) => {
      const parsed = organizationQueryResponseSchema.parse(body); const thread = parsed.threads[0];
      if (!thread) throw new Error("Thread placement is unavailable");
      setConfiguration(parsed.laneConfiguration); setPlacement(thread.organization.lanePlacement); setState("ready");
    }).catch((reason) => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Placement unavailable"); setState("error"); } });
    return () => controller.abort();
  }, [accountId, demoMode, threadId]);

  useEffect(() => {
    if (!drawer) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); setDrawer(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); window.requestAnimationFrame(() => previous?.focus()); };
  }, [drawer]);

  const lane = useMemo(() => configuration?.lanes.find((item) => item.id === placement?.primaryLaneId) ?? null, [configuration, placement]);
  async function apply(action: OrganizationLaneAction) {
    if (!configuration || !placement || state === "saving") return;
    setState("saving"); setError(null);
    try {
      if (demoMode) {
        const at = new Date().toISOString();
        if (action.kind === "set_thread_manual_override") setPlacement({ ...placement, primaryLaneId: action.laneId ?? configuration.fallbackLaneId, manualOverride: action.laneId ? { laneId: action.laneId, actor: { id: "demo-human", type: "human" }, reason: action.reason, updatedAt: at } : null, evidence: action.laneId ? { winningSource: "manual_override", sourceId: action.laneId, precedenceLevel: "2_manual_override", actor: { id: "demo-human", type: "human" }, reason: action.reason } : demoPlacement(accountId, threadId).evidence, revision: (placement.revision ?? 0) + 1 });
        if (action.kind === "set_thread_safety_lock") setPlacement({ ...placement, safetyLock: { locked: action.locked, actor: { id: "demo-human", type: "human" }, reason: action.reason, updatedAt: at }, revision: (placement.revision ?? 0) + 1 });
        setConfiguration({ ...configuration, workspaceRevision: configuration.workspaceRevision + 1 });
      } else {
        const body = await readJson("/v1/organization/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: nextId(), idempotencyKey: `web:thread-lane:${nextId()}`, expectedWorkspaceRevision: configuration.workspaceRevision, actions: [action] }) });
        const parsed = organizationLaneApplyResponseSchema.parse(body); setConfiguration(parsed.laneConfiguration); setPlacement(parsed.placements[0] ?? placement);
      }
      setState("ready");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Nothing changed"); setState("error"); }
  }

  return <div className="thread-lane-controls">
    <button aria-expanded={drawer === "controls"} className="thread-lane-trigger" disabled={!placement} onClick={() => setDrawer("controls")} type="button"><span>Lane</span><strong>{lane?.name ?? (state === "loading" ? "Loading…" : "Unavailable")}</strong></button>
    <button aria-expanded={drawer === "evidence"} className="thread-lane-why" disabled={!placement} onClick={() => setDrawer("evidence")} type="button">Why is this here?</button>
    {drawer ? <div className="thread-lane-layer" role="presentation"><button aria-label="Close Lane drawer" className="thread-lane-backdrop" onClick={() => setDrawer(null)} tabIndex={-1} type="button"/><aside aria-label={drawer === "controls" ? "Thread Lane controls" : "Thread placement evidence"} aria-modal="true" className="thread-lane-drawer" ref={drawerRef} role="dialog"><header><div><span>{drawer === "controls" ? "Manual organization" : "Placement evidence"}</span><h2>{drawer === "controls" ? "Choose this Thread’s Lane" : "Why is this here?"}</h2></div><button aria-label="Close" onClick={() => setDrawer(null)} type="button">×</button></header>
      {error ? <p className="thread-lane-error" role="alert">{error}</p> : null}
      {drawer === "controls" && configuration && placement ? <>
        <div className="thread-lane-options" role="group" aria-label="Manual Override Lane">{configuration.lanes.filter((item) => !item.retiredAt).map((item) => <button aria-pressed={placement.primaryLaneId === item.id} disabled={state === "saving" || placement.safetyLock.locked} key={item.id} onClick={() => void apply({ kind: "set_thread_manual_override", accountId, threadId, laneId: item.id, reason: `Human selected ${item.name} from the Thread reader.`, expectedThreadRevision: placement.revision })} type="button"><span>{item.name}</span><small>{item.id === configuration.fallbackLaneId ? "Workspace Fallback" : "Manual Override"}</small></button>)}</div>
        <button className="thread-clear-override" disabled={state === "saving" || placement.safetyLock.locked || !placement.manualOverride} onClick={() => void apply({ kind: "set_thread_manual_override", accountId, threadId, laneId: null, reason: "Human cleared the Manual Override from the Thread reader.", expectedThreadRevision: placement.revision })} type="button">Clear Manual Override</button>
        <section className="thread-safety-lock"><div><span>Safety Lock</span><strong>{placement.safetyLock.locked ? "Locked by you" : "Changes allowed"}</strong><p>Prevents Orca rules and Manual Overrides from changing this Thread’s Lane until you unlock it.</p></div><button aria-pressed={placement.safetyLock.locked} disabled={state === "saving"} onClick={() => void apply({ kind: "set_thread_safety_lock", accountId, threadId, locked: !placement.safetyLock.locked, reason: placement.safetyLock.locked ? "Human unlocked the Thread after review." : "Human protected this Thread placement from organizational changes.", expectedThreadRevision: placement.revision })} type="button">{placement.safetyLock.locked ? "Unlock" : "Lock placement"}</button></section>
      </> : placement ? <div className="thread-evidence-grid"><section><span>Winning source</span><h3>{placement.evidence.winningSource.replaceAll("_", " ")}</h3><p>Source identity · {placement.evidence.sourceId}</p></section><section><span>Precedence level</span><h3>{placement.evidence.precedenceLevel.replaceAll("_", " ")}</h3><p>Safety Lock → Manual Override → Rule → Lane Policy → Workspace Fallback.</p></section><section><span>Actor</span><h3>{placement.evidence.actor.type} · {placement.evidence.actor.id}</h3><p>The accountable identity behind the winning decision.</p></section><section><span>Reason</span><h3>{placement.evidence.reason}</h3><p>Primary Lane · {lane?.name ?? placement.primaryLaneId}</p></section>{placement.safetyLock.locked ? <section className="thread-evidence-lock"><span>Safety Lock active</span><h3>{placement.safetyLock.reason}</h3><p>{placement.safetyLock.actor?.type} · {placement.safetyLock.actor?.id}</p></section> : null}</div> : null}
      <footer><span>Account scope · {accountId.slice(0, 12)}</span><strong>Provider mail is never moved or deleted.</strong></footer>
    </aside></div> : null}
  </div>;
}
