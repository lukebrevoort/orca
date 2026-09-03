import { describe, expect, test } from "bun:test";

import { refreshMailboxThroughProvider, VISIBLE_MAILBOX_REVALIDATE_MS, startVisibleMailboxRevalidation } from "./mailbox-revalidation";

class VisibilityTarget extends EventTarget {
  visibilityState = "visible";
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function harness(load: (reason: "interval" | "focus" | "visibility" | "manual") => Promise<void>) {
  const visibility = new VisibilityTarget();
  const focus = new EventTarget();
  let intervalMs = 0;
  let interval: (() => void) | null = null;
  let cleared = false;
  const controller = startVisibleMailboxRevalidation({
    load,
    visibilitySource: visibility,
    focusSource: focus,
    scheduler: {
      setInterval(handler, milliseconds) {
        interval = handler;
        intervalMs = milliseconds;
        return 1;
      },
      clearInterval() { cleared = true; },
    },
  });
  return { controller, visibility, focus, get interval() { return interval; }, get intervalMs() { return intervalMs; }, get cleared() { return cleared; } };
}

describe("visible mailbox revalidation", () => {
  test("runs the same status, provider sync, inbox, status sequence used by the app", async () => {
    const calls: string[] = [];
    let statusRead = 0;
    const result = await refreshMailboxThroughProvider({
      readStatus: async () => {
        calls.push("GET /v1/sync/status");
        statusRead += 1;
        return statusRead === 1 ? "before" : "fresh";
      },
      sync: async () => { calls.push("POST /v1/sync/gmail"); },
      readInbox: async () => {
        calls.push("GET /v1/inbox");
        return ["message"];
      },
    });
    expect(calls).toEqual([
      "GET /v1/sync/status",
      "POST /v1/sync/gmail",
      "GET /v1/inbox",
      "GET /v1/sync/status",
    ]);
    expect(result).toEqual({ inbox: ["message"], status: "fresh" });
  });

  test("uses the 15 second target and skips every trigger while the tab is hidden", async () => {
    const reasons: string[] = [];
    const view = harness(async (reason) => { reasons.push(reason); });
    expect(view.intervalMs).toBe(VISIBLE_MAILBOX_REVALIDATE_MS);

    view.visibility.visibilityState = "hidden";
    view.interval?.();
    view.focus.dispatchEvent(new Event("focus"));
    view.visibility.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(reasons).toEqual([]);

    view.controller.stop();
    expect(view.cleared).toBe(true);
  });

  test("revalidates immediately when visible and coalesces focus, visibility, interval, and manual requests", async () => {
    const pending = deferred();
    const reasons: string[] = [];
    const view = harness(async (reason) => {
      reasons.push(reason);
      await pending.promise;
    });

    view.focus.dispatchEvent(new Event("focus"));
    view.visibility.dispatchEvent(new Event("visibilitychange"));
    view.interval?.();
    const manual = view.controller.revalidate("manual");
    await Promise.resolve();
    expect(reasons).toEqual(["focus"]);

    pending.resolve();
    await manual;
    await view.controller.revalidate("manual");
    expect(reasons).toEqual(["focus", "manual"]);
    view.controller.stop();
  });

  test("reports focus-to-fresh latency and releases the request slot after failures", async () => {
    let now = 10;
    let attempts = 0;
    const metrics: Array<{ reason: string; durationMs: number; outcome: string }> = [];
    const visibility = new VisibilityTarget();
    const focus = new EventTarget();
    const controller = startVisibleMailboxRevalidation({
      visibilitySource: visibility,
      focusSource: focus,
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      clock: () => now,
      observe: (metric) => metrics.push(metric),
      load: async () => {
        attempts += 1;
        now += 24;
        if (attempts === 1) throw new Error("offline");
      },
    });

    await expect(controller.revalidate("focus")).rejects.toThrow("offline");
    await controller.revalidate("focus");
    expect(metrics).toEqual([
      { reason: "focus", durationMs: 24, outcome: "error" },
      { reason: "focus", durationMs: 24, outcome: "fresh" },
    ]);
    controller.stop();
  });
});
