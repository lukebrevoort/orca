import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeSearchBuild, verifySearchBuild } from "./admin.ts";
import { acquireWriterOwnership, type WriterOwnership } from "./ownership.ts";
import { claimNextJob, DEFAULT_INDEX_LIMITS, enqueueBaseline, type IndexJob, type IndexLimits } from "./queue.ts";
import { getSearchIndexPath, openCanonicalReadOnly, readSearchControl, type SourceAccount } from "./schema.ts";
import { SearchIndexSupervisor } from "./supervisor.ts";
import type { IndexWorkerRequest } from "./worker.ts";
import { applyIndexJob, publishAccountReady } from "./worker-core.ts";

function fixture(extraAccounts = 0) {
  const directory = mkdtempSync(join(tmpdir(), "orca-idle-search-"));
  const path = join(directory, "canonical.sqlite");
  const canonical = new Database(path);
  canonical.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE oauth_accounts(id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE emails(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,from_name TEXT,from_address TEXT,subject TEXT,snippet TEXT,body_text TEXT);
    INSERT INTO oauth_accounts(id,user_id) VALUES('a','u');`);
  for (const sql of readFileSync(resolve(import.meta.dir, "../../../drizzle/0051_queued_mail_search.sql"), "utf8").split("--> statement-breakpoint")) canonical.exec(sql);
  const indexPath = getSearchIndexPath(path);
  initializeSearchBuild(canonical, indexPath);
  canonical.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  enqueueBaseline(canonical, "a", "metadata"); enqueueBaseline(canonical, "a", "full");
  for (let n = 0; n < extraAccounts; n++) canonical.query("INSERT INTO oauth_accounts(id,user_id) VALUES(?,'u')").run(`z-${n}`);
  const index = new Database(indexPath);
  index.exec("PRAGMA synchronous=FULL");
  const readonly = openCanonicalReadOnly(path);
  const owner = acquireWriterOwnership(index, indexPath, readSearchControl(canonical));
  try {
    const control = readSearchControl(canonical);
    const identity = { sourceId: control.source_id, buildId: control.build_id, ownerToken: owner.token };
    for (const a of canonical.query<SourceAccount, []>("SELECT * FROM mail_search_accounts WHERE deleted=0").all()) {
      expect(publishAccountReady(readonly, index, a.account_id, a.incarnation, a.mode, identity)).toBe(true);
    }
  } finally { owner.release(); }
  const versions = () => [canonical, index].map(db => db.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version);
  const jobs = () => canonical.query<IndexJob, []>("SELECT * FROM mail_search_outbox ORDER BY mode").all();
  const insert = () => canonical.exec("INSERT INTO emails(id,account_id,subject,body_text) VALUES('one','a','Small test message','Ordinary synthetic text')");
  return { directory, path, indexPath, canonical, index, readonly, versions, jobs, insert,
    close() { readonly.close(); index.close(); canonical.close(); rmSync(directory, { recursive: true, force: true }); } };
}

type Invoke = (request: IndexWorkerRequest, owner: WriterOwnership, limits: IndexLimits) => Promise<unknown>;
function supervisor(f: ReturnType<typeof fixture>, maxJobsPerRun: number = DEFAULT_INDEX_LIMITS.maxJobsPerRun, before?: (request: IndexWorkerRequest) => void) {
  const instance = new SearchIndexSupervisor({ canonicalPath: f.path, limits: { ...DEFAULT_INDEX_LIMITS, maxJobsPerRun } });
  const calls: IndexWorkerRequest[] = [];
  // Use real apply/seal functions with the supervisor's acquired token. Child
  // lifecycle is covered separately; this records exact bounded work counts.
  (instance as unknown as { invoke: Invoke }).invoke = async (request, _owner, limits) => {
    calls.push(request); before?.(request);
    return request.action === "apply"
      ? applyIndexJob(f.readonly, f.index, request.job, request.identity, limits)
      : { protocol: 1, sealed: publishAccountReady(f.readonly, f.index, request.accountId, request.incarnation, request.mode, request.identity) };
  };
  return { instance, calls };
}

const idle = { attempted: 0, acknowledged: 0, blocked: 0, sealed: 0, stopped: false };

test("caught-up resident and fresh supervisors perform zero writes or worker calls", async () => {
  const f = fixture(3);
  const resident = supervisor(f, 2);
  try {
    f.canonical.exec(`CREATE TRIGGER test_no_idle_control BEFORE UPDATE ON mail_search_control BEGIN SELECT RAISE(ABORT,'unexpected_idle_write'); END;
      CREATE TRIGGER test_no_idle_claim BEFORE UPDATE ON mail_search_outbox BEGIN SELECT RAISE(ABORT,'unexpected_idle_write'); END;`);
    f.index.exec(`CREATE TRIGGER test_no_idle_owner BEFORE UPDATE ON index_control BEGIN SELECT RAISE(ABORT,'unexpected_idle_write'); END;
      CREATE TRIGGER test_no_idle_seal BEFORE UPDATE ON index_accounts BEGIN SELECT RAISE(ABORT,'unexpected_idle_write'); END;`);
    const versions = f.versions();
    const wal = [f.path, f.indexPath].map(path => readFileSync(`${path}-wal`));
    for (let tick = 0; tick < 3; tick++) {
      expect(await resident.instance.kick()).toEqual(idle);
      const fresh = supervisor(f, 2);
      try { expect(await fresh.instance.kick()).toEqual(idle); expect(fresh.calls).toHaveLength(0); }
      finally { await fresh.instance.shutdown(); }
    }
    expect(resident.calls).toHaveLength(0);
    expect(f.versions()).toEqual(versions);
    expect([f.path, f.indexPath].map(path => readFileSync(`${path}-wal`))).toEqual(wal);
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    expect(readSearchControl(f.canonical).enabled).toBe(0);
  } finally { await resident.instance.shutdown(); f.close(); }
});

test("blocked and not-yet-due obligations stay read-only, then due work wakes", async () => {
  const f = fixture();
  const s = supervisor(f);
  try {
    f.insert();
    f.canonical.query("UPDATE mail_search_outbox SET state=CASE mode WHEN 'full' THEN 'blocked' ELSE 'pending' END,available_at=?").run(Date.now() + 60_000);
    const versions = f.versions();
    expect(await s.instance.kick()).toEqual(idle);
    expect(s.calls).toHaveLength(0); expect(f.versions()).toEqual(versions);
    f.canonical.exec("UPDATE mail_search_outbox SET available_at=0 WHERE mode='metadata'");
    expect(await s.instance.kick()).toMatchObject({ attempted: 1, acknowledged: 1, sealed: 1 });
    expect(s.calls.map(call => call.action)).toEqual(["apply", "seal"]);
    expect(f.jobs().map(job => [job.mode, job.state])).toEqual([["full", "blocked"]]);
    expect(readSearchControl(f.canonical).enabled).toBe(0);
  } finally { await s.instance.shutdown(); f.close(); }
});

test("one-shot drains skip a ready prefix and bound seal work to dirty modes", async () => {
  const f = fixture(4);
  try {
    f.canonical.exec("UPDATE mail_search_control SET seal_account='',seal_mode=''");
    f.index.exec("UPDATE index_accounts SET ready=0 WHERE account_id='z-3'");
    for (let n = 0; n < 2; n++) {
      const s = supervisor(f, 1);
      try {
        expect(await s.instance.kick()).toMatchObject({ attempted: 0, sealed: 1 });
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]).toMatchObject({ action: "seal", accountId: "z-3" });
      } finally { await s.instance.shutdown(); }
    }
    expect(f.canonical.query("SELECT seal_account,seal_mode FROM mail_search_control").get()).toEqual({ seal_account: "z-3", seal_mode: "metadata" });
    expect(verifySearchBuild(f.canonical, f.index).ready).toBe(true);
    const s = supervisor(f, 1); const versions = f.versions();
    try { expect(await s.instance.kick()).toEqual(idle); expect(f.versions()).toEqual(versions); }
    finally { await s.instance.shutdown(); }
  } finally { f.close(); }
});

test("a canonical mutation after advisory selection still prevents a stale seal", async () => {
  const f = fixture();
  let mutated = false;
  const s = supervisor(f, DEFAULT_INDEX_LIMITS.maxJobsPerRun, request => {
    if (request.action === "seal" && !mutated) { mutated = true; f.insert(); }
  });
  try {
    f.index.exec("UPDATE index_accounts SET ready=0 WHERE mode='metadata'");
    expect(await s.instance.kick()).toMatchObject({ attempted: 0, sealed: 0 });
    expect(mutated).toBe(true); expect(f.jobs()).toHaveLength(2);
    expect(verifySearchBuild(f.canonical, f.index).ready).toBe(false);
    expect(await s.instance.kick()).toMatchObject({ attempted: 2, acknowledged: 2, sealed: 2 });
    expect(verifySearchBuild(f.canonical, f.index).ready).toBe(true);
  } finally { await s.instance.shutdown(); f.close(); }
});

test("a build reset during a drain cannot claim jobs for the replacement build", async () => {
  const f = fixture();
  let reset = false;
  const s = supervisor(f, DEFAULT_INDEX_LIMITS.maxJobsPerRun, request => {
    if (request.action === "apply" && !reset) {
      reset = true;
      f.canonical.exec("UPDATE mail_search_control SET build_id='replacement'; UPDATE mail_search_outbox SET build_id='replacement',state='pending',attempt_token=NULL,attempt_count=0");
    }
  });
  try {
    f.insert();
    await expect(s.instance.kick()).rejects.toThrow("search_build_mismatch");
    expect(reset).toBe(true); expect(s.calls).toHaveLength(1);
    expect(f.jobs().every(job => job.build_id === "replacement" && job.state === "pending" && job.attempt_token === null && job.attempt_count === 0)).toBe(true);
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    expect(f.index.query("SELECT owner_token FROM index_control").get()).toEqual({ owner_token: null });
    const versions = f.versions();
    await expect(s.instance.kick()).rejects.toThrow("search_build_mismatch");
    expect(f.versions()).toEqual(versions);
  } finally { await s.instance.shutdown(); f.close(); }
});

test("idle probing reports stale ownership without taking over or writing", async () => {
  const f = fixture();
  const s = supervisor(f);
  try {
    f.index.exec("UPDATE index_control SET owner_token='abandoned'");
    let versions = f.versions();
    await expect(s.instance.kick()).rejects.toThrow("search_writer_recovery_required");
    expect(f.versions()).toEqual(versions);
    expect(f.index.query("SELECT owner_token FROM index_control").get()).toEqual({ owner_token: "abandoned" });
    f.index.exec("UPDATE index_control SET owner_token=NULL");
    mkdirSync(`${f.indexPath}.writer-lock`);
    versions = f.versions();
    await expect(s.instance.kick()).rejects.toThrow("search_writer_owned_or_recovery_required");
    expect(f.versions()).toEqual(versions); expect(s.calls).toHaveLength(0);
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(true);
  } finally { await s.instance.shutdown(); f.close(); }
});

test("claimed recovery still runs and its delayed retry returns to read-only idle", async () => {
  const f = fixture();
  const s = supervisor(f);
  try {
    f.insert();
    const claimed = claimNextJob(f.canonical)!;
    f.canonical.query("UPDATE mail_search_outbox SET state='blocked' WHERE mode<>?").run(claimed.mode);
    expect(await s.instance.kick()).toEqual(idle);
    expect(f.jobs().find(job => job.mode === claimed.mode)).toMatchObject({ state: "pending", attempt_token: null, attempt_count: 1, error_code: "interrupted" });
    expect(f.index.query("SELECT owner_token FROM index_control").get()).toEqual({ owner_token: null });
    const versions = f.versions();
    expect(await s.instance.kick()).toEqual(idle);
    expect(f.versions()).toEqual(versions); expect(s.calls).toHaveLength(0);
    f.canonical.exec("UPDATE mail_search_outbox SET available_at=0 WHERE state='pending'");
    expect(await s.instance.kick()).toMatchObject({ attempted: 1, acknowledged: 1, sealed: 1 });
  } finally { await s.instance.shutdown(); f.close(); }
});
