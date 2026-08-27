import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { organizationLaneConfigurationFixture, organizationViewsFixture } from "@orca/shared";
import { evaluateOrcaRules } from "../../api/src/organization/rules/evaluator.ts";
import { reviewerEvaluationInput } from "../../api/src/organization/rules/evaluator-fixtures.ts";
import { OrganizationStudio } from "./desktop-switch";

const browserGlobals = ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Element", "Node", "Event", "InputEvent", "MouseEvent", "KeyboardEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;
const reviewTrace = evaluateOrcaRules(reviewerEvaluationInput()).trace;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/dev/inbox?destination=organization" });
  const values: Record<string, unknown> = {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
    Element: browserWindow.Element, Node: browserWindow.Node, Event: browserWindow.Event, InputEvent: browserWindow.InputEvent,
    MouseEvent: browserWindow.MouseEvent, KeyboardEvent: browserWindow.KeyboardEvent,
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  globalThis.fetch = originalFetch;
  for (const name of browserGlobals) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browserWindow.close();
});

function button(container: unknown, label: string) {
  const found = [...(container as HTMLElement).querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  return found as unknown as HTMLButtonElement;
}

async function click(target: HTMLButtonElement) {
  await act(async () => { target.click(); await Promise.resolve(); });
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function compileSuccess(source: string, revision: number, workspaceSchemaRevision: number) {
  const createdAt = "2026-08-26T12:00:00.000Z";
  return {
    ok: true as const,
    rule: { id: "rule-production-failures", workspaceId: "workspace-demo", name: "Production failures", latestRevision: revision, activeRevisionId: null, position: 0, createdAt, updatedAt: createdAt },
    revision: {
      id: `rule-revision-${revision}`, ruleId: "rule-production-failures", workspaceId: "workspace-demo", revision, source,
      sourceDigest: `sha256:${String(revision).repeat(64)}`,
      compiled: {
        languageVersion: 1, workspaceId: "workspace-demo", workspaceSchemaRevision, name: "Production failures", event: { kind: "message.received" as const },
        predicates: [{ name: null, expression: { kind: "compare" as const, field: "subject", operator: "contains" as const, value: "failed", valueType: "text" as const, optional: false, missingBehavior: "false" as const } }],
        actions: [{ kind: "route_lane" as const, laneId: "lane-everything-else" }], because: "A failed deploy blocks work and needs a human response",
        requiredCapabilities: ["organization_thread" as const], risk: "low" as const,
      },
      actor: { id: "human-demo", type: "human" as const }, createdAt,
    },
    diagnostics: [] as [],
  };
}

function describeResponse(workspaceRevision: number) {
  return {
    workspaceId: "workspace-demo",
    accountIds: ["account-demo"],
    workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
    capabilities: {
      operations: { describe: true, query: true, simulate: true, apply: true, revert: true },
      surfaces: {
        rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true },
        mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false },
      },
      authority: { sendMail: false, deleteProviderMail: false },
    },
    workspaceRevision,
    facetDefinitions: [],
    workflowStates: [],
    laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision },
  };
}

