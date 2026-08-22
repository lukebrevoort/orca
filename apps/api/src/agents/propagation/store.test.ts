import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  agentPropagationAssessmentSchema,
  type AgentPropagationAssessment,
} from "@orca/shared";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import {
  agentPropagationMutes,
  agentPropagationPolicyOverrides,
  emails,
  oauthAccounts,
  threads,
  users,
} from "../../db/schema.ts";
import { buildAgentEventDeduplicationKey } from "./deterministic.ts";
import {
  AgentEventNotFoundError,
  AgentEventRevisionConflictError,
  deleteAgentPropagationMute,
  listAgentPropagationMutes,
  resolveAgentPropagationPolicy,
  SqliteAgentEventStore,
} from "./store.ts";

const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite agent event store", () => {
  test("deduplicates retries and updates meaningful same-message changes in place", async () => {
    const { db, sqlite } = createMigratedClient();
    try {
      insertSource(db, { ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" });
      const store = new SqliteAgentEventStore(db, () => new Date("2026-08-19T17:00:00.000Z"));
      const initial = assessment({ ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" });

      const created = await store.upsertWithResult(initial);
      const retry = await store.upsertWithResult({
        ...initial,
        provenance: { ...initial.provenance, trigger: "push" },
        evaluatedAt: "2026-08-19T16:05:00.000Z",
      });

      assert.equal(created.outcome, "created");
      assert.equal(retry.outcome, "duplicate");
      assert.equal(retry.event.id, created.event.id);
      assert.equal(retry.event.lifecycle.revision, 1);
      assert.equal(retry.event.evaluatedAt, initial.evaluatedAt);

      const dismissed = await store.updateLifecycle({
        ownerUserId: "user_1",
        accountId: "account_1",
        eventId: created.event.id,
        update: { action: "dismiss", expectedRevision: 1 },
      });
      const changed = await store.upsertWithResult({
        ...initial,
        source: { ...initial.source, subject: "Orca 2.1 (43) is ready to test" },
        title: "Orca 2.1 (43) is ready to test",
        summary: "TestFlight sent an updated build availability notice.",
        evaluatedAt: "2026-08-19T18:00:00.000Z",
      });

      assert.equal(dismissed.lifecycle.state, "dismissed");
      assert.equal(changed.outcome, "updated");
      assert.equal(changed.event.id, created.event.id);
      assert.equal(changed.event.lifecycle.state, "dismissed");
      assert.equal(changed.event.lifecycle.lastTransition, "updated");
      assert.equal(changed.event.lifecycle.revision, 3);
      assert.equal(changed.event.title, "Orca 2.1 (43) is ready to test");
      assert.equal(
        (sqlite.query("select count(*) as count from agent_events").get() as { count: number }).count,
        1,
      );
    } finally {
      sqlite.close();
    }
  });

  test("keeps new provider-message follow-ups as distinct immutable source events", async () => {
    const { db, sqlite } = createMigratedClient();
    try {
      insertSource(db, { ownerUserId: "user_1", accountId: "account_1", messageId: "message_1", threadId: "thread_shared" });
      insertEmail(db, { accountId: "account_1", messageId: "message_2", threadId: "thread_shared" });
      const store = new SqliteAgentEventStore(db);

      const first = await store.upsert(assessment({
        ownerUserId: "user_1", accountId: "account_1", messageId: "message_1", threadId: "thread_shared",
      }));
      const followUp = await store.upsert(assessment({
        ownerUserId: "user_1", accountId: "account_1", messageId: "message_2", threadId: "thread_shared",
      }));

      assert.notEqual(first.id, followUp.id);
      assert.notEqual(first.deduplicationKey, followUp.deduplicationKey);
      assert.equal(first.source.messageId, "message_1");
      assert.equal(followUp.source.messageId, "message_2");
    } finally {
      sqlite.close();
    }
  });

  test("prevents cross-account create, read, and mutation", async () => {
    const { db, sqlite } = createMigratedClient();
    try {
      insertSource(db, { ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" });
      insertSource(db, { ownerUserId: "user_2", accountId: "account_2", messageId: "message_2" });
      const store = new SqliteAgentEventStore(db);
      const created = await store.upsert(assessment({ ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" }));

      assert.deepEqual(await store.list({
        ownerUserId: "user_2",
        accountIds: ["account_1"],
        limit: 25,
      }), { events: [], nextCursor: null });
      await assert.rejects(
        () => store.upsert(assessment({ ownerUserId: "user_1", accountId: "account_2", messageId: "message_2" })),
        AgentEventNotFoundError,
      );
      await assert.rejects(
        () => store.updateLifecycle({
          ownerUserId: "user_2",
          accountId: "account_1",
          eventId: created.id,
          update: { action: "dismiss", expectedRevision: 1 },
        }),
        AgentEventNotFoundError,
      );
      await assert.rejects(
        () => store.updateLifecycle({
          ownerUserId: "user_1",
          accountId: "account_1",
          eventId: created.id,
          update: { action: "dismiss", expectedRevision: 99 },
        }),
        AgentEventRevisionConflictError,
      );
    } finally {
      sqlite.close();
    }
  });

  test("rejects a concurrent stale lifecycle writer instead of returning the winner's transition", async () => {
    const { db, sqlite } = createMigratedClient();
    try {
      insertSource(db, { ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" });
      const winner = new SqliteAgentEventStore(db, () => new Date("2026-08-19T17:00:00.000Z"));
      const created = await winner.upsert(assessment({
        ownerUserId: "user_1",
        accountId: "account_1",
        messageId: "message_1",
      }));
      let winnerUpdate: Promise<typeof created> | undefined;
      const staleWriter = new SqliteAgentEventStore(db, () => {
        winnerUpdate = winner.updateLifecycle({
          ownerUserId: "user_1",
          accountId: "account_1",
          eventId: created.id,
          update: { action: "mark_seen", expectedRevision: 1 },
        });
        return new Date("2026-08-19T17:00:01.000Z");
      });

      await assert.rejects(
        () => staleWriter.updateLifecycle({
          ownerUserId: "user_1",
          accountId: "account_1",
          eventId: created.id,
          update: { action: "dismiss", expectedRevision: 1 },
        }),
        AgentEventRevisionConflictError,
      );
      assert.ok(winnerUpdate);
      const winnerResult = await winnerUpdate;

      assert.equal(winnerResult.lifecycle.state, "seen");
      assert.equal(winnerResult.lifecycle.lastTransition, "seen");
      assert.equal(winnerResult.lifecycle.revision, 2);
      const [persisted] = (await winner.list({
        ownerUserId: "user_1",
        accountIds: ["account_1"],
        limit: 1,
      })).events;
      assert.equal(persisted?.lifecycle.state, "seen");
      assert.equal(persisted?.lifecycle.revision, 2);
    } finally {
      sqlite.close();
    }
  });

  test("resolves account policy and reversible mutes without provider writes", async () => {
    const { db, sqlite } = createMigratedClient();
    try {
      insertSource(db, { ownerUserId: "user_1", accountId: "account_1", messageId: "message_1" });
      insertSource(db, { ownerUserId: "user_2", accountId: "account_2", messageId: "message_2" });
      db.insert(agentPropagationPolicyOverrides).values({
        id: "override_1",
        accountId: "account_1",
        category: "security_or_account_alert",
        enabled: false,
      }).run();
      db.insert(agentPropagationMutes).values({
        id: "mute_1",
        accountId: "account_1",
        targetScope: "sender_domain",
        targetValue: "example.com",
      }).run();

      assert.equal(resolveAgentPropagationPolicy(db, "account_1").securityOrAccountAlert, false);
      assert.equal(resolveAgentPropagationPolicy(db, "account_2").securityOrAccountAlert, true);
      assert.deepEqual(listAgentPropagationMutes(db, "account_2"), []);
      assert.deepEqual(listAgentPropagationMutes(db, "account_1").map((rule) => rule.target), [
        { scope: "sender_domain", value: "example.com" },
      ]);
      assert.equal(deleteAgentPropagationMute(db, {
        ownerUserId: "user_2", accountId: "account_1", muteId: "mute_1",
      }), false);
      assert.equal(deleteAgentPropagationMute(db, {
        ownerUserId: "user_1", accountId: "account_1", muteId: "mute_1",
      }), true);
      assert.deepEqual(listAgentPropagationMutes(db, "account_1"), []);

      const providerColumns = sqlite.query("pragma table_info(agent_events)").all() as Array<{ name: string }>;
      assert.equal(providerColumns.some((column) => /body|header|attachment|token/i.test(column.name)), false);
    } finally {
      sqlite.close();
    }
  });
});

function createMigratedClient() {
  const directory = mkdtempSync(join(tmpdir(), "orca-propagation-store-"));
  tempDirs.push(directory);
  const client = createDatabaseClient(join(directory, "store.sqlite"));
  migrate(client.db, { migrationsFolder });
  return client;
}

function insertSource(
  db: ReturnType<typeof createDatabaseClient>["db"],
  input: { ownerUserId: string; accountId: string; messageId: string; threadId?: string },
) {
  db.insert(users).values({ id: input.ownerUserId, email: `${input.ownerUserId}@example.com` }).onConflictDoNothing().run();
  db.insert(oauthAccounts).values({
    id: input.accountId,
    userId: input.ownerUserId,
    provider: "gmail",
    providerEmail: `${input.ownerUserId}@example.com`,
    providerId: `provider-${input.accountId}`,
  }).run();
  const threadId = input.threadId ?? `thread_${input.messageId}`;
  db.insert(threads).values({
    id: threadId,
    accountId: input.accountId,
    providerThreadId: `provider-${threadId}`,
  }).onConflictDoNothing().run();
  insertEmail(db, { accountId: input.accountId, messageId: input.messageId, threadId });
}

function insertEmail(
  db: ReturnType<typeof createDatabaseClient>["db"],
  input: { accountId: string; messageId: string; threadId: string },
) {
  db.insert(emails).values({
    id: input.messageId,
    accountId: input.accountId,
    threadId: input.threadId,
    providerMessageId: `provider-${input.messageId}`,
  }).run();
}

function assessment(input: {
  ownerUserId: string;
  accountId: string;
  messageId: string;
  threadId?: string;
}): AgentPropagationAssessment {
  const threadId = input.threadId ?? `thread_${input.messageId}`;
  return agentPropagationAssessmentSchema.parse({
    source: {
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      provider: "gmail",
      messageId: input.messageId,
      providerMessageId: `provider-${input.messageId}`,
      threadId,
      sender: { name: "TestFlight", email: "no_reply@email.apple.com" },
      subject: "Orca 2.1 (42) is ready to test",
      receivedAt: "2026-08-19T16:00:00.000Z",
      sourceUrl: `http://localhost:5173/?accountId=${input.accountId}&thread=${threadId}`,
    },
    provenance: {
      trigger: "sync",
      policyVersion: "m6-v0",
      agentId: "orca-deterministic-propagator",
      agentVersion: "0.1.0",
      executionMode: "deterministic",
    },
    eventKind: "release_available",
    importance: "high",
    relevance: "matched",
    destination: "timeline",
    reasonCodes: ["release_became_available"],
    title: "Orca 2.1 (42) is ready to test",
    summary: "TestFlight sent an updated build availability notice.",
    whyThisMatters: "A release or beta build is ready for review.",
    suggestedNextStep: "Open the original message when you are ready to review the build.",
    humanClassification: {
      classification: "automated_or_bulk",
      score: 1,
      reasonCodes: ["sender_no_reply_pattern"],
      classifierVersion: "m5-v2",
      source: "automatic_heuristic",
    },
    deduplicationKey: buildAgentEventDeduplicationKey({
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
      provider: "gmail",
      providerMessageId: `provider-${input.messageId}`,
      eventKind: "release_available",
    }),
    evaluatedAt: "2026-08-19T16:00:01.000Z",
  });
}
