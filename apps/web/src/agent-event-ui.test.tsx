import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

import { applyDemoAgentEventAction, readDemoAgentEvents } from "./App";
import { demoAgentEvents, demoAgentMutes, demoSuppressedAgentAssessment } from "./demo-data";
import { AgentEventTimeline } from "./agent-event-ui";

const noop = () => {};
const browserGlobals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"] as const;
const originalGlobals = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/" });
  const values: Record<string, unknown> = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    Node: browserWindow.Node,
    Event: browserWindow.Event,
    MouseEvent: browserWindow.MouseEvent,
    KeyboardEvent: browserWindow.KeyboardEvent,
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  for (const name of browserGlobals) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browserWindow.close();
});

async function renderTimeline(overrides: Partial<ComponentProps<typeof AgentEventTimeline>> = {}) {
  const props: ComponentProps<typeof AgentEventTimeline> = {
    actionErrors: {},
    busyEventId: null,
    error: null,
    events: demoAgentEvents,
    mutes: demoAgentMutes,
    onAction: noop,
    onOpenSource: noop,
    onRetry: noop,
    status: "ready",
    ...overrides,
  };
  const container = browserWindow.document.createElement("div");
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<AgentEventTimeline {...props} />));
  return {
    container,
    rerender: async (next: Partial<ComponentProps<typeof AgentEventTimeline>>) => {
      Object.assign(props, next);
      await act(async () => root!.render(<AgentEventTimeline {...props} />));
    },
  };
}

