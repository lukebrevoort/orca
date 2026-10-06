import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeSearchBuild, verifySearchBuild } from "./admin.ts";
import { acquireWriterOwnership, type WriterOwnership } from "./ownership.ts";
import { acknowledgeReceipt, claimNextJob, DEFAULT_INDEX_LIMITS, enqueueBaseline, failAttempt, recoverClaimedJobs, type IndexJob, type IndexLimits } from "./queue.ts";
import { canonicalizePath, getSearchIndexPath, openCanonicalReadOnly, openIndexReadOnly, readIndexAccount, readSearchControl, readSourceAccounts } from "./schema.ts";
import { SearchIndexSupervisor } from "./supervisor.ts";
import type { IndexWorkerRequest } from "./worker.ts";
import { applyIndexJob, publishAccountReady } from "./worker-core.ts";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(beforeMigration = false) {
  const directory = mkdtempSync(join(tmpdir(), "orca-search-v3-")); paths.push(directory);
  const path = join(directory, "canonical.sqlite");
  const canonical = new Database(path);
  canonical.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE oauth_accounts(id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE emails(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,from_name TEXT,from_address TEXT,subject TEXT,snippet TEXT,body_text TEXT,is_read INTEGER DEFAULT 0);
    INSERT INTO oauth_accounts(id,user_id) VALUES('a','u');`);
  const insert = (id: string, subject = "Hello travel", body = "Synthetic itinerary") => canonical.query("INSERT INTO emails(id,account_id,from_address,subject,snippet,body_text) VALUES(?,'a','sender@example.test',?,'A short note',?)").run(id, subject, body);
  if (beforeMigration) insert("old");
  const migration = readFileSync(resolve(import.meta.dir, "../../../drizzle/0051_queued_mail_search.sql"), "utf8");
  for (const sql of migration.split("--> statement-breakpoint")) canonical.exec(sql);
  const indexPath = getSearchIndexPath(path);
  initializeSearchBuild(canonical, indexPath);
  const index = new Database(indexPath);
  index.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100");
  canonical.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  const owner = acquireWriterOwnership(index, indexPath, readSearchControl(canonical));
  const identity = { sourceId: readSearchControl(canonical).source_id, buildId: readSearchControl(canonical).build_id, ownerToken: owner.token };
  const readonly = openCanonicalReadOnly(path);
  const account = () => readSourceAccounts(canonical, ["a"], "metadata")[0]!;
  const jobs = () => canonical.query<IndexJob, []>("SELECT * FROM mail_search_outbox ORDER BY mode,message_id").all();
  const drain = () => { let job; while ((job = claimNextJob(canonical))) acknowledgeReceipt(canonical, applyIndexJob(readonly, index, job, identity)); };
  const baseline = () => { enqueueBaseline(canonical, "a", "metadata"); enqueueBaseline(canonical, "a", "full"); };
  const seal = (mode: "metadata" | "full") => publishAccountReady(readonly, index, "a", account().incarnation, mode, identity);
  const close = () => { readonly.close(); owner.release(); index.close(); canonical.close(); };
  return { directory, path, canonical, index, indexPath, readonly, owner, identity, insert, account, jobs, drain, baseline, seal, close };
}

test("migration defaults disabled, capture is atomic, coalesced and contains no body work", () => {
  const f = fixture();
  try {
    f.canonical.exec("UPDATE mail_search_control SET worker_enabled=0,paused=1");
    expect(readSearchControl(f.canonical).enabled).toBe(0);
    f.insert("one");
    expect(f.jobs().map((j) => [j.mode, j.version])).toEqual([["full", 1], ["metadata", 1]]);
    const triggers = f.canonical.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'mail_search_v3_%'").all().map((r) => r.sql).join("\n");
    expect(triggers).not.toMatch(/new\.body_text|old\.body_text|fts|lower\(|length\(|hash\(/i);
    expect(() => f.canonical.transaction(() => { f.canonical.exec("UPDATE emails SET subject='rolled back' WHERE id='one'"); throw new Error("rollback"); }).immediate()).toThrow("rollback");
    expect(f.jobs().every((j) => j.version === 1)).toBe(true);
    f.canonical.exec("UPDATE emails SET body_text='changed' WHERE id='one'");
    expect(f.jobs().map((j) => [j.mode, j.version])).toEqual([["full", 2], ["metadata", 1]]);
    f.canonical.exec("UPDATE emails SET is_read=1 WHERE id='one'");
    expect(f.jobs().map((j) => j.version)).toEqual([2, 1]);
    f.canonical.exec("UPDATE emails SET subject='changed' WHERE id='one'");
    expect(f.jobs()).toHaveLength(2);
    expect(f.index.query("SELECT count(*) AS n FROM metadata_fts").get()).toEqual({ n: 0 });
  } finally { f.close(); }
});

test("baseline zero applies and checkpoint/enqueue rollback together", () => {
  const f = fixture(true);
  try {
    expect(f.jobs()).toHaveLength(0);
    expect(() => f.canonical.transaction(() => { enqueueBaseline(f.canonical, "a", "metadata", 1); throw new Error("checkpoint fault"); }).immediate()).toThrow();
    expect(f.jobs()).toHaveLength(0); expect(f.account().baseline_cursor).toBe("");
    f.baseline(); f.drain();
    expect(f.index.query("SELECT metadata_version,full_version FROM index_documents").get()).toEqual({ metadata_version: 0, full_version: 0 });
    expect(f.seal("metadata")).toBe(true); expect(f.seal("full")).toBe(true);
    expect(verifySearchBuild(f.canonical, f.index).ready).toBe(true);
  } finally { f.close(); }
});

test("stale ack/failure cannot erase a coalesced newer version", () => {
  const f = fixture();
  try {
    f.insert("one");
    const old = claimNextJob(f.canonical)!;
    const receipt = applyIndexJob(f.readonly, f.index, old, f.identity);
    f.canonical.exec("UPDATE emails SET subject='new revision' WHERE id='one'");
    expect(acknowledgeReceipt(f.canonical, receipt)).toBe(false);
    expect(failAttempt(f.canonical, old, "stale")).toBe(false);
    expect(f.jobs().find((j) => j.mode === old.mode)?.version).toBe(2);
    f.drain();
    expect(f.index.query("SELECT metadata_version,full_version FROM index_documents").get()).toEqual({ metadata_version: 2, full_version: 2 });
  } finally { f.close(); }
});

test("commit failures roll back, commit-before-ack replay is idempotent, seal follows ack", () => {
  const f = fixture();
  try {
    f.insert("one"); f.baseline();
    const job = claimNextJob(f.canonical)!;
    expect(() => applyIndexJob(f.readonly, f.index, job, f.identity, DEFAULT_INDEX_LIMITS, "before_commit")).toThrow();
    expect(f.index.query("SELECT count(*) AS n FROM index_documents").get()).toEqual({ n: 0 });
    expect(() => applyIndexJob(f.readonly, f.index, job, f.identity, DEFAULT_INDEX_LIMITS, "after_commit")).toThrow();
    expect(f.seal(job.mode)).toBe(false);
    const mutation = readIndexAccount(f.index, "a", f.account().incarnation, job.mode)!.mutation_token;
    const replay = applyIndexJob(f.readonly, f.index, job, f.identity);
    expect(readIndexAccount(f.index, "a", f.account().incarnation, job.mode)!.mutation_token).toBe(mutation);
    expect(acknowledgeReceipt(f.canonical, replay)).toBe(true);
    expect(acknowledgeReceipt(f.canonical, replay)).toBe(false);
    expect(readIndexAccount(f.index, "a", f.account().incarnation, job.mode)!.ready).toBe(0);
    expect(f.seal(job.mode)).toBe(true);
  } finally { f.close(); }
});

test("delayed baseline cannot resurrect deleted text and reinsert uses stable doc ID", () => {
  const f = fixture(true);
  try {
    f.baseline();
    f.canonical.exec("DELETE FROM emails WHERE id='old'"); f.drain();
    const deleted = f.index.query<{ doc_id: number; metadata_deleted: number }, []>("SELECT doc_id,metadata_deleted FROM index_documents").get()!;
    expect(deleted.metadata_deleted).toBe(1);
    f.canonical.exec("UPDATE mail_search_accounts SET baseline_complete=0,baseline_cursor=''");
    f.insert("old", "Reinserted ticket"); f.baseline(); f.drain();
    expect(f.index.query("SELECT doc_id,metadata_deleted FROM index_documents").get()).toEqual({ doc_id: deleted.doc_id, metadata_deleted: 0 });
    expect(f.index.query("SELECT rowid FROM metadata_fts WHERE metadata_fts MATCH 'subject : \"reinserted\"'").all()).toHaveLength(1);
  } finally { f.close(); }
});

test("oversize full job stays blocked while metadata can publish; canonical text retained", () => {
  const f = fixture();
  try {
    f.insert("one", "Ticket", "A harmless forty character synthetic body"); f.baseline();
    let job; while ((job = claimNextJob(f.canonical))) acknowledgeReceipt(f.canonical, applyIndexJob(f.readonly, f.index, job, f.identity, { ...DEFAULT_INDEX_LIMITS, fullBytes: 8 }));
    expect(f.jobs().map((j) => [j.mode, j.state, j.error_code])).toEqual([["full", "blocked", "source_too_large"]]);
    expect(f.seal("metadata")).toBe(true); expect(f.seal("full")).toBe(false);
    expect(f.canonical.query("SELECT body_text FROM emails").get()).toEqual({ body_text: "A harmless forty character synthetic body" });
  } finally { f.close(); }
});

test("account tombstones survive cascade, clean bounded batches and isolate reused IDs", () => {
  const f = fixture();
  try {
    f.insert("one"); f.insert("two"); f.drain(); const old = f.account().incarnation;
    f.canonical.exec("DELETE FROM oauth_accounts WHERE id='a'");
    expect(f.jobs().every((j) => j.target === "account")).toBe(true);
    f.canonical.exec("INSERT INTO oauth_accounts(id,user_id) VALUES('a','new-user')");
    expect(f.account().incarnation).not.toBe(old);
    f.insert("one", "New incarnation");
    let job; let sawMore = false;
    while ((job = claimNextJob(f.canonical))) { const r = applyIndexJob(f.readonly, f.index, job, f.identity, { ...DEFAULT_INDEX_LIMITS, cleanupDocuments: 1 }); sawMore ||= r.status === "more"; acknowledgeReceipt(f.canonical, r); }
    expect(sawMore).toBe(true);
    expect(f.index.query("SELECT count(*) AS n FROM index_documents WHERE incarnation=? AND metadata_deleted=0").get(old)).toEqual({ n: 0 });
    expect(f.index.query("SELECT count(*) AS n FROM index_documents WHERE incarnation=? AND metadata_deleted=0").get(f.account().incarnation)).toEqual({ n: 1 });
  } finally { f.close(); }
});

test("posting mutation clears ready atomically and mutation token rejects stale seal proof", () => {
  const f = fixture();
  try {
    f.insert("one"); f.baseline(); f.drain(); f.seal("metadata");
    const published = publishAccountReady(f.readonly, f.index, "a", f.account().incarnation, "metadata", f.identity, () => {
      f.canonical.exec("UPDATE emails SET subject='new posting' WHERE id='one'");
      const job = claimNextJob(f.canonical)!;
      expect(job.mode).toBe("metadata");
      acknowledgeReceipt(f.canonical, applyIndexJob(f.readonly, f.index, job, f.identity));
    });
    expect(published).toBe(false);
    expect(readIndexAccount(f.index, "a", f.account().incarnation, "metadata")!.ready).toBe(0);
  } finally { f.close(); }
});

test("readonly source, ownership token, hardlink path refusal and stale ownership fail closed", () => {
  const f = fixture();
  try {
    expect(() => f.readonly.exec("UPDATE emails SET subject='forbidden'")).toThrow();
    expect(() => acquireWriterOwnership(f.index, f.indexPath, readSearchControl(f.canonical))).toThrow("search_writer_owned_or_recovery_required");
    const alias = join(f.directory, "alias.sqlite"); linkSync(f.indexPath, alias);
    // Do not open aliases as SQLite connections: reject paths before any alias write.
    expect(() => canonicalizePath(alias)).toThrow("search_database_hardlink_unsupported");
    expect(() => openIndexReadOnly(alias)).toThrow("search_database_hardlink_unsupported");
    expect(() => canonicalizePath(f.indexPath)).toThrow("search_database_hardlink_unsupported");
    rmSync(alias);
    const sourceAlias = join(f.directory, "canonical-alias.sqlite"); linkSync(f.path, sourceAlias);
    expect(() => openCanonicalReadOnly(sourceAlias)).toThrow("search_database_hardlink_unsupported");
    rmSync(sourceAlias);
    f.insert("one"); const job = claimNextJob(f.canonical)!;
    expect(() => applyIndexJob(f.readonly, f.index, job, { ...f.identity, ownerToken: "unowned-token" })).toThrow("search_writer_fenced");
    expect(existsSync(f.owner.directory)).toBe(true);
    expect(readFileSync(join(f.owner.directory, "owner.json"), "utf8")).toContain(String(process.pid));
  } finally { f.close(); }
});

test("finite retry recovery includes delayed and blocked obligations in readiness", () => {
  const f = fixture();
  try {
    f.insert("one"); f.baseline();
    const job = claimNextJob(f.canonical)!;
    recoverClaimedJobs(f.canonical, 0, { ...DEFAULT_INDEX_LIMITS, maxAttempts: 1 });
    expect(f.jobs().find((j) => j.mode === job.mode)?.state).toBe("blocked");
    expect(f.seal(job.mode)).toBe(false);
    const other = claimNextJob(f.canonical)!;
    failAttempt(f.canonical, other, "tiny_fault", 0);
    expect(claimNextJob(f.canonical, 1)).toBeNull();
    expect(f.seal(other.mode)).toBe(false);
  } finally { f.close(); }
});

test("real bounded child commits/acks, timeout is reaped, orderly shutdown releases owner", async () => {
  const f = fixture();
  f.insert("one"); f.baseline();
  f.readonly.close(); f.owner.release(); f.index.close();
  try {
    const supervisor = new SearchIndexSupervisor({ canonicalPath: f.path });
    const result = await supervisor.kick();
    expect(result.acknowledged).toBe(2); expect(result.sealed).toBe(2);
    await supervisor.shutdown();
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    f.canonical.exec("UPDATE emails SET subject='small timeout example' WHERE id='one'");
    const timeout = new SearchIndexSupervisor({ canonicalPath: f.path, limits: { ...DEFAULT_INDEX_LIMITS, attemptTimeoutMs: 1, maxJobsPerRun: 1 } });
    await timeout.kick(); await timeout.shutdown();
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    expect(f.jobs().some((j) => j.error_code === "search_attempt_timeout")).toBe(true);
    const shutdown = new SearchIndexSupervisor({ canonicalPath: f.path });
    const active = shutdown.kick(); await shutdown.shutdown(); await active;
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    expect(f.jobs().some((j) => j.state === "claimed")).toBe(false);
  } finally { f.canonical.close(); }
});

test("migration refuses the experimental schema and leaves canonical mail intact", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE mail_search_documents(id TEXT); INSERT INTO mail_search_documents VALUES('preserved')");
    const sql = readFileSync(resolve(import.meta.dir, "../../../drizzle/0051_queued_mail_search.sql"), "utf8");
    expect(() => db.exec(sql)).toThrow();
    expect(db.query("SELECT id FROM mail_search_documents").get()).toEqual({ id: "preserved" });
  } finally { db.close(); }
});

test("a canonical write after seal proof makes its published revision unusable", () => {
  const f = fixture();
  try {
    f.insert("one"); f.baseline(); f.drain();
    const priorRevision = f.account().revision;
    expect(publishAccountReady(f.readonly, f.index, "a", f.account().incarnation, "metadata", f.identity, () => {
      f.canonical.exec("UPDATE emails SET subject='later canonical write' WHERE id='one'");
    })).toBe(true);
    const applied = readIndexAccount(f.index, "a", f.account().incarnation, "metadata")!;
    expect(applied.published_revision).toBe(priorRevision);
    expect(applied.published_revision).not.toBe(f.account().revision);
    expect(verifySearchBuild(f.canonical, f.index).ready).toBe(false);
  } finally { f.close(); }
});

test("identity moves enqueue delete-old/upsert-new and account IDs rotate incarnations", () => {
  const f = fixture();
  try {
    f.insert("old-id"); f.drain();
    f.canonical.exec("UPDATE emails SET id='new-id' WHERE id='old-id'");
    expect(f.jobs().map((j) => [j.message_id, j.operation])).toEqual([["new-id", "upsert"], ["old-id", "delete"], ["new-id", "upsert"], ["old-id", "delete"]]);
    f.drain();
    expect(f.index.query("SELECT message_id,metadata_deleted FROM index_documents ORDER BY message_id").all()).toEqual([{ message_id: "new-id", metadata_deleted: 0 }, { message_id: "old-id", metadata_deleted: 1 }]);
    f.canonical.exec("INSERT INTO oauth_accounts(id,user_id) VALUES('empty','u')");
    const before = readSourceAccounts(f.canonical, ["empty"], "metadata")[0]!.incarnation;
    f.canonical.exec("UPDATE oauth_accounts SET id='renamed' WHERE id='empty'");
    expect(readSourceAccounts(f.canonical, ["renamed"], "metadata")[0]!.incarnation).not.toBe(before);
    expect(f.jobs().filter((j) => j.account_id === "empty").every((j) => j.target === "account")).toBe(true);
  } finally { f.close(); }
});

test("disconnect subsumes blocked message jobs into durable account cleanup", () => {
  const f = fixture();
  try {
    f.insert("one"); const job = claimNextJob(f.canonical)!;
    failAttempt(f.canonical, job, "blocked", 0, { ...DEFAULT_INDEX_LIMITS, maxAttempts: 1 });
    f.canonical.exec("DELETE FROM oauth_accounts WHERE id='a'");
    expect(f.jobs()).toHaveLength(2);
    expect(f.jobs().every((row) => row.target === "account" && row.state === "pending")).toBe(true);
    f.drain(); expect(f.jobs()).toHaveLength(0);
  } finally { f.close(); }
});

test("lost index cannot be silently recreated by the runtime and mail still writes", async () => {
  const f = fixture();
  f.readonly.close(); f.owner.release(); f.index.close();
  rmSync(f.indexPath);
  try {
    const supervisor = new SearchIndexSupervisor({ canonicalPath: f.path });
    await expect(supervisor.kick()).rejects.toThrow();
    await supervisor.shutdown().catch(() => {});
    expect(existsSync(f.indexPath)).toBe(false);
    f.insert("still-available"); expect(f.jobs()).toHaveLength(2);
  } finally { f.canonical.close(); }
});

test("bounded sealing advances a durable cursor across more accounts than one run", async () => {
  const f = fixture(); f.baseline();
  for (let n = 0; n < 3; n++) f.canonical.query("INSERT INTO oauth_accounts(id,user_id) VALUES(?,'u')").run(`extra-${n}`);
  f.readonly.close(); f.owner.release(); f.index.close();
  try {
    for (let n = 0; n < 4; n++) {
      const supervisor = new SearchIndexSupervisor({ canonicalPath: f.path, limits: { ...DEFAULT_INDEX_LIMITS, maxJobsPerRun: 2 } });
      await supervisor.kick(); await supervisor.shutdown();
    }
    const index = new Database(f.indexPath);
    try { expect(verifySearchBuild(f.canonical, index)).toEqual({ ready: true, accounts: 8, outstanding: 0 }); }
    finally { index.close(); }
  } finally { f.canonical.close(); }
});

test("claim and baseline use ID indexes without whole-queue sorting", () => {
  const f = fixture();
  try {
    const claim = f.canonical.query<{ detail: string }, [string, number]>("EXPLAIN QUERY PLAN SELECT * FROM mail_search_outbox WHERE state='pending' AND account_id>? ORDER BY account_id,CASE mode WHEN 'metadata' THEN 0 ELSE 1 END,created_at,message_id LIMIT ?").all("", 32).map((r) => r.detail).join("\n");
    expect(claim).toContain("mail_search_outbox_schedule"); expect(claim).not.toContain("TEMP B-TREE");
    const baseline = f.canonical.query<{ detail: string }, [string, string, number]>("EXPLAIN QUERY PLAN SELECT id FROM emails WHERE account_id=? AND id>? ORDER BY id LIMIT ?").all("a", "", 64).map((r) => r.detail).join("\n");
    expect(baseline).toContain("mail_search_baseline_ids"); expect(baseline).not.toContain("TEMP B-TREE");
  } finally { f.close(); }
});

test("a second OS process cannot acquire writer ownership and artifacts are private", async () => {
  const f = fixture();
  try {
    expect(statSync(f.owner.directory).mode & 0o777).toBe(0o700);
    expect(statSync(f.indexPath).mode & 0o777).toBe(0o600);
    const script = `import { Database } from 'bun:sqlite';
      import { acquireWriterOwnership, type WriterOwnership } from ${JSON.stringify(resolve(import.meta.dir, "ownership.ts"))};
      const index = new Database(process.argv.at(-1), { readwrite: true, create: false });
      try { acquireWriterOwnership(index, process.argv.at(-1), ${JSON.stringify(readSearchControl(f.canonical))}); process.exitCode=2; }
      catch(error) { if (error.message !== 'search_writer_owned_or_recovery_required') process.exitCode=3; }
      finally { index.close(); }`;
    const child = Bun.spawn([process.execPath, "-e", script, f.indexPath], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    expect(existsSync(f.owner.directory)).toBe(true);
    // Existing owner records are never interpreted as authority to kill a PID.
    expect(readFileSync(join(f.owner.directory, "owner.json"), "utf8")).toContain(f.owner.token);
  } finally { f.close(); }
});

interface SupervisorHarness {
  child: ReturnType<typeof Bun.spawn> | null;
  invoke(request: IndexWorkerRequest, owner: WriterOwnership, limits: IndexLimits): Promise<unknown>;
}

test("post-spawn owner-record failure still kills and reaps the child", async () => {
  const f = fixture();
  try {
    f.insert("one"); const job = claimNextJob(f.canonical)!;
    const supervisor = new SearchIndexSupervisor({ canonicalPath: f.path });
    const harness = supervisor as unknown as SupervisorHarness;
    let spawned: ReturnType<typeof Bun.spawn> | undefined;
    let cleared = false;
    const owner: WriterOwnership = { ...f.owner, recordWorker(pid) {
      if (pid !== null) { spawned = harness.child!; throw new Error("injected_owner_record_failure"); }
      cleared = true; f.owner.recordWorker(null);
    } };
    await expect(harness.invoke({ protocol: 1, action: "apply", canonicalPath: f.path, indexPath: f.indexPath, identity: f.identity, job }, owner, DEFAULT_INDEX_LIMITS)).rejects.toThrow("injected_owner_record_failure");
    expect(spawned).toBeDefined();
    expect(spawned!.signalCode).toBe("SIGKILL");
    expect(typeof await spawned!.exited).toBe("number");
    expect(cleared).toBe(true); expect(harness.child).toBeNull();
    await supervisor.shutdown();
  } finally { f.close(); }
});

test("shutdown during seal resolves kick/shutdown and releases ownership after reap", async () => {
  const f = fixture(); f.insert("one"); f.baseline(); f.drain();
  f.readonly.close(); f.owner.release(); f.index.close();
  try {
    const supervisor = new SearchIndexSupervisor({ canonicalPath: f.path });
    const harness = supervisor as unknown as SupervisorHarness;
    const invoke = harness.invoke.bind(supervisor);
    let shutdown: Promise<void> | undefined;
    let spawned: ReturnType<typeof Bun.spawn> | undefined;
    harness.invoke = (request, owner, limits) => {
      const pending = invoke(request, owner, limits);
      if (request.action === "seal") {
        spawned = harness.child!;
        queueMicrotask(() => { shutdown = supervisor.shutdown(); });
      }
      return pending;
    };
    const result = await supervisor.kick();
    expect(shutdown).toBeDefined(); await shutdown;
    expect(result.stopped).toBe(true); expect(result.sealed).toBe(0);
    expect(spawned!.signalCode).toBe("SIGKILL"); expect(harness.child).toBeNull();
    expect(existsSync(`${f.indexPath}.writer-lock`)).toBe(false);
    const index = new Database(f.indexPath);
    try { expect(index.query("SELECT owner_token FROM index_control").get()).toEqual({ owner_token: null }); }
    finally { index.close(); }
  } finally { f.canonical.close(); }
});

test("symlink admin init/status/drain and supervisor resolve one sidecar", async () => {
  const f = fixture();
  f.readonly.close(); f.owner.release(); f.index.close();
  rmSync(f.indexPath);
  const alias = join(f.directory, "canonical-link.sqlite"); symlinkSync(f.path, alias);
  const admin = resolve(import.meta.dir, "admin.ts");
  const run = async (command: string) => {
    const child = Bun.spawn([process.execPath, admin, command, alias], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(code).toBe(0);
    return output ? JSON.parse(output) as Record<string, unknown> : undefined;
  };
  try {
    await run("init");
    expect(existsSync(f.indexPath)).toBe(true);
    expect(existsSync(`${alias}.search-v3.sqlite`)).toBe(false);
    expect((await run("status"))?.indexFilePresent).toBe(true);
    f.insert("one"); enqueueBaseline(f.canonical, "a", "metadata"); enqueueBaseline(f.canonical, "a", "full");
    await run("resume"); expect((await run("drain"))?.acknowledged).toBe(2);
    const supervisor = new SearchIndexSupervisor({ canonicalPath: alias });
    await supervisor.kick(); await supervisor.shutdown();
    const index = new Database(f.indexPath);
    try { expect(verifySearchBuild(f.canonical, index).ready).toBe(true); }
    finally { index.close(); }
  } finally { f.canonical.close(); }
});

test("document updates and cleanup preserve IDs above Number.MAX_SAFE_INTEGER", () => {
  const f = fixture();
  try {
    f.index.exec("INSERT INTO sqlite_sequence(name,seq) VALUES('index_documents',9007199254740992)");
    f.insert("one", "Original first"); f.insert("two", "Original second"); f.drain();
    const rows = f.index.query<{ doc_id: string; message_id: string }, []>("SELECT CAST(doc_id AS TEXT) AS doc_id,message_id FROM index_documents ORDER BY index_documents.doc_id").all();
    expect(rows).toHaveLength(2); expect(rows[0]!.doc_id).toBe("9007199254740993");
    expect(new Set(rows.map(row => row.doc_id)).size).toBe(2);
    f.canonical.exec("UPDATE emails SET subject='Updated first' WHERE id='one'"); f.drain();
    expect(f.index.query("SELECT CAST(rowid AS TEXT) AS id FROM metadata_fts WHERE metadata_fts MATCH 'subject : \"updated\"'").all()).toEqual([{ id: rows[0]!.doc_id }]);
    f.canonical.exec("DELETE FROM oauth_accounts WHERE id='a'");
    let job; while ((job = claimNextJob(f.canonical))) acknowledgeReceipt(f.canonical, applyIndexJob(f.readonly, f.index, job, f.identity, { ...DEFAULT_INDEX_LIMITS, cleanupDocuments: 1 }));
    expect(f.index.query("SELECT count(*) AS n FROM metadata_fts").get()).toEqual({ n: 0 });
    expect(f.index.query("SELECT count(*) AS n FROM full_fts").get()).toEqual({ n: 0 });
    expect(f.index.query("SELECT count(*) AS n FROM index_documents WHERE metadata_deleted=1 AND full_deleted=1").get()).toEqual({ n: 2 });
  } finally { f.close(); }
});
