/** Synthetic loopback fixture only: keep a JSON response incomplete during UI inspection. */
export type InboxRefreshTerminalReason = "explicit" | "expired" | "cancelled";

// Empirical XCTest budgets: three/five possible 60s idle waits plus 60s overhead.
// These affect only synthetic fixture response lifetime, never app networking.
export const inboxRefreshDeadlines = Object.freeze({ default: 120_000, controls: 240_000, switch: 360_000 });
export type InboxRefreshScenario = keyof typeof inboxRefreshDeadlines;

export function inboxRefreshScenario(parameters: URLSearchParams): InboxRefreshScenario {
  if ([...parameters.keys()].some(key => key !== "scenario") || parameters.getAll("scenario").length > 1) {
    throw new RangeError("Only one named refresh scenario is accepted");
  }
  const scenario = parameters.get("scenario") ?? "default";
  if (scenario !== "default" && scenario !== "controls" && scenario !== "switch") {
    throw new RangeError("Unknown refresh scenario");
  }
  return scenario;
}

/** Empty POSTs can have a non-null body stream (runtime/transport dependent). */
export async function inboxRefreshArmBodyIsEmpty(request: Request, timeoutMs = 250): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 250) throw new RangeError("Invalid arm body read budget");
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^0+$/.test(length.trim())) {
    void request.body?.cancel().catch(() => {});
    return false;
  }
  if (request.body === null) return true;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    // Do not aggregate an arbitrary body. Stop at its first nonempty chunk;
    // cap zero-sized chunks too, so an adversarial source cannot starve timers.
    for (let reads = 0; reads < 16; reads += 1) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk === null) return false;
      if (chunk.done) { complete = true; return true; }
      if (chunk.value.byteLength !== 0) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class InboxRefreshGate {
  readonly started: Promise<void>;
  readonly finished: Promise<InboxRefreshTerminalReason>;
  private markStarted!: () => void;
  private markFinished!: (reason: InboxRefreshTerminalReason) => void;
  private claimed = false;
  private holding = false;
  private streaming = false;
  private reason: InboxRefreshTerminalReason | undefined;
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private bytes: Uint8Array | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private removeAbortListener: (() => void) | undefined;
  private readonly keepAliveMs: number;

  constructor(options: { keepAliveMs?: number; deadlineMs?: number } = {}) {
    this.keepAliveMs = options.keepAliveMs ?? 5_000;
    const deadlineMs = options.deadlineMs ?? inboxRefreshDeadlines.default;
    if (!Number.isFinite(this.keepAliveMs) || this.keepAliveMs < 1 || this.keepAliveMs > 5_000
      || !Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > inboxRefreshDeadlines.switch) {
      throw new RangeError("Refresh gate timings must be positive and bounded (5s heartbeat, 360s deadline)");
    }
    this.started = new Promise(resolve => { this.markStarted = resolve; });
    this.finished = new Promise(resolve => { this.markFinished = resolve; });
    this.deadline = setTimeout(() => this.finish("expired"), deadlineMs);
  }

  get pending(): boolean { return this.reason === undefined; }
  get terminalReason(): InboxRefreshTerminalReason | undefined { return this.reason; }
  get active(): boolean { return this.pending && this.streaming; }

  claim(): boolean {
    if (!this.pending || this.claimed) return false;
    this.claimed = true;
    return true;
  }

  /** A historical started promise is not proof that a response is still held. */
  async waitForStart(): Promise<boolean> {
    await Promise.race([this.started, this.finished]);
    return this.active;
  }

  async hold(response: Response, signal?: AbortSignal): Promise<Response> {
    if (!this.claimed || this.holding) throw new Error("Claim the refresh gate exactly once before holding a response");
    this.holding = true;
    if (!this.pending) throw new Error(`Refresh gate ${this.reason}`);
    // Failures must remain failures; never turn them into a successful fixture hold.
    if (!response.ok || !response.body) {
      this.cancel();
      return response;
    }
    const abort = () => this.cancel();
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      this.removeAbortListener = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
    try {
      // The real app response is already decoded. Its transfer metadata no longer applies.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const stopped = this.finished.then(reason => { throw new Error(`Refresh gate ${reason}`); });
      try {
        for (;;) {
          const chunk = await Promise.race([reader.read(), stopped]);
          if (chunk.done) break;
          chunks.push(chunk.value);
          size += chunk.value.byteLength;
        }
      } finally {
        if (!this.pending) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      this.bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        this.bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (!this.pending) throw new Error(`Refresh gate ${this.reason}`);
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      const body = new ReadableStream<Uint8Array>({
        start: controller => {
          this.controller = controller;
          this.streaming = true;
          const emit = () => controller.enqueue(new Uint8Array([0x20]));
          emit();
          this.heartbeat = setInterval(emit, this.keepAliveMs);
          this.markStarted();
        },
        cancel: () => { this.cancel(); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      this.cancel();
      this.bytes = undefined;
      throw error;
    }
  }

  release(): boolean {
    if (!this.active) return false;
    this.finish("explicit");
    return true;
  }

  cancel(): void { this.finish("cancelled"); }

  private finish(reason: InboxRefreshTerminalReason): void {
    if (!this.pending) return;
    this.reason = reason;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    this.deadline = undefined;
    this.heartbeat = undefined;
    this.removeAbortListener?.();
    this.removeAbortListener = undefined;
    if (this.controller) {
      if (reason === "explicit") {
        this.controller.enqueue(this.bytes!);
        this.controller.close();
      } else {
        // An expired/cancelled fixture must not masquerade as a released JSON response.
        this.controller.error(new Error(`Refresh gate ${reason}`));
      }
    }
    this.controller = undefined;
    this.bytes = undefined;
    this.streaming = false;
    this.markFinished(reason);
  }
}
