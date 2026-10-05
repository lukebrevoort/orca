import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { setMailSearchEnabled } from "../db/mail-search-index.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import {
  createMailSearchExecutorForTests, executeMailboxSearch, mailSearchProcessLimits,
  type MailSearchExecutionInput, type MailSearchExecutionObservation,
} from "./search-executor.ts";
import { mailSearchWorkerRequestSchema, openMailSearchDatabase } from "./search-worker.ts";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
function directory() {
  const path = mkdtempSync(join(tmpdir(), "orca-search-process-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fixture(messageCount = 1) {
  const path = join(directory(), "mail.sqlite");
  const client = createDatabaseClient(path);
  cleanups.push(() => client.sqlite.close());
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  setMailSearchEnabled(client.sqlite, true);
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "foreign"].map(id => ({
    id, userId: id === "foreign" ? "foreign" : "owner", provider: "gmail" as const,
    providerId: id, providerEmail: `${id}@example.com`, scope: "snapshot-scope",
  }))).run();
  function mail(id: string, accountId = "a") {
    client.db.insert(threads).values({ id, accountId, providerThreadId: id, subject: "harbor subject", messageCount: 1 }).run();
    client.db.insert(emails).values({
      id, accountId, threadId: id, providerMessageId: id, subject: "harbor subject", snippet: "Public summary",
      fromAddress: "sender@example.com", bodyText: "private-body-needle", bodyHtml: "<p>never-project-this-html</p>",
      receivedAt: new Date("2026-01-01T12:00:00Z"),
    }).run();
  }
  client.sqlite.transaction(() => { for (let i = 0; i < messageCount; i++) mail(`mail-${i.toString().padStart(4, "0")}`); })();
  const input: MailSearchExecutionInput = {
    databasePath: path, authorization: { userId: "owner", accountIds: ["a", "b"] },
    query: { query: "harbor", limit: 100, view: "all" }, searchBodyText: true,
  };
  return { ...client, mail, input, path };
}

