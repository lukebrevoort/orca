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
  const { createMailboxReader } = await import(source("mailbox/read.ts"));
  const workloads: Record<string, unknown> = {};
  for (const [name, query] of [["common", { view: "all", query: "common" }], ["default-inbox", {}], ["focus", { view: "focus" }]]) {
    const plans: unknown[] = [];
    const reader = createMailboxReader(client.sqlite, { observePageQueryPlan: (plan: unknown) => plans.push(plan) });
    const result = reader.read({ authorization: { userId: "owner", accountIds: ["a", "b", "c", "d"] }, query: { ...query, classification: "all", limit: 50 } });
    workloads[name as string] = { plans, ids: result.response.messages.map((m: {id: string}) => m.id), counts: result.response.counts };
  }
  await Bun.write(option("output")!, JSON.stringify({ purpose: "EXPLAIN-only diagnostic, not timing acceptance", revision, mode, size, settings: connections, seededDisk, workloads }, null, 2));
} finally { client.sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
