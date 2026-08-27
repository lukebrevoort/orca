import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { bre320ProductionFailureFixture } from "@orca/shared";
import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationChangeSets,
  organizationCorrectionReceipts,
  organizationEvaluationTraces,
  organizationLanePolicies,
  organizationLanes,
  organizationRules,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationWorkspaceStates,
  threads,
  users,
} from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { persistGmailMessages } from "../../providers/gmail/sync.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { OrcaThreadCorrectionError, correctOrganizationThread } from "./correction.ts";
import { createRuleRevisionService } from "./service.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";

const directories: string[] = [];
const migrations = resolve(import.meta.dir, "../../../drizzle");

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

function gmailMessage(): GmailMessage {
  return {
    id: bre320ProductionFailureFixture.historicalThreads[0].providerMessageId,
    threadId: bre320ProductionFailureFixture.historicalThreads[0].providerThreadId,
    internalDate: String(Date.parse(bre320ProductionFailureFixture.historicalThreads[0].receivedAt)),
    labelIds: ["INBOX"],
    snippet: bre320ProductionFailureFixture.historicalThreads[0].subject,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Deploy System <alerts@deploy.example>" },
        { name: "To", value: bre320ProductionFailureFixture.workspace.email },
        { name: "Subject", value: bre320ProductionFailureFixture.historicalThreads[0].subject },
      ],
      body: { data: Buffer.from("Checkout is returning 500 responses.").toString("base64url") },
    },
  };
}

