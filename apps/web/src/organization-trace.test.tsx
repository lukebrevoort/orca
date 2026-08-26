import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { OrcaEvaluationTrace } from "@orca/shared";

import { evaluateOrcaRules } from "../../api/src/organization/rules/evaluator.ts";
import { reviewerEvaluationInput } from "../../api/src/organization/rules/evaluator-fixtures.ts";
import { OrganizationStudio } from "./desktop-switch";

const styles = await Bun.file(new URL("./desktop-switch.css", import.meta.url)).text();
const globals = ["window", "document", "navigator", "HTMLElement", "Node", "Element", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "getComputedStyle", "fetch"] as const;
const originals = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: Window;
let root: Root | null;

const trace = evaluateOrcaRules(reviewerEvaluationInput()).trace;
const safetyTrace = evaluateOrcaRules(reviewerEvaluationInput({ safetyLock: true })).trace;

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

    expect(browser.document.body.textContent).toContain("Rule · rule-production");
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
    expect(content).toContain("ticket_present · exists · false");
    expect(content).toContain("facet:facet-ticket is missing");
    expect(content).toContain("rule:rule-production:rule-production-r2:0 · Winner");
    expect(content).toContain("revision rule-production-r2 · rule order 0 · action order 0");
    expect(content).toContain("lane-policy:policy-focus:attention · Loser");
    expect(content).toContain("Proposal · Notify immediately");
    expect(content).toContain("system · system:lane-policy:policy-focus");
    expect(content).toContain("rule:rule-production:rule-production-r2:3 · Loser");
    expect(content).toContain("Authorization denied · missing provider_delete");
    expect(content).toContain("workspace-fallback:lane · Loser");
    expect(content).toContain("Winner link · rule:rule-production:rule-production-r2:0");
    expect(content).toContain("Snapshot sync-capabilities · revision 1");
    expect(content).toContain("Scope workspace workspace-1 · accounts account-1");
    expect(content).toContain("Operations · apply");
    expect(content).toContain("Resource families · thread · lane · workflow_state · trace");
    expect(content).toContain("Action families · organization_thread · organization_attention");
    expect(browser.document.body.textContent).toContain("4 / 2,000 predicate steps");
  });

  test("renders exact Safety Lock provenance and links the losing Manual Override", async () => {
    servedTrace = structuredClone(safetyTrace);
    await act(async () => {
      root!.render(<OrganizationStudio />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(browser.document.querySelector("#organization-title")?.textContent).toBe("Safety Lock");
    expect(browser.document.querySelector(".glass-because strong")?.textContent).toBe("Hold the incident in Focus");
    expect(browser.document.querySelector(".glass-because small")?.textContent).toBe("human Actor · human-safety");
    const open = [...browser.document.querySelectorAll("button")].find((button) => button.textContent === "Open complete Trace");
    act(() => open?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
    const content = browser.document.body.textContent ?? "";
    expect(content).toContain("message.received");
    expect(content).toContain("safety-lock:lane · Winner");
    expect(content).toContain("safety lock");
    expect(content).toContain("human · human-safety");
    expect(content).toContain("Hold the incident in Focus");
    expect(content).toContain("manual-override:lane · Loser");
    expect(content).toContain("human · human-manual");
    expect(content).toContain("Winner link · safety-lock:lane");
    expect(content).toContain("rule:rule-production:rule-production-r2:0 · Loser");
    expect(content).toContain("Reason · Hold the incident in Focus");
  });

  test("keeps the browser reviewer fixture identical to real evaluator output", async () => {
    const fixture = await Bun.file(new URL("../public/docs/assets/bre-315-trace-fixture.json", import.meta.url)).json() as { trace: OrcaEvaluationTrace };
    expect(fixture.trace).toEqual(safetyTrace);
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
