import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { TideTableEditor } from "./tide-table";

let browser: Window;
let root: Root;
const originals = new Map(["window", "document", "navigator", "HTMLElement", "Event", "MouseEvent"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

beforeEach(() => {
  browser = new Window({ url: "http://localhost:5173/?destination=organization" });
  for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Event: browser.Event, MouseEvent: browser.MouseEvent })) {
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
  test("authors accepted Orca v1 source and preserves located diagnostics", async () => {
    const requests: string[] = [];
    const requestBodies: unknown[] = [];
    const request = async (path: string, init?: RequestInit) => {
      requests.push(path);
      if (path === "/v1/organization/describe") return new Response(JSON.stringify({ workspaceRevision: 7 }), { status: 200 });
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: false, diagnostics: [{ severity: "error", phase: "resolve", code: "unknown_resource", message: "Lane 'Missing' does not exist.", span: { start: { offset: 86, line: 5, column: 1 }, end: { offset: 110, line: 5, column: 25 } }, hint: "Choose a Lane from this Workspace revision." }] }), { status: 422 });
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
});
