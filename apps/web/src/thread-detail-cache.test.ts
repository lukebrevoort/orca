import { describe, expect, test } from "bun:test";
import type { InboxMessage, ThreadDetail } from "@orca/shared";
import { ThreadDetailCache, recentThreadReferences, scheduleThreadDetailRefresh, threadMailboxVersion } from "./thread-detail-cache";

const message = (index: number): InboxMessage => ({
  id: `message-${index}`,
  accountId: "account",
  provider: "gmail",
  providerMessageId: `provider-message-${index}`,
  threadId: `thread-${index}`,
  from: { name: null, email: `sender-${index}@example.com` },
  subject: `Message ${index}`,
  snippet: "Preview",
  receivedAt: new Date(Date.UTC(2026, 8, 17, 12, index)).toISOString(),
  unread: true,
  labels: [],
  attentionBehavior: "normal",
  humanSignal: 0.8,
  humanClassification: null,
});

const detail = (index: number) => ({ thread: { id: `thread-${index}` } }) as ThreadDetail;

describe("recent thread detail cache", () => {
  test("prioritizes the 30 newest unique conversations", () => {
    const messages = Array.from({ length: 35 }, (_, index) => message(index));
    messages.push({ ...message(34), id: "newer-message-in-same-thread" });

    const references = recentThreadReferences(messages, 30);

    expect(references).toHaveLength(30);
    expect(references[0]).toEqual({
      accountId: "account",
      threadId: "thread-34",
      version: threadMailboxVersion(messages.filter(({ threadId }) => threadId === "thread-34")),
    });
    expect(references.at(-1)).toEqual({
      accountId: "account",
      threadId: "thread-5",
      version: threadMailboxVersion(messages.filter(({ threadId }) => threadId === "thread-5")),
    });
  });

  test("deduplicates in-flight reads and serves the resolved detail from memory", async () => {
    const cache = new ThreadDetailCache(30);
    let resolve!: (value: ThreadDetail) => void;
    let reads = 0;
    const loader = () => {
      reads += 1;
      return new Promise<ThreadDetail>((done) => { resolve = done; });
    };
    const reference = { accountId: "account", threadId: "thread-1" };

    const first = cache.load(reference, loader);
    const second = cache.load(reference, loader);
    expect(reads).toBe(1);
    resolve(detail(1));
    expect(await first).toBe(await second);
    expect(cache.peek(reference)?.detail).toEqual(detail(1));
  });

  test("keeps only the hottest configured details", async () => {
    const cache = new ThreadDetailCache(2);
    for (let index = 0; index < 3; index += 1) {
      await cache.load({ accountId: "account", threadId: `thread-${index}` }, async () => detail(index));
    }

    expect(cache.peek({ accountId: "account", threadId: "thread-0" })).toBeNull();
    expect(cache.peek({ accountId: "account", threadId: "thread-1" })?.detail).toEqual(detail(1));
    expect(cache.peek({ accountId: "account", threadId: "thread-2" })?.detail).toEqual(detail(2));
  });

  test("invalidation supersedes an in-flight prefetch and blocks its completion from repopulating the cache", async () => {
    const cache = new ThreadDetailCache(30);
    const resolvers: Array<(value: ThreadDetail) => void> = [];
    let reads = 0;
    const loader = () => {
      reads += 1;
      return new Promise<ThreadDetail>((resolve) => resolvers.push(resolve));
    };
    const reference = { accountId: "account", threadId: "thread-1" };

    const prefetched = cache.load(reference, loader, { version: "mailbox-v1" });
    cache.invalidate(reference);
    const refreshed = cache.load(reference, loader, { refresh: true, version: "mailbox-v1" });

    expect(reads).toBe(2);
    resolvers[1]!(detail(2));
    await refreshed;
    resolvers[0]!(detail(1));
    await prefetched;
    expect(cache.peek(reference)?.detail).toEqual(detail(2));
  });

  test("consecutive mailbox versions each supersede the older pending read", async () => {
    const cache = new ThreadDetailCache(30);
    const resolvers: Array<(value: ThreadDetail) => void> = [];
    let reads = 0;
    const loader = () => {
      reads += 1;
      return new Promise<ThreadDetail>((resolve) => resolvers.push(resolve));
    };
    const reference = { accountId: "account", threadId: "thread-1" };

    const older = cache.load(reference, loader, { version: "mailbox-v1" });
    const olderGeneration = cache.retainGeneration(reference);
    const newer = cache.load(reference, loader, { version: "mailbox-v2" });
    const newerGeneration = cache.retainGeneration(reference);
    const newest = cache.load(reference, loader, { version: "mailbox-v3" });
    const newestGeneration = cache.retainGeneration(reference);

    expect(reads).toBe(3);
    expect(olderGeneration.isCurrent()).toBe(false);
    expect(newerGeneration.isCurrent()).toBe(false);
    expect(newestGeneration.isCurrent()).toBe(true);
    olderGeneration.release(); newerGeneration.release(); newestGeneration.release();
    resolvers[0]!(detail(1));
    await older;
    expect(cache.peek(reference)).toBeNull();
    resolvers[1]!(detail(2));
    await newer;
    expect(cache.peek(reference)).toBeNull();
    resolvers[2]!(detail(3));
    await newest;
    expect(cache.peek(reference)).toMatchObject({ detail: detail(3), version: "mailbox-v3", stale: false });
  });

  test("mailbox-version changes and explicit staleness both bypass freshness", async () => {
    const cache = new ThreadDetailCache(30);
    const reference = { accountId: "account", threadId: "thread-1" };
    await cache.load(reference, async () => detail(1), { version: "mailbox-v1" });

    expect(cache.isFresh(reference, 30_000, Date.now(), "mailbox-v1")).toBe(true);
    expect(cache.isFresh(reference, 30_000, Date.now(), "mailbox-v2")).toBe(false);
    cache.markStale(reference);
    expect(cache.isFresh(reference, 30_000, Date.now(), "mailbox-v1")).toBe(false);
    expect(cache.peek(reference)?.detail).toEqual(detail(1));
  });

  test("send and routing refresh generations keep the visible detail but force an authoritative read", async () => {
    const cache = new ThreadDetailCache(30);
    const reference = { accountId: "account", threadId: "thread-1" };
    let refreshGeneration = 0;
    let reads = 0;
    await cache.load(reference, async () => detail(1), { version: "mailbox-v1" });

    scheduleThreadDetailRefresh(cache, reference, () => { refreshGeneration += 1; });

    expect(refreshGeneration).toBe(1);
    expect(cache.peek(reference)?.detail).toEqual(detail(1));
    expect(cache.isFresh(reference, 30_000, Date.now(), "mailbox-v1")).toBe(false);
    await cache.load(reference, async () => { reads += 1; return detail(2); }, { refresh: true, version: "mailbox-v1" });
    expect(reads).toBe(1);
    expect(cache.peek(reference)?.detail).toEqual(detail(2));
  });
});

