import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MailCapabilities, MailProvider } from "@orca/shared";

import type { MailboxReadAuthorization, MailboxReadQuery, MailboxReadResult } from "./read.ts";
import { MailboxCursorError, MailboxScopeError } from "./read.ts";
import { MailSearchAdmissionError, MailSearchUnavailableError } from "./search-index.ts";
import {
  mailSearchProcessLimits, mailSearchWorkerReplySchema, mailSearchWorkerRequestSchema,
  type MailSearchWorkerReply, type MailSearchWorkerRequest,
} from "./search-worker.ts";

export { mailSearchProcessLimits } from "./search-worker.ts";

export class MailSearchExecutionError extends Error {
  constructor(readonly code: "search_busy" | "search_aborted" | "search_invalid_request" | "search_database_unavailable" | "search_failed") {
    const messages = {
      search_busy: "Mail search is busy. Please try again shortly.",
      search_aborted: "Mail search was cancelled.",
      search_invalid_request: "Invalid internal mail search request.",
      search_database_unavailable: "Mail search requires an available file-backed database.",
      search_failed: "Mail search could not complete. Please try again.",
    };
    super(messages[code]);
    this.name = "MailSearchExecutionError";
  }
}

export type MailSearchExecutionInput = {
  /** Explicit, absolute filename supplied by the server's database factory.
   * In-memory databases deliberately have no synchronous fallback. */
  databasePath: string;
  authorization: MailboxReadAuthorization;
  query: MailboxReadQuery;
  /** Server-selected permission, never copied from client query parameters. */
  searchBodyText: boolean;
};

export type MailSearchExecutionObservation = {
  queueWaitMs: number;
  processDurationMs: number;
  readerDurationMs: number | null;
  /** Linux VmHWM at snapshot completion; null where unavailable. */
  peakRssBytes: number | null;
};
export type MailSearchExecutionOptions = {
  signal?: AbortSignal;
  capabilitiesFor?: (provider: MailProvider, scopes: string | null) => MailCapabilities;
  observe?: (observation: MailSearchExecutionObservation) => void;
};

type Lifecycle = { event: "started" | "kill" | "closed"; pid: number | undefined; active: number };
type ExecutorTestOptions = {
  /** Trusted test-only fixtures; never exposed in request or environment config. */
  workerPath?: string;
  deadlineMs?: number;
  queueWaitMs?: number;
  maxStdoutBytes?: number;
  onLifecycle?: (event: Lifecycle) => void;
};
type Job = {
  request: MailSearchWorkerRequest;
  options: MailSearchExecutionOptions;
  queuedAt: number;
  resolve: (result: MailboxReadResult) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  abort: () => void;
};

