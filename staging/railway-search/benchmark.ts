// Bounded, synthetic, offline comparison. Run this same file against archived
// source trees with revision-local @orca workspace links (see the report).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MailboxReadMetric } from "../../apps/api/src/mailbox/read.ts";
import type { GmailMessage } from "../../apps/api/src/providers/gmail/types.ts";

const option = (name: string) => Bun.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(option("root") ?? ".");
const revision = option("revision");
const mode = option("mode");
const size = Number(option("size") ?? 1000);
const samples = Number(option("samples") ?? 20);
assert(revision && /^[a-f0-9]{40}$/.test(revision), "Pass the exact archived revision");
assert(mode === "base" || mode === "head");
assert([1000, 5000, 10000].includes(size), "Bounded fixture sizes only");
assert(Number.isInteger(samples) && samples >= 5 && samples <= 30, "5–30 samples only");
const source = (path: string) => pathToFileURL(join(root, "apps/api/src", path)).href;
const { createDatabaseClient } = await import(source("db/client.ts")) as typeof import("../../apps/api/src/db/client.ts");
const { users, oauthAccounts } = await import(source("db/schema.ts")) as typeof import("../../apps/api/src/db/schema.ts");
const { createApp } = await import(source("index.ts")) as typeof import("../../apps/api/src/index.ts");
const { createSession } = await import(source("auth/session-store.ts")) as typeof import("../../apps/api/src/auth/session-store.ts");
const { persistGmailMessages } = await import(source("providers/gmail/sync.ts")) as typeof import("../../apps/api/src/providers/gmail/sync.ts");
process.env.SESSION_SECRET = "synthetic-offline-search-benchmark-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const directory = mkdtempSync(join(tmpdir(), "orca-search-stage-bench-"));
const path = join(directory, "mail.sqlite");
const mixedSeconds = Number(option("mixed-seconds") ?? 0);
assert([0, 2, 60].includes(mixedSeconds));
const connections: unknown[] = [];
let connectionCount = 0;
function open() {
  connectionCount++;
  const c = createDatabaseClient(path);
  const settings = { journal: c.sqlite.query("PRAGMA journal_mode").get(), synchronous: c.sqlite.query("PRAGMA synchronous").get(), busy: c.sqlite.query("PRAGMA busy_timeout").get(), checkpoint: c.sqlite.query("PRAGMA wal_autocheckpoint").get() };
  assert.deepEqual(settings.journal, { journal_mode: "wal" });
  const n = (settings.synchronous as { synchronous: number }).synchronous;
  assert(mode === "head" ? n === 2 : [1, 2].includes(n));
  if (connections.length === 0) connections.push(settings);
  else assert.deepEqual(settings, connections[0]);
  return c;
}
const client = open();
const time = Date.UTC(2026, 8, 2);
const startHost = { load: loadavg(), freeBytes: freemem() };
const stat = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
const disk = () => ({ databaseBytes: stat(path), walBytes: stat(`${path}-wal`), shmBytes: stat(`${path}-shm`) });
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  return { n: values.length, min: sorted[0], p50: quantile(.5), p95: quantile(.95), max: sorted.at(-1) };
};
type Observation = { ms: number; cpuMs: number; rssBytes: number; prepared: number; metrics: MailboxReadMetric[] };
let prepares = 0;
const metrics: MailboxReadMetric[] = [];
function instrument(connection: ReturnType<typeof createDatabaseClient>) {
  const prepare = connection.sqlite.prepare.bind(connection.sqlite);
  Object.defineProperty(connection.sqlite, "prepare", { value(sql: string, ...args: unknown[]) {
    prepares += 1;
    return Reflect.apply(prepare, connection.sqlite, [sql, ...args]);
  } });
  return connection;
}
let mixed: unknown = null;
const results: Record<string, { summaryMs: ReturnType<typeof summary>; summaryCpuMs: ReturnType<typeof summary>; observations: Observation[] }> = {};
async function measure(name: string, work: (iteration: number) => unknown | Promise<unknown>, warmups = 3) {
  for (let i = -warmups; i < 0; i++) await work(i);
  const observations: Observation[] = [];
  for (let i = 0; i < samples; i++) {
    prepares = 0; metrics.length = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    await work(i);
    const ms = performance.now() - start;
    const usage = process.cpuUsage(cpu);
    observations.push({ ms, cpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss, prepared: prepares, metrics: [...metrics] });
  }
  results[name] = { summaryMs: summary(observations.map((v) => v.ms)), summaryCpuMs: summary(observations.map((v) => v.cpuMs)), observations };
}
try {
  migrate(client.db, { migrationsFolder: join(root, "apps/api/drizzle") });
  assert.deepEqual(client.sqlite.query("PRAGMA journal_mode").get(), { journal_mode: "wal" });
  const synchronous = client.sqlite.query("PRAGMA synchronous").get() as { synchronous: number };
  // Observe the unmodified factory: Bun's baseline is NORMAL on the measured
  // Mac, but FULL on Linux. Never lower it to manufacture a NORMAL/FULL pair.
  if (mode === "head") assert.deepEqual(synchronous, { synchronous: 2 });
  else assert([1, 2].includes(synchronous.synchronous), "Baseline must retain NORMAL or FULL");
  client.db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "foreign", email: "foreign@example.test" }]).run();
  for (const id of ["a", "b", "c", "d", "foreign"]) client.db.insert(oauthAccounts).values({ id, userId: id === "foreign" ? "foreign" : "owner", provider: "gmail", providerId: id, providerEmail: `${id}@example.test` }).run();
  const insertThread = client.sqlite.prepare("INSERT INTO threads(id,account_id,provider_thread_id,subject,latest_received_at) VALUES(?,?,?,?,?)");
  const insertMail = client.sqlite.prepare("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,subject,snippet,body_text,received_at) VALUES(?,?,?,?,?,?,?,?,?)");
  const insertLabel = client.sqlite.prepare("INSERT INTO email_labels(id,email_id,label_id) VALUES(?,?,?)");
  for (const id of ["a", "b", "c", "d", "foreign"]) for (let label = 0; label < 4; label++) client.sqlite.run("INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES(?,?,?,?,?)", [`label-${id}-${label}`, id, `BENCH-${label}`, `Benchmark ${label}`, "user"]);
  client.sqlite.transaction(() => {
    for (let i = 0; i < size + 10; i++) {
      const account = i >= size ? "foreign" : ["a", "b", "c", "d"][i % 4]!;
      const id = `message-${i}`;
      // One oversized message per 1,000, alternating owned accounts. Metadata
      // needle is beyond 32 KiB; the body-only needle must never match.
      const large = i % 1001 === 0;
      const subject = large ? "x".repeat(33 * 1024) + " oversize" : `Subject ${i}`;
      insertThread.run(`t-${i}`, account, `pt-${i}`, subject, time - i);
      insertMail.run(id, account, `t-${i < size && i % 8 >= 4 ? i - 4 : i}`, `pm-${i}`, `sender-${i % 100}@example.test`, subject, `common preview ${i % 10 === 0 ? "selective" : "ordinary"} ${i % 8 >= 4 ? "olderonly" : ""}`, (large ? "b".repeat(257 * 1024) : "body ".repeat(400)) + " bodyonly", time - i);
      for (let label = 0; label <= i % 4; label++) insertLabel.run(`el-${i}-${label}`, id, `label-${account}-${label}`);
    }
  })();
  client.sqlite.run("INSERT INTO human_classification_overrides(id,account_id,target_type,target_value,classification,source) VALUES('bench-domain','a','sender_domain','example.test','likely_human','user_choice')");
  client.sqlite.run("INSERT INTO human_classification_overrides(id,account_id,target_type,target_value,classification,source) VALUES('bench-message','a','message','message-0','automated_or_bulk','user_choice')");
  client.sqlite.run("INSERT INTO sender_attention_rules(id,account_id,scope,value,behavior,source) VALUES('bench-focus','a','domain','example.test','focus','user_choice')");
  const session = await createSession(client.db, "owner");
  client.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const seededDisk = disk();
  const app = createApp({ dbFactory: () => instrument(open()), mailboxReadObserver: (metric) => metrics.push(metric) });
  const request = async (suffix: string) => {
    const response = await app.request(`/v1/inbox?view=all&classification=all&limit=50${suffix}`, { headers: { cookie: `orca_session=${session.token}` } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: { id: string; bodyText?: string }[]; counts: { attention: { all: number } }; nextCursor: string | null; search?: unknown }>;
  };
  const overrideResponse = await app.request("/v1/inbox?view=all&classification=human&accountId=a&query=common", { headers: { cookie: `orca_session=${session.token}` } });
  assert.equal(overrideResponse.status, 200);
  const overridePayload = await overrideResponse.json();
  assert.equal(overridePayload.counts.classification.likely_human, size / 4 - 1);
  assert(!overridePayload.messages.some((m: { id: string }) => m.id === "message-0"));
  const signatures: Record<string, unknown> = {};
  const cases = [
    ["inbox", "", size], ["common", "&query=common", size],
    ["selective", "&query=selective", size / 10], ["absent", "&query=absentneedle", 0],
    ["body-only", "&query=bodyonly", 0], ["oversized", "&query=oversize", Math.ceil(size / 1001)],
    ["account-a", "&accountId=a&query=common", size / 4],
  ] as const;
  for (const [name, suffix, count] of (mixedSeconds ? [] : cases)) {
    const check = async (explicit: boolean) => {
      const payload = await request(suffix + (explicit && mode === "head" ? "&searchMode=metadata" : ""));
      assert.equal(payload.counts.attention.all, count);
      assert.equal(payload.messages.length, Math.min(count, 50));
      assert(payload.messages.every((message) => Number(message.id.slice(8)) < size && message.bodyText === undefined));
      if (explicit && mode === "head") assert.deepEqual(payload.search, { mode: "metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1", fullBody: "unavailable" });
      else assert.equal(payload.search, undefined);
      const signature = { ids: payload.messages.map((m) => m.id), count };
      if (explicit) assert.deepEqual(signature, signatures[name]); else signatures[name] = signature;
    };
    await measure(`legacy-${name}`, () => check(false));
    await measure(`${mode === "head" ? "metadata" : "control-repeat"}-${name}`, () => check(true));
  }
  if (!mixedSeconds) for (const [name, suffix] of [["default-inbox", ""], ["focus", "&view=focus"], ["older-thread-match", "&query=olderonly"]]) {
    const check = async (explicit: boolean) => {
      const response = await app.request(`/v1/inbox?classification=all&limit=50${suffix}${explicit && mode === "head" ? "&searchMode=metadata" : ""}`, { headers: { cookie: `orca_session=${session.token}` } });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.counts.attention.all, size / 2);
      assert.equal(payload.counts.attention.focus, size / 8);
      assert.deepEqual(payload.messages.map((m: { id: string }) => m.id), Array.from({ length: 50 }, (_, i) => `message-${i * 8}`));
      const signature = { ids: payload.messages.map((m: { id: string }) => m.id), counts: payload.counts };
      if (explicit) { assert.deepEqual(signature, signatures[name!]); if (mode === "head") assert.equal(payload.search.coverage, "stored-metadata"); else assert.equal(payload.search, undefined); }
      else { assert.equal(payload.search, undefined); signatures[name!] = signature; }
    };
    await measure(`legacy-${name}`, () => check(false));
    await measure(`${mode === "head" ? "metadata" : "control-repeat"}-${name}`, () => check(true));
  }
  const first = await request("&query=common");
  assert(first.nextCursor);
  if (!mixedSeconds) await measure("legacy-page-two", async () => {
    const second = await request(`&query=common&cursor=${encodeURIComponent(first.nextCursor!)}`);
    assert.equal(second.counts.attention.all, size);
    assert.equal(second.messages.length, 50);
    assert(second.messages.every((m) => !first.messages.some((f) => f.id === m.id)));
    signatures["page-two"] = second.messages.map((m) => m.id);
  });
  const foreign = await app.request("/v1/inbox?accountId=foreign", { headers: { cookie: `orca_session=${session.token}` } });
  assert.equal(foreign.status, 404);
  if (mode === "head") {
    const full = await app.request("/v1/inbox?searchMode=full&query=common", { headers: { cookie: `orca_session=${session.token}` } });
    assert.equal(full.status, 503);
    const rejected = await full.json();
    assert.equal(rejected.error.code, "search_full_body_unavailable"); assert.equal(rejected.messages, undefined);
  }
  const afterReadsDisk = disk();
  instrument(client);
  const update = client.sqlite.prepare("UPDATE emails SET is_read=1-is_read WHERE id=?");
  if (!mixedSeconds) await measure("single-autocommit-update", () => { update.run("message-0"); });
  if (!mixedSeconds) await measure("transaction-100-updates", () => { client.sqlite.transaction(() => { for (let i = 0; i < 100; i++) update.run(`message-${i}`); })(); });
  const beforeSyncDisk = disk();
  const sync = (iteration: number) => ({
    accountId: "a", accountEmail: "a@example.test", labelList: [{ id: "INBOX", name: "Inbox" }],
    now: new Date(time), propagationTrigger: "sync" as const, propagationOptions: { enabled: false },
    gmailMessages: Array.from({ length: 25 }, (_, i): GmailMessage => ({
      id: `sync-${iteration}-${i}`, threadId: `sync-thread-${iteration}-${i}`, internalDate: String(time + i), labelIds: ["INBOX"], snippet: "sync preview",
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: "sender@example.test" }, { name: "To", value: "a@example.test" }, { name: "Subject", value: `Sync ${i}` }], body: { data: Buffer.from("Synthetic message body. ".repeat(100)).toString("base64") } },
    })),
  });
  if (!mixedSeconds) await measure("persist-25-new", async (i) => { assert.equal((await persistGmailMessages(client.db, sync(i))).changedEmailCount, 25); });
  if (!mixedSeconds) await measure("persist-25-replay", async (i) => { assert.equal((await persistGmailMessages(client.db, sync(i))).unchangedEmailCount, 25); });
  if (mixedSeconds) {
    const startAt = Date.now() + 1500;
    const children = ["reader-0", "reader-1", "writer"].map((role) => {
      const output = `${directory}/${role}.json`;
      const child = Bun.spawn([process.execPath, `${import.meta.dir}/mixed.ts`, `--root=${root}`, `--db=${path}`, `--mode=${mode}`, `--role=${role}`, `--session=${session.token}`, `--size=${size}`, `--seconds=${mixedSeconds}`, `--start=${startAt}`, `--output=${output}`], { stdout: "inherit", stderr: "inherit", env: { ...process.env } });
      return { child, output };
    });
    try {
      await Promise.all(children.map(async ({ child }) => { const code = await child.exited; assert.equal(code, 0, "Mixed worker failed"); }));
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map(({ child }) => child.exited));
      mixed = await Promise.all(children.map(async ({ output }) => await Bun.file(output).exists() ? Bun.file(output).json() : { passed: false, error: "Worker interrupted; see resource timeline" }));
    }
  }
  const afterSyncDisk = disk();
  const checkpoint = client.sqlite.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
  assert.equal(checkpoint.busy, 0);
  const checkpointedDisk = disk();
  await Bun.sleep(500);
  assert.deepEqual(disk(), checkpointedDisk, "Disk grew after quiescent checkpoint");
  assert.equal((client.sqlite.query("SELECT count(*) AS n FROM emails").get() as { n: number }).n, size + 10 + (mixedSeconds ? mixedSeconds : samples + 3) * 25);
  const report = { benchmark: "railway-replacement-v1", mixed, connections, connectionCount, revision, mode, size, samples, warmups: 3, generatedAt: new Date().toISOString(), runtime: Bun.version,
    sqlite: client.sqlite.query("SELECT sqlite_version() AS version").get(), synchronous, journalMode: "wal", fixture: { seed: "search-stage-v1", ownedAccounts: 4, ownedMessagesPerThread: 2, senderRule: "account-a domain focus", foreignMessages: 10, labelsPerMessage: "1-4", overrides: "account-a domain human except message-0 bulk", ordinaryBodyBytes: 2009, oversizedMessages: Math.ceil(size / 1001) },
    host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), start: startHost, end: { load: loadavg(), freeBytes: freemem() } },
    processResources: process.resourceUsage(), disk: { seededDisk, afterReadsDisk, beforeSyncDisk, afterSyncDisk, checkpointedDisk }, signatures, results, passed: true };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (option("output")) await Bun.write(option("output")!, json); else console.log(json);
} catch (error) {
  if (option("output")) await Bun.write(option("output")!, JSON.stringify({ passed: false, error: String(error), stack: (error as Error).stack, revision, mode, size, results, mixed, connections, disk: disk() }));
  throw error;
} finally {
  client.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
}
