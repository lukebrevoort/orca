import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { OrcaEvaluationTrace } from "@orca/shared";

import { OrganizationStudio } from "./desktop-switch";

const styles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Element", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "getComputedStyle", "fetch"] as const;
const originals = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: Window;
let root: Root | null;

const trace: OrcaEvaluationTrace = {
  id: "evaluation:event-1:rules-1:7",
  event: { id: "event-1", kind: "message.received", cause: "provider", occurredAt: "2026-08-26T12:00:00.000Z", workspaceId: "workspace-1", accountId: "account-1", threadId: "thread-1", messageId: "message-1" },
  workspaceSchemaRevision: 7,
  ruleSet: { id: "rules-1", revision: 7 },
  logicalTime: "2026-08-26T12:00:00.000Z",
  actor: { id: "system:gmail-sync", type: "system" },
  capabilities: {
    id: "sync-capabilities", revision: 1, actor: { id: "system:gmail-sync", type: "system" },
    scope: { workspaceId: "workspace-1", accountIds: ["account-1"] }, operations: ["apply"],
    resourceFamilies: ["thread", "lane", "trace"], actionFamilies: ["organization_thread", "organization_attention"],
  },
  consideredRevisions: [{ ruleId: "rule-production", revisionId: "rule-production-r2", revision: 2, order: 0, eventMatched: true, predicateMatched: true, authorized: true, reason: "matched" }],
  observedValues: [{ field: "sender.domain", present: true, value: "vercel.com" }, { field: "sender.email", present: false }, { field: "subject", present: true, value: "Production deploy failed" }],
  predicateResults: [
    { revisionId: "rule-production-r2", predicate: "when:2", kind: "all", result: true, observedFields: ["sender.domain", "subject"] },
    { revisionId: "rule-production-r2", predicate: "known_sender", kind: "compare", result: false, observedFields: ["sender.email"] },
  ],
  candidates: [
    { candidateId: "rule:lane", action: { kind: "route_lane", laneId: "lane-focus" }, slot: "lane", precedence: "rule_revision", ruleOrder: 0, actionOrder: 0, actor: { id: "system:gmail-sync", type: "system" }, reason: "A failed deploy blocks work", authorized: true, revisionId: "rule-production-r2" },
    { candidateId: "lane-policy:notify", action: { kind: "notify", urgency: "immediate" }, slot: "attention", precedence: "lane_policy", ruleOrder: 0, actionOrder: 0, actor: { id: "system:lane-policy:focus", type: "system" }, reason: "Focus supplies immediate attention", authorized: true },
    { candidateId: "rule:delete", action: { kind: "propose_provider_deletion" }, slot: "provider_deletion", precedence: "rule_revision", ruleOrder: 0, actionOrder: 1, actor: { id: "system:gmail-sync", type: "system" }, reason: "Expired provider copy", authorized: false, revisionId: "rule-production-r2", missingCapabilities: ["provider_delete"] },
    { candidateId: "fallback:lane", action: { kind: "route_lane", laneId: "lane-fallback" }, slot: "lane", precedence: "workspace_fallback", ruleOrder: 0, actionOrder: 0, actor: { id: "system:workspace-fallback", type: "system" }, reason: "Workspace fallback", authorized: true },
  ],
  winners: [
    { candidateId: "rule:lane", action: { kind: "route_lane", laneId: "lane-focus" }, slot: "lane", precedence: "rule_revision", ruleOrder: 0, actionOrder: 0, actor: { id: "system:gmail-sync", type: "system" }, reason: "A failed deploy blocks work", authorized: true, revisionId: "rule-production-r2" },
    { candidateId: "lane-policy:notify", action: { kind: "notify", urgency: "immediate" }, slot: "attention", precedence: "lane_policy", ruleOrder: 0, actionOrder: 0, actor: { id: "system:lane-policy:focus", type: "system" }, reason: "Focus supplies immediate attention", authorized: true },
  ],
  losers: [
    { candidateId: "rule:delete", action: { kind: "propose_provider_deletion" }, slot: "provider_deletion", precedence: "rule_revision", ruleOrder: 0, actionOrder: 1, actor: { id: "system:gmail-sync", type: "system" }, candidateReason: "Expired provider copy", reason: "capability_denied", authorized: false, revisionId: "rule-production-r2", missingCapabilities: ["provider_delete"] },
    { candidateId: "fallback:lane", action: { kind: "route_lane", laneId: "lane-fallback" }, slot: "lane", precedence: "workspace_fallback", ruleOrder: 0, actionOrder: 0, actor: { id: "system:workspace-fallback", type: "system" }, candidateReason: "Workspace fallback", reason: "higher_precedence_candidate", authorized: true, winnerCandidateId: "rule:lane" },
  ],
  reason: "Production failures: A failed deploy blocks work",
  budget: { maximumRuleRevisions: 100, maximumPredicateSteps: 2_000, maximumCandidates: 1_000, maximumPredicateDepth: 16, ruleRevisions: 1, predicateSteps: 3, candidates: 2, exhausted: false },
};