// Resource assertions inspect bookkeeping without adding a production diagnostics API.
const retained = (cache: ThreadDetailCache) => {
  const state = cache as unknown as { generations: Map<string, number>; leases: Map<string, number>; inFlight: Map<string, unknown> };
  return { generations: state.generations.size, leases: state.leases.size, pending: state.inFlight.size };
};

describe("thread generation lifecycle", () => {
  test("refreshing distinct settled threads retains only the payload working set", async () => {
    const cache = new ThreadDetailCache(3);
    for (let i = 0; i < 100; i++) {
      const reference = { accountId: "account", threadId: `thread-${i}` };
      await cache.load(reference, async () => detail(i));
      cache.markStale(reference);
      const request = cache.load(reference, async () => detail(i));
      const lease = cache.retainGeneration(reference);
      await request;
      expect(lease.isCurrent()).toBe(true);
      lease.release();
    }
    expect(retained(cache)).toEqual({ generations: 3, leases: 0, pending: 0 });
    for (let i = 0; i < 100; i++) cache.invalidate({ accountId: "account", threadId: `thread-${i}` });
    expect(retained(cache)).toEqual({ generations: 0, leases: 0, pending: 0 });
  });

  test("an evicted success remains current through its consumer, then can be pruned", async () => {
    const cache = new ThreadDetailCache(1);
    const reference = { accountId: "account", threadId: "first" };
    const request = cache.load(reference, async () => detail(1));
    const lease = cache.retainGeneration(reference);
    await request;
    await cache.load({ accountId: "account", threadId: "second" }, async () => detail(2));
    expect(cache.peek(reference)).toBeNull();
    expect(lease.isCurrent()).toBe(true);
    expect(retained(cache).generations).toBe(2);
    lease.release(); lease.release();
    expect(lease.isCurrent()).toBe(false);
    expect(retained(cache)).toEqual({ generations: 1, leases: 0, pending: 0 });
  });

  test("a current failure remains visible through catch and is pruned after release", async () => {
    const cache = new ThreadDetailCache();
    const reference = { accountId: "account", threadId: "failure" };
    const request = cache.load(reference, async () => { throw new Error("synthetic failure"); });
    const lease = cache.retainGeneration(reference);
    const message = await request.catch((error: Error) => lease.isCurrent() ? error.message : "incorrectly suppressed");
    expect(message).toBe("synthetic failure");
    expect(retained(cache)).toEqual({ generations: 1, leases: 1, pending: 0 });
    lease.release();
    expect(retained(cache)).toEqual({ generations: 0, leases: 0, pending: 0 });
  });

  test("supersede, prune and reload cannot resurrect a delayed success", async () => {
    const cache = new ThreadDetailCache(1);
    const reference = { accountId: "account", threadId: "same" };
    let resolve!: (value: ThreadDetail) => void;
    const old = cache.load(reference, () => new Promise(done => { resolve = done; }));
    const oldLease = cache.retainGeneration(reference);
    cache.invalidate(reference);
    expect(oldLease.isCurrent()).toBe(false);
    oldLease.release();
    expect(retained(cache).generations).toBe(0);
    const fresh = cache.load(reference, async () => detail(2));
    const freshLease = cache.retainGeneration(reference);
    await fresh;
    resolve(detail(1)); await old;
    expect(cache.peek(reference)?.detail).toEqual(detail(2));
    expect(oldLease.isCurrent()).toBe(false);
    expect(freshLease.isCurrent()).toBe(true);
    freshLease.release();
  });

  test("a late failure cannot replace a newer success and does not release its lease", async () => {
    const cache = new ThreadDetailCache();
    const reference = { accountId: "account", threadId: "same" };
    let reject!: (error: Error) => void;
    const old = cache.load(reference, () => new Promise((_done, fail) => { reject = fail; }), { version: "old" });
    const oldLease = cache.retainGeneration(reference);
    const handled = old.catch(() => oldLease.isCurrent());
    const fresh = cache.load(reference, async () => detail(2), { version: "new" });
    const freshLease = cache.retainGeneration(reference);
    await fresh;
    reject(new Error("late"));
    expect(await handled).toBe(false);
    oldLease.release(); oldLease.release();
    expect(freshLease.isCurrent()).toBe(true);
    expect(retained(cache).leases).toBe(1);
    freshLease.release();
    expect(retained(cache).leases).toBe(0);
  });

  test("same thread IDs in different accounts keep independent leases", async () => {
    const cache = new ThreadDetailCache();
    const a = { accountId: "a", threadId: "same" }, b = { accountId: "b", threadId: "same" };
    const first = cache.load(a, async () => detail(1));
    const aLease = cache.retainGeneration(a);
    const second = cache.load(b, async () => detail(2));
    const bLease = cache.retainGeneration(b);
    await Promise.all([first, second]);
    cache.invalidate(a);
    expect(aLease.isCurrent()).toBe(false);
    expect(bLease.isCurrent()).toBe(true);
    expect(cache.peek(b)?.detail).toEqual(detail(2));
    aLease.release(); bLease.release();
    expect(retained(cache)).toEqual({ generations: 1, leases: 0, pending: 0 });
  });
});
