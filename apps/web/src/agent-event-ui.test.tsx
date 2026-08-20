import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { applyDemoAgentEventAction, readDemoAgentEvents } from "./App";
import { demoAgentEvents, demoSuppressedAgentAssessment } from "./demo-data";
import { AgentEventTimeline } from "./agent-event-ui";

const noop = () => {};

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