const safetyTrace: OrcaEvaluationTrace = {
  ...structuredClone(trace),
  id: "evaluation:event-safety:rules-1:7",
  event: { ...trace.event, id: "event-safety", kind: "thread.updated", messageId: "message-2" },
  logicalTime: "2026-08-26T12:05:00.000Z",
  actor: { id: "system:gmail-sync", type: "system" },
  candidates: [
    { candidateId: "safety-lock:lane", action: { kind: "route_lane", laneId: "lane-focus" }, slot: "lane", precedence: "safety_lock", ruleOrder: 0, actionOrder: 0, actor: { id: "human-safety", type: "human" }, reason: "Hold the incident in Focus", authorized: true },
    { candidateId: "manual-override:lane", action: { kind: "route_lane", laneId: "lane-fallback" }, slot: "lane", precedence: "manual_override", ruleOrder: 0, actionOrder: 0, actor: { id: "human-manual", type: "human" }, reason: "Move after unlock", authorized: true },
  ],
  winners: [{ candidateId: "safety-lock:lane", action: { kind: "route_lane", laneId: "lane-focus" }, slot: "lane", precedence: "safety_lock", ruleOrder: 0, actionOrder: 0, actor: { id: "human-safety", type: "human" }, reason: "Hold the incident in Focus", authorized: true }],
  losers: [{ candidateId: "manual-override:lane", action: { kind: "route_lane", laneId: "lane-fallback" }, slot: "lane", precedence: "manual_override", ruleOrder: 0, actionOrder: 0, actor: { id: "human-manual", type: "human" }, candidateReason: "Move after unlock", reason: "higher_precedence_candidate", authorized: true, winnerCandidateId: "safety-lock:lane" }],
  reason: "Hold the incident in Focus",
};

let servedTrace: OrcaEvaluationTrace;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  servedTrace = structuredClone(trace);
  browser = new Window({ url: "http://localhost:5173/?destination=organization" });
  setGlobal("window", browser);
  setGlobal("document", browser.document);
  setGlobal("navigator", browser.navigator);
  setGlobal("HTMLElement", browser.HTMLElement);
  setGlobal("Node", browser.Node);
  setGlobal("Element", browser.Element);
  setGlobal("Event", browser.Event);
  setGlobal("MouseEvent", browser.MouseEvent);
  setGlobal("KeyboardEvent", browser.KeyboardEvent);
  setGlobal("MutationObserver", browser.MutationObserver);
  setGlobal("getComputedStyle", browser.getComputedStyle.bind(browser));
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "/v1/organization/evaluations/latest") return Response.json({ trace: servedTrace });
    return Response.json({ error: { code: "not_available" } }, { status: 503 });
  });
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = browser.document.createElement("main");
  browser.document.body.append(container);
  root = createRoot(container as unknown as Element);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  browser.close();
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

