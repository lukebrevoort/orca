import { describe, expect, test } from "bun:test";
import type { InboxMessage, ThreadDetail } from "@orca/shared";
import { ThreadDetailCache, recentThreadReferences } from "./thread-detail-cache";

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
    expect(references[0]).toEqual({ accountId: "account", threadId: "thread-34" });
    expect(references.at(-1)).toEqual({ accountId: "account", threadId: "thread-5" });
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
});
