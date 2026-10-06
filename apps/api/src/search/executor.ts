import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MailSearchQueryError } from "@orca/shared/mail-search";
import type { MailCapabilities, MailProvider } from "@orca/shared/schemas";
import { MailboxScopeError } from "../mailbox/read.ts";
import { SearchError } from "./errors.ts";
import type { RankedSearchInput, RankedSearchResult } from "./read.ts";
import {
  rankedSearchProcessLimits, rankedSearchProtocolVersion, rankedSearchWorkerReplySchema,
  rankedSearchWorkerRequestSchema, type RankedSearchWorkerErrorCode, type RankedSearchWorkerRequest,
} from "./protocol.ts";

export { rankedSearchProcessLimits } from "./protocol.ts";
export type RankedSearchExecutionObservation = {
  queueWaitMs: number;
  processDurationMs: number;
  readerDurationMs: number | null;
  /** Linux executable VmHWM, null when unavailable or killed before a reply. */
  peakRssBytes: number | null;
};
export type RankedSearchExecutionOptions = {
  signal?: AbortSignal;
  capabilitiesFor?: (provider: MailProvider, scopes: string | null) => MailCapabilities;
  observe?: (observation: RankedSearchExecutionObservation) => void;
};
export type RankedSearchLifecycle = { event: "started" | "kill" | "closed"; pid: number | undefined; active: number };
type ExecutorOptions = {
  /** Trusted lifecycle-test fixtures only; never a client or environment knob. */
  workerPath?: string;
  deadlineMs?: number;
  queueWaitMs?: number;
  maxStdoutBytes?: number;
  onLifecycle?: (event: RankedSearchLifecycle) => void;
};
type Job = {
  request: RankedSearchWorkerRequest;
  payload: string;
  options: RankedSearchExecutionOptions;
  queuedAt: number;
  resolve: (result: RankedSearchResult) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  abort: () => void;
};

/** Reconstruct fixed, typed application errors without child-provided messages. */
export function rankedSearchErrorFromCode(code: RankedSearchWorkerErrorCode): Error {
  switch (code) {
    case "search_invalid_query": return new MailSearchQueryError(code, "Enter up to 200 characters using words or quoted phrases.");
    case "search_anchor_required": return new MailSearchQueryError(code, "Add a word or phrase with at least 3 characters. Short terms can accompany it, such as AI update.");
    case "no_accounts": return new MailboxScopeError();
    default: return new SearchError(code);
  }
}

/** Isolated harness for ordinary lifecycle tests. API and MCP must use the
 * singleton below so admission stays bounded across all callers in the process. */