async function setup() {
  process.env.SESSION_SECRET = "bre320-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-bre320-correction-"));
  directories.push(directory);
  const path = join(directory, "correction.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: migrations });
  const fixture = bre320ProductionFailureFixture;
  const now = new Date("2026-08-26T18:30:00.000Z");
  client.db.insert(users).values({ id: fixture.workspace.id, email: fixture.workspace.email }).run();
  client.db.insert(oauthAccounts).values({
    id: fixture.workspace.accountId, userId: fixture.workspace.id, provider: "gmail",
    providerEmail: fixture.workspace.email, providerId: "bre320-provider-account",
  }).run();
  client.db.insert(organizationLanePolicies).values({
    workspaceId: fixture.workspace.id, id: fixture.lanePolicy.id,
    visibility: fixture.lanePolicy.visibility, interruption: fixture.lanePolicy.interruption,
    review: fixture.lanePolicy.review, retentionMode: "keep", retentionDays: null,
    providerDeletion: false, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationLanes).values({
    workspaceId: fixture.workspace.id, id: fixture.lanes.production.id, name: fixture.lanes.production.name,
    position: 1, defaultPolicyId: fixture.lanePolicy.id, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  await persistGmailMessages(client.db, {
    accountId: fixture.workspace.accountId, accountEmail: fixture.workspace.email,
    gmailMessages: [gmailMessage()], labelList: [], now, propagationTrigger: "sync",
  });
  const thread = client.db.select().from(threads).where(and(
    eq(threads.accountId, fixture.workspace.accountId), eq(threads.providerThreadId, fixture.historicalThreads[0].providerThreadId),
  )).get()!;
  const service = createRuleRevisionService(createSqliteRuleRevisionRepository(client.db), { now: () => now });
  const compiled = service.compile({
    actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id,
    request: {
      idempotencyKey: "bre320-user-corrected-rule", expectedRuleRevision: null,
      workspaceSchemaRevision: client.db.select().from(organizationWorkspaceStates).get()!.revision,
      source: `orca 1
rule "Human-confirmed production failures"
event user.corrected
when subject contains "failed"
action route lane "Production"
because "A human confirmed the production incident classification."`,
    },
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("Correction Rule did not compile");
  client.db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
  const session = await createSession(client.db, fixture.workspace.id);
  return { client, path, session, thread, compiled, now };
}

describe("production user.corrected seam", () => {
  test("persists one complete correction Trace and audited projection, replays exactly, and exposes the authenticated REST seam", async () => {
    const { client, path, session, thread, compiled, now } = await setup();
    const fixture = bre320ProductionFailureFixture;
    try {
      const workspaceRevision = client.db.select().from(organizationWorkspaceStates).get()!.revision;
      const threadRevision = client.db.select().from(organizationThreadStates).where(and(
        eq(organizationThreadStates.workspaceId, fixture.workspace.id), eq(organizationThreadStates.accountId, fixture.workspace.accountId), eq(organizationThreadStates.threadId, thread.id),
      )).get()?.revision ?? null;
      const request = {
        accountId: fixture.workspace.accountId, threadId: thread.id,
        expectedWorkspaceRevision: workspaceRevision, expectedThreadRevision: threadRevision,
        idempotencyKey: fixture.correction.idempotencyKey, reason: fixture.correction.reason,
      };
      const first = correctOrganizationThread(client.db, {
        actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id, request, now,
      });
      assert.equal(first.eventKind, "user.corrected");
      assert.equal(first.trace.event.kind, "user.corrected");
      assert.equal(first.trace.event.cause, "user");
      assert.equal(first.trace.winners.some((winner) => winner.revisionId === compiled.revision.id), true);
      assert.equal(first.trace.winners.find((winner) => winner.slot === "lane")?.reason, "A human confirmed the production incident classification.");
      assert.ok(first.changeSetId);
      assert.equal(client.db.select().from(organizationEvaluationTraces).where(eq(organizationEvaluationTraces.eventId, first.eventId)).all().length, 1);
      assert.equal(client.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, first.changeSetId!)).all().length, 1);

      const replay = correctOrganizationThread(client.db, {
        actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id, request, now,
      });
      assert.deepEqual(replay, first);
      assert.equal(client.db.select().from(organizationEvaluationTraces).where(eq(organizationEvaluationTraces.eventId, first.eventId)).all().length, 1);
      assert.equal(client.db.select().from(organizationCorrectionReceipts).all().length, 1);
      assert.throws(() => correctOrganizationThread(client.db, {
        actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id,
        request: { ...request, reason: "A conflicting correction body." }, now,
      }), (error: unknown) => error instanceof OrcaThreadCorrectionError && error.code === "idempotency_conflict");
      assert.equal(client.db.select().from(organizationEvaluationTraces).where(eq(organizationEvaluationTraces.eventId, first.eventId)).all().length, 1);

      const placement = client.db.select().from(organizationThreadLaneStates).where(and(
        eq(organizationThreadLaneStates.workspaceId, fixture.workspace.id), eq(organizationThreadLaneStates.accountId, fixture.workspace.accountId), eq(organizationThreadLaneStates.threadId, thread.id),
      )).get()!;
      client.db.update(organizationThreadLaneStates).set({
        safetyLocked: true, safetyLockActorId: fixture.workspace.id, safetyLockActorType: "human",
        safetyLockReason: "Hold the production incident in its reviewed Lane.", safetyLockUpdatedAt: now,
        revision: placement.revision + 1, updatedAt: now,
      }).where(and(
        eq(organizationThreadLaneStates.workspaceId, fixture.workspace.id), eq(organizationThreadLaneStates.accountId, fixture.workspace.accountId), eq(organizationThreadLaneStates.threadId, thread.id),
      )).run();
      const lockedWorkspaceRevision = client.db.select().from(organizationWorkspaceStates).get()!.revision;
      const lockedThreadRevision = client.db.select().from(organizationThreadStates).where(and(
        eq(organizationThreadStates.workspaceId, fixture.workspace.id), eq(organizationThreadStates.accountId, fixture.workspace.accountId), eq(organizationThreadStates.threadId, thread.id),
      )).get()!.revision;
      const lockedRequest = { ...request, expectedWorkspaceRevision: lockedWorkspaceRevision, expectedThreadRevision: lockedThreadRevision, idempotencyKey: `${request.idempotencyKey}:safety-lock`, reason: "Human reconfirmed the incident while Safety Lock remained active." };
      const locked = correctOrganizationThread(client.db, {
        actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id, request: lockedRequest, now,
      });
      assert.equal(locked.trace.winners.find((winner) => winner.slot === "lane")?.precedence, "safety_lock");
      assert.equal(locked.changeSetId, null);
      assert.equal(client.db.select().from(organizationCorrectionReceipts).all().length, 2);
      assert.equal(client.db.select().from(organizationWorkspaceStates).get()!.revision, lockedWorkspaceRevision);
      assert.deepEqual(correctOrganizationThread(client.db, {
        actor: { id: fixture.workspace.id, type: "human" }, workspaceId: fixture.workspace.id, request: lockedRequest, now,
      }), locked);

      client.sqlite.close();
      const app = createApp({ dbFactory: () => createDatabaseClient(path), now: () => now });
      const response = await app.request(`/v1/organization/threads/${encodeURIComponent(thread.id)}/correct`, {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.json();
      assert.equal(body.eventKind, "user.corrected");
      assert.equal(body.trace.id, first.trace.id);
      const conflict = await app.request(`/v1/organization/threads/${encodeURIComponent(thread.id)}/correct`, {
        method: "POST",
        headers: { cookie: `orca_session=${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...request, reason: "A conflicting correction body." }),
      });
      assert.equal(conflict.status, 409);
      const denied = await app.request(`/v1/organization/threads/${encodeURIComponent(thread.id)}/correct`, { method: "POST" });
      assert.equal(denied.status, 401);
    } finally {
      try { client.sqlite.close(); } catch { /* already closed for the REST readback */ }
    }
  }, 20_000);
});
