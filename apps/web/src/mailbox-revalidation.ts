export const VISIBLE_MAILBOX_REVALIDATE_MS = 15_000;
export const MAILBOX_REVALIDATION_EVENT = "orca:mailbox-revalidation";

export type MailboxRevalidationReason = "interval" | "focus" | "visibility" | "manual";

export type MailboxRevalidationMetric = {
  reason: MailboxRevalidationReason;
  durationMs: number;
  outcome: "fresh" | "error";
};

type VisibilitySource = EventTarget & { visibilityState: string };
type IntervalScheduler = {
  setInterval(handler: () => void, milliseconds: number): unknown;
  clearInterval(id: unknown): void;
};

type MailboxRevalidationOptions = {
  load: (reason: MailboxRevalidationReason) => Promise<void>;
  visibilitySource: VisibilitySource;
  focusSource: EventTarget;
  scheduler: IntervalScheduler;
  intervalMs?: number;
  clock?: () => number;
  observe?: (metric: MailboxRevalidationMetric) => void;
};

/**
 * One small interface hides the visible-tab lifecycle and its concurrency
 * invariant: at most one mailbox revalidation may be in flight.
 */
export function startVisibleMailboxRevalidation(options: MailboxRevalidationOptions) {
  const intervalMs = options.intervalMs ?? VISIBLE_MAILBOX_REVALIDATE_MS;
  const clock = options.clock ?? (() => performance.now());
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const revalidate = (reason: MailboxRevalidationReason): Promise<void> => {
    if (stopped || options.visibilitySource.visibilityState !== "visible") return Promise.resolve();
    if (inFlight) return inFlight;
    const startedAt = clock();
    const run = Promise.resolve()
      .then(() => options.load(reason))
      .then(() => {
        options.observe?.({ reason, durationMs: clock() - startedAt, outcome: "fresh" });
      }, (error) => {
        options.observe?.({ reason, durationMs: clock() - startedAt, outcome: "error" });
        throw error;
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
    return run;
  };

  const onFocus = () => { void revalidate("focus").catch(() => undefined); };
  const onVisibility = () => {
    if (options.visibilitySource.visibilityState === "visible") void revalidate("visibility").catch(() => undefined);
  };
  const intervalId = options.scheduler.setInterval(() => {
    void revalidate("interval").catch(() => undefined);
  }, intervalMs);
  options.focusSource.addEventListener("focus", onFocus);
  options.visibilitySource.addEventListener("visibilitychange", onVisibility);

  return {
    revalidate,
    stop() {
      if (stopped) return;
      stopped = true;
      options.scheduler.clearInterval(intervalId);
      options.focusSource.removeEventListener("focus", onFocus);
      options.visibilitySource.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

export function reportMailboxRevalidationMetric(metric: MailboxRevalidationMetric) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MAILBOX_REVALIDATION_EVENT, { detail: metric }));
  if (typeof performance?.measure === "function") {
    performance.measure(`orca.mailbox.${metric.reason}-to-${metric.outcome}`, {
      start: Math.max(0, performance.now() - metric.durationMs),
      duration: metric.durationMs,
      detail: metric,
    });
  }
}
