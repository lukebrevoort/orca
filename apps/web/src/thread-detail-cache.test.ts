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
    const newer = cache.load(reference, loader, { version: "mailbox-v2" });
    const newest = cache.load(reference, loader, { version: "mailbox-v3" });

    expect(reads).toBe(3);
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
