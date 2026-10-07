// A tiny subprocess fixture: wait for a test-owned release file, then return one
// ordinary page or fixed budget error. No SQLite work or expensive operation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RankedSearchWorkerReply, RankedSearchWorkerRequest } from "../protocol.ts";

const request = JSON.parse(await Bun.stdin.text()) as RankedSearchWorkerRequest;
const root = dirname(request.databasePath);
const releasePath = join(root, `${request.authorization.userId}.release`);
writeFileSync(join(root, `${request.authorization.userId}.ready`), String(process.pid));
await new Promise<void>(resolve => {
  const poll = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(poll); resolve();
  }, 5);
});
const result = {
  page: {
    accounts: [{ id: "a", provider: "gmail" as const, email: "fixture@example.test", displayName: "Fixture", capabilities: { read: true, send: false, draft: false } }],
    messages: [{ id: "message", accountId: "a", provider: "gmail" as const, providerMessageId: "message", threadId: "thread",
      from: { name: "Sender", email: "sender@example.test" }, subject: "Appointment", snippet: "One synthetic message",
      receivedAt: "2026-01-01T12:00:00.000Z", unread: true, labels: [], attentionBehavior: "normal" as const, humanSignal: 5, humanClassification: null }],
    nextCursor: null, continuation: "none" as const, snapshot: "fixture-snapshot", order: "field-relevance-v1" as const,
    semantics: "literal-index-v3" as const, coverage: request.mode === "full" ? "stored-plaintext" as const : "stored-metadata" as const,
  },
  ...(request.exactCounts ? { counts: { attention: { all: 1, focus: 0, normal: 1, quiet: 0, hidden: 0 }, classification: { all: 1, likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 1 } } } : {}),
  freshness: { revision: `mailbox-v2:${"a".repeat(64)}`, lastSyncedAt: null },
  capabilityAccounts: [{ id: "a", provider: "gmail" as const, scope: "fixture-scope" }],
  metric: { durationMs: 1, candidateRows: 1, indexBatches: 1, shortBodyBytes: 0, projectedMessages: 1 },
};
const reply: RankedSearchWorkerReply = readFileSync(releasePath, "utf8") === "search_budget_exceeded"
  ? { version: 1, ok: false, code: "search_budget_exceeded", peakRssBytes: 1024 }
  : { version: 1, ok: true, result, peakRssBytes: 1024 };
await Bun.write(Bun.stdout, JSON.stringify(reply));
