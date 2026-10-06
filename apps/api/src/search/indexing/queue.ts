import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readSearchControl, type SearchMode, type SourceAccount } from "./schema.ts";

export interface IndexJob {
  account_id: string; incarnation: string; mode: SearchMode; target: "message" | "account";
  message_id: string; version: number; operation: "upsert" | "delete"; build_id: string;
  state: "pending" | "claimed" | "blocked"; attempt_token: string | null;
  attempt_count: number; available_at: number; created_at: number; error_code: string | null;
}
export interface IndexReceipt {
  protocol: 1; build_id: string; account_id: string; incarnation: string; mode: SearchMode;
  target: "message" | "account"; message_id: string; version: number; attempt_token: string;
  status: "applied" | "more" | "blocked"; error_code?: "source_too_large";
}
export const DEFAULT_INDEX_LIMITS = Object.freeze({
  // Initial defensive limits, not measured capacity or latency guarantees.
  metadataBytes: 32 * 1024, fullBytes: 256 * 1024,
  cleanupDocuments: 8, baselineBatch: 64, maxAttempts: 3,
  attemptTimeoutMs: 5_000, maxJobsPerRun: 16, maxRunMs: 20_000,
  retryBaseMs: 1_000, receiptBytes: 4_096,
});
export type IndexLimits = { readonly [K in keyof typeof DEFAULT_INDEX_LIMITS]: number };
export function jobKey(job: Pick<IndexJob, "account_id" | "incarnation" | "mode" | "target" | "message_id">): [string, string, SearchMode, string, string] {
  return [job.account_id, job.incarnation, job.mode, job.target, job.message_id];
}
const exactAttempt = "account_id=? AND incarnation=? AND mode=? AND target=? AND message_id=? AND version=? AND attempt_token=? AND build_id=? AND state='claimed'";
export function claimNextJob(db: Database, now = Date.now(), afterAccount?: string): IndexJob | null {
  return db.transaction((): IndexJob | null => {
    const control = readSearchControl(db);
    if (!control.worker_enabled || control.paused) return null;
    // Durable round-robin accounts; metadata precedes full work for each account.
    const cursor = afterAccount ?? db.query<{ claim_account: string }, []>("SELECT claim_account FROM mail_search_control WHERE singleton=1").get()!.claim_account;
    // Bound the index probe before filtering delayed work. Do not sort or scan
    // the whole queue while holding the canonical write lock.
    const order = "account_id,CASE mode WHEN 'metadata' THEN 0 ELSE 1 END,created_at,message_id";
    const candidates = db.query<IndexJob, [string, number]>(`SELECT * FROM mail_search_outbox WHERE state='pending' AND account_id>? ORDER BY ${order} LIMIT ?`).all(cursor, 32);
    if (candidates.length < 32) candidates.push(...db.query<IndexJob, [string, number]>(`SELECT * FROM mail_search_outbox WHERE state='pending' AND account_id<=? ORDER BY ${order} LIMIT ?`).all(cursor, 32 - candidates.length));
    const job = candidates.find((candidate) => candidate.build_id === control.build_id && candidate.available_at <= now);
    if (!job) {
      if (candidates.length) db.query("UPDATE mail_search_control SET claim_account=? WHERE singleton=1").run(candidates.at(-1)!.account_id);
      return null;
    }
    const token = randomUUID();
    db.query("UPDATE mail_search_control SET claim_account=? WHERE singleton=1").run(job.account_id);
    db.query("UPDATE mail_search_outbox SET state='claimed',attempt_token=?,attempt_count=attempt_count+1 WHERE account_id=? AND incarnation=? AND mode=? AND target=? AND message_id=? AND version=? AND state='pending'").run(token, ...jobKey(job), job.version);
    return { ...job, state: "claimed", attempt_token: token, attempt_count: job.attempt_count + 1 };
  }).immediate();
}
export function acknowledgeReceipt(db: Database, receipt: IndexReceipt): boolean {
  return db.transaction(() => {
    if (readSearchControl(db).build_id !== receipt.build_id) return false;
    const params = [...jobKey(receipt), receipt.version, receipt.attempt_token, receipt.build_id] as const;
    if (receipt.status === "applied") return db.query(`DELETE FROM mail_search_outbox WHERE ${exactAttempt}`).run(...params).changes === 1;
    return db.query(`UPDATE mail_search_outbox SET state=?,attempt_token=NULL,attempt_count=CASE WHEN ?='more' THEN 0 ELSE attempt_count END,error_code=? WHERE ${exactAttempt}`)
      .run(receipt.status === "blocked" ? "blocked" : "pending", receipt.status, receipt.error_code ?? null, ...params).changes === 1;
  }).immediate();
}
export function failAttempt(db: Database, job: IndexJob, errorCode: string, now = Date.now(), limits: IndexLimits = DEFAULT_INDEX_LIMITS): boolean {
  return db.query(`UPDATE mail_search_outbox SET state=?,attempt_token=NULL,available_at=?,error_code=? WHERE ${exactAttempt}`)
    .run(job.attempt_count >= limits.maxAttempts ? "blocked" : "pending", now + limits.retryBaseMs * 2 ** Math.min(job.attempt_count - 1, 8), errorCode, ...jobKey(job), job.version, job.attempt_token, job.build_id).changes === 1;
}
/** Only call while holding exclusive ownership, after all earlier child processes are confirmed stopped. */
export function recoverClaimedJobs(db: Database, now = Date.now(), limits: IndexLimits = DEFAULT_INDEX_LIMITS): number {
  return db.query("UPDATE mail_search_outbox SET state=CASE WHEN attempt_count>=? THEN 'blocked' ELSE 'pending' END,attempt_token=NULL,available_at=?,error_code='interrupted' WHERE state='claimed'")
    .run(limits.maxAttempts, now + limits.retryBaseMs).changes;
}
export function enqueueBaseline(db: Database, accountId: string, mode: SearchMode, batchSize: number = DEFAULT_INDEX_LIMITS.baselineBatch): { enqueued: number; complete: boolean } {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) throw new Error("invalid_baseline_batch");
  return db.transaction(() => {
    const control = readSearchControl(db);
    const account = db.query<SourceAccount, [string, SearchMode]>("SELECT * FROM mail_search_accounts WHERE account_id=? AND mode=? AND deleted=0").get(accountId, mode);
    if (!account) throw new Error("search_account_missing");
    if (account.baseline_complete) return { enqueued: 0, complete: true };
    const ids = db.query<{ id: string }, [string, string, number]>("SELECT id FROM emails WHERE account_id=? AND id>? ORDER BY id LIMIT ?").all(accountId, account.baseline_cursor, batchSize);
    const insert = db.query("INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id) VALUES(?,?,?,'message',?,0,'upsert',?) ON CONFLICT DO NOTHING");
    let enqueued = 0;
    for (const { id } of ids) enqueued += insert.run(accountId, account.incarnation, mode, id, control.build_id).changes;
    const complete = ids.length < batchSize;
    db.query("UPDATE mail_search_accounts SET baseline_cursor=?,baseline_complete=? WHERE account_id=? AND incarnation=? AND mode=?")
      .run(ids.at(-1)?.id ?? account.baseline_cursor, complete ? 1 : 0, accountId, account.incarnation, mode);
    return { enqueued, complete };
  }).immediate();
}
export function retryBlockedJobs(db: Database, accountId: string, mode: SearchMode): number {
  return db.query("UPDATE mail_search_outbox SET state='pending',attempt_count=0,attempt_token=NULL,available_at=0,error_code=NULL WHERE account_id=? AND mode=? AND state='blocked'").run(accountId, mode).changes;
}
export function searchQueueStatus(db: Database) {
  return {
    control: readSearchControl(db),
    jobs: db.query<{ mode: SearchMode; state: string; count: number; oldest_at: number | null; max_attempts: number }, []>("SELECT mode,state,count(*) AS count,min(created_at) AS oldest_at,max(attempt_count) AS max_attempts FROM mail_search_outbox GROUP BY mode,state").all(),
    accounts: db.query<SourceAccount, []>("SELECT * FROM mail_search_accounts ORDER BY account_id,incarnation,mode").all(),
  };
}
