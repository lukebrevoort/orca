import type { InboxMessage, ThreadDetail } from "@orca/shared";

export type ThreadReference = Pick<InboxMessage, "accountId" | "threadId">;

export type VersionedThreadReference = ThreadReference & {
  version: string;
};

export type CachedThreadDetail = {
  detail: ThreadDetail;
  fetchedAt: number;
  version: string | null;
  stale: boolean;
};

type InFlightThreadDetail = {
  generation: number;
  promise: Promise<ThreadDetail>;
  version: string | null;
};

const cacheKey = ({ accountId, threadId }: ThreadReference) => JSON.stringify([accountId, threadId]);

/**
 * A bounded hot cache for Reader payloads. In-flight reads form the first tier:
 * opening a thread while it is being prefetched joins the same request. Resolved
 * details form the second tier and are kept in LRU order.
 */
export class ThreadDetailCache {
  private readonly details = new Map<string, CachedThreadDetail>();
  private readonly generations = new Map<string, number>();
  private nextGeneration = 1;
  private readonly leases = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlightThreadDetail>();

  constructor(private readonly capacity = 30) {}

  peek(reference: ThreadReference): CachedThreadDetail | null {
    const key = cacheKey(reference);
    const cached = this.details.get(key);
    if (!cached) return null;
    this.details.delete(key);
    this.details.set(key, cached);
    return cached;
  }

  isFresh(reference: ThreadReference, maxAgeMs: number, now = Date.now(), version?: string) {
    const cached = this.details.get(cacheKey(reference));
    return Boolean(
      cached
      && !cached.stale
      && now - cached.fetchedAt <= maxAgeMs
      && (version === undefined || cached.version === version),
    );
  }

  invalidate(reference: ThreadReference) {
    const key = cacheKey(reference);
    this.supersede(key);
    this.details.delete(key);
    this.pruneGeneration(key);
  }

  markStale(reference: ThreadReference) {
    const key = cacheKey(reference);
    this.supersede(key);
    const cached = this.details.get(key);
    if (cached) cached.stale = true;
    this.pruneGeneration(key);
  }

  /** Retain identity through a caller's success/error continuation, even after eviction.
   * Acquire synchronously after load; release on completion or cancellation. */
  retainGeneration(reference: ThreadReference) {
    const key = cacheKey(reference);
    const generation = this.ensureGeneration(key);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return {
      isCurrent: () => !released && this.generations.get(key) === generation,
      release: () => {
        if (released) return;
        released = true;
        const remaining = this.leases.get(key)! - 1;
        if (remaining === 0) this.leases.delete(key);
        else this.leases.set(key, remaining);
        this.pruneGeneration(key);
      },
    };
  }

  load(
    reference: ThreadReference,
    loader: () => Promise<ThreadDetail>,
    options: { refresh?: boolean; version?: string } = {},
  ) {
    const key = cacheKey(reference);
    const requestedVersion = options.version ?? null;
    const pending = this.inFlight.get(key);
    if (pending && pending.version === requestedVersion) return pending.promise;
    if (pending) this.supersede(key);
    const cached = this.details.get(key);
    if (cached && !cached.stale && cached.version === requestedVersion && !options.refresh) {
      return Promise.resolve(cached.detail);
    }

    const generation = this.ensureGeneration(key);
    let loaded: Promise<ThreadDetail>;
    try {
      loaded = loader();
    } catch (error) {
      this.pruneGeneration(key);
      throw error;
    }
    const request = loaded.then((detail) => {
      if (this.generations.get(key) !== generation) return detail;
      this.details.delete(key);
      this.details.set(key, { detail, fetchedAt: Date.now(), version: requestedVersion, stale: false });
      while (this.details.size > Math.max(1, this.capacity)) {
        const oldest = this.details.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.details.delete(oldest);
        this.pruneGeneration(oldest);
      }
      return detail;
    }).finally(() => {
      if (this.inFlight.get(key)?.promise === request) this.inFlight.delete(key);
      this.pruneGeneration(key);
    });
    this.inFlight.set(key, { generation, promise: request, version: requestedVersion });
    return request;
  }

  async prefetch(
    references: readonly VersionedThreadReference[],
    loader: (reference: VersionedThreadReference) => Promise<ThreadDetail>,
    options: { concurrency?: number; shouldContinue?: () => boolean } = {},
  ) {
    let cursor = 0;
    const concurrency = Math.max(1, options.concurrency ?? 3);
    const worker = async () => {
      while (cursor < references.length && (options.shouldContinue?.() ?? true)) {
        const reference = references[cursor++];
        if (!reference || this.isFresh(reference, Number.POSITIVE_INFINITY, Date.now(), reference.version)) continue;
        try {
          await this.load(reference, () => loader(reference), { version: reference.version });
        } catch {
          // Prefetch is opportunistic. A foreground open can retry normally.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  }

  private ensureGeneration(key: string) {
    let generation = this.generations.get(key);
    if (generation === undefined) {
      generation = this.nextGeneration++;
      this.generations.set(key, generation);
    }
    return generation;
  }

  private pruneGeneration(key: string) {
    if (!this.details.has(key) && !this.inFlight.has(key) && !this.leases.has(key)) {
      this.generations.delete(key);
    }
  }

  private supersede(key: string) {
    this.generations.set(key, this.nextGeneration++);
    this.inFlight.delete(key);
  }
}

/**
 * Explicit post-mutation refreshes (send and routing) share this operation so
 * they preserve the visible payload while guaranteeing the next generation
 * cannot be satisfied by a still-fresh entry or an older in-flight read.
 */
export function scheduleThreadDetailRefresh(
  cache: ThreadDetailCache,
  reference: ThreadReference | null,
  schedule: () => void,
) {
  if (reference) cache.markStale(reference);
  schedule();
}

export function threadMailboxVersion(messages: readonly InboxMessage[]) {
  return messages
    .map((message) => JSON.stringify([
      message.id,
      message.providerMessageId,
      message.receivedAt,
      message.subject,
      message.snippet,
      message.unread,
      message.labels,
      message.humanSignal,
      message.humanClassification,
    ]))
    .sort()
    .join("\n");
}

export function recentThreadReferences(messages: readonly InboxMessage[], limit = 30): VersionedThreadReference[] {
  const messagesByThread = new Map<string, InboxMessage[]>();
  for (const message of messages) {
    const key = cacheKey(message);
    const threadMessages = messagesByThread.get(key) ?? [];
    threadMessages.push(message);
    messagesByThread.set(key, threadMessages);
  }
  return [...messagesByThread.values()]
    .map((threadMessages) => ({
      newest: threadMessages.reduce((current, message) => (
        message.receivedAt > current.receivedAt || (message.receivedAt === current.receivedAt && message.id > current.id)
          ? message
          : current
      )),
      version: threadMailboxVersion(threadMessages),
    }))
    .sort((left, right) => right.newest.receivedAt.localeCompare(left.newest.receivedAt) || cacheKey(left.newest).localeCompare(cacheKey(right.newest)))
    .slice(0, Math.max(0, limit))
    .map(({ newest: { accountId, threadId }, version }) => ({ accountId, threadId, version }));
}
