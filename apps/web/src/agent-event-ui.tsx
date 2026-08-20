import { useState, type Ref } from "react";
import type { AgentEventKind, AgentEventLifecycleState, AgentPropagationMuteRule, PropagatedAgentEvent } from "@orca/shared";

export type AgentEventControlAction =
  | { action: "mark_seen" | "dismiss" | "restore" | "mark_false_positive" }
  | { action: "snooze"; until: string }
  | { action: "mute"; target: { scope: "sender_address" | "sender_domain" | "event_kind"; value: string } };

type AgentEventTimelineProps = {
  accountLabels?: Record<string, string>;
  events: PropagatedAgentEvent[];
  mutes?: AgentPropagationMuteRule[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  busyEventId: string | null;
  actionErrors: Record<string, string>;
  onAction: (event: PropagatedAgentEvent, action: AgentEventControlAction) => void;
  onOpenSource: (event: PropagatedAgentEvent) => void;
  onUnmute?: (event: PropagatedAgentEvent, mute: AgentPropagationMuteRule) => void;
  onRetry: () => void;
  sourceButtonRef?: (eventId: string) => Ref<HTMLButtonElement>;
};

const quietedStates = new Set<AgentEventLifecycleState>(["dismissed", "snoozed", "muted", "false_positive", "retracted"]);

const kindLabels: Record<AgentEventKind, string> = {
  release_available: "Release available",
  ci_or_deploy_failure: "CI / deploy failure",
  security_or_account_alert: "Security / account alert",
  receipt_or_renewal: "Receipt / renewal",
  travel_or_booking_change: "Travel / booking change",
  marketing_or_newsletter: "Marketing / newsletter",
  other: "Other",
};

const stateLabels: Record<AgentEventLifecycleState, string> = {
  new: "New",
  seen: "Seen",
  dismissed: "Dismissed",
  snoozed: "Snoozed",
  muted: "Muted",
  false_positive: "Not useful",
  retracted: "Retracted",
};

export function agentEventKindLabel(kind: AgentEventKind) {
  return kindLabels[kind];
}

export function agentEventStateLabel(state: AgentEventLifecycleState) {
  return stateLabels[state];
}

export function AgentEventTimeline({
  accountLabels = {},
  events,
  mutes = [],
  status,
  error,
  busyEventId,
  actionErrors,
  onAction,
  onOpenSource,
  onUnmute,
  onRetry,
  sourceButtonRef,
}: AgentEventTimelineProps) {
  const [showQuieted, setShowQuieted] = useState(false);
  const active = events.filter((event) => !quietedStates.has(event.lifecycle.state));
  const quieted = events.filter((event) => quietedStates.has(event.lifecycle.state));
  const visible = showQuieted ? [...active, ...quieted] : active;

  if (status === "idle" || (status === "ready" && events.length === 0)) return null;

  return (
    <section aria-labelledby="orca-signals-title" className="agent-events">
      <header className="agent-events-heading">
        <div>
          <p>Orca signals · local estimates</p>
          <h2 id="orca-signals-title">Worth a look</h2>
          <span>Explainable events from automated mail. The original messages stay in Tideline and All mail.</span>
        </div>
        {status === "ready" && quieted.length ? (
          <button
            aria-controls="orca-signal-list"
            aria-pressed={showQuieted}
            className="agent-events-history-toggle"
            onClick={() => setShowQuieted((current) => !current)}
            type="button"
          >
            {showQuieted ? "Hide quieted" : `Review quieted (${quieted.length})`}
          </button>
        ) : null}
      </header>

      {status === "loading" ? (
        <div aria-label="Loading Orca signals" aria-live="polite" className="agent-events-loading">
          {[0, 1].map((index) => <div className="agent-event-skeleton" key={index}><span /><span /><span /></div>)}
          <span className="sr-only">Loading signals…</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="agent-events-error" role="alert">
          <div><strong>Signals could not load.</strong><span>{error ?? "Orca could not reach the local signal projection."}</span></div>
          <button onClick={onRetry} type="button">Try signals again</button>
        </div>
      ) : null}

      {status === "ready" ? (
        <ol className="agent-event-list" id="orca-signal-list">
          {visible.map((event) => {
            const busy = busyEventId === event.id;
            const inactive = quietedStates.has(event.lifecycle.state);
            const actionError = actionErrors[event.id];
            const senderDomain = event.source.sender.email.split("@").at(-1) ?? event.source.sender.email;
            const matchingMutes = mutes.filter((mute) => muteAppliesToEvent(mute, event));
            return (
              <li key={event.id}>
                <article className={`agent-event agent-event-${event.importance}${inactive ? " agent-event-quieted" : ""}`}>
                  <div aria-hidden="true" className="agent-event-mark">⌁</div>
                  <div className="agent-event-main">
                    <div className="agent-event-meta">
                      <span className="agent-event-estimate">Orca estimate</span>
                      <span>{agentEventKindLabel(event.eventKind)}</span>
                      <span>{event.importance} importance · {event.relevance.replace("_", " ")}</span>
                      <span>{formatAgentEventTime(event.source.receivedAt)}</span>
                    </div>
                    <div className="agent-event-title-line">
                      <h3>{event.title}</h3>
                      <span className={`agent-event-state agent-event-state-${event.lifecycle.state}`}>{agentEventStateLabel(event.lifecycle.state)}</span>
                      {event.lifecycle.revision > 1 ? <span className="agent-event-update">Updated · revision {event.lifecycle.revision}</span> : null}
                    </div>
                    <p className="agent-event-summary">{event.summary}</p>
                    <p className="agent-event-why"><strong>Why Orca surfaced this</strong><span>{event.whyThisMatters}</span></p>
                    <dl className="agent-event-source">
                      <div><dt>Source</dt><dd>{event.source.sender.name ?? event.source.sender.email} · {event.source.subject || "(no subject)"}</dd></div>
                      <div><dt>Account</dt><dd>{formatProvider(event.source.provider)} · {accountLabels[event.source.accountId] ?? event.source.accountId}</dd></div>
                      <div><dt>Rule</dt><dd>{event.provenance.policyVersion} · {event.provenance.executionMode.replace("_", " ")}</dd></div>
                    </dl>
                    {event.lifecycle.state === "snoozed" && event.lifecycle.snoozedUntil ? <p className="agent-event-disposition">Returns {formatAgentEventTime(event.lifecycle.snoozedUntil)}</p> : null}
                    {event.lifecycle.state === "false_positive" ? <p className="agent-event-disposition">Your correction only changes this local Orca projection. Human Signal and provider mail are unchanged.</p> : null}
                    {actionError ? <p className="agent-event-action-error" role="alert">{actionError}</p> : null}
                    <div className="agent-event-actions">
                      <button disabled={busy} onClick={() => onOpenSource(event)} ref={sourceButtonRef?.(event.id)} type="button">Open original</button>
                      {!inactive && event.lifecycle.state === "new" ? <button disabled={busy} onClick={() => onAction(event, { action: "mark_seen" })} type="button">Mark seen</button> : null}
                      {!inactive ? <button disabled={busy} onClick={() => onAction(event, { action: "dismiss" })} type="button">Dismiss</button> : null}
                      {!inactive ? <button disabled={busy} onClick={() => onAction(event, { action: "snooze", until: tomorrowAtNine() })} type="button">Snooze</button> : null}
                      {!inactive ? <button disabled={busy} onClick={() => onAction(event, { action: "mark_false_positive" })} type="button">Not useful</button> : null}
                      {!inactive ? (
                        <details className="agent-event-mute-menu">
                          <summary aria-disabled={busy || undefined}>Mute…</summary>
                          <div>
                            <button disabled={busy} onClick={() => onAction(event, { action: "mute", target: { scope: "sender_address", value: event.source.sender.email.trim().toLowerCase() } })} type="button">Mute {event.source.sender.name ?? event.source.sender.email}</button>
                            <button disabled={busy} onClick={() => onAction(event, { action: "mute", target: { scope: "sender_domain", value: senderDomain.toLowerCase() } })} type="button">Mute {senderDomain}</button>
                            <button disabled={busy} onClick={() => onAction(event, { action: "mute", target: { scope: "event_kind", value: event.eventKind } })} type="button">Mute {agentEventKindLabel(event.eventKind).toLowerCase()}</button>
                          </div>
                        </details>
                      ) : null}
                      {event.lifecycle.state === "muted" && matchingMutes.map((mute) => <button className="agent-event-restore" disabled={busy} key={mute.id} onClick={() => onUnmute?.(event, mute)} type="button">Unmute {muteTargetLabel(mute)}</button>)}
                      {inactive && event.lifecycle.state !== "retracted" ? <button className="agent-event-restore" disabled={busy || (event.lifecycle.state === "muted" && matchingMutes.length > 0)} onClick={() => onAction(event, { action: "restore" })} type="button">{event.lifecycle.state === "muted" ? "Restore event" : "Restore"}</button> : null}
                      {event.lifecycle.state === "muted" && matchingMutes.length ? <span className="agent-event-saving">Unmute the local rule before restoring the event.</span> : null}
                      {busy ? <span className="agent-event-saving" role="status">Saving locally…</span> : null}
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function tomorrowAtNine() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function formatAgentEventTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatProvider(provider: PropagatedAgentEvent["source"]["provider"]) {
  return provider === "gmail" ? "Gmail" : "Outlook";
}

function muteAppliesToEvent(mute: AgentPropagationMuteRule, event: PropagatedAgentEvent) {
  if (mute.accountId !== event.source.accountId) return false;
  if (mute.target.scope === "sender_address") return mute.target.value === event.source.sender.email.trim().toLowerCase();
  if (mute.target.scope === "sender_domain") return mute.target.value === (event.source.sender.email.split("@").at(-1) ?? "").toLowerCase();
  return mute.target.value === event.eventKind;
}

function muteTargetLabel(mute: AgentPropagationMuteRule) {
  if (mute.target.scope === "sender_address") return mute.target.value;
  if (mute.target.scope === "sender_domain") return mute.target.value;
  return agentEventKindLabel(mute.target.value).toLowerCase();
}