describe("propagated agent event timeline", () => {
  test("explains active estimates without presenting raw automated mail as human", () => {
    const html = renderToStaticMarkup(
      <AgentEventTimeline
        actionErrors={{}}
        busyEventId={null}
        error={null}
        events={demoAgentEvents}
        onAction={noop}
        onOpenSource={noop}
        onRetry={noop}
        status="ready"
      />,
    );

    expect(html).toContain("Orca signals · local estimates");
    expect(html).toContain("Why Orca surfaced this");
    expect(html).toContain("Open original");
    expect(html).toContain("m6-v0 · deterministic");
    expect(html).toContain("Review quieted (4)");
    expect(html).not.toContain("definitely human");
    expect(html).not.toContain("definitely AI");
    expect(html).not.toContain("Possible itinerary change");
  });

  test("renders bounded loading, error, and disabled control states", () => {
    const loading = renderToStaticMarkup(<AgentEventTimeline actionErrors={{}} busyEventId={null} error={null} events={demoAgentEvents} onAction={noop} onOpenSource={noop} onRetry={noop} status="loading" />);
    const failed = renderToStaticMarkup(<AgentEventTimeline actionErrors={{ [demoAgentEvents[0]!.id]: "Local save failed." }} busyEventId={demoAgentEvents[0]!.id} error={null} events={demoAgentEvents} onAction={noop} onOpenSource={noop} onRetry={noop} status="ready" />);
    const listError = renderToStaticMarkup(<AgentEventTimeline actionErrors={{}} busyEventId={null} error="Local projection unavailable." events={demoAgentEvents} onAction={noop} onOpenSource={noop} onRetry={noop} status="error" />);

    expect(loading).toContain("Loading signals");
    expect(failed).toContain("Local save failed.");
    expect(failed).toContain("disabled");
    expect(failed).toContain("Saving locally…");
    expect(listError).toContain('role="alert"');
    expect(listError).toContain("Try signals again");
  });

  test("disables lifecycle writes across every card while preserving source navigation", async () => {
    let actionCalls = 0;
    let sourceCalls = 0;
    const { container, rerender } = await renderTimeline({
      onAction: () => { actionCalls += 1; },
      onOpenSource: () => { sourceCalls += 1; },
    });

    const reviewQuieted = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Review quieted"));
    expect(reviewQuieted).toBeDefined();
    await act(async () => reviewQuieted!.click());
    await rerender({ busyEventId: demoAgentEvents[0]!.id });
    const cards = [...container.querySelectorAll("article.agent-event")];
    expect(cards).toHaveLength(demoAgentEvents.length);

    for (const card of cards) {
      const buttons = [...card.querySelectorAll("button")];
      const source = buttons.find((button) => button.textContent === "Open original");
      expect(source?.disabled).toBe(false);
      expect(buttons.filter((button) => button !== source).every((button) => button.disabled)).toBe(true);
    }

    const otherCard = cards.find((card) => card.textContent?.includes("The production deploy failed again"));
    const otherSource = [...(otherCard?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Open original");
    const otherDismiss = [...(otherCard?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Dismiss");
    expect(otherSource).toBeDefined();
    expect(otherDismiss).toBeDefined();
    await act(async () => {
      otherDismiss!.click();
      otherSource!.click();
    });
    expect(actionCalls).toBe(0);
    expect(sourceCalls).toBe(1);
  });

  test("keeps a busy Mute summary closed and out of keyboard focus", async () => {
    const { container, rerender } = await renderTimeline();
    let details = container.querySelector("details.agent-event-mute-menu")!;
    let summary = details.querySelector("summary")!;

    expect(summary.getAttribute("aria-disabled")).toBeNull();
    expect(summary.getAttribute("tabindex")).toBeNull();
    await act(async () => summary.click());
    expect(details.hasAttribute("open")).toBe(true);

    await rerender({ busyEventId: demoAgentEvents[0]!.id });
    details = container.querySelector("details.agent-event-mute-menu")!;
    summary = details.querySelector("summary")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(summary.getAttribute("aria-disabled")).toBe("true");
    expect(summary.getAttribute("tabindex")).toBe("-1");

    const pointerClick = new browserWindow.MouseEvent("click", { bubbles: true, cancelable: true });
    const enter = new browserWindow.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    let pointerAllowed = true;
    let keyboardAllowed = true;
    await act(async () => {
      pointerAllowed = summary.dispatchEvent(pointerClick);
      keyboardAllowed = summary.dispatchEvent(enter);
      await Promise.resolve();
    });
    expect(pointerAllowed).toBe(false);
    expect(keyboardAllowed).toBe(false);
    expect(pointerClick.defaultPrevented).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    expect(details.hasAttribute("open")).toBe(false);
  });

  test("moves focus to source navigation before a Mute write closes its menu", async () => {
    let actionCalls = 0;
    const { container, rerender } = await renderTimeline({ onAction: () => { actionCalls += 1; } });
    const details = container.querySelector("details.agent-event-mute-menu")!;
    const summary = details.querySelector("summary")!;
    await act(async () => summary.click());
    const muteOption = details.querySelector("button")!;
    muteOption.focus();
    expect(browserWindow.document.activeElement).toBe(muteOption);

    await act(async () => muteOption.click());
    const source = details.closest(".agent-event-actions")!.querySelector("button")!;
    expect(actionCalls).toBe(1);
    expect(browserWindow.document.activeElement).toBe(source);

    await rerender({ busyEventId: demoAgentEvents[0]!.id });
    expect(details.hasAttribute("open")).toBe(false);
    expect(browserWindow.document.activeElement).toBe(source);
  });

  test("keeps an in-flight quieted card and its failure announcement visible", async () => {
    const quieted = demoAgentEvents.find((event) => event.lifecycle.state === "dismissed")!;
    const { container, rerender } = await renderTimeline();
    const historyToggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Review quieted"))!;
    await act(async () => historyToggle.click());
    expect(container.textContent).toContain(quieted.title);

    await rerender({ busyEventId: quieted.id });
    expect(historyToggle.hasAttribute("disabled")).toBe(true);
    await act(async () => historyToggle.click());
    expect(container.textContent).toContain(quieted.title);
    expect(container.textContent).toContain("Saving locally…");

    await rerender({ busyEventId: null, actionErrors: { [quieted.id]: "Local save failed." } });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Local save failed.");
    expect(container.textContent).toContain(quieted.title);
  });

  test("keeps demo lifecycle actions durable and independent of the source assessment", () => {
    const source = demoAgentEvents[0]!;
    const dismissed = applyDemoAgentEventAction(source, { action: "dismiss" }, new Date("2026-08-20T10:00:00.000Z"));
    const restored = applyDemoAgentEventAction(dismissed, { action: "restore" }, new Date("2026-08-20T10:01:00.000Z"));
    const storage = { getItem: () => JSON.stringify({ [source.id]: dismissed.lifecycle }) };

    expect(dismissed.lifecycle.state).toBe("dismissed");
    expect(dismissed.lifecycle.revision).toBe(source.lifecycle.revision + 1);
    expect(restored.lifecycle.state).toBe("new");
    expect(readDemoAgentEvents(storage).find((event) => event.id === source.id)?.lifecycle.state).toBe("dismissed");
    expect(dismissed.humanClassification).toEqual(source.humanClassification);
    expect(dismissed.source).toEqual(source.source);
    expect(demoSuppressedAgentAssessment.destination).toBe("none");
    expect(demoSuppressedAgentAssessment.reasonCodes).toEqual(["routine_bulk_content"]);
  });
});