describe("Organization Glass Box Trace", () => {
  test("explains a live production-failure evaluation and opens its complete deterministic Trace", async () => {
    await act(async () => {
      root!.render(<OrganizationStudio />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(browser.document.body.textContent).toContain("Production failures");
    expect(browser.document.body.textContent).toContain("message.received");
    expect(browser.document.body.textContent).toContain("sender.domain = vercel.com");
    expect(browser.document.body.textContent).toContain("Route to lane-focus");
    expect(browser.document.body.textContent).toContain("A failed deploy blocks work");
    const open = [...browser.document.querySelectorAll("button")].find((button) => button.textContent === "Open complete Trace");
    expect(open?.disabled).toBe(false);
    act(() => open?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
    expect(browser.document.body.textContent).toContain("Deterministic Trace");
    const content = browser.document.body.textContent ?? "";
    expect(content).toContain("Event ID · event-1");
    expect(content).toContain("Logical time · 2026-08-26T12:00:00.000Z");
    expect(content).toContain("Rule Set · rules-1 · revision 7");
    expect(content).toContain("Workspace Schema · revision 7");
    expect(content).toContain("Top-level Actor · system · system:gmail-sync");
    expect(content).toContain("Rule rule-production · revision 2 · order 0");
    expect(content).toContain("Event matched yes · Predicate matched yes · Authorized yes");
    expect(content).toContain("known_sender · compare · false");
    expect(content).toContain("sender.email is missing");
    expect(content).toContain("rule:lane · Winner");
    expect(content).toContain("revision rule-production-r2 · rule order 0 · action order 0");
    expect(content).toContain("lane-policy:notify · Winner");
    expect(content).toContain("Proposal · Notify immediately");
    expect(content).toContain("system · system:lane-policy:focus");
    expect(content).toContain("rule:delete · Loser");
    expect(content).toContain("Authorization denied · missing provider_delete");
    expect(content).toContain("fallback:lane · Loser");
    expect(content).toContain("Winner link · rule:lane");
    expect(content).toContain("Snapshot sync-capabilities · revision 1");
    expect(content).toContain("Scope workspace workspace-1 · accounts account-1");
    expect(content).toContain("Operations · apply");
    expect(content).toContain("Resource families · thread · lane · trace");
    expect(content).toContain("Action families · organization_thread · organization_attention");
    expect(browser.document.body.textContent).toContain("3 / 2,000 predicate steps");
  });

  test("renders exact Safety Lock provenance and links the losing Manual Override", async () => {
    servedTrace = structuredClone(safetyTrace);
    await act(async () => {
      root!.render(<OrganizationStudio />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const open = [...browser.document.querySelectorAll("button")].find((button) => button.textContent === "Open complete Trace");
    act(() => open?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
    const content = browser.document.body.textContent ?? "";
    expect(content).toContain("thread.updated");
    expect(content).toContain("safety-lock:lane · Winner");
    expect(content).toContain("safety lock");
    expect(content).toContain("human · human-safety");
    expect(content).toContain("Hold the incident in Focus");
    expect(content).toContain("manual-override:lane · Loser");
    expect(content).toContain("human · human-manual");
    expect(content).toContain("Winner link · safety-lock:lane");
  });

  test("defines labeled default, hover, focus, selected, disabled, and Trace states with theme-safe tokens", () => {
    expect(styles).toContain(".organization-trace-trigger:hover");
    expect(styles).toContain(".organization-trace-trigger:focus-visible");
    expect(styles).toContain('.organization-editor nav button[aria-pressed="true"]');
    expect(styles).toContain(".organization-trace-trigger:disabled");
    expect(styles).toContain(".glass-live-trace");
    expect(styles).toContain("var(--desktop-surface-hover)");
    expect(styles).toContain("var(--desktop-border-strong)");
    expect(styles).toContain("var(--desktop-ink)");
    expect(styles).toContain(':root[data-theme="dark"] .glass-live-trace');
  });
});
