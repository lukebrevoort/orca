import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MailSearchQueryError } from "@orca/shared/mail-search";
import { MailboxScopeError } from "../mailbox/read.ts";
import { createRankedSearchExecutor, rankedSearchErrorFromCode, rankedSearchProcessLimits, type RankedSearchExecutionObservation, type RankedSearchLifecycle } from "./executor.ts";
import { SearchError } from "./errors.ts";
import type { RankedSearchInput } from "./read.ts";

const directories: string[] = [];
const executors: ReturnType<typeof createRankedSearchExecutor>[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map(executor => executor.shutdown()));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(options: Parameters<typeof createRankedSearchExecutor>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-ranked-executor-")); directories.push(root);
  const executor = createRankedSearchExecutor({ workerPath: resolve(import.meta.dir, "fixtures/controlled-worker.ts"), deadlineMs: 3_000, queueWaitMs: 2_000, ...options }); executors.push(executor);
  function input(userId = "user"): RankedSearchInput {
    return { databasePath: join(root, "unused.sqlite"), authorization: { userId }, query: { query: "appointment", limit: 10 }, mode: "full", cursorKey: "synthetic-cursor-key" };
  }
  return { executor, input,
    ready: (id = "user") => existsSync(join(root, `${id}.ready`)),
    pid: (id = "user") => Number(readFileSync(join(root, `${id}.ready`), "utf8")),
    release: (id = "user", reply: "success" | "search_budget_exceeded" = "success") => {
      const path = join(root, `${id}.release`);
      writeFileSync(`${path}.tmp`, reply); renameSync(`${path}.tmp`, path);
    },
  };
}
async function until(condition: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Fixture did not become ready");
    await Bun.sleep(5);
  }
}
function isDead(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
async function code(result: Promise<unknown>) { try { await result; return "success"; } catch (error) { return (error as { code?: string }).code; } }

test("success hydrates capabilities and observes bounded subprocess timing", async () => {
  const f = fixture(); const observations: RankedSearchExecutionObservation[] = [];
  const result = f.executor.read(f.input(), { capabilitiesFor: () => ({ read: true, draft: true, send: false }), observe: observation => observations.push(observation) });
  await until(f.ready); const pid = f.pid(); f.release();
  const value = await result;
  expect(isDead(pid)).toBe(true);
  expect(value.page.messages.map(message => message.id)).toEqual(["message"]);
  expect(value.page.accounts[0]!.capabilities.draft).toBe(true);
  expect(observations).toHaveLength(1);
  expect(observations[0]!.readerDurationMs).toBe(1);
  expect(observations[0]!.processDurationMs).toBeGreaterThan(0);
  expect(observations[0]!.peakRssBytes).toBe(1024);
  expect(observations[0]!.stdoutBytes).toBeGreaterThan(0);
  expect(observations[0]!.stdoutBytes).toBeLessThanOrEqual(rankedSearchProcessLimits.maxStdoutBytes);
  expect(observations[0]!.budgetReason).toBeNull();
  expect(Object.keys(observations[0]!).sort()).toEqual([
    "budgetReason", "peakRssBytes", "processDurationMs", "queueWaitMs", "readerDurationMs", "stdoutBytes",
  ]);
});

test("only one child runs and cancellation reaps it before queued work starts", async () => {
  const events: RankedSearchLifecycle[] = []; const f = fixture({ onLifecycle: event => events.push(event) });
  const observations: RankedSearchExecutionObservation[] = [];
  const abort = new AbortController();
  const first = code(f.executor.read(f.input("first"), { signal: abort.signal, observe: observation => observations.push(observation) }));
  const second = code(f.executor.read(f.input("second")));
  await until(() => f.ready("first")); const firstPid = f.pid("first");
  expect(f.ready("second")).toBe(false);
  abort.abort(); expect(await first).toBe("search_aborted"); expect(isDead(firstPid)).toBe(true);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ budgetReason: null, stdoutBytes: 0, readerDurationMs: null, peakRssBytes: null });
  await until(() => f.ready("second")); const secondPid = f.pid("second");
  expect(events.findIndex(event => event.event === "closed" && event.pid === firstPid)).toBeLessThan(events.findIndex(event => event.event === "started" && event.pid === secondPid));
  expect(events.every(event => event.active <= 1)).toBe(true);
  expect(rankedSearchProcessLimits.maxActive).toBe(1);
  f.release("second"); expect(await second).toBe("success");
});

test("each user gets one pending slot and cancelled queued work never starts", async () => {
  const f = fixture(); const abort = new AbortController();
  const active = code(f.executor.read(f.input("active")));
  const pending = code(f.executor.read(f.input("queued"), { signal: abort.signal }));
  expect(await code(f.executor.read(f.input("queued")))).toBe("search_busy");
  abort.abort(); expect(await pending).toBe("search_aborted");
  await until(() => f.ready("active")); f.release("active"); expect(await active).toBe("success");
  expect(f.ready("queued")).toBe(false);
});

