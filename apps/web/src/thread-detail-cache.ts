import type { InboxMessage, ThreadDetail } from "@orca/shared";

export type ThreadReference = Pick<InboxMessage, "accountId" | "threadId">;

export type CachedThreadDetail = {
  detail: ThreadDetail;
  fetchedAt: number;
};

const cacheKey = ({ accountId, threadId }: ThreadReference) => JSON.stringify([accountId, threadId]);

/**
 * A bounded hot cache for Reader payloads. In-flight reads form the first tier:
 * opening a thread while it is being prefetched joins the same request. Resolved
 * details form the second tier and are kept in LRU order.
 */
export class ThreadDetailCache {
  private readonly details = new Map<string, CachedThreadDetail>();
  private readonly inFlight = new Map<string, Promise<ThreadDetail>>();

  constructor(private readonly capacity = 30) {}

  peek(reference: ThreadReference): CachedThreadDetail | null {
    const key = cacheKey(reference);
    const cached = this.details.get(key);
    if (!cached) return null;
    this.details.delete(key);
    this.details.set(key, cached);
    return cached;
  }

  isFresh(reference: ThreadReference, maxAgeMs: number, now = Date.now()) {
    const cached = this.details.get(cacheKey(reference));
    return Boolean(cached && now - cached.fetchedAt <= maxAgeMs);
  }

  invalidate(reference: ThreadReference) {
    this.details.delete(cacheKey(reference));
  }

  load(reference: ThreadReference, loader: () => Promise<ThreadDetail>, options: { refresh?: boolean } = {}) {
    const key = cacheKey(reference);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const cached = this.details.get(key);
    if (cached && !options.refresh) return Promise.resolve(cached.detail);

    const request = loader().then((detail) => {
      this.details.delete(key);
      this.details.set(key, { detail, fetchedAt: Date.now() });
      while (this.details.size > Math.max(1, this.capacity)) {
        const oldest = this.details.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.details.delete(oldest);
      }
      return detail;
    }).finally(() => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  async prefetch(
    references: readonly ThreadReference[],
    loader: (reference: ThreadReference) => Promise<ThreadDetail>,
    options: { concurrency?: number; shouldContinue?: () => boolean } = {},
  ) {
    let cursor = 0;
    const concurrency = Math.max(1, options.concurrency ?? 3);
    const worker = async () => {
      while (cursor < references.length && (options.shouldContinue?.() ?? true)) {
        const reference = references[cursor++];
        if (!reference || this.details.has(cacheKey(reference))) continue;
        try {
          await this.load(reference, () => loader(reference));
        } catch {
          // Prefetch is opportunistic. A foreground open can retry normally.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  }
}

export function recentThreadReferences(messages: readonly InboxMessage[], limit = 30): ThreadReference[] {
  const newestByThread = new Map<string, InboxMessage>();
  for (const message of messages) {
    const key = cacheKey(message);
    const current = newestByThread.get(key);
    if (!current || message.receivedAt > current.receivedAt || (message.receivedAt === current.receivedAt && message.id > current.id)) {
      newestByThread.set(key, message);
    }
  }
  return [...newestByThread.values()]
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || cacheKey(left).localeCompare(cacheKey(right)))
    .slice(0, Math.max(0, limit))
    .map(({ accountId, threadId }) => ({ accountId, threadId }));
}