export function createRankedSearchExecutor(testOptions: ExecutorOptions = {}) {
  let shuttingDown = false;
  let active = false;
  const queue: Job[] = [];
  const activeRuns = new Set<Promise<void>>();
  const activeCancels = new Set<() => void>();
  const workerPath = testOptions.workerPath ?? fileURLToPath(new URL("./worker.ts", import.meta.url));
  const deadlineMs = testOptions.deadlineMs ?? rankedSearchProcessLimits.deadlineMs;
  const queueWaitMs = testOptions.queueWaitMs ?? rankedSearchProcessLimits.queueWaitMs;
  const maxStdoutBytes = testOptions.maxStdoutBytes ?? rankedSearchProcessLimits.maxStdoutBytes;

  function lifecycle(event: RankedSearchLifecycle["event"], pid: number | undefined) {
    try { testOptions.onLifecycle?.({ event, pid, active: active ? 1 : 0 }); }
    catch { /* Diagnostic observers cannot change process ownership. */ }
  }
  function removeQueued(job: Job, error: Error) {
    const index = queue.indexOf(job);
    if (index === -1) return;
    queue.splice(index, 1);
    clearTimeout(job.queueTimer);
    job.options.signal?.removeEventListener("abort", job.abort);
    job.reject(error);
  }
  function drain() {
    if (shuttingDown || active) return;
    const job = queue.shift();
    if (!job) return;
    clearTimeout(job.queueTimer);
    job.options.signal?.removeEventListener("abort", job.abort);
    if (job.options.signal?.aborted) {
      job.reject(new SearchError("search_aborted"));
      drain();
      return;
    }
    active = true;
    const completion = run(job).then(job.resolve, job.reject).finally(() => {
      // run cannot settle until child close, including after cancellation,
      // timeout, pipe errors, or an over-budget response.
      active = false;
      activeRuns.delete(completion);
      drain();
    });
    activeRuns.add(completion);
  }

  async function run(job: Job): Promise<RankedSearchResult> {
    const startedAt = performance.now();
    let readerDurationMs: number | null = null;
    let peakRssBytes: number | null = null;
    try {
      // Fixed executable, no shell, no inherited credentials or .env loading.
      // Request text and cursor signing material travel only through stdin.
      const child = spawn(process.execPath, ["--no-env-file", "--smol", workerPath], {
        stdio: ["pipe", "pipe", "ignore"], env: { TZ: "UTC", LANG: "C.UTF-8" },
      });
      const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
      let failure: Error | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const terminate = (error: Error) => {
        if (failure) return;
        failure = error;
        lifecycle("kill", child.pid);
        child.kill("SIGKILL");
      };
      const abort = () => terminate(new SearchError("search_aborted"));
      const streamError = () => terminate(new SearchError("search_failed"));
      activeCancels.add(abort);
      const deadline = setTimeout(() => terminate(new SearchError("search_budget_exceeded")), deadlineMs);
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxStdoutBytes) { terminate(new SearchError("search_budget_exceeded")); return; }
        if (!failure) chunks.push(chunk);
      });
      child.stdout!.on("error", streamError);
      child.stdin!.on("error", streamError);
      child.on("error", streamError);
      job.options.signal?.addEventListener("abort", abort, { once: true });
      lifecycle("started", child.pid);
      if (job.options.signal?.aborted || shuttingDown) abort();
      let exitCode: number | null;
      try {
        try { child.stdin!.end(job.payload); } catch { streamError(); }
        exitCode = await closed;
      } finally {
        clearTimeout(deadline);
        activeCancels.delete(abort);
        job.options.signal?.removeEventListener("abort", abort);
        lifecycle("closed", child.pid);
      }
      if (failure) throw failure;
      if (exitCode !== 0) throw new SearchError("search_failed");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const reply = rankedSearchWorkerReplySchema.parse(JSON.parse(decoded));
      peakRssBytes = reply.peakRssBytes;
      if (!reply.ok) throw rankedSearchErrorFromCode(reply.code);
      const result = reply.result;
      readerDurationMs = result.metric.durationMs;
      if (result.page.coverage !== (job.request.mode === "full" ? "stored-plaintext" : "stored-metadata")
        || Boolean(result.counts) !== Boolean(job.request.exactCounts)
        || result.page.messages.length > job.request.query.limit) throw new SearchError("search_failed");
      const capabilityById = new Map(result.capabilityAccounts.map(account => [account.id, account]));
      const pageAccountIds = new Set(result.page.accounts.map(account => account.id));
      if (pageAccountIds.size !== result.page.accounts.length
        || capabilityById.size !== result.capabilityAccounts.length
        || capabilityById.size !== pageAccountIds.size) throw new SearchError("search_failed");
      for (const account of result.page.accounts) {
        const raw = capabilityById.get(account.id);
        if (!raw || raw.provider !== account.provider
          || job.request.authorization.accountIds && !job.request.authorization.accountIds.includes(account.id)) {
          throw new SearchError("search_failed");
        }
        if (job.options.capabilitiesFor) account.capabilities = job.options.capabilitiesFor(raw.provider, raw.scope);
      }
      for (const message of result.page.messages) {
        if (capabilityById.get(message.accountId)?.provider !== message.provider) throw new SearchError("search_failed");
      }
      return result;
    } catch (error) {
      if (error instanceof SearchError || error instanceof MailSearchQueryError || error instanceof MailboxScopeError) throw error;
      throw new SearchError("search_failed");
    } finally {
      try {
        job.options.observe?.({ queueWaitMs: startedAt - job.queuedAt, processDurationMs: performance.now() - startedAt, readerDurationMs, peakRssBytes });
      } catch { /* Observability must not fail an otherwise valid request. */ }
    }
  }

  return {
    read(input: RankedSearchInput, options: RankedSearchExecutionOptions = {}): Promise<RankedSearchResult> {
      if (shuttingDown) return Promise.reject(new SearchError("search_busy"));
      if (options.signal?.aborted) return Promise.reject(new SearchError("search_aborted"));
      if (!input.databasePath || input.databasePath === ":memory:" || input.databasePath.startsWith("file:")) {
        return Promise.reject(new SearchError("search_index_unavailable"));
      }
      const parsed = rankedSearchWorkerRequestSchema.safeParse({ ...input, version: rankedSearchProtocolVersion });
      if (!parsed.success) return Promise.reject(new SearchError("search_failed"));
      const payload = JSON.stringify(parsed.data);
      if (Buffer.byteLength(payload) > rankedSearchProcessLimits.maxRequestBytes) return Promise.reject(new SearchError("search_failed"));
      const userId = parsed.data.authorization.userId;
      if (queue.length >= rankedSearchProcessLimits.maxQueued
        || queue.filter(job => job.request.authorization.userId === userId).length >= rankedSearchProcessLimits.maxQueuedPerUser) {
        return Promise.reject(new SearchError("search_busy"));
      }
      return new Promise((resolve, reject) => {
        const job: Job = { request: parsed.data, payload, options, queuedAt: performance.now(), resolve, reject, abort: () => {} };
        job.abort = () => removeQueued(job, new SearchError("search_aborted"));
        queue.push(job);
        options.signal?.addEventListener("abort", job.abort, { once: true });
        job.queueTimer = setTimeout(() => removeQueued(job, new SearchError("search_busy")), queueWaitMs);
        drain();
      });
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const job of [...queue]) removeQueued(job, new SearchError("search_aborted"));
      for (const cancel of activeCancels) cancel();
      await Promise.all([...activeRuns]);
    },
  };
}

// One admission queue for API and MCP together. Never construct per request.
const executor = createRankedSearchExecutor();
export const executeRankedSearch = executor.read;
export const shutdownRankedSearch = executor.shutdown;
// Graceful API shutdown calls the awaited method. Explicit process.exit can only
// send the kill synchronously; deployment must terminate the whole process group
// when the API itself is forcibly killed and cannot run JavaScript cleanup.
process.once("exit", () => { void executor.shutdown(); });
