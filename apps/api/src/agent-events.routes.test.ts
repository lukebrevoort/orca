import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { propagatedAgentEventSchema, type PropagatedAgentEvent } from "@orca/shared";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { agentPropagationMutes, oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import type { AgentEventListQuery } from "./agents/interfaces.ts";

function fixtureEvent(): PropagatedAgentEvent {
  return propagatedAgentEventSchema.parse({
    id: "event_owned",
    source: {
      ownerUserId: "owner",
      accountId: "account_owned",
      provider: "gmail",
      messageId: "message_owned",
      providerMessageId: "provider-message-owned",
      threadId: "thread_owned",
      sender: { name: "CI", email: "ci@example.dev" },
      subject: "Deploy failed",
      receivedAt: "2026-08-19T15:00:00.000Z",
      sourceUrl: "http://localhost:5173/?thread=thread_owned&accountId=account_owned",
    },
    provenance: { trigger: "sync", policyVersion: "m6-v0", agentId: "orca-deterministic-propagator", agentVersion: "0.1.0", executionMode: "deterministic" },
    eventKind: "ci_or_deploy_failure",
    importance: "high",
    relevance: "matched",
    destination: "timeline",
    reasonCodes: ["workflow_failed"],
    title: "The deploy failed",
    summary: "The production deploy stopped.",
    whyThisMatters: "The release is blocked.",
    suggestedNextStep: "Open the source message.",
    humanClassification: { classification: "automated_or_bulk", score: 1, reasonCodes: ["auto_submitted_header"], classifierVersion: "m5-v1", source: "automatic_heuristic" },
    deduplicationKey: "sha256:684ec1beaf1326dfb78e271e22de4af674a4c74abc060226373daf67ae12f425",
    evaluatedAt: "2026-08-19T15:00:01.000Z",
    lifecycle: { state: "new", lastTransition: "created", revision: 1, createdAt: "2026-08-19T15:00:01.000Z", updatedAt: "2026-08-19T15:00:01.000Z", lastTransitionAt: "2026-08-19T15:00:01.000Z", seenAt: null, snoozedUntil: null },
  });
}

test("agent-event routes list and mutate only the authenticated user's local projection", async () => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 20).toString("base64");
  const tempDir = mkdtempSync(join(tmpdir(), "orca-agent-events-routes-"));
  const dbPath = join(tempDir, "agent-events.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  try {
    db.insert(users).values([
      { id: "owner", email: "owner@example.com" },
      { id: "other", email: "other@example.com" },
    ]).run();
    db.insert(oauthAccounts).values([
      { id: "account_owned", userId: "owner", provider: "gmail", providerEmail: "owner@gmail.com", providerId: "provider-owned" },
      { id: "account_other", userId: "other", provider: "gmail", providerEmail: "other@gmail.com", providerId: "provider-other" },
    ]).run();
    db.insert(agentPropagationMutes).values([
      { id: "mute_owned", accountId: "account_owned", targetScope: "sender_address", targetValue: "ci@example.dev" },
      { id: "mute_other", accountId: "account_other", targetScope: "event_kind", targetValue: "receipt_or_renewal" },
    ]).run();
    const session = await createSession(db, "owner");
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const event = fixtureEvent();
    const listQueries: AgentEventListQuery[] = [];
    const updates: Array<{ ownerUserId: string; accountId: string; eventId: string; update: unknown }> = [];
    const testApp = createApp({
      dbFactory: () => createDatabaseClient(dbPath),
      agentEventStore: {
        async list(query) {
          listQueries.push(query);
          return { events: [event], nextCursor: null };
        },
        async updateLifecycle(input) {
          updates.push(input);
          return { ...event, lifecycle: { ...event.lifecycle, state: "seen", lastTransition: "seen", revision: 2, seenAt: "2026-08-19T15:05:00.000Z", updatedAt: "2026-08-19T15:05:00.000Z", lastTransitionAt: "2026-08-19T15:05:00.000Z" } };
        },
      },
    });

    assert.equal((await testApp.request("/v1/agent-events", { headers })).status, 200);
    assert.deepEqual(listQueries[0], { ownerUserId: "owner", accountIds: ["account_owned"], states: undefined, limit: 50, cursor: undefined });
    assert.equal((await testApp.request("/v1/agent-events?accountId=account_other", { headers })).status, 404);
    assert.equal((await testApp.request("/v1/agent-events?states=definitely_safe", { headers })).status, 400);

    const updated = await testApp.request("/v1/agent-events/event_owned/lifecycle?accountId=account_owned", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "mark_seen", expectedRevision: 1 }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).lifecycle.state, "seen");
    assert.deepEqual(updates, [{ ownerUserId: "owner", accountId: "account_owned", eventId: "event_owned", update: { action: "mark_seen", expectedRevision: 1 } }]);

    const crossAccount = await testApp.request("/v1/agent-events/event_owned/lifecycle?accountId=account_other", {
      method: "PATCH", headers, body: JSON.stringify({ action: "dismiss", expectedRevision: 1 }),
    });
    assert.equal(crossAccount.status, 404);
    assert.equal(updates.length, 1);

    const mutes = await testApp.request("/v1/agent-event-mutes", { headers });
    assert.equal(mutes.status, 200);
    assert.deepEqual((await mutes.json()).map((mute: { id: string }) => mute.id), ["mute_owned"]);
    assert.equal((await testApp.request("/v1/agent-event-mutes/mute_other?accountId=account_other", { method: "DELETE", headers })).status, 404);
    assert.equal((await testApp.request("/v1/agent-event-mutes/mute_owned?accountId=account_owned", { method: "DELETE", headers })).status, 204);
    assert.equal((await testApp.request("/v1/agent-event-mutes/mute_owned?accountId=account_owned", { method: "DELETE", headers })).status, 404);
  } finally {
    sqlite.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.SESSION_SECRET;
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});
