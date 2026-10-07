import { constants, Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireWriterOwnership, type WriterOwnership } from "./ownership.ts";
import { acknowledgeReceipt, claimNextJob, DEFAULT_INDEX_LIMITS, failAttempt, recoverClaimedJobs, type IndexLimits, type IndexReceipt } from "./queue.ts";
import { assertDurableCanonical, assertMatchingBuild, assertNoLegacySearch, canonicalizePath, getSearchIndexPath, readSearchControl, type IndexControl, type SourceAccount } from "./schema.ts";
import type { IndexWorkerRequest } from "./worker.ts";

export interface SupervisorOptions {
  canonicalPath: string; indexPath?: string; limits?: IndexLimits;
  maxRssBytes?: number;
  /** A deployment-supplied per-child hard memory limit is required on non-Linux. */
  externalMemoryLimit?: boolean;
}
class SearchIndexShutdownError extends Error {
  constructor() { super("search_shutdown"); }
}

export interface DrainResult { attempted: number; acknowledged: number; blocked: number; sealed: number; stopped: boolean }

function readProbeControl(probe: Database): IndexControl {
  const control = probe.query<IndexControl, []>("SELECT source_id,build_id,format_version,owner_token FROM search_index.index_control WHERE singleton=1").get();
  if (!control) throw new Error("search_index_incompatible");
  assertMatchingBuild(readSearchControl(probe), control);
  return control;
}

/** Advisory selection only: every child still obtains its own fresh seal proof.
 * Filter ready modes before LIMIT so one-shot drains cannot starve a later dirty
 * account behind an arbitrarily long prefix of already-ready accounts. LIMIT
 * bounds returned candidates/children, not the number of account rows read. */
function readSealCandidates(probe: Database, limit: number): SourceAccount[] {
  const cursor = probe.query<{ seal_account: string; seal_mode: string }, []>("SELECT seal_account,seal_mode FROM mail_search_control WHERE singleton=1").get()!;
  return probe.query<SourceAccount, [string, string, string, number]>(`SELECT a.* FROM mail_search_accounts a
    LEFT JOIN search_index.index_accounts i ON i.account_id=a.account_id AND i.incarnation=a.incarnation AND i.mode=a.mode
    WHERE a.deleted=0 AND a.baseline_complete=1
      AND (i.account_id IS NULL OR i.ready<>1 OR i.deleted<>0 OR i.published_revision IS NOT a.revision)
      AND NOT EXISTS (SELECT 1 FROM mail_search_outbox o WHERE o.account_id=a.account_id AND o.incarnation=a.incarnation AND o.mode=a.mode)
    ORDER BY CASE WHEN a.account_id>? OR (a.account_id=? AND a.mode>?) THEN 0 ELSE 1 END,a.account_id,a.mode LIMIT ?`)
    .all(cursor.seal_account, cursor.seal_account, cursor.seal_mode, limit);
}

