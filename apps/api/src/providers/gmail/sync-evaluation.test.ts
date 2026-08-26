import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationEvaluationTraces,
  organizationRules,
  threads,
  users,
} from "../../db/schema.ts";
import { createSqliteRuleRevisionRepository } from "../../organization/rules/sqlite-repository.ts";
import { createRuleRevisionService } from "../../organization/rules/service.ts";
import { persistGmailMessages } from "./sync.ts";
import type { GmailMessage } from "./types.ts";

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function gmailMessage(input: {
  id: string;
  receivedAt: string;
  unread: boolean;
}): GmailMessage {
  return {
    id: input.id,
    threadId: "provider-thread-history",
    internalDate: String(Date.parse(input.receivedAt)),
    labelIds: input.unread ? ["INBOX", "UNREAD"] : ["INBOX"],
    snippet: input.id,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Maya <maya@example.com>" },
        { name: "To", value: "Owner <owner@example.com>" },
        { name: "Subject", value: input.id },
      ],
      body: { data: Buffer.from(input.id).toString("base64url") },
    },
  };
}

function compileRule(
  service: ReturnType<typeof createRuleRevisionService>,
  db: ReturnType<typeof createDatabaseClient>["db"],
  input: { idempotencyKey: string; workspaceSchemaRevision: number; source: string },
) {
  const compiled = service.compile({
    actor: { id: "workspace-history", type: "human" },
    workspaceId: "workspace-history",
    request: {
      idempotencyKey: input.idempotencyKey,
      expectedRuleRevision: null,
      workspaceSchemaRevision: input.workspaceSchemaRevision,
      source: input.source,
    },
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("Historical snapshot Rule failed to compile");
  db.update(organizationRules)
    .set({ activeRevisionId: compiled.revision.id })
    .where(eq(organizationRules.id, compiled.rule.id))
    .run();
  return compiled.revision.id;
}

describe("persistGmailMessages Event snapshots", () => {
  test("evaluates same-Thread Events against immutable historical aggregates", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "orca-gmail-event-snapshot-"));
    tempDirectories.push(tempDirectory);
    const { db, sqlite } = createDatabaseClient(join(tempDirectory, "snapshot.sqlite"));
    migrate(db, { migrationsFolder });

    try {
      const now = new Date("2026-08-26T13:00:00.000Z");
      db.insert(users).values({ id: "workspace-history", email: "owner@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "account-history",
        userId: "workspace-history",
        provider: "gmail",
        providerEmail: "owner@example.com",
        providerId: "gmail-owner-history",
      }).run();

      const service = createRuleRevisionService(createSqliteRuleRevisionRepository(db), {
        now: () => now,
        id: (() => {
          let sequence = 0;
          return () => `historical-rule-${++sequence}`;
        })(),
      });
      const firstRevisionId = compileRule(service, db, {
        idempotencyKey: "historical-first-event",
        workspaceSchemaRevision: 1,
        source: `orca 1
rule "First historical message"
event message.received
predicate count = thread.message_count equals 1
predicate read = thread.unread equals false
predicate latest = thread.latest_received_at equals "2026-08-26T12:00:00.000Z"
when all(count, read, latest)
action notify immediate
because "The first Event sees only the first message"`,
      });
      const secondRevisionId = compileRule(service, db, {
        idempotencyKey: "historical-second-event",
        workspaceSchemaRevision: 2,
        source: `orca 1
rule "Second historical message"
event thread.updated
predicate count = thread.message_count equals 2
predicate unread = thread.unread equals true
predicate latest = thread.latest_received_at equals "2026-08-26T12:05:00.000Z"
when all(count, unread, latest)
action notify immediate
because "The second Event sees both messages"`,
      });

      const first = gmailMessage({
        id: "message-first",
        receivedAt: "2026-08-26T12:00:00.000Z",
        unread: false,
      });
      const second = gmailMessage({
        id: "message-second",
        receivedAt: "2026-08-26T12:05:00.000Z",
        unread: true,
      });

      await persistGmailMessages(db, {
        accountId: "account-history",
        accountEmail: "owner@example.com",
        gmailMessages: [second, first],
        labelList: [
          { id: "INBOX", name: "Inbox", type: "system" },
          { id: "UNREAD", name: "Unread", type: "system" },
        ],
        now,
        propagationTrigger: "sync",
      });

      const traceRows = db.select({
        eventId: organizationEvaluationTraces.eventId,
        eventKind: organizationEvaluationTraces.eventKind,
        traceJson: organizationEvaluationTraces.traceJson,
      }).from(organizationEvaluationTraces).orderBy(organizationEvaluationTraces.logicalTime).all();
      assert.equal(traceRows.length, 2);

      const firstTrace = JSON.parse(traceRows[0]!.traceJson) as {
        observedValues: Array<{ field: string; present: boolean; value?: string | number | boolean }>;
        consideredRevisions: Array<{ revisionId: string; eventMatched: boolean; predicateMatched: boolean }>;
        winners: Array<{ action: { kind: string } }>;
      };
      assert.deepEqual(
        { eventId: traceRows[0]!.eventId, eventKind: traceRows[0]!.eventKind },
        { eventId: "message.received:gmail:account-history:message-first", eventKind: "message.received" },
      );
      assert.deepEqual(firstTrace.observedValues, [
        { field: "thread.latest_received_at", present: true, value: "2026-08-26T12:00:00.000Z" },
        { field: "thread.message_count", present: true, value: 1 },
        { field: "thread.unread", present: true, value: false },
      ]);
      assert.equal(
        firstTrace.consideredRevisions.find((revision) => revision.revisionId === firstRevisionId)?.predicateMatched,
        true,
      );
      assert.equal(firstTrace.winners.some((winner) => winner.action.kind === "notify"), true);

      const secondTrace = JSON.parse(traceRows[1]!.traceJson) as typeof firstTrace;
      assert.deepEqual(
        { eventId: traceRows[1]!.eventId, eventKind: traceRows[1]!.eventKind },
        { eventId: "thread.updated:gmail:account-history:message-second", eventKind: "thread.updated" },
      );
      assert.deepEqual(secondTrace.observedValues, [
        { field: "thread.latest_received_at", present: true, value: "2026-08-26T12:05:00.000Z" },
        { field: "thread.message_count", present: true, value: 2 },
        { field: "thread.unread", present: true, value: true },
      ]);
      assert.equal(
        secondTrace.consideredRevisions.find((revision) => revision.revisionId === secondRevisionId)?.predicateMatched,
        true,
      );
      assert.equal(secondTrace.winners.some((winner) => winner.action.kind === "notify"), true);

      const finalThread = db.select().from(threads).where(eq(threads.id, "gmail:account-history:provider-thread-history")).get();
      assert.equal(finalThread?.messageCount, 2);
      assert.equal(finalThread?.latestReceivedAt?.toISOString(), "2026-08-26T12:05:00.000Z");
      assert.equal(finalThread?.isRead, false);
    } finally {
      sqlite.close();
    }
  }, 15_000);
});
