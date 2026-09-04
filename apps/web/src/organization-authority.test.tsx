import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { organizationLaneConfigurationFixture } from "@orca/shared";
import { OrganizationAuthorityProvider, OrganizationRecoveryBanner, classifyOrganizationFailure, useOrganizationAuthority } from "./organization-authority";
import { OrganizationStudio } from "./desktop-switch";
import { ThreadLaneControls } from "./organization-lanes";
import { TopLayerProvider } from "./top-layer";

const browserGlobals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const originalFetch = globalThis.fetch;
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

function describeResponse(accountIds = ["account-demo"]) {
  return {
    workspaceId: "workspace-demo",
    accountIds,
    workspaceSchema: { revision: 4, aggregate: "thread", resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"], filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"] },
    capabilities: {
      operations: { describe: true, query: true, simulate: true, apply: true, revert: true },
      surfaces: {
        rest: { describe: true, query: true, simulate: true, apply: true, revert: true, correct: true },
        mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false },
      },
      authority: { sendMail: false, deleteProviderMail: false },
    },
    workspaceRevision: 7,
    facetDefinitions: [],
    workflowStates: [],
    laneConfiguration: { ...structuredClone(organizationLaneConfigurationFixture), workspaceRevision: 7 },
  };
}

function Harness() {
  const authority = useOrganizationAuthority();
  const [result, setResult] = useState("idle");
  return <>
    <OrganizationRecoveryBanner />
    <output data-testid="snapshot">{authority.snapshot ? "Workspace " + authority.snapshot.workspaceRevision : "No snapshot"}</output>
    <output data-testid="capability">{authority.state.canMutate ? "writable" : "read-only"}</output>
    <button disabled={!authority.state.canMutate} type="button">Change Organization</button>
    <button onClick={() => void authority.request("/v1/organization/partial", undefined, { hasReliableData: true }).catch(() => undefined)} type="button">Load partial</button>
    <button onClick={() => void authority.request("/v1/organization/mutate", { method: "POST" }, { operation: "mutation" }).then(() => setResult("sent")).catch(() => setResult("blocked"))} type="button">Force mutation</button>
    <output data-testid="result">{result}</output>
  </>;
}

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/?destination=organization" });
  const values: Record<string, unknown> = {
    window: browserWindow, document: browserWindow.document, navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement, Element: browserWindow.Element, Node: browserWindow.Node,
    Event: browserWindow.Event, MouseEvent: browserWindow.MouseEvent,
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

async function renderHarness() {
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => { root!.render(<OrganizationAuthorityProvider><Harness /></OrganizationAuthorityProvider>); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container as unknown as HTMLElement;
}

function action(container: HTMLElement) {
  return container.querySelector(".organization-recovery button,.organization-recovery a");
}

describe("BRE-369 shared Organization authority", () => {
  test("keeps loading geometry stable without presenting a premature recovery action", async () => {
    let resolveDescribe!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveDescribe = resolve; })) as unknown as typeof fetch;
    const container = await renderHarness();
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("loading");
    expect(action(container)).toBeNull();
    expect((container.querySelector("button[disabled]") as HTMLButtonElement).textContent).toBe("Change Organization");
    await act(async () => { resolveDescribe(Response.json(describeResponse())); await Promise.resolve(); });
  });

  test("classifies offline, session expiry, no access, partial data, and generic errors distinctly", () => {
    expect(classifyOrganizationFailure({ offline: true }).kind).toBe("offline");
    expect(classifyOrganizationFailure({ status: 401 }).kind).toBe("session_expired");
    expect(classifyOrganizationFailure({ status: 403 }).kind).toBe("no_access");
    expect(classifyOrganizationFailure({ status: 503, hasReliableData: true }).kind).toBe("partial");
    expect(classifyOrganizationFailure({ status: 503 }).kind).toBe("error");
  });

  for (const [status, kind, label] of [
    [401, "session_expired", "Reconnect session"],
    [403, "no_access", "Ask a Workspace owner"],
    [503, "error", "Retry Organization"],
  ] as const) {
    test("renders one coherent " + kind + " action and blocks mutation below the button", async () => {
      let mutationCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const path = String(input);
        if (path === "/v1/organization/describe") return Response.json({ error: { message: "Authority unavailable" } }, { status });
        if (path === "/v1/organization/mutate") mutationCalls += 1;
        return Response.json({});
      }) as typeof fetch;
      const container = await renderHarness();
      expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe(kind);
      expect(action(container)?.textContent).toBe(label);
      expect(container.querySelectorAll(".organization-recovery button,.organization-recovery a")).toHaveLength(1);
      expect((container.querySelector("button[disabled]") as HTMLButtonElement | null)?.textContent).toBe("Change Organization");
      const force = [...container.querySelectorAll("button")].find((button) => button.textContent === "Force mutation")!;
      await act(async () => { force.click(); await Promise.resolve(); });
      expect(container.querySelector('[data-testid="result"]')?.textContent).toBe("blocked");
      expect(mutationCalls).toBe(0);
    });
  }

  test("names empty account scope and offers exactly one connection action", async () => {
    globalThis.fetch = (async () => Response.json(describeResponse([]))) as unknown as typeof fetch;
    const container = await renderHarness();
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("empty");
    expect(action(container)?.textContent).toBe("Connect an account");
    expect(container.textContent).toContain("Nothing was removed or changed");
  });

  test("treats a valid 206 authority snapshot as partial and read-only", async () => {
    globalThis.fetch = (async () => Response.json(describeResponse(), { status: 206 })) as unknown as typeof fetch;
    const container = await renderHarness();
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("partial");
    expect(container.querySelector('[data-testid="snapshot"]')?.textContent).toBe("Workspace 7");
    expect(container.querySelector('[data-testid="capability"]')?.textContent).toBe("read-only");
    expect(action(container)?.textContent).toBe("Retry Organization");
  });

  test("applies no-access authority consistently to Views, Lanes, Tide Table, and lifecycle entry points", async () => {
    globalThis.fetch = (async () => Response.json({ error: { message: "Workspace owner approval is required" } }, { status: 403 })) as unknown as typeof fetch;
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => { root!.render(<OrganizationStudio />); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("no_access");
    expect((([...container.querySelectorAll("button")].find((button) => button.textContent === "+ New View")) as unknown as HTMLButtonElement).disabled).toBe(true);
    const tide = [...container.querySelectorAll("button")].find((button) => button.textContent === "Tide Table")!;
    await act(async () => { tide.click(); await Promise.resolve(); });
    expect((([...container.querySelectorAll("button")].find((button) => button.textContent === "Compile immutable revision")) as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelectorAll(".organization-recovery button,.organization-recovery a")).toHaveLength(1);
    expect(container.textContent).not.toContain("Sample messages");
    expect(container.textContent).not.toContain("Use Tide Table");
  });

  test("uses the same no-access recovery and mutation gate in Thread Lane controls", async () => {
    globalThis.fetch = (async () => Response.json({ error: { message: "Workspace owner approval is required" } }, { status: 403 })) as unknown as typeof fetch;
    const container = browserWindow.document.createElement("div");
    browserWindow.document.body.append(container);
    root = createRoot(container as unknown as Element);
    await act(async () => { root!.render(<TopLayerProvider><ThreadLaneControls accountId="account-a" threadId="thread-a" /></TopLayerProvider>); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const trigger = container.querySelector("button.thread-lane-trigger") as unknown as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain("Organization access is read-only");
    await act(async () => { trigger.click(); });
    const drawer = browserWindow.document.querySelector('[role="dialog"][aria-label="Thread Lane controls"]');
    expect(drawer?.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("no_access");
    expect(drawer?.querySelectorAll(".organization-recovery button,.organization-recovery a")).toHaveLength(1);
    expect(drawer?.textContent).toContain("No mutation request will be sent");
  });

  test("preserves the last reliable snapshot through a partial failure and retries coherently", async () => {
    let describeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input);
      if (path === "/v1/organization/describe") { describeCalls += 1; return Response.json(describeResponse()); }
      if (path === "/v1/organization/partial") return Response.json({ error: { message: "Trace refresh failed" } }, { status: 503 });
      return Response.json({});
    }) as typeof fetch;
    const container = await renderHarness();
    expect(container.querySelector('[data-testid="snapshot"]')?.textContent).toBe("Workspace 7");
    const load = [...container.querySelectorAll("button")].find((button) => button.textContent === "Load partial")!;
    await act(async () => { load.click(); await Promise.resolve(); });
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("partial");
    expect(container.querySelector('[data-testid="snapshot"]')?.textContent).toBe("Workspace 7");
    expect(action(container)?.textContent).toBe("Retry Organization");
    await act(async () => { (action(container) as HTMLButtonElement).click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector("[data-organization-authority]")).toBeNull();
    expect(describeCalls).toBe(2);
  });

  test("reacts to connectivity truth without discarding reliable data", async () => {
    globalThis.fetch = (async () => Response.json(describeResponse())) as unknown as typeof fetch;
    const container = await renderHarness();
    Object.defineProperty(browserWindow.navigator, "onLine", { configurable: true, value: false });
    await act(async () => { browserWindow.dispatchEvent(new browserWindow.Event("offline")); });
    expect(container.querySelector("[data-organization-authority]")?.getAttribute("data-organization-authority")).toBe("offline");
    expect(container.querySelector('[data-testid="snapshot"]')?.textContent).toBe("Workspace 7");
    expect(action(container)?.textContent).toBe("Retry connection");
  });
});