/** Demand-started only. Construction and import never initialize, backfill, enable, or spawn. */
export class SearchIndexSupervisor {
  private running: Promise<DrainResult> | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private stopped = false;
  constructor(private readonly options: SupervisorOptions) {}
  kick(): Promise<DrainResult> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve({ attempted: 0, acknowledged: 0, blocked: 0, sealed: 0, stopped: true });
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.child) {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      await this.child.exited;
    }
    await this.running;
  }
  private async invoke(request: IndexWorkerRequest, ownership: WriterOwnership, limits: IndexLimits): Promise<unknown> {
    if (this.stopped) throw new SearchIndexShutdownError();
    if (process.platform !== "linux" && !this.options.externalMemoryLimit) throw new Error("search_memory_guard_required");
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > 16_384) throw new Error("search_request_too_large");
    const child = Bun.spawn([process.execPath, "--smol", resolve(import.meta.dir, "worker.ts")], {
      stdin: new Blob([input]), stdout: "pipe", stderr: "ignore",
      env: { PATH: process.env.PATH ?? "", TZ: "UTC" },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let memory: ReturnType<typeof setInterval> | undefined;
    let failure: string | undefined;
    try {
      // All bookkeeping after spawn belongs inside the reap guarantee, including
      // a failed owner-record write before the watchdogs have been installed.
      this.child = child;
      ownership.recordWorker(child.pid);
      const terminate = (code: string) => {
        failure ??= code;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      };
      timer = setTimeout(() => terminate("search_attempt_timeout"), limits.attemptTimeoutMs);
      // Sampling can overshoot; production still needs a cgroup hard memory cap.
      memory = process.platform === "linux" ? setInterval(() => {
        try {
          const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
          const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024;
          if (rss > (this.options.maxRssBytes ?? 192 * 1024 * 1024)) terminate("search_worker_memory");
        } catch { /* Process exit is established by child.exited below. */ }
      }, 20) : undefined;
      const chunks: Uint8Array[] = [];
      let total = 0;
      const stream = child.stdout;
      if (typeof stream === "number" || stream === null) throw new Error("search_worker_pipe");
      const reader = stream.getReader();
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
          if (total > limits.receiptBytes) { terminate("search_receipt_too_large"); break; }
          chunks.push(chunk);
        }
      } finally { reader.releaseLock(); }
      const code = await child.exited;
      if (this.stopped) throw new SearchIndexShutdownError();
      if (failure) throw new Error(failure);
      if (code !== 0) throw new Error("search_worker_failed");
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      if (timer) clearTimeout(timer); if (memory) clearInterval(memory);
      try {
        try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
        finally { await child.exited; } // Always establish exit, even after bookkeeping failure.
        ownership.recordWorker(null);
      } finally { this.child = null; }
    }
  }
  private async drain(): Promise<DrainResult> {
    const result: DrainResult = { attempted: 0, acknowledged: 0, blocked: 0, sealed: 0, stopped: false };
    const limits = this.options.limits ?? DEFAULT_INDEX_LIMITS;
    const canonicalPath = canonicalizePath(this.options.canonicalPath);
    const indexPath = canonicalizePath(this.options.indexPath ?? getSearchIndexPath(canonicalPath));
    if (canonicalPath === indexPath) throw new Error("search_index_must_be_separate");
    // Both files are opened read-only for the idle probe. URI mode prevents the
    // attachment from creating a missing sidecar or ever writing through it.
    const probe = new Database(canonicalPath, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    let canonical: Database | undefined;
    let index: Database | undefined;
    let ownership: WriterOwnership | undefined;
    try {
      probe.exec("PRAGMA query_only=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048");
      assertNoLegacySearch(probe); assertDurableCanonical(probe);
      let control = readSearchControl(probe);
      if (!control.worker_enabled || control.paused) return result;
      probe.query("ATTACH DATABASE ? AS search_index").run(`${pathToFileURL(indexPath).href}?mode=ro`);
      const derived = readProbeControl(probe);
      // Preserve explicit-recovery errors even when no jobs need to run. These
      // checks are advisory; acquisition below remains the atomic owner fence.
      if (existsSync(`${indexPath}.writer-lock`)) throw new Error("search_writer_owned_or_recovery_required");
      if (derived.owner_token !== null) throw new Error("search_writer_recovery_required");
      const recoverable = probe.query("SELECT 1 FROM mail_search_outbox WHERE state='claimed' LIMIT 1").get();
      // This read-only existence probe can scan delayed pending rows. The
      // separate write-locked claim still inspects at most 32 indexed IDs.
      const due = probe.query("SELECT 1 FROM mail_search_outbox WHERE state='pending' AND build_id=? AND available_at<=? LIMIT 1").get(control.build_id, Date.now());
      if (!recoverable && !due && readSealCandidates(probe, 1).length === 0) return result;

      // No empty-queue claim transaction, ownership record/token, or durable
      // cursor update is needed on the genuinely idle path above. A concurrent
      // change missed by the probe is reconsidered on the next scheduler tick.
      canonical = new Database(canonicalPath, { strict: true, readwrite: true, create: false });
      canonical.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100");
      control = readSearchControl(canonical);
      if (!control.worker_enabled || control.paused) return result;
      index = new Database(indexPath, { strict: true, readwrite: true, create: false });
      index.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100");
      ownership = acquireWriterOwnership(index, indexPath, control);
      recoverClaimedJobs(canonical, Date.now(), limits, control);
      const identity = { sourceId: control.source_id, buildId: control.build_id, ownerToken: ownership.token };
      const started = Date.now();
      while (!this.stopped && result.attempted < limits.maxJobsPerRun && Date.now() - started < limits.maxRunMs) {
        const job = claimNextJob(canonical, Date.now(), undefined, control);
        if (!job) break;
        result.attempted++;
        try {
          const raw = await this.invoke({ protocol: 1, action: "apply", canonicalPath, indexPath, identity, job, limits }, ownership, limits);
          const receipt = raw as IndexReceipt;
          if (receipt.protocol !== 1 || receipt.build_id !== job.build_id || receipt.account_id !== job.account_id || receipt.incarnation !== job.incarnation || receipt.mode !== job.mode || receipt.message_id !== job.message_id || receipt.target !== job.target || receipt.version !== job.version || receipt.attempt_token !== job.attempt_token || !["applied", "more", "blocked"].includes(receipt.status)) throw new Error("search_receipt_mismatch");
          if (acknowledgeReceipt(canonical, receipt)) result.acknowledged++;
          if (receipt.status === "blocked") result.blocked++;
        } catch (error) {
          failAttempt(canonical, job, error instanceof Error ? error.message : "search_worker_failed", Date.now(), limits);
        }
      }
      // A new bounded child obtains each fresh proof after all matching acks.
      assertMatchingBuild(control, readProbeControl(probe));
      const accounts = readSealCandidates(probe, limits.maxJobsPerRun);
      for (const account of accounts) {
        const currentControl = readSearchControl(canonical);
        if (currentControl.source_id !== control.source_id || currentControl.build_id !== control.build_id) throw new Error("search_build_mismatch");
        if (this.stopped || !currentControl.worker_enabled || currentControl.paused || Date.now() - started >= limits.maxRunMs) break;
        const state = index.query<{ ready: number; deleted: number; published_revision: number }, [string, string, string]>("SELECT ready,deleted,published_revision FROM index_accounts WHERE account_id=? AND incarnation=? AND mode=?").get(account.account_id, account.incarnation, account.mode);
        if (state?.ready && !state.deleted && state.published_revision === account.revision) continue;
        if (canonical.query("UPDATE mail_search_control SET seal_account=?,seal_mode=? WHERE singleton=1 AND source_id=? AND build_id=?").run(account.account_id, account.mode, control.source_id, control.build_id).changes !== 1) throw new Error("search_build_mismatch");
        const seal = await this.invoke({ protocol: 1, action: "seal", canonicalPath, indexPath, identity, accountId: account.account_id, incarnation: account.incarnation, mode: account.mode }, ownership, limits) as { protocol: number; sealed: boolean };
        if (seal.protocol !== 1) throw new Error("search_receipt_mismatch");
        if (seal.sealed) result.sealed++;
      }
      result.stopped = this.stopped;
      return result;
    } catch (error) {
      if (this.stopped && error instanceof SearchIndexShutdownError) {
        result.stopped = true;
        return result;
      }
      throw error;
    } finally {
      try { ownership?.release(); }
      finally { index?.close(); canonical?.close(); probe.close(); }
    }
  }
}
