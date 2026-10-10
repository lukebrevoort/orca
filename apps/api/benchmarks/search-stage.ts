// Bounded, synthetic, offline comparison. Run this same file against archived
// source trees with revision-local @orca workspace links (see the report).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MailboxReadMetric } from "../src/mailbox/read.ts";
import type { GmailMessage } from "../src/providers/gmail/types.ts";

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
const { createDatabaseClient } = await import(source("db/client.ts")) as typeof import("../src/db/client.ts");
const { users, oauthAccounts } = await import(source("db/schema.ts")) as typeof import("../src/db/schema.ts");
const { createApp } = await import(source("index.ts")) as typeof import("../src/index.ts");
const { createSession } = await import(source("auth/session-store.ts")) as typeof import("../src/auth/session-store.ts");
const { persistGmailMessages } = await import(source("providers/gmail/sync.ts")) as typeof import("../src/providers/gmail/sync.ts");
process.env.SESSION_SECRET = "synthetic-offline-search-benchmark-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
const directory = mkdtempSync(join(tmpdir(), "orca-search-stage-bench-"));
const path = join(directory, "mail.sqlite");
const client = createDatabaseClient(path);
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
  const synchronous = client.sqlite.query("PRAGMA synchronous").get();
  assert.deepEqual(synchronous, { synchronous: mode === "head" ? 2 : 1 });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "foreign", email: "foreign@example.test" }]).run();
  for (const id of ["a", "b", "foreign"]) client.db.insert(oauthAccounts).values({ id, userId: id === "foreign" ? "foreign" : "owner", provider: "gmail", providerId: id, providerEmail: `${id}@example.test` }).run();
  const insertThread = client.sqlite.prepare("INSERT INTO threads(id,account_id,provider_thread_id,subject,latest_received_at) VALUES(?,?,?,?,?)");
  const insertMail = client.sqlite.prepare("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,subject,snippet,body_text,received_at) VALUES(?,?,?,?,?,?,?,?,?)");
  const insertLabel = client.sqlite.prepare("INSERT INTO email_labels(id,email_id,label_id) VALUES(?,?,?)");
  for (const id of ["a", "b", "foreign"]) client.sqlite.run("INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES(?,?,?,?,?)", [`label-${id}`, id, "BENCH", "Benchmark", "user"]);
  client.sqlite.transaction(() => {
    for (let i = 0; i < size + 10; i++) {
      const account = i >= size ? "foreign" : i % 2 ? "b" : "a";
      const id = `message-${i}`;
      // One oversized message per 1,000, alternating owned accounts. Metadata
      // needle is beyond 32 KiB; the body-only needle must never match.
      const large = i % 1001 === 0;
      const subject = large ? "x".repeat(33 * 1024) + " oversize" : `Subject ${i}`;
      insertThread.run(`t-${i}`, account, `pt-${i}`, subject, time - i);
      insertMail.run(id, account, `t-${i}`, `pm-${i}`, `sender-${i % 100}@example.test`, subject, `common preview ${i % 10 === 0 ? "selective" : "ordinary"}`, (large ? "b".repeat(257 * 1024) : "body ".repeat(400)) + " bodyonly", time - i);
      insertLabel.run(`el-${i}`, id, `label-${account}`);
    }
  })();
  const session = await createSession(client.db, "owner");
  client.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const seededDisk = disk();
  const app = createApp({ dbFactory: () => instrument(createDatabaseClient(path)), mailboxReadObserver: (metric) => metrics.push(metric) });
  const request = async (suffix: string) => {
    const response = await app.request(`/v1/inbox?view=all&classification=all&limit=50${suffix}`, { headers: { cookie: `orca_session=${session.token}` } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ messages: { id: string; bodyText?: string }[]; counts: { attention: { all: number } }; nextCursor: string | null; search?: unknown }>;
  };
  const signatures: Record<string, unknown> = {};
  const cases = [
    ["inbox", "", size], ["common", "&query=common", size],
    ["selective", "&query=selective", size / 10], ["absent", "&query=absentneedle", 0],
    ["body-only", "&query=bodyonly", 0], ["oversized", "&query=oversize", Math.ceil(size / 1001)],
    ["account-a", "&accountId=a&query=common", size / 2],
  ] as const;
  for (const [name, suffix, count] of cases) {
    const check = async (explicit: boolean) => {
      const payload = await request(suffix + (explicit ? "&searchMode=metadata" : ""));
      assert.equal(payload.counts.attention.all, count);
      assert.equal(payload.messages.length, Math.min(count, 50));
      assert(payload.messages.every((message) => Number(message.id.slice(8)) < size && message.bodyText === undefined));
      if (explicit) assert.deepEqual(payload.search, { mode: "metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1", fullBody: "unavailable" });
      else assert.equal(payload.search, undefined);
      const signature = { ids: payload.messages.map((m) => m.id), count };
      if (explicit) assert.deepEqual(signature, signatures[name]); else signatures[name] = signature;
    };
    await measure(`legacy-${name}`, () => check(false));
    if (mode === "head") await measure(`metadata-${name}`, () => check(true));
  }
  const first = await request("&query=common");
  assert(first.nextCursor);
  await measure("legacy-page-two", async () => {
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
  await measure("single-autocommit-update", () => { update.run("message-0"); });
  await measure("transaction-100-updates", () => { client.sqlite.transaction(() => { for (let i = 0; i < 100; i++) update.run(`message-${i}`); })(); });
  const beforeSyncDisk = disk();
  const sync = (iteration: number) => ({
    accountId: "a", accountEmail: "a@example.test", labelList: [{ id: "INBOX", name: "Inbox" }],
    now: new Date(time), propagationTrigger: "sync" as const, propagationOptions: { enabled: false },
    gmailMessages: Array.from({ length: 25 }, (_, i): GmailMessage => ({
      id: `sync-${iteration}-${i}`, threadId: `sync-thread-${iteration}-${i}`, internalDate: String(time + i), labelIds: ["INBOX"], snippet: "sync preview",
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: "sender@example.test" }, { name: "To", value: "a@example.test" }, { name: "Subject", value: `Sync ${i}` }], body: { data: Buffer.from("Synthetic message body. ".repeat(100)).toString("base64") } },
    })),
  });
  await measure("persist-25-new", async (i) => { assert.equal((await persistGmailMessages(client.db, sync(i))).changedEmailCount, 25); });
  await measure("persist-25-replay", async (i) => { assert.equal((await persistGmailMessages(client.db, sync(i))).unchangedEmailCount, 25); });
  const afterSyncDisk = disk();
  client.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const checkpointedDisk = disk();
  assert.equal((client.sqlite.query("SELECT count(*) AS n FROM emails").get() as { n: number }).n, size + 10 + (samples + 3) * 25);
  const report = { benchmark: "search-stage-v1", revision, mode, size, samples, warmups: 3, generatedAt: new Date().toISOString(), runtime: Bun.version,
    sqlite: client.sqlite.query("SELECT sqlite_version() AS version").get(), synchronous, journalMode: "wal", fixture: { seed: "search-stage-v1", ownedAccounts: 2, foreignMessages: 10, labelsPerMessage: 1, ordinaryBodyBytes: 2009, oversizedMessages: Math.ceil(size / 1001) },
    host: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), start: startHost, end: { load: loadavg(), freeBytes: freemem() } },
    processResources: process.resourceUsage(), disk: { seededDisk, afterReadsDisk, beforeSyncDisk, afterSyncDisk, checkpointedDisk }, signatures, results, passed: true };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (option("output")) await Bun.write(option("output")!, json); else console.log(json);
} finally {
  client.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
}