describe("OrganizationStudio integration", () => {
  test("shows proposed, simulated, active, and reverted Rule states across Tide Table and Glass Box", async () => {
    const requests: string[] = [];
    let simulationCalls = 0;
    const simulationId = `sha256:${"a".repeat(64)}`;
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (url === "/v1/organization/views") return Response.json({ workspaceId: "workspace-demo", workspaceRevision: 7, items: [] });
      if (url === "/v1/organization/describe") return Response.json(describeResponse(7));
      if (url === "/v1/organization/evaluations/latest") return Response.json({ trace: null });
      if (url === "/v1/organization/rules/compile" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { source: string; workspaceSchemaRevision: number };
        return Response.json(compileSuccess(payload.source, 1, payload.workspaceSchemaRevision), { status: 201 });
      }
      if (url === "/v1/organization/rules/rule-production-failures/simulate") {
        simulationCalls += 1;
        return Response.json({
        simulationId,
        state: simulationCalls === 1 ? "conflicted" : "simulated",
        binding: { ruleId: "rule-production-failures", revisionId: "rule-revision-1", ruleRevision: 1, sourceDigest: `sha256:${"1".repeat(64)}`, workspaceSchemaRevision: 7, workspaceRevision: 8, ruleSetRevision: 1 },
        scope: { accountIds: ["account-demo"], maximumThreads: 500 },
        counts: { evaluatedThreads: 2418, affectedThreads: 14, candidateActions: 17, conflicts: simulationCalls === 1 ? 1 : 0 },
        laneChanges: [{ fromLaneId: "lane-everything", toLaneId: "lane-focus", count: 14 }],
        facetChanges: [],
        representativeThreads: [
          { accountId: "account-demo", threadId: "thread-failure", subject: "Production checkout failed", lane: { before: "lane-everything", after: "lane-focus" }, facets: [], conflictCount: simulationCalls === 1 ? 1 : 0, traceId: reviewTrace.id },
          { accountId: "account-demo", threadId: "thread-live-failure", subject: "Later production deploy failed", lane: { before: "lane-everything", after: "lane-focus" }, facets: [], conflictCount: 0, traceId: reviewTrace.id },
        ],
        reviews: [
          { accountId: "account-demo", threadId: "thread-failure", trace: reviewTrace },
          { accountId: "account-demo", threadId: "thread-live-failure", trace: { ...structuredClone(reviewTrace), id: "evaluation:live-review", event: { ...structuredClone(reviewTrace.event), id: "event-live-review", threadId: "thread-live-failure" } } },
        ],
        conflicts: simulationCalls === 1 ? [{ accountId: "account-demo", threadId: "thread-failure", slot: "lane", winningCandidateId: "candidate-manual", losingCandidateIds: ["candidate-rule"] }] : [], losingRules: [], risk: "medium",
        attentionImpact: { notifications: 3, interruptionsSuppressed: 0, estimatedMinutesSaved: 6 },
      });
      }
      if (url === "/v1/organization/rules/rule-production-failures/activate") return Response.json({
        changeSetId: "change-active", status: "active", operation: "apply", ruleId: "rule-production-failures", revisionId: "rule-revision-1", simulationId,
        revertsChangeSetId: null, workspaceRevisionBefore: 8, workspaceRevisionAfter: 9, ruleSetRevisionAfter: 2, traceCount: 1, risk: "medium", conflicts: [],
      });
      if (url === "/v1/organization/change-sets/change-active") return Response.json({
        changeSet: { id: "change-active", operation: "apply", status: "active", simulationId, risk: "medium", revertsChangeId: null, revertedByChangeId: null, workspaceRevisionBefore: 8, workspaceRevisionAfter: 9, authorityTrace: { decision: "approved", actor: "human-demo" }, createdAt: "2026-08-26T12:05:00.000Z" },
        trace: [reviewTrace], actions: [{ position: 0, kind: "activate_rule_revision", resourceFamily: "rule", resourceId: "rule-production-failures", before: null, after: { revisionId: "rule-revision-1" } }],
        inverse: { threads: [{ threadId: "thread-failure" }] }, resultingRevisions: { workspace: 9 },
      });
      if (url === "/v1/organization/change-sets/change-revert") return Response.json({
        changeSet: { id: "change-revert", operation: "revert", status: "active", simulationId, risk: "medium", revertsChangeId: "change-active", revertedByChangeId: null, workspaceRevisionBefore: 9, workspaceRevisionAfter: 10, authorityTrace: { decision: "approved", actor: "human-demo" }, createdAt: "2026-08-26T12:06:00.000Z" },
        trace: [reviewTrace], actions: [{ position: 0, kind: "restore_thread", resourceFamily: "thread", resourceId: "thread-failure", before: { lane: "lane-focus" }, after: { lane: "lane-everything" } }],
        inverse: { reapply: "change-active" }, resultingRevisions: { workspace: 10 },
      });
      if (url === "/v1/organization/change-sets/change-active/revert") return Response.json({
        changeSetId: "change-revert", status: "reverted", operation: "revert", ruleId: "rule-production-failures", revisionId: "rule-revision-1", simulationId,
        revertsChangeSetId: "change-active", workspaceRevisionBefore: 9, workspaceRevisionAfter: 10, ruleSetRevisionAfter: 3, traceCount: 1, risk: "medium", conflicts: [],
      });
      if (url.includes("/results")) return Response.json({ viewId: "none", viewRevision: 1, accountIds: [], items: [], nextCursor: null, limit: 25 });
      throw new Error(`Unexpected request ${method} ${url}`);
    }) as typeof fetch;

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<OrganizationStudio />));
    await flush(); await flush();

    await click(button(container, "Tide Table"));
    await click(button(container, "Compile immutable revision"));
    await flush(); await flush();
    expect(container.querySelector('[data-lifecycle-state="proposed"]')).not.toBeNull();

    await click(button(container, "Simulate history"));
    await flush(); await flush();
    expect(container.querySelector('[data-lifecycle-state="conflicted"]')).not.toBeNull();
    expect(container.querySelector('[data-operation-state="conflict"]')).not.toBeNull();
    expect(container.textContent).toContain("candidate-manual");

    await click(button(container, "Simulate history"));
    await flush(); await flush();
    expect(container.querySelector('[data-lifecycle-state="simulated"]')).not.toBeNull();
    expect(container.textContent).toContain("2,418");
    expect(container.textContent).toContain("Production checkout failed");
    expect(container.textContent).toContain("Later production deploy failed");
    expect(container.textContent).toContain("Exact winner");
    expect(container.textContent).toContain("Losers");

    await click(button(container, "Activate Change Set"));
    await flush(); await flush();
    expect(container.querySelector('[data-lifecycle-state="active"]')).not.toBeNull();
    expect(container.textContent).toContain("1 complete Trace");
    expect(container.textContent).toContain("activate_rule_revision");
    expect(container.textContent).toContain("Authority & approval evidence");
    expect(container.textContent).toContain("Resulting revisions");

    await click(button(container, "Review revert"));
    await click(button(container, "Apply compensating revert"));
    await flush(); await flush();
    expect(container.querySelector('[data-lifecycle-state="reverted"]')).not.toBeNull();
    expect(container.textContent).toContain("Audit history preserved");
    expect(requests).toContain("POST /v1/organization/change-sets/change-active/revert");
  });

  test("keeps the interactive preview local while Tide Table remains demonstrably interactive", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname : new URL(request.url).pathname;
      requests.push(path);
      throw new Error(`Interactive preview must not fetch ${path}`);
    }) as unknown as typeof fetch;
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<OrganizationStudio interactivePreview />));

    await click(button(container, "Tide Table"));
    expect(container.textContent).toContain("Local demo adapter ready");
    await click(button(container, "Compile local demo"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 950)); });

    expect(requests).toEqual([]);
    expect(container.textContent).toContain("Local demo revision 1 compiled");
    expect(container.textContent).toContain("Not persisted or activated");
  });

  test("renders the deterministic full review and every distinct operational-state label", async () => {
    globalThis.fetch = (async (request: string | URL | Request) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname : new URL(request.url).pathname;
      if (path === "/docs/assets/bre-315-trace-fixture.json") return Response.json({ trace: reviewTrace });
      throw new Error(`Unexpected evidence request ${path}`);
    }) as typeof fetch;
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<OrganizationStudio interactivePreview releaseEvidenceState="transaction_failure" />));
    await flush(); await flush();

    expect(container.querySelector('[data-operation-state="transaction_failure"]')).not.toBeNull();
    for (const label of ["ready", "loading", "unavailable", "no access", "offline", "transaction failure", "conflict", "active", "reverted"]) {
      expect(container.querySelector(".bre320-state-matrix")?.textContent).toContain(label);
    }
    expect(container.textContent).toContain("Production checkout failed");
    expect(container.textContent).toContain("Production payments failed");
    expect(container.textContent).toContain("Exact winner");
    expect(container.textContent).toContain("Ordered actions & audit");
    expect(container.textContent).toContain("activate_rule_revision");
    expect(container.textContent).toContain("Provider send · absent");
    expect(container.textContent).toContain("Provider delete · absent");
  });

  test("rebinds Views and Lanes after Rule compilation and every sibling Workspace mutation", async () => {
    let workspaceRevision = 7;
    let viewItems = structuredClone(organizationViewsFixture);
    const mutationRevisions: Array<{ kind: "compile" | "view" | "lane"; expected: number }> = [];
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/describe" && method === "GET") return Response.json(describeResponse(workspaceRevision));
      if (path === "/v1/organization/views" && method === "GET") return Response.json({ workspaceId: "workspace-demo", workspaceRevision, items: viewItems });
      if (path.includes("/results") && method === "GET") {
        const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? viewItems[0]!.id;
        const view = viewItems.find((candidate) => candidate.id === viewId)!;
        return Response.json({ viewId, viewRevision: view.revision, accountIds: [], items: [], nextCursor: null, limit: 25 });
      }
      if (path === "/v1/organization/rules/compile" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { workspaceSchemaRevision: number; source: string };
        mutationRevisions.push({ kind: "compile", expected: payload.workspaceSchemaRevision });
        if (payload.workspaceSchemaRevision !== workspaceRevision) return Response.json({ error: { message: "stale compile" } }, { status: 409 });
        workspaceRevision += 1;
        return Response.json(compileSuccess(payload.source, 1, payload.workspaceSchemaRevision), { status: 201 });
      }
      if (path === "/v1/organization/views/reorder" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { expectedWorkspaceRevision: number };
        mutationRevisions.push({ kind: "view", expected: payload.expectedWorkspaceRevision });
        if (payload.expectedWorkspaceRevision !== workspaceRevision) return Response.json({ error: { message: `stale View r${payload.expectedWorkspaceRevision}; current r${workspaceRevision}` } }, { status: 409 });
        workspaceRevision += 1;
        viewItems = [viewItems[1]!, viewItems[0]!, ...viewItems.slice(2)].map((view, position) => ({ ...view, position, revision: view.revision + (position < 2 ? 1 : 0) }));
        return Response.json({ workspaceId: "workspace-demo", workspaceRevision, items: viewItems });
      }
      if (path === "/v1/organization/apply" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { expectedWorkspaceRevision: number; actions: unknown[] };
        mutationRevisions.push({ kind: "lane", expected: payload.expectedWorkspaceRevision });
        if (payload.expectedWorkspaceRevision !== workspaceRevision) return Response.json({ error: { message: `stale Lane r${payload.expectedWorkspaceRevision}; current r${workspaceRevision}` } }, { status: 409 });
        workspaceRevision += 1;
        return Response.json({ changeSetId: "change-lane-fallback", workspaceId: "workspace-demo", workspaceRevision, appliedActions: payload.actions.length, laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision, fallbackLaneId: "lane_focus" }, placements: [] });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<OrganizationStudio />));
    await flush(); await flush();

    await click(button(container, "Tide Table"));
    await click(button(container, "Compile immutable revision"));
    await flush(); await flush();
    expect(container.textContent).toContain("Workspace r8");

    await click(container.querySelector('[aria-label="Move Weekly production review down"]') as unknown as HTMLButtonElement);
    await flush(); await flush();
    expect(container.querySelector(".view-state-error")).toBeNull();
    expect(container.textContent).toContain("Workspace r9");

    await click(button(container, "Make fallback"));
    await flush(); await flush();
    expect(container.querySelector(".lane-error")).toBeNull();
    expect(container.textContent).toContain("Workspace r10");
    expect(mutationRevisions).toEqual([
      { kind: "compile", expected: 7 },
      { kind: "view", expected: 8 },
      { kind: "lane", expected: 9 },
    ]);
  });

  test("ignores pre-compile View and Lane reads that resolve after the canonical refresh", async () => {
    let resolveStaleViews!: (response: Response) => void;
    let resolveStaleLanes!: (response: Response) => void;
    const staleViews = new Promise<Response>((resolve) => { resolveStaleViews = resolve; });
    const staleLanes = new Promise<Response>((resolve) => { resolveStaleLanes = resolve; });
    let viewReads = 0;
    let describeReads = 0;
    let workspaceRevision = 7;
    const canonicalViews = organizationViewsFixture.map((view, index) => index === 0 ? { ...view, name: "Canonical after compile" } : view);
    globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
      const path = typeof request === "string" ? request : request instanceof URL ? request.pathname + request.search : new URL(request.url).pathname + new URL(request.url).search;
      const method = init?.method ?? "GET";
      if (path === "/v1/organization/views" && method === "GET") {
        viewReads += 1;
        return viewReads === 1 ? staleViews : Response.json({ workspaceId: "workspace-demo", workspaceRevision, items: canonicalViews });
      }
      if (path === "/v1/organization/describe" && method === "GET") {
        describeReads += 1;
        return describeReads === 1 ? staleLanes : Response.json(describeResponse(workspaceRevision));
      }
      if (path.includes("/results")) {
        const viewId = /\/views\/([^/]+)\/results/.exec(path)?.[1] ?? canonicalViews[0]!.id;
        const view = canonicalViews.find((candidate) => candidate.id === viewId)!;
        return Response.json({ viewId, viewRevision: view.revision, accountIds: [], items: [], nextCursor: null, limit: 25 });
      }
      if (path === "/v1/organization/rules/compile" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { workspaceSchemaRevision: number; source: string };
        workspaceRevision = 8;
        return Response.json(compileSuccess(payload.source, 1, payload.workspaceSchemaRevision), { status: 201 });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }) as typeof fetch;

    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(<OrganizationStudio />));
    await click(button(container, "Tide Table"));
    await click(button(container, "Compile immutable revision"));
    await flush(); await flush();
    expect(container.textContent).toContain("Canonical after compile");
    expect(container.textContent).toContain("Workspace r8");

    await act(async () => {
      resolveStaleViews(Response.json({ workspaceId: "workspace-demo", workspaceRevision: 7, items: organizationViewsFixture }));
      resolveStaleLanes(Response.json(describeResponse(7)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Canonical after compile");
    expect(container.textContent).toContain("Workspace r8");
    expect(container.textContent).not.toContain("Workspace r7");
  });
});