function code(error: unknown) { return (error as { code?: string }).code; }
async function errorCode(promise: Promise<unknown>) { try { await promise; return "unexpected_success"; } catch (error) { return code(error); } }
async function until(condition: () => boolean, timeoutMs = 2_000) {
  const started = performance.now();
  while (!condition()) { if (performance.now() - started > timeoutMs) throw new Error("fixture did not become ready"); await Bun.sleep(5); }
}
function dead(pid: number) {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Controlled local child fixture uses real OS processes and (for 'native') a
 * real, non-returning native SQLite query. There is no production test mode. */
function controlledWorker() {
  const root = directory();
  const path = join(root, "worker.ts");
  writeFileSync(path, `
    import { Database } from "bun:sqlite";
    import { existsSync, writeFileSync } from "node:fs";
    const request = JSON.parse(await Bun.stdin.text());
    const key = request.authorization.userId + "-" + request.query.query;
    const root = ${JSON.stringify(root)};
    writeFileSync(root + "/" + key + ".ready", JSON.stringify({ pid: process.pid, argv: process.argv, env: process.env }));
    if (request.query.query === "native") {
      const db = new Database(":memory:");
      db.query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n").get();
    } else if (request.query.query === "stdout") {
      process.stdout.write("x".repeat(3 * 1024 * 1024));
      await Bun.sleep(10_000);
    } else if (request.query.query === "malformed") {
      console.log('{"ok":true,"bodyText":"private-never-expose"}');
    } else if (request.query.query === "stderr") {
      process.stderr.write("private-never-expose".repeat(20_000));
      process.exitCode = 1;
    } else {
      while (!existsSync(root + "/" + key + ".release")) await Bun.sleep(5);
      console.log(JSON.stringify({ ok: false, code: "no_accounts" }));
    }
  `);
  function input(userId: string, query = "gate"): MailSearchExecutionInput {
    return { databasePath: join(root, "unused.sqlite"), authorization: { userId }, query: { query, limit: 10 }, searchBodyText: false };
  }
  const ready = (user: string, query = "gate") => existsSync(join(root, `${user}-${query}.ready`));
  const info = (user: string, query = "gate") => JSON.parse(readFileSync(join(root, `${user}-${query}.ready`), "utf8")) as { pid: number; argv: string[]; env: Record<string, string> };
  const release = (user: string, query = "gate") => writeFileSync(join(root, `${user}-${query}.release`), "release");
  return { root, path, input, ready, info, release };
}

describe("isolated indexed mailbox search", () => {
  test("serves a real SQLite search, preserves ownership, and applies registry capabilities from the snapshot", async () => {
    const f = fixture(); f.mail("foreign-mail", "foreign"); f.mail("second-account", "b");
    const observed: MailSearchExecutionObservation[] = [];
    const scopes: Array<string | null> = [];
    const result = await executeMailboxSearch({ ...f.input, authorization: { userId: "owner", accountIds: ["a", "foreign"] } }, {
      capabilitiesFor(provider, scope) {
        assert.equal(provider, "gmail"); scopes.push(scope);
        f.sqlite.query("update oauth_accounts set scope='newer-scope' where id='a'").run();
        return { read: false, draft: true, send: false };
      }, observe: metric => observed.push(metric),
    });
    assert.deepEqual(result.response.messages.map(row => row.id), ["mail-0000"]);
    assert.equal(result.response.counts.attention.all, 1);
    assert.deepEqual(result.response.accounts.map(row => row.id), ["a"]);
    assert.deepEqual(scopes, ["snapshot-scope"]);
    assert.deepEqual(result.response.accounts[0]!.capabilities, { read: false, draft: true, send: false });
    assert.equal(observed.length, 1);
    assert.ok(observed[0]!.processDurationMs >= result.metric.durationMs);
    if (process.platform === "linux") assert.ok(observed[0]!.peakRssBytes! > 0);
    else assert.equal(observed[0]!.peakRssBytes, null);
    assert.equal(await errorCode(executeMailboxSearch({ ...f.input, authorization: { userId: "owner", accountIds: ["foreign"] } })), "no_accounts");
  });

  test("MCP body=false cannot infer bodies or reuse body-mode cursors; IPC/API payload stays metadata-only", async () => {
    const f = fixture(2);
    const body = await executeMailboxSearch({ ...f.input, query: { ...f.input.query, query: "private-body-needle", limit: 1 } });
    assert.equal(body.response.counts.attention.all, 2);
    assert.ok(body.response.nextCursor);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("private-body-needle"));
    assert.ok(!serialized.includes("never-project-this-html"));
    assert.ok(!serialized.includes("bodyText"));
    assert.ok(!serialized.includes("bodyHtml"));
    assert.ok(!serialized.includes("snapshot-scope"));
    f.sqlite.exec("drop table mail_search_full_v1");
    const metadata = await executeMailboxSearch({ ...f.input, searchBodyText: false, query: { ...f.input.query, query: "private-body-needle" } });
    assert.equal(metadata.response.counts.attention.all, 0);
    assert.equal(await errorCode(executeMailboxSearch({ ...f.input, searchBodyText: false, query: { ...f.input.query, query: "private-body-needle", cursor: body.response.nextCursor! } })), "invalid_cursor");
  });

  test("500 candidate IDs succeed with bounded page payload; 501 reject without partial counts", async () => {
    const f = fixture(500);
    const result = await executeMailboxSearch(f.input);
    assert.equal(result.response.counts.attention.all, 500);
    assert.equal(result.response.messages.length, 100);
    assert.ok(result.response.nextCursor);
    f.mail("overflow");
    assert.equal(await errorCode(executeMailboxSearch(f.input)), "search_query_too_broad");
  });

  test("opens strictly read-only/query-only without migrations or creating absent files", async () => {
    const f = fixture();
    const sqlite = openMailSearchDatabase(f.path);
    try {
      assert.deepEqual(sqlite.query("PRAGMA query_only").get(), { query_only: 1 });
      assert.deepEqual(sqlite.query("PRAGMA busy_timeout").get(), { timeout: 100 });
      assert.throws(() => sqlite.exec("delete from emails"), /readonly/i);
      assert.throws(() => sqlite.exec("create temp table write_probe(id integer)"), /readonly/i);
      sqlite.exec("PRAGMA query_only=OFF");
      assert.throws(() => sqlite.exec("delete from emails"), /readonly/i); // OS/SQLite open flags remain enforced.
    } finally { sqlite.close(); }
    const missing = join(directory(), "missing.sqlite");
    assert.equal(await errorCode(executeMailboxSearch({ ...f.input, databasePath: missing })), "search_database_unavailable");
    assert.equal(existsSync(missing), false);
    assert.equal(await errorCode(executeMailboxSearch({ ...f.input, databasePath: ":memory:" })), "search_database_unavailable");
    f.sqlite.exec("update mail_search_state set enabled=0");
    assert.equal(await errorCode(executeMailboxSearch(f.input)), "search_index_not_ready");
  });

  test("validates private protocol authority/body mode and rejects client fields inside query", async () => {
    const f = fixture();
    assert.equal(mailSearchWorkerRequestSchema.safeParse({ version: 1, ...f.input }).success, true);
    for (const input of [
      { ...f.input, searchBodyText: undefined },
      { ...f.input, authorization: { userId: "" } },
      { ...f.input, query: { ...f.input.query, accountId: "foreign" } },
      { ...f.input, query: { ...f.input.query, searchBodyText: true } },
      { ...f.input, query: { ...f.input.query, limit: 501 } },
      { ...f.input, query: { ...f.input.query, query: " " } },
    ]) assert.equal(await errorCode(executeMailboxSearch(input as MailSearchExecutionInput)), "search_invalid_request");
  });

  test("the child independently rejects malformed private stdin without SQL, stacks or query text", async () => {
    const f = fixture();
    const subprocess = Bun.spawn([process.execPath, "--no-env-file", "--smol", resolve(import.meta.dir, "search-worker.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { TZ: "UTC", LANG: "C.UTF-8" },
    });
    subprocess.stdin.write(JSON.stringify({ version: 1, ...f.input, query: { ...f.input.query, query: "private-input-marker", searchBodyText: true } }));
    subprocess.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited,
    ]);
    assert.deepEqual(JSON.parse(stdout), { ok: false, code: "search_invalid_request" });
    assert.equal(stderr, "");
    assert.equal(exitCode, 0);
    assert.ok(!stdout.includes("private-input-marker"));
  });

  test("WAL writer remains available during an isolated read and newest committed snapshot is searchable", async () => {
    const f = fixture(400);
    const read = executeMailboxSearch(f.input);
    f.sqlite.query("update emails set subject='newquartz subject' where id='mail-0000'").run();
    const concurrent = await read;
    assert.ok([399, 400].includes(concurrent.response.counts.attention.all));
    const latest = await executeMailboxSearch({ ...f.input, query: { ...f.input.query, query: "newquartz" } });
    assert.deepEqual(latest.response.messages.map(row => row.id), ["mail-0000"]);
  });

  test("fresh-process startup/round-trip and peak RSS are measured on synthetic real SQLite searches", async () => {
    const f = fixture(100);
    const samples: MailSearchExecutionObservation[] = [];
    for (let i = 0; i < 8; i++) await executeMailboxSearch(f.input, { observe: metric => samples.push(metric) });
    const sorted = samples.map(sample => sample.processDurationMs).sort((a, b) => a - b);
    const rss = samples.map(sample => sample.peakRssBytes).filter((value): value is number => value !== null);
    console.log(JSON.stringify({ syntheticSearchProcesses: samples.length,
      roundTripP50Ms: Math.round(sorted[4]!), roundTripMaxMs: Math.round(sorted.at(-1)!),
      meanReaderMs: Math.round(samples.reduce((sum, value) => sum + value.readerDurationMs!, 0) / samples.length),
      peakChildRssMiB: rss.length ? Math.round(Math.max(...rss) / 1024 / 1024) : null,
    }));
  }, 20_000);
});

