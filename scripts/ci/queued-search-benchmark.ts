/** Ordinary, bounded local cost evidence. Creates only small synthetic mail.
 * Run: bun scripts/ci/queued-search-benchmark.ts /tmp/queued-search-report.json /path/to/scratch
 * Add --keep-fixture as the final argument to retain the synthetic SQLite files.
 * Read-only rerun: bun scripts/ci/queued-search-benchmark.ts --phase reads /path/to/retrieval.sqlite
 * This is not a security, large-body, concurrency, or production capacity test.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RankedSearchInput } from "../../apps/api/src/search/read.ts";

const root = resolve(import.meta.dir, "../..");
const migrationDirectory = join(root, "apps/api/drizzle");
const messages = 20_000;
const samples = 5;
const mib = 1024 * 1024;
const round = (n: number) => Math.round(n * 1000) / 1000;
const rss = (pid = process.pid) => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return { rss: Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024,
      hwm: Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024 };
  } catch { return { rss: 0, hwm: 0 }; }
};
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, min: round(sorted[0] ?? 0), median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0), max: round(sorted.at(-1) ?? 0),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length) };
}
function footprint(path: string) {
  const size = (suffix: string) => existsSync(path + suffix) ? statSync(path + suffix).size : 0;
  return { databaseBytes: size(""), walBytes: size("-wal"), shmBytes: size("-shm") };
}
function migrate(db: Database, capture: boolean) {
  const journal = JSON.parse(readFileSync(join(migrationDirectory, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  for (const entry of journal.entries) {
    if (!capture && entry.idx === 51) continue;
    for (const statement of readFileSync(join(migrationDirectory, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint")) db.exec(statement);
  }
}
function createCanonical(path: string, capture: boolean) {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  migrate(db, capture);
  db.exec(`INSERT INTO users(id,email,display_name) VALUES('user','benchmark@example.test','Synthetic benchmark');
    INSERT INTO oauth_accounts(id,user_id,provider,provider_email,provider_id) VALUES('account','user','gmail','benchmark@example.test','synthetic');`);
  return db;
}
function fixtureRow(i: number) {
  const id = `mail-${String(i).padStart(6, "0")}`;
  return { id, subject: i === 12 ? "Quasar planning appointment" : i % 40 === 0 ? `Tattoo appointment confirmation ${i}` : `Project update ${i}`,
    body: i === 0 ? "Archipelago itinerary for a synthetic trip. Please keep this old note." :
      i % 23 === 0 ? "Tattoo appointment confirmation. Please review the enclosed synthetic visit notes." :
      `Here are the project notes for our weekly planning meeting. Please review item ${i} and share your thoughts. Thank you.` };
}
function insertFixture(db: Database, count: number) {
  const thread = db.query("INSERT INTO threads(id,account_id,provider_thread_id) VALUES(?,'account',?)");
  const email = db.query(`INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,from_name,subject,snippet,body_text,received_at,human_classification)
    VALUES(?,'account',?,?,'taylor@example.test','Taylor Synthetic',?,'Notes for weekly planning',?,?,'likely_human')`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const row = fixtureRow(i);
      thread.run(`thread-${row.id}`, row.id);
      email.run(row.id, `thread-${row.id}`, row.id, row.subject, row.body, Date.UTC(2000, 0, 1) + i * 86_400_000);
    }
  }).immediate();
}
function input(path: string, query: string, mode: "metadata" | "full" = "full"): RankedSearchInput {
  return { databasePath: path, authorization: { userId: "user", accountIds: ["account"] },
    mode, cursorKey: "synthetic-benchmark-cursor-key", query: { query, limit: 10, view: "all", classification: "all" } };
}

/** Samples this executable's RSS rather than inherited getrusage maxima. */
async function measuredChild(args: string[], payload = "", deadlineMs = 30_000) {
  const start = performance.now();
  const child = Bun.spawn([process.execPath, "--no-env-file", "--smol", ...args], {
    stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C.UTF-8" },
  });
  let peakRssBytes = 0, previousRss = 0, previousAt = start, rssMiBSeconds = 0, points = 0;
  const sample = () => {
    const now = performance.now(); const memory = rss(child.pid);
    rssMiBSeconds += ((previousRss + memory.rss) / 2 / mib) * ((now - previousAt) / 1000);
    previousRss = memory.rss; previousAt = now; points++;
    peakRssBytes = Math.max(peakRssBytes, memory.hwm, memory.rss);
  };
  const interval = setInterval(sample, 2);
  const timeout = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  sample(); clearInterval(interval); clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Benchmark child exited ${exitCode}: ${stderr.slice(0, 1000)}`);
  const usage = child.resourceUsage();
  return { value: JSON.parse(stdout), wallMs: performance.now() - start,
    cpuSeconds: usage ? Number(usage.cpuTime.total) / 1e6 : null, userCpuSeconds: usage ? Number(usage.cpuTime.user) / 1e6 : null,
    systemCpuSeconds: usage ? Number(usage.cpuTime.system) / 1e6 : null, peakRssBytes, sampledRssMiBSeconds: rssMiBSeconds, rssSamples: points };
}

async function capturePhase(directory: string) {
  const repetitions = [];
  for (let repeat = 0; repeat < 3; repeat++) for (const capture of repeat % 2 ? [true, false] : [false, true]) {
    const path = join(directory, `capture-${repeat}-${capture}.sqlite`);
    const db = createCanonical(path, capture);
    insertFixture(db, 300);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const operations = [
      ["insert", db.query("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,from_name,subject,snippet,body_text,received_at) VALUES(?,'account','thread-mail-000000',?,'taylor@example.test','Taylor','Weekly project update','Small synthetic note','Please review the planning notes.',946684800000)")],
      ["metadataUpdate", db.query("UPDATE emails SET subject=? WHERE id=?")],
      ["bodyUpdate", db.query("UPDATE emails SET body_text=? WHERE id=?")],
      ["readFlagUpdate", db.query("UPDATE emails SET is_read=? WHERE id=?")],
    ] as const;
    const timings: Record<string, unknown> = {};
    for (const [name, statement] of operations) {
      const cpuBefore = process.cpuUsage(); const started = performance.now(); const durations = [];
      for (let i = 0; i < 300; i++) {
        const id = `fresh-${i}`; const operationStart = performance.now();
        if (name === "insert") statement.run(id, id);
        else if (name === "readFlagUpdate") statement.run(1, id);
        else statement.run(`Synthetic revised planning note ${i}`, id);
        durations.push(performance.now() - operationStart);
      }
      const cpu = process.cpuUsage(cpuBefore);
      timings[name] = { latencyMs: summary(durations), wallMs: performance.now() - started, cpuSeconds: (cpu.user + cpu.system) / 1e6 };
    }
    const beforeCheckpoint = footprint(path);
    const queuedJobs = capture ? (db.query("SELECT count(*) n FROM mail_search_outbox").get() as { n: number }).n : 0;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    repetitions.push({ repeat, capture, countPerOperation: 300, synchronous: "FULL", timings, queuedJobs, beforeCheckpoint, checkpointed: footprint(path) });
    db.close();
  }
  return repetitions;
}

async function preparePhase(path: string) {
  const { prepareSyntheticSearchIndex } = await import("../../apps/api/src/search/test-support.ts");
  const db = createCanonical(path, true);
  const start = performance.now(); insertFixture(db, messages);
  const insertMs = performance.now() - start;
  const sourceBytes = db.query("SELECT sum(coalesce(octet_length(from_address),0)+coalesce(octet_length(from_name),0)+coalesce(octet_length(subject),0)+coalesce(octet_length(snippet),0)+coalesce(octet_length(body_text),0)) total,max(octet_length(body_text)) maxBodyBytes FROM emails").get();
  const preparationStart = performance.now(); prepareSyntheticSearchIndex(db);
  const indexPreparationMs = performance.now() - preparationStart;
  const indexPath = `${path}.search-v3.sqlite`;
  const index = new Database(indexPath); index.exec("PRAGMA synchronous=FULL");
  const beforeCheckpoint = { canonical: footprint(path), index: footprint(indexPath) };
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); index.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const checkpointed = { canonical: footprint(path), index: footprint(indexPath) };
  const postingRows = index.query("SELECT (SELECT count(*) FROM metadata_fts) metadataRows,(SELECT count(*) FROM full_fts) fullRows").get();
  const queue = db.query("SELECT count(*) jobs FROM mail_search_outbox").get();
  index.close(); db.close();
  return { messages, accounts: 1, insertMs, indexPreparationMs, sourceBytes, postingRows, queue, beforeCheckpoint, checkpointed,
    preparationMethod: "Existing synthetic test helper: in-process apply/ack for both modes. Excludes process-per-job overhead and is NOT supervised backfill throughput." };
}

async function supervisorPhase(path: string) {
  const { SearchIndexSupervisor } = await import("../../apps/api/src/search/indexing/supervisor.ts");
  const { initializeSearchBuild } = await import("../../apps/api/src/search/indexing/admin.ts");
  const { enqueueBaseline } = await import("../../apps/api/src/search/indexing/queue.ts");
  const db = createCanonical(path, true); insertFixture(db, 16);
  const indexPath = `${path}.search-v3.sqlite`; initializeSearchBuild(db, indexPath);
  for (const mode of ["metadata", "full"] as const) enqueueBaseline(db, "account", mode);
  db.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  const beforeConstruction = rss(); const supervisor = new SearchIndexSupervisor({ canonicalPath: path });
  const idleBefore = rss();
  const idleCpuStart = process.cpuUsage(); await Bun.sleep(300); const idleCpu = process.cpuUsage(idleCpuStart);
  const workingStart = performance.now(); let parentRssPeakBytes = 0; let childRssPeakBytes = 0; let combinedRssPeakBytes = 0;
  const children = new Set<number>();
  let parentRssMiBSeconds = 0, childRssMiBSeconds = 0, previousTime = workingStart;
  const sample = () => {
    const now = performance.now(); const parent = rss().rss; let child = 0;
    try { const record = JSON.parse(readFileSync(`${indexPath}.writer-lock/owner.json`, "utf8")); if (record.workerPid) { children.add(record.workerPid); child = rss(record.workerPid).rss; } } catch { /* Between owned runs. */ }
    parentRssPeakBytes = Math.max(parentRssPeakBytes, parent); childRssPeakBytes = Math.max(childRssPeakBytes, child);
    combinedRssPeakBytes = Math.max(combinedRssPeakBytes, parent + child);
    parentRssMiBSeconds += parent / mib * (now - previousTime) / 1000;
    childRssMiBSeconds += child / mib * (now - previousTime) / 1000; previousTime = now;
  };
  const timer = setInterval(sample, 2); const cpuBefore = process.cpuUsage(); const drains = [];
  for (let run = 0; run < 2; run++) { const start = performance.now(); drains.push({ result: await supervisor.kick(), wallMs: performance.now() - start }); }
  sample(); clearInterval(timer);
  const wallMs = performance.now() - workingStart; const parentCpu = process.cpuUsage(cpuBefore);
  const afterWork = rss(); await supervisor.shutdown();
  const remaining = db.query("SELECT count(*) n FROM mail_search_outbox").get();
  const sourceFootprint = footprint(path); const indexFootprint = footprint(indexPath); db.close();
  return { messages: 16, obligations: 32, beforeConstruction, idleBefore, idleCpuSecondsDuring300ms: (idleCpu.user + idleCpu.system) / 1e6,
    wallMs, drains, parentCpuSeconds: (parentCpu.user + parentCpu.system) / 1e6, observedChildCount: children.size,
    parentRssPeakBytes, childRssPeakBytes, combinedRssPeakBytes, parentRssMiBSeconds, childRssMiBSeconds, afterWork,
    remaining, sourceFootprint, indexFootprint, note: "Supervisor lives in existing API process; these are an isolated harness process's absolute RSS values, not additional persistent production RSS. Samples include actual default-bounded children and seals." };
}

async function writerPhase(path: string) {
  const { initializeSearchBuild } = await import("../../apps/api/src/search/indexing/admin.ts");
  const { acquireWriterOwnership } = await import("../../apps/api/src/search/indexing/ownership.ts");
  const { claimNextJob, acknowledgeReceipt, DEFAULT_INDEX_LIMITS } = await import("../../apps/api/src/search/indexing/queue.ts");
  const { readSearchControl } = await import("../../apps/api/src/search/indexing/schema.ts");
  const db = createCanonical(path, true); insertFixture(db, 5);
  const indexPath = `${path}.search-v3.sqlite`; initializeSearchBuild(db, indexPath);
  db.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  const index = new Database(indexPath); index.exec("PRAGMA synchronous=FULL");
  const control = readSearchControl(db); const owner = acquireWriterOwnership(index, indexPath, control);
  const identity = { sourceId: control.source_id, buildId: control.build_id, ownerToken: owner.token };
  const jobs = [];
  try {
    for (let n = 0; n < 10; n++) {
      const job = claimNextJob(db); if (!job) throw new Error("Expected synthetic job");
      const request = { protocol: 1, action: "apply", canonicalPath: path, indexPath, identity, job, limits: DEFAULT_INDEX_LIMITS };
      const result = await measuredChild([join(root, "apps/api/src/search/indexing/worker.ts")], JSON.stringify(request), 5_000);
      if (result.value.status !== "applied" || !acknowledgeReceipt(db, result.value)) throw new Error("Expected durable synthetic receipt");
      jobs.push({ mode: job.mode, ...result, value: { status: result.value.status } });
    }
    return jobs;
  } finally { owner.release(); index.close(); db.close(); }
}

async function readPhase(path: string) {
  const sourcePaths = ["apps/api/src/search/read.ts", "apps/api/src/search/executor.ts", "apps/api/src/search/protocol.ts", "apps/api/src/mailbox/read.ts"];
  const hashes = () => Object.fromEntries(sourcePaths.map(file => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]));
  const sourceHashesBefore = hashes();
  const { createRankedSearchExecutor } = await import("../../apps/api/src/search/executor.ts");
  const queries = [];
  const executor = createRankedSearchExecutor();
  let exactCounts: unknown;
  try {
    for (const [name, text, mode, expected] of [
      ["rareSubject", "quasar", "full", "mail-000012"],
      ["oldBodyOnly", "archipelago", "full", "mail-000000"],
      ["commonSubject", "project", "full", null],
      ["noHit", "nonexistentfixtureterm", "full", null],
      ["metadataOnly", "quasar", "metadata", "mail-000012"],
    ] as const) {
      const request = input(path, text, mode); const rawWorkers = []; const executorReads = [];
      for (let n = 0; n < samples; n++) {
        const child = await measuredChild([join(root, "apps/api/src/search/worker.ts")], JSON.stringify({ version: 1, ...request }), 2_000);
        if (!child.value.ok) throw new Error(`Read failed: ${child.value.code}`);
        const result = child.value.result;
        if (expected && !result.page.messages.some((row: { id: string }) => row.id === expected)) throw new Error(`Missing synthetic match ${expected}`);
        rawWorkers.push({ ...child, value: { metric: result.metric, ids: result.page.messages.map((row: { id: string }) => row.id),
          continuation: result.page.continuation, peakRssBytes: child.value.peakRssBytes } });
        const start = performance.now(); let observation;
        const read = await executor.read(request, { observe: value => { observation = value; } });
        executorReads.push({ endToEndMs: performance.now() - start, observation, metric: read.metric, returned: read.page.messages.length });
      }
      queries.push({ name, mode, rawWorkers, executorReads });
    }
    const countRequest = { ...input(path, "project", "metadata"), exactCounts: true };
    countRequest.query.limit = 25;
    const started = performance.now(); let observation;
    try {
      const result = await executor.read(countRequest, { observe: value => { observation = value; } });
      if (result.counts?.classification.all !== 19_499) throw new Error("Unexpected synthetic exact count");
      exactCounts = { success: true, endToEndMs: performance.now() - started, observation,
        returned: result.page.messages.length, metric: result.metric, counts: result.counts };
    } catch (error) {
      exactCounts = { success: false, endToEndMs: performance.now() - started, observation,
        code: error instanceof Error && "code" in error ? error.code : "unexpected_error" };
      if (!(error instanceof Error && "code" in error && error.code === "search_budget_exceeded")) throw error;
    }
  } finally { await executor.shutdown(); }
  return { queries, exactCounts, sourceHashesBefore, sourceHashesAfter: hashes() };
}

async function main() {
  const reportPath = resolve(process.argv[2] ?? "/tmp/queued-search-report.json");
  const fixtureRoot = resolve(process.argv[3] ?? tmpdir());
  const keepFixture = process.argv.includes("--keep-fixture");
  const directory = mkdtempSync(join(fixtureRoot, "orca-queued-cost-"));
  const filesystemType = statfsSync(directory).type;
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), runtime: Bun.version, platform: platform(), arch: arch(), release: release(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, fixtureDirectory: directory, fixtureRetained: keepFixture,
    filesystem: { type: `0x${filesystemType.toString(16)}`, label: filesystemType === 0x01021994 ? "tmpfs (memory-backed)" : filesystemType === 0x794c7630 ? "overlayfs" : "other" },
    configuration: { messages, samples, pageSize: 10, maximumBodyBytes: 160 },
    limitations: ["Local filesystem and warm host caches; no cache-drop or production traffic. No Railway price or capacity claim.",
      "Only ordinary small synthetic messages; no large-body, resource exhaustion, native-query hang, or security validation.",
      "Prior blocked PR224 security validation remains incomplete and is not exercised or resolved here.",
      "RSS integral is 2ms sampling, approximate, and excludes unobserved sub-2ms intervals. Child CPU uses reaped process resource usage.",
      "Raw worker lifetime includes startup, imports, query/apply, serialization and exit. Executor timing additionally includes its protocol validation and scheduling.",
      "Capture compares otherwise identical full canonical schemas through migration0050 versus0051 with WAL/FULL and no active index worker.",
      "Outer phase CPU includes fixture setup and waited descendant CPU. Use writerChildren.value and queries.rawWorkers for per-operation CPU; do not sum nested measurements.",
      "The 300ms idle sample is only a short harness observation, not a steady-state API memory or CPU estimate. Construction creates no persistent worker process."],
    sourceHashes: Object.fromEntries(["apps/api/drizzle/0051_queued_mail_search.sql", "apps/api/src/search/indexing/supervisor.ts", "apps/api/src/search/indexing/worker.ts", "apps/api/src/search/indexing/worker-core.ts", "apps/api/src/search/read.ts", "apps/api/src/search/executor.ts", "scripts/ci/queued-search-benchmark.ts"].map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])) };
  const save = () => { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n"); };
  try {
    report.capture = await measuredChild([import.meta.path, "--phase", "capture", directory]); save();
    report.supervisor = await measuredChild([import.meta.path, "--phase", "supervisor", join(directory, "supervisor.sqlite")]); save();
    report.writerChildren = await measuredChild([import.meta.path, "--phase", "writers", join(directory, "writers.sqlite")]); save();
    report.preparation = await measuredChild([import.meta.path, "--phase", "prepare", join(directory, "retrieval.sqlite")], "", 180_000); save();
    const startup = [];
    for (let n = 0; n < samples; n++) startup.push(await measuredChild(["-e", "process.stdout.write('{}')"]));
    report.emptyBunStartup = startup; save();
    const readResults = await readPhase(join(directory, "retrieval.sqlite"));
    report.queries = readResults.queries; report.exactCounts = readResults.exactCounts;
    report.readSourceHashesBefore = readResults.sourceHashesBefore; report.readSourceHashesAfter = readResults.sourceHashesAfter;
    report.complete = true; save(); console.log(JSON.stringify({ reportPath, complete: true }));
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); save(); throw error; }
  finally { if (!keepFixture) rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[2] === "--phase") {
  const name = process.argv[3]; const path = process.argv[4]!;
  const result = name === "capture" ? await capturePhase(path) : name === "prepare" ? await preparePhase(path) :
    name === "supervisor" ? await supervisorPhase(path) : name === "writers" ? await writerPhase(path) : name === "reads" ? await readPhase(path) : null;
  if (!result) throw new Error("Unknown benchmark phase");
  console.log(JSON.stringify(result));
} else await main();