test("queue expiry and the execution deadline release ordinary waiting fixtures", async () => {
  const f = fixture({ deadlineMs: 350, queueWaitMs: 80 });
  const observations: RankedSearchExecutionObservation[] = [];
  const active = code(f.executor.read(f.input("active"), { observe: observation => observations.push(observation) }));
  const queued = code(f.executor.read(f.input("queued")));
  await until(() => f.ready("active")); const pid = f.pid("active");
  expect(await queued).toBe("search_busy"); expect(f.ready("queued")).toBe(false);
  expect(await active).toBe("search_budget_exceeded"); expect(isDead(pid)).toBe(true);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ budgetReason: "execution_deadline", stdoutBytes: 0, readerDurationMs: null, peakRssBytes: null });
  expect(observations[0]!.processDurationMs).toBeGreaterThan(0);
});

test("an ordinary reply over a lowered stdout cap reports bytes and reaps the child", async () => {
  const events: RankedSearchLifecycle[] = [];
  const f = fixture({ maxStdoutBytes: 128, onLifecycle: event => events.push(event) });
  const observations: RankedSearchExecutionObservation[] = [];
  const result = code(f.executor.read(f.input(), { observe: observation => observations.push(observation) }));
  await until(f.ready); const pid = f.pid(); f.release();
  expect(await result).toBe("search_budget_exceeded");
  expect(isDead(pid)).toBe(true);
  expect(events.map(event => event.event)).toEqual(["started", "kill", "closed"]);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ budgetReason: "stdout_limit", readerDurationMs: null, peakRssBytes: null });
  expect(observations[0]!.stdoutBytes).toBeGreaterThan(128);
  expect(observations[0]!.processDurationMs).toBeGreaterThan(0);
});

test("a fixed worker budget reply is distinct from a parent guard with exact output bytes", async () => {
  const events: RankedSearchLifecycle[] = []; const f = fixture({ onLifecycle: event => events.push(event) });
  const observations: RankedSearchExecutionObservation[] = [];
  const result = code(f.executor.read(f.input(), { observe: observation => observations.push(observation) }));
  await until(f.ready); const pid = f.pid(); f.release("user", "search_budget_exceeded");
  expect(await result).toBe("search_budget_exceeded");
  expect(isDead(pid)).toBe(true);
  expect(events.map(event => event.event)).toEqual(["started", "closed"]);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    budgetReason: "worker_budget", readerDurationMs: null, peakRssBytes: 1024,
    stdoutBytes: Buffer.byteLength(JSON.stringify({ version: 1, ok: false, code: "search_budget_exceeded", peakRssBytes: 1024 })),
  });
  expect(observations[0]!.processDurationMs).toBeGreaterThan(0);
});

test("shutdown cancels, reaps, rejects pending work and remains idempotent", async () => {
  const f = fixture(); const active = code(f.executor.read(f.input("active"))); const queued = code(f.executor.read(f.input("queued")));
  await until(() => f.ready("active")); const pid = f.pid("active");
  await f.executor.shutdown(); await f.executor.shutdown();
  expect(isDead(pid)).toBe(true); expect(f.ready("queued")).toBe(false);
  expect(await active).toBe("search_aborted"); expect(await queued).toBe("search_aborted");
  expect(await code(f.executor.read(f.input()))).toBe("search_busy");
});

test("pre-aborted work and unsupported in-memory databases never start", async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  expect(await code(f.executor.read(f.input(), { signal: abort.signal }))).toBe("search_aborted");
  expect(await code(f.executor.read({ ...f.input(), databasePath: ":memory:" }))).toBe("search_index_unavailable");
  expect(f.ready()).toBe(false);
});

test("typed error bridge preserves stable application classes", () => {
  expect(rankedSearchErrorFromCode("search_index_updating")).toBeInstanceOf(SearchError);
  expect(rankedSearchErrorFromCode("search_invalid_query")).toBeInstanceOf(MailSearchQueryError);
  expect(rankedSearchErrorFromCode("search_anchor_required")).toBeInstanceOf(MailSearchQueryError);
  expect(rankedSearchErrorFromCode("no_accounts")).toBeInstanceOf(MailboxScopeError);
});

test("a diagnostic observer cannot discard a successful page", async () => {
  const f = fixture({ onLifecycle: () => { throw new Error("fixture observer"); } });
  const result = f.executor.read(f.input(), { observe: () => { throw new Error("fixture observer"); } });
  await until(f.ready); f.release(); expect((await result).page.messages).toHaveLength(1);
});

test("a diagnostic observer cannot replace a budget error or block queued work", async () => {
  const f = fixture({ onLifecycle: () => { throw new Error("fixture observer"); } });
  const first = code(f.executor.read(f.input("first"), { observe: () => { throw new Error("fixture observer"); } }));
  const second = f.executor.read(f.input("second"));
  await until(() => f.ready("first")); const pid = f.pid("first"); f.release("first", "search_budget_exceeded");
  expect(await first).toBe("search_budget_exceeded"); expect(isDead(pid)).toBe(true);
  await until(() => f.ready("second")); f.release("second");
  expect((await second).page.messages).toHaveLength(1);
});
