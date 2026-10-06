import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { acquireWriterOwnership } from "./ownership.ts";
import { enqueueBaseline, retryBlockedJobs, searchQueueStatus } from "./queue.ts";
import { assertMatchingBuild, assertNoLegacySearch, canonicalizePath, getSearchIndexPath, initializeIndex, readIndexAccount, readIndexControl, readSearchControl, SEARCH_MODES, type SearchMode, type SourceAccount } from "./schema.ts";
import { SearchIndexSupervisor } from "./supervisor.ts";

export function initializeSearchBuild(canonical: Database, indexPath: string): string {
  indexPath = canonicalizePath(indexPath);
  // Callers supply an open canonical handle; reject unsafe aliases here too.
  canonicalizePath(canonical.filename);
  assertNoLegacySearch(canonical);
  readSearchControl(canonical);
  if (existsSync(indexPath) || existsSync(`${indexPath}.writer-lock`)) throw new Error("search_existing_index_or_owner_requires_operator_review");
  // Exclusive creation also prevents two explicit init commands from racing.
  const initializationLock = `${indexPath}.writer-lock`;
  mkdirSync(initializationLock, { mode: 0o700 });
  try { closeSync(openSync(indexPath, "wx", 0o600)); }
  catch (error) { rmSync(initializationLock, { recursive: true }); throw error; }
  const buildId = randomUUID();
  canonical.transaction(() => {
    canonical.query("UPDATE mail_search_control SET build_id=?,enabled=0,activation_epoch=activation_epoch+1,worker_enabled=0,paused=1 WHERE singleton=1").run(buildId);
    recordActivation(canonical, "init", "Explicit initialization of a new search build");
    canonical.exec("UPDATE mail_search_accounts SET baseline_cursor='',baseline_complete=CASE WHEN deleted=1 THEN 1 ELSE 0 END");
    canonical.query("UPDATE mail_search_outbox SET build_id=?,state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL").run(buildId);
  }).immediate();
  const index = new Database(indexPath, { create: true, strict: true });
  try { initializeIndex(index, readSearchControl(canonical)); }
  finally { index.close(); }
  // On failure leave the lock/file in place: an incomplete init needs review.
  rmSync(initializationLock, { recursive: true });
  return buildId;
}
/** Exact readiness is checked again by every query; this is only an operator gate. */
export function verifySearchBuild(canonical: Database, index: Database): { ready: boolean; accounts: number; outstanding: number } {
  assertMatchingBuild(readSearchControl(canonical), readIndexControl(index));
  const accounts = canonical.query<SourceAccount, []>("SELECT * FROM mail_search_accounts WHERE deleted=0").all();
  const outstanding = canonical.query<{ count: number }, []>("SELECT count(*) AS count FROM mail_search_outbox").get()!.count;
  const ready = outstanding === 0 && accounts.every((account) => {
    const applied = readIndexAccount(index, account.account_id, account.incarnation, account.mode);
    return account.baseline_complete === 1 && applied?.ready === 1 && applied.deleted === 0 && applied.published_revision === account.revision;
  });
  return { ready, accounts: accounts.length, outstanding };
}
function recordActivation(canonical: Database, command: "init" | "enable" | "disable", reason: string): void {
  if (!reason.trim()) throw new Error("search_activation_reason_required");
  canonical.query("INSERT INTO mail_search_activation_audit(activation_epoch,command,reason,source_id,build_id) SELECT activation_epoch,?,?,source_id,build_id FROM mail_search_control WHERE singleton=1").run(command, reason);
}
export function enableSearch(canonical: Database, index: Database, reason = "Explicit operator activation"): void {
  canonical.transaction(() => {
    if (!verifySearchBuild(canonical, index).ready) throw new Error("search_not_ready");
    if (readSearchControl(canonical).enabled) return;
    canonical.exec("UPDATE mail_search_control SET enabled=1,activation_epoch=activation_epoch+1 WHERE singleton=1");
    recordActivation(canonical, "enable", reason);
  }).immediate();
}
/** Deliberate operator rollback to labeled metadata compatibility. Never called
 * by read failures, index lag, startup, or automatic recovery. */