describe("bounded subprocess admission and actual cancellation", () => {
  test("shipped single-child cap preserves owner/FIFO fairness and waits for actual exit", async () => {
    const child = controlledWorker();
    const lifecycle: Array<{ event: string; pid: number | undefined; active: number }> = [];
    const executor = createMailSearchExecutorForTests({ workerPath: child.path, deadlineMs: 3_000, queueWaitMs: 2_000, onLifecycle: event => lifecycle.push(event) });
    const aAbort = new AbortController();
    const a = errorCode(executor.read(child.input("a", "first"), { signal: aAbort.signal }));
    const b = errorCode(executor.read(child.input("b")));
    const aPending = errorCode(executor.read(child.input("a", "second")));
    assert.equal(await errorCode(executor.read(child.input("a", "third"))), "search_busy");
    await until(() => child.ready("a", "first"));
    assert.equal(child.ready("b"), false);
    assert.equal(child.ready("a", "second"), false);
    const aPid = child.info("a", "first").pid;
    aAbort.abort();
    assert.equal(await a, "search_aborted");
    assert.ok(dead(aPid));
    await until(() => child.ready("b"));
    assert.equal(child.ready("a", "second"), false);
    child.release("b");
    assert.equal(await b, "no_accounts");
    await until(() => child.ready("a", "second"));
    assert.ok(lifecycle.findIndex(event => event.pid === aPid && event.event === "closed")
      < lifecycle.findIndex(event => event.pid === child.info("b").pid && event.event === "started"));
    assert.ok(lifecycle.every(event => event.active <= 1));
    assert.equal(mailSearchProcessLimits.maxActive, 1);
    child.release("a", "second");
    assert.equal(await aPending, "no_accounts");
  });

  test("global queue cap and queue deadline are bounded; cancelled queued work never spawns", async () => {
    const child = controlledWorker();
    const executor = createMailSearchExecutorForTests({ workerPath: child.path, deadlineMs: 2_000, queueWaitMs: 350 });
    const activeAbort = new AbortController();
    const a = errorCode(executor.read(child.input("a"), { signal: activeAbort.signal }));
    const queuedAbort = new AbortController();
    const pending = Array.from({ length: 8 }, (_, i) => errorCode(executor.read(child.input(`q${i}`), i === 0 ? { signal: queuedAbort.signal } : {})));
    assert.equal(await errorCode(executor.read(child.input("overflow"))), "search_busy");
    queuedAbort.abort();
    assert.equal(await pending[0], "search_aborted");
    assert.deepEqual(await Promise.all(pending.slice(1)), Array(7).fill("search_busy"));
    assert.equal(child.ready("q0"), false);
    assert.equal(child.ready("q1"), false);
    activeAbort.abort();
    assert.equal(await a, "search_aborted");
  });

  test("graceful shutdown kills and reaps active children, rejects pending work, and blocks new admission", async () => {
    const child = controlledWorker();
    const executor = createMailSearchExecutorForTests({ workerPath: child.path });
    const active = errorCode(executor.read(child.input("a", "native")));
    const pending = errorCode(executor.read(child.input("a", "queued")));
    await until(() => child.ready("a", "native"));
    const pid = child.info("a", "native").pid;
    await executor.shutdown();
    assert.ok(dead(pid));
    assert.equal(child.ready("a", "queued"), false);
    assert.deepEqual(await Promise.all([active, pending]), ["search_aborted", "search_aborted"]);
    assert.equal(await errorCode(executor.read(child.input("b"))), "search_busy");
    await executor.shutdown(); // Idempotent cleanup.
  });

  test("deadline kills a non-returning native SQLite query while parent timer and HTTP health stay responsive", async () => {
    const child = controlledWorker();
    let killedPid: number | undefined;
    const executor = createMailSearchExecutorForTests({ workerPath: child.path, deadlineMs: 700, onLifecycle: event => { if (event.event === "kill") killedPid = event.pid; } });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("healthy") });
    const startedAt = performance.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      const result = errorCode(executor.read(child.input("a", "native")));
      await until(() => child.ready("a", "native"));
      const healthAt = performance.now();
      assert.equal(await (await fetch(`http://127.0.0.1:${server.port}`)).text(), "healthy");
      assert.ok(performance.now() - healthAt < 400);
      assert.equal(await result, "search_query_too_broad");
      assert.ok(killedPid && dead(killedPid));
      assert.ok(ticks >= 10);
      assert.ok(performance.now() - startedAt < 1_800);
    } finally { clearInterval(timer); await server.stop(true); }
  });

  test("client abort kills native SQLite before settling; pre-aborted work never launches", async () => {
    const child = controlledWorker();
    const executor = createMailSearchExecutorForTests({ workerPath: child.path });
    const abort = new AbortController();
    const result = errorCode(executor.read(child.input("a", "native"), { signal: abort.signal }));
    await until(() => child.ready("a", "native"));
    const pid = child.info("a", "native").pid;
    abort.abort();
    assert.equal(await result, "search_aborted");
    assert.ok(dead(pid));
    assert.equal(await errorCode(executor.read(child.input("b"), { signal: abort.signal })), "search_aborted");
    assert.equal(child.ready("b"), false);
  });

  test("stdout cap, malformed response and stderr cannot yield partial mail or private errors", async () => {
    const child = controlledWorker();
    const executor = createMailSearchExecutorForTests({ workerPath: child.path });
    assert.equal(await errorCode(executor.read(child.input("a", "stdout"))), "search_query_too_broad");
    assert.ok(dead(child.info("a", "stdout").pid));
    for (const mode of ["malformed", "stderr"]) {
      let captured: unknown;
      try { await executor.read(child.input("a", mode)); } catch (error) { captured = error; }
      assert.equal(code(captured), "search_failed");
      assert.ok(!String(captured).includes("private-never-expose"));
    }
  });

  test("fixed executable/argv and minimal child env do not inherit server credentials or query strings", async () => {
    const child = controlledWorker();
    process.env.ORCA_EXECUTOR_TEST_SECRET = "synthetic-test-secret";
    writeFileSync(join(child.root, ".env"), "ORCA_ENV_FILE_TEST_SECRET=synthetic-env-file-secret\n");
    const executor = createMailSearchExecutorForTests({ workerPath: child.path });
    try {
      const oldCwd = process.cwd();
      let result: Promise<string | undefined>;
      try {
        process.chdir(child.root);
        result = errorCode(executor.read(child.input("a", "private-query-token")));
      } finally { process.chdir(oldCwd); }
      await until(() => child.ready("a", "private-query-token"));
      const info = child.info("a", "private-query-token");
      assert.equal(info.argv[0], process.execPath);
      assert.equal(info.argv.at(-1), child.path);
      assert.ok(!info.argv.join(" ").includes("private-query-token"));
      assert.equal(info.env.ORCA_EXECUTOR_TEST_SECRET, undefined);
      assert.equal(info.env.ORCA_ENV_FILE_TEST_SECRET, undefined);
      assert.equal(info.env.TZ, "UTC");
      assert.equal(info.env.LANG, "C.UTF-8");
      child.release("a", "private-query-token");
      assert.equal(await result, "no_accounts");
    } finally { delete process.env.ORCA_EXECUTOR_TEST_SECRET; }
    assert.equal(mailSearchProcessLimits.maxStdoutBytes, 2 * 1024 * 1024);
  });
});