function createExecutor(testOptions: ExecutorTestOptions = {}) {
  const activeUsers = new Set<string>();
  const activeRuns = new Set<Promise<void>>();
  const activeCancels = new Set<() => void>();
  let shuttingDown = false;
  const queue: Job[] = [];
  const workerPath = testOptions.workerPath ?? fileURLToPath(new URL("./search-worker.ts", import.meta.url));
  const deadlineMs = testOptions.deadlineMs ?? mailSearchProcessLimits.deadlineMs;
  const queueWaitMs = testOptions.queueWaitMs ?? mailSearchProcessLimits.queueWaitMs;
  const maxStdoutBytes = testOptions.maxStdoutBytes ?? mailSearchProcessLimits.maxStdoutBytes;

  function removeQueued(job: Job, error: Error) {
    const index = queue.indexOf(job);
    if (index === -1) return;
    queue.splice(index, 1);
    clearTimeout(job.queueTimer);
    job.options.signal?.removeEventListener("abort", job.abort);
    job.reject(error);
  }

  function drain() {
    if (shuttingDown) return;
    while (activeUsers.size < mailSearchProcessLimits.maxActive) {
      // An active user's pending request never blocks an unrelated user's slot.
      const index = queue.findIndex(job => !activeUsers.has(job.request.authorization.userId));
      if (index === -1) return;
      const [job] = queue.splice(index, 1);
      clearTimeout(job!.queueTimer);
      job!.options.signal?.removeEventListener("abort", job!.abort);
      if (job!.options.signal?.aborted) { job!.reject(new MailSearchExecutionError("search_aborted")); continue; }
      activeUsers.add(job!.request.authorization.userId);
      const completion = run(job!).then(job!.resolve, job!.reject).finally(() => {
        // run() cannot settle before the OS reports child close, including on
        // timeout, cancellation, malformed output, and stream errors.
        activeUsers.delete(job!.request.authorization.userId);
        activeRuns.delete(completion);
        drain();
      });
      activeRuns.add(completion);
    }
  }

  async function run(job: Job): Promise<MailboxReadResult> {
    const startedAt = performance.now();
    let child: ReturnType<typeof spawn>;
    try {
      // No shell, queries in argv, inherited secrets, or automatic .env loading.
      child = spawn(process.execPath, ["--no-env-file", "--smol", workerPath], {
        stdio: ["pipe", "pipe", "pipe"], env: { TZ: "UTC", LANG: "C.UTF-8" },
      });
    } catch { throw new MailSearchExecutionError("search_failed"); }
    testOptions.onLifecycle?.({ event: "started", pid: child.pid, active: activeUsers.size });
    let failure: Error | undefined;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    // Drain stderr even once capped, but never publish it or append it to errors.
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      testOptions.onLifecycle?.({ event: "kill", pid: child.pid, active: activeUsers.size });
      child.kill("SIGKILL");
    };
    const abort = () => terminate(new MailSearchExecutionError("search_aborted"));
    activeCancels.add(abort);
    const deadline = setTimeout(() => terminate(new MailSearchAdmissionError()), deadlineMs);
    job.options.signal?.addEventListener("abort", abort, { once: true });
    if (job.options.signal?.aborted) abort();
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) { terminate(new MailSearchAdmissionError()); return; }
      if (!failure) stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      const available = mailSearchProcessLimits.maxStderrBytes - stderrBytes;
      if (available > 0) { const bounded = Buffer.from(chunk.subarray(0, available)); stderr.push(bounded); stderrBytes += bounded.byteLength; }
    });
    const streamError = () => terminate(new MailSearchExecutionError("search_failed"));
    child.stdout!.on("error", streamError);
    child.stderr!.on("error", streamError);
    child.stdin!.on("error", streamError);
    child.on("error", streamError);
    const exitCode = await new Promise<number | null>(resolve => {
      child.once("close", code => resolve(code));
      child.stdin!.end(JSON.stringify(job.request));
    });
    clearTimeout(deadline);
    activeCancels.delete(abort);
    job.options.signal?.removeEventListener("abort", abort);
    testOptions.onLifecycle?.({ event: "closed", pid: child.pid, active: activeUsers.size });
    stderr.length = 0;
    if (failure) throw failure;
    if (exitCode !== 0) throw new MailSearchExecutionError("search_failed");
    let reply: MailSearchWorkerReply;
    try { reply = mailSearchWorkerReplySchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8"))); }
    catch { throw new MailSearchExecutionError("search_failed"); }
    if (!reply.ok) throw workerError(reply.code);
    const capabilityById = new Map(reply.capabilityAccounts.map(account => [account.id, account]));
    if (capabilityById.size !== reply.result.response.accounts.length) throw new MailSearchExecutionError("search_failed");
    for (const account of reply.result.response.accounts) {
      const raw = capabilityById.get(account.id);
      if (!raw || raw.provider !== account.provider) throw new MailSearchExecutionError("search_failed");
      if (job.options.capabilitiesFor) account.capabilities = job.options.capabilitiesFor(raw.provider, raw.scope);
    }
    job.options.observe?.({
      queueWaitMs: startedAt - job.queuedAt,
      processDurationMs: performance.now() - startedAt,
      readerDurationMs: reply.result.metric.durationMs,
      peakRssBytes: reply.peakRssBytes,
    });
    return reply.result;
  }

  return {
    read(input: MailSearchExecutionInput, options: MailSearchExecutionOptions = {}): Promise<MailboxReadResult> {
      if (shuttingDown) return Promise.reject(new MailSearchExecutionError("search_busy"));
      if (options.signal?.aborted) return Promise.reject(new MailSearchExecutionError("search_aborted"));
      if (!input.databasePath || input.databasePath === ":memory:" || input.databasePath.startsWith("file:")) {
        return Promise.reject(new MailSearchExecutionError("search_database_unavailable"));
      }
      const parsed = mailSearchWorkerRequestSchema.safeParse({ version: 1, ...input });
      if (!parsed.success) return Promise.reject(new MailSearchExecutionError("search_invalid_request"));
      if (Buffer.byteLength(JSON.stringify(parsed.data)) > mailSearchProcessLimits.maxRequestBytes) {
        return Promise.reject(new MailSearchExecutionError("search_invalid_request"));
      }
      const userId = parsed.data.authorization.userId;
      if (queue.length >= mailSearchProcessLimits.maxQueued
        || queue.filter(job => job.request.authorization.userId === userId).length >= mailSearchProcessLimits.maxQueuedPerUser) {
        return Promise.reject(new MailSearchExecutionError("search_busy"));
      }
      return new Promise((resolve, reject) => {
        const job: Job = { request: parsed.data, options, queuedAt: performance.now(), resolve, reject, abort: () => {} };
        job.abort = () => removeQueued(job, new MailSearchExecutionError("search_aborted"));
        queue.push(job);
        options.signal?.addEventListener("abort", job.abort, { once: true });
        job.queueTimer = setTimeout(() => removeQueued(job, new MailSearchExecutionError("search_busy")), queueWaitMs);
        drain();
      });
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const job of [...queue]) removeQueued(job, new MailSearchExecutionError("search_aborted"));
      for (const cancel of activeCancels) cancel();
      await Promise.all([...activeRuns]);
    },
  };
}

function workerError(code: Exclude<MailSearchWorkerReply, { ok: true }>["code"]): Error {
  switch (code) {
    case "search_query_too_broad": return new MailSearchAdmissionError();
    case "search_index_not_ready": return new MailSearchUnavailableError();
    case "invalid_cursor": return new MailboxCursorError("The mail search cursor is invalid or stale.");
    case "no_accounts": return new MailboxScopeError();
    default: return new MailSearchExecutionError(code);
  }
}

// API and MCP share this singleton. Creating one executor per request would
// defeat both per-owner fairness and the process/memory admission bound.
const executor = createExecutor();
export const executeMailboxSearch = executor.read;
/** Call from the API's existing graceful-shutdown handler before process.exit.
 * No new signal handler here: installing one would change API exit semantics. */
export const shutdownMailboxSearch = executor.shutdown;
// Covers explicit process.exit / normal exits. This synchronous callback sends
// SIGKILL immediately; graceful shutdown additionally awaits reaping above.
// SIGKILL of the API itself cannot run JS cleanup: deployment must terminate the
// whole container/process group, not merely replace the API PID.
process.once("exit", () => { void executor.shutdown(); });

/** Explicit isolated harness for controlled subprocess lifecycle tests. The
 * application must use executeMailboxSearch; this never reads client options. */
export const createMailSearchExecutorForTests = createExecutor;