export function disableSearch(canonical: Database, reason = "Explicit operator metadata rollback"): void {
  canonical.transaction(() => {
    if (!readSearchControl(canonical).enabled) return;
    canonical.exec("UPDATE mail_search_control SET enabled=0,activation_epoch=activation_epoch+1 WHERE singleton=1");
    recordActivation(canonical, "disable", reason);
  }).immediate();
}

if (import.meta.main) {
  const [command, canonicalArgument, accountId, modeArg] = process.argv.slice(2);
  if (!command || !canonicalArgument) throw new Error("Usage: bun src/search/indexing/admin.ts <status|init|backfill|resume|drain|verify|enable|disable|pause|retry> <canonical.sqlite> [accountId] [metadata|full]");
  const canonicalPath = canonicalizePath(canonicalArgument);
  const indexPath = canonicalizePath(getSearchIndexPath(canonicalPath));
  const canonical = new Database(canonicalPath, { strict: true, readwrite: true, create: false });
  canonical.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100");
  let index: Database | undefined;
  try {
    assertNoLegacySearch(canonical);
    if (command === "status") console.log(JSON.stringify({ ...searchQueueStatus(canonical), indexFilePresent: existsSync(indexPath), writer: existsSync(`${indexPath}.writer-lock`) ? "owned_or_recovery_required" : "unlocked" }, null, 2));
    else if (command === "init") console.log(JSON.stringify({ buildId: initializeSearchBuild(canonical, indexPath), enabled: false }));
    else if (command === "backfill") {
      const accounts = accountId ? [accountId] : canonical.query<{ account_id: string }, []>("SELECT DISTINCT account_id FROM mail_search_accounts WHERE deleted=0").all().map((row) => row.account_id);
      const modes: readonly SearchMode[] = modeArg === undefined ? SEARCH_MODES : modeArg === "metadata" || modeArg === "full" ? [modeArg] : (() => { throw new Error("invalid_mode"); })();
      for (const id of accounts) for (const mode of modes) console.log(JSON.stringify({ accountId: id, mode, ...enqueueBaseline(canonical, id, mode) }));
    } else if (command === "resume") canonical.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0 WHERE singleton=1");
    else if (command === "pause") canonical.exec("UPDATE mail_search_control SET paused=1 WHERE singleton=1");
    else if (command === "disable") disableSearch(canonical, accountId ?? "Explicit operator metadata rollback");
    else if (command === "drain") {
      const supervisor = new SearchIndexSupervisor({ canonicalPath });
      let signalShutdown: Promise<void> | undefined;
      const shutdown = () => {
        signalShutdown ??= supervisor.shutdown();
        // Observe immediately; the same promise is awaited in final cleanup.
        void signalShutdown.catch(() => { process.exitCode = 1; });
      };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
      try { console.log(JSON.stringify(await supervisor.kick())); }
      finally {
        process.removeListener("SIGTERM", shutdown); process.removeListener("SIGINT", shutdown);
        try { await supervisor.shutdown(); }
        finally { await signalShutdown; }
      }
    } else if (command === "retry") {
      if (!accountId || (modeArg !== "metadata" && modeArg !== "full")) throw new Error("retry_requires_account_and_mode");
      console.log(JSON.stringify({ retried: retryBlockedJobs(canonical, accountId, modeArg) }));
    } else if (command === "verify" || command === "enable") {
      index = new Database(indexPath, { readwrite: true, create: false, strict: true });
      index.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100");
      const owner = acquireWriterOwnership(index, indexPath, readSearchControl(canonical));
      try {
        if (command === "verify") {
          // Explicit maintenance command, never part of startup or canonical writes.
          index.exec("INSERT INTO metadata_fts(metadata_fts) VALUES('integrity-check'); INSERT INTO full_fts(full_fts) VALUES('integrity-check')");
          console.log(JSON.stringify(verifySearchBuild(canonical, index)));
        } else { enableSearch(canonical, index, accountId ?? "Explicit operator activation"); console.log(JSON.stringify({ enabled: true })); }
      } finally { owner.release(); }
    } else throw new Error("unknown_search_admin_command");
  } finally { index?.close(); canonical.close(); }
}
