import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { TideTableEditor } from "./tide-table";

let browser: Window;
let root: Root;
const originals = new Map(["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "Event", "InputEvent", "MouseEvent"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

beforeEach(() => {
  browser = new Window({ url: "http://localhost:5173/?destination=organization" });
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, Event: browser.Event, InputEvent: browser.InputEvent, MouseEvent: browser.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  browser.close();
  for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete (globalThis as Record<string, unknown>)[name];
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
});

describe("TideTableEditor", () => {
  const compileSuccess = (source: string, revision: number, workspaceSchemaRevision: number) => ({
    ok: true as const,
    rule: {
      id: "rule-production-failures",
      workspaceId: "workspace-demo",
      name: "Production failures",
      latestRevision: revision,
      activeRevisionId: null,
      position: 0,
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: `2026-08-26T12:0${revision}:00.000Z`,
    },
    revision: {
      id: `rule-revision-${revision}`,
      ruleId: "rule-production-failures",
      workspaceId: "workspace-demo",
      revision,
      source,
      sourceDigest: `sha256:${String(revision).repeat(64)}`,
      compiled: {
        languageVersion: 1,
        workspaceId: "workspace-demo",
        workspaceSchemaRevision,
        name: "Production failures",
        event: { kind: "message.received" as const },
        predicates: [{ name: null, expression: { kind: "compare" as const, field: "subject", operator: "contains" as const, value: "failed", valueType: "text" as const, optional: false, missingBehavior: "false" as const } }],
        actions: [{ kind: "route_lane" as const, laneId: "lane-everything-else" }],
        because: "A failed deploy blocks work and needs a human response",
        requiredCapabilities: ["organization_thread" as const],
        risk: "low" as const,
      },
      actor: { id: "human-demo", type: "human" as const },
      createdAt: `2026-08-26T12:0${revision}:00.000Z`,
    },
    diagnostics: [] as [],
  });

  async function render(request: (path: string, init?: RequestInit) => Promise<Response>) {
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root.render(<TideTableEditor request={request} />));
    return container;
  }

  async function changeSource(textarea: HTMLTextAreaElement, source: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, source);
      textarea.dispatchEvent(new browser.InputEvent("input", { bubbles: true, data: source, inputType: "insertText" }) as unknown as Event);
      textarea.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
    });
  }

  function action(container: unknown, label: string) {
    const button = [...(container as HTMLElement).querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    expect(button, `button ${label}`).toBeDefined();
    return button as unknown as HTMLButtonElement;
  }

  test("authors accepted Orca v1 source and preserves located diagnostics", async () => {
    const requests: string[] = [];
    const requestBodies: unknown[] = [];
    const request = async (path: string, init?: RequestInit) => {
      requests.push(path);
      if (path === "/v1/organization/describe") return new Response(JSON.stringify({ workspaceRevision: 7 }), { status: 200 });
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        ok: false,
        diagnostics: [{ severity: "error", phase: "resolve", code: "unknown_resource", message: "Lane 'Missing' does not exist.", span: { start: { offset: 86, line: 5, column: 1 }, end: { offset: 110, line: 5, column: 25 } }, hint: "Choose a Lane from this Workspace revision." }],
        budget: {
          status: "complete", exhausted: [],
          limits: { maximumSourceBytes: 65_536, maximumLines: 1_000, maximumLineBytes: 2_000, maximumTokens: 8_000, maximumAstNodes: 1_000, maximumExpressionDepth: 16, maximumPredicates: 100, maximumActions: 100 },
          usage: { sourceBytes: 1, lines: 1, maximumLineBytes: 1, tokens: 1, astNodes: 1, expressionDepth: 1, predicates: 1, actions: 1 },
        },
      }), { status: 422 });
    };
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root.render(<TideTableEditor request={request} />));

    expect(container.textContent).toContain("Accepted Orca language · version 1");
    expect(container.textContent).toContain("Compile creates an immutable revision. It does not activate or execute the rule.");
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toContain("orca 1");
    await act(async () => (container.querySelector("button[type=button]") as unknown as HTMLButtonElement).click());

    expect(requests).toEqual(["/v1/organization/describe", "/v1/organization/rules/compile"]);
    expect(requestBodies[0]).toMatchObject({ expectedRuleRevision: null, workspaceSchemaRevision: 7 });
    expect((requestBodies[0] as { idempotencyKey?: string }).idempotencyKey).toMatch(/^rule-compile:/);
    expect(textarea.value).toContain("orca 1");
    expect(container.textContent).toContain("Line 5, column 1");
    expect(container.textContent).toContain("Lane 'Missing' does not exist.");
    expect(container.querySelector("[role=alert]")).not.toBeNull();
  });

  test("queues an edited generation behind a delayed create and appends to the returned Rule identity", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstCompile = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const compileBodies: string[] = [];
    let describeReads = 0;
    const request = async (path: string, init?: RequestInit) => {
      if (path === "/v1/organization/describe") return Response.json({ workspaceRevision: ++describeReads === 1 ? 7 : 8 });
      const body = String(init?.body);
      compileBodies.push(body);
      if (compileBodies.length === 1) return firstCompile;
      const payload = JSON.parse(body) as { source: string };
      return Response.json(compileSuccess(payload.source, 2, 8));
    };
    const container = await render(request);
    const textarea = container.querySelector("textarea") as unknown as HTMLTextAreaElement;
    const originalSource = textarea.value;

    await act(async () => { action(container, "Compile immutable revision").click(); await Promise.resolve(); });
    const editedSource = originalSource.replace("Production failures", "Production failures edited");
    await changeSource(textarea, editedSource);
    expect(textarea.disabled).toBe(false);
    expect(container.textContent).toContain("finish first");
    await act(async () => { action(container, "Queue next revision").click(); await Promise.resolve(); });
    expect(compileBodies).toHaveLength(1);

    await act(async () => {
      resolveFirst(Response.json(compileSuccess(originalSource, 1, 7), { status: 201 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(compileBodies).toHaveLength(2);
    const first = JSON.parse(compileBodies[0]!) as { ruleId?: string; idempotencyKey: string; expectedRuleRevision: number | null; workspaceSchemaRevision: number; source: string };
    const second = JSON.parse(compileBodies[1]!) as typeof first;
    expect(first).toMatchObject({ expectedRuleRevision: null, workspaceSchemaRevision: 7, source: originalSource });
    expect(first.ruleId).toBeUndefined();
    expect(second).toMatchObject({ ruleId: "rule-production-failures", expectedRuleRevision: 1, workspaceSchemaRevision: 8, source: editedSource });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(container.textContent).toContain("Rule revision 2");
    expect(container.textContent).toContain("Immutable revision 2 compiled");
  });

  test("retries a network-unknown compile with the byte-equivalent serialized request", async () => {
    const compileBodies: string[] = [];
    let describeReads = 0;
    const request = async (path: string, init?: RequestInit) => {
      if (path === "/v1/organization/describe") { describeReads += 1; return Response.json({ workspaceRevision: 7 }); }
      const body = String(init?.body);
      compileBodies.push(body);
      if (compileBodies.length === 1) throw new TypeError("Network connection lost after request write");
      return Response.json(compileSuccess(JSON.parse(body).source, 1, 7), { status: 201 });
    };
    const container = await render(request);

    await act(async () => { action(container, "Compile immutable revision").click(); await Promise.resolve(); });
    expect(container.textContent).toContain("outcome is unknown");
    await act(async () => { action(container, "Retry exact request").click(); await Promise.resolve(); });

    expect(describeReads).toBe(1);
    expect(compileBodies).toHaveLength(2);
    expect(compileBodies[1]).toBe(compileBodies[0]);
    expect(container.textContent).toContain("Immutable revision 1 compiled");
  });

  test("retries a parseable 5xx with the old Workspace revision and idempotency identity intact", async () => {
    const compileBodies: string[] = [];
    let describeReads = 0;
    const request = async (path: string, init?: RequestInit) => {
      if (path === "/v1/organization/describe") { describeReads += 1; return Response.json({ workspaceRevision: 7 }); }
      const body = String(init?.body);
      compileBodies.push(body);
      if (compileBodies.length === 1) return Response.json({ error: { code: "storage_unavailable", message: "Commit acknowledgement lost" } }, { status: 503 });
      return Response.json(compileSuccess(JSON.parse(body).source, 1, 7), { status: 201 });
    };
    const container = await render(request);

    await act(async () => { action(container, "Compile immutable revision").click(); await Promise.resolve(); });
    await act(async () => { action(container, "Retry exact request").click(); await Promise.resolve(); });

    expect(describeReads).toBe(1);
    expect(compileBodies[1]).toBe(compileBodies[0]);
    const payload = JSON.parse(compileBodies[1]!);
    expect(payload.workspaceSchemaRevision).toBe(7);
    expect(payload.idempotencyKey).toBe(JSON.parse(compileBodies[0]!).idempotencyKey);
  });
});
