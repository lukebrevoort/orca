import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { createApp } from "../index.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("Organization REST read adapter", () => {
  test("describes and queries only the session Workspace Accounts", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 18).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-routes-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values([
        { id: "workspace_owner", email: "owner@example.com" },
        { id: "workspace_other", email: "other@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider-a" },
        { id: "account_b", userId: "workspace_owner", provider: "outlook", providerEmail: "owner@outlook.example", providerId: "provider-b" },
        { id: "account_private", userId: "workspace_other", provider: "gmail", providerEmail: "private@example.com", providerId: "provider-private" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "source-a", subject: "A", latestReceivedAt: new Date("2026-08-23T12:00:00.000Z"), messageCount: 1, isRead: false },
        { id: "thread_b", accountId: "account_b", providerThreadId: "source-b", subject: "B", latestReceivedAt: new Date("2026-08-23T11:00:00.000Z"), messageCount: 1, isRead: true },
        { id: "thread_private", accountId: "account_private", providerThreadId: "source-private", subject: "Private", latestReceivedAt: new Date("2026-08-23T13:00:00.000Z"), messageCount: 1, isRead: false },
      ]).run();
      db.insert(emails).values([
        { id: "message_a", accountId: "account_a", threadId: "thread_a", providerMessageId: "message-source-a", subject: "A", receivedAt: new Date("2026-08-23T12:00:00.000Z") },
        { id: "message_b", accountId: "account_b", threadId: "thread_b", providerMessageId: "message-source-b", subject: "B", receivedAt: new Date("2026-08-23T11:00:00.000Z"), isRead: true },
        { id: "message_private", accountId: "account_private", threadId: "thread_private", providerMessageId: "message-source-private", subject: "Private", receivedAt: new Date("2026-08-23T13:00:00.000Z") },
      ]).run();
      const session = await createSession(db, "workspace_owner");
      const headers = { cookie: `orca_session=${session.token}` };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });

      const describeResponse = await app.request("/v1/organization/describe", { headers });
      assert.equal(describeResponse.status, 200);
      const description = await describeResponse.json();
      assert.deepEqual(description.accountIds, ["account_a", "account_b"]);
      assert.equal(description.workspaceSchema.aggregate, "thread");
      assert.equal(description.capabilities.operations.simulate, false);
      assert.deepEqual(description.facetSupport.valueTypes, ["text", "number", "boolean", "datetime", "duration", "email", "domain", "enum"]);
      assert.deepEqual(description.facetSupport.workflowStateIndependentOf, ["lane", "subject_matter"]);
      assert.equal(description.laneConfiguration.lanes.length, 1);
      assert.equal(description.laneConfiguration.policies[0].providerDeletion, false);
      assert.equal(JSON.stringify(description).includes("gmail"), false);

      const workspaceResponse = await app.request("/v1/organization/query?attention=all", { headers });
      assert.equal(workspaceResponse.status, 200);
      const workspace = await workspaceResponse.json();
      assert.deepEqual(workspace.threads.map((thread: { id: string }) => thread.id), ["thread_a", "thread_b"]);
      assert.ok(workspace.threads.every((thread: { organization: { lanePlacement: { primaryLaneId: string } } }) => thread.organization.lanePlacement.primaryLaneId === description.laneConfiguration.fallbackLaneId));
      assert.equal(JSON.stringify(workspace).includes("Private"), false);

      const policyId = "0e969841-acde-4a91-acde-491000000001";
      const laneId = "0e969841-acde-4a91-acde-491000000002";
      const createLane = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000003", idempotencyKey: "routes:create-lane", expectedWorkspaceRevision: 1,
        actions: [
          { kind: "define_lane_policy", id: policyId, visibility: "prominent", interruption: "notify", review: "continuous", retention: { mode: "keep", days: null } },
          { kind: "define_lane", id: laneId, name: "Human now", position: 1, defaultPolicyId: policyId },
        ],
      }) });
      const created = await createLane.json();
      assert.equal(createLane.status, 200, JSON.stringify(created));
      assert.equal(created.laneConfiguration.lanes.find((lane: { id: string }) => lane.id === laneId).name, "Human now");

      const override = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000004", idempotencyKey: "routes:override", expectedWorkspaceRevision: 2,
        actions: [{ kind: "set_thread_manual_override", accountId: "account_b", threadId: "thread_b", laneId, reason: "Human chose this Lane from the Thread reader.", expectedThreadRevision: 1 }],
      }) });
      const overridden = await override.json();
      assert.equal(override.status, 200, JSON.stringify(overridden));
      assert.equal(overridden.placements[0].primaryLaneId, laneId);
      assert.equal(overridden.placements[0].evidence.winningSource, "manual_override");
      assert.deepEqual(overridden.placements[0].evidence.actor, { id: "workspace_owner", type: "human" });

      const lock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000005", idempotencyKey: "routes:lock", expectedWorkspaceRevision: 3,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_b", threadId: "thread_b", locked: true, reason: "Protect the human decision.", expectedThreadRevision: 2 }],
      }) });
      const locked = await lock.json();
      assert.equal(lock.status, 200, JSON.stringify(locked));
      assert.equal(locked.placements[0].primaryLaneId, laneId);
      assert.deepEqual(locked.placements[0].evidence, {
        winningSource: "safety_lock",
        sourceId: laneId,
        precedenceLevel: "1_safety_lock",
        actor: { id: "workspace_owner", type: "human" },
        reason: "Protect the human decision.",
      });
      const storedManualLock = sqlite.query(`
        SELECT placement_source, actor_id, reason, safety_lock_actor_id, safety_lock_reason
        FROM organization_thread_lane_states
        WHERE workspace_id = 'workspace_owner' AND account_id = 'account_b' AND thread_id = 'thread_b'
      `).get() as Record<string, string>;
      assert.deepEqual(storedManualLock, {
        placement_source: "manual_override",
        actor_id: "workspace_owner",
        reason: "Human chose this Lane from the Thread reader.",
        safety_lock_actor_id: "workspace_owner",
        safety_lock_reason: "Protect the human decision.",
      });
      const blocked = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000006", idempotencyKey: "routes:blocked", expectedWorkspaceRevision: 4,
        actions: [{ kind: "set_thread_manual_override", accountId: "account_b", threadId: "thread_b", laneId: null, reason: "Attempted move.", expectedThreadRevision: 3 }],
      }) });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error.code, "safety_lock_denied");

      const accountResponse = await app.request("/v1/organization/query?accountId=account_b&attention=all", { headers });
      assert.equal(accountResponse.status, 200);
      const account = await accountResponse.json();
      assert.deepEqual(account.threads.map((thread: { id: string }) => thread.id), ["thread_b"]);
      assert.deepEqual(account.threads[0].organization.lanePlacement.evidence, locked.placements[0].evidence);

      const unlock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000007", idempotencyKey: "routes:unlock", expectedWorkspaceRevision: 4,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_b", threadId: "thread_b", locked: false, reason: "Human reviewed the protected decision.", expectedThreadRevision: 3 }],
      }) });
      const unlocked = await unlock.json();
      assert.equal(unlock.status, 200, JSON.stringify(unlocked));
      assert.equal(unlocked.placements[0].primaryLaneId, laneId);
      assert.deepEqual(unlocked.placements[0].evidence, {
        winningSource: "manual_override",
        sourceId: laneId,
        precedenceLevel: "2_manual_override",
        actor: { id: "workspace_owner", type: "human" },
        reason: "Human chose this Lane from the Thread reader.",
      });

      const fallbackLock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000008", idempotencyKey: "routes:lock-fallback", expectedWorkspaceRevision: 5,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: true, reason: "Keep this unresolved Thread in its current Lane.", expectedThreadRevision: 1 }],
      }) });
      const fallbackLocked = await fallbackLock.json();
      assert.equal(fallbackLock.status, 200, JSON.stringify(fallbackLocked));
      const storedFallbackLock = sqlite.query(`
        SELECT placement_source, source_id, actor_id, safety_lock_actor_id, safety_lock_reason
        FROM organization_thread_lane_states
        WHERE workspace_id = 'workspace_owner' AND account_id = 'account_a' AND thread_id = 'thread_a'
      `).get() as Record<string, string>;
      assert.deepEqual(storedFallbackLock, {
        placement_source: "workspace_fallback",
        source_id: description.laneConfiguration.fallbackLaneId,
        actor_id: "system:workspace-fallback",
        safety_lock_actor_id: "workspace_owner",
        safety_lock_reason: "Keep this unresolved Thread in its current Lane.",
      });
      const fallbackAccountResponse = await app.request("/v1/organization/query?accountId=account_a&attention=all", { headers });
      assert.equal(fallbackAccountResponse.status, 200);
      const fallbackAccount = await fallbackAccountResponse.json();
      assert.deepEqual(fallbackAccount.threads[0].organization.lanePlacement.evidence, {
        winningSource: "safety_lock",
        sourceId: description.laneConfiguration.fallbackLaneId,
        precedenceLevel: "1_safety_lock",
        actor: { id: "workspace_owner", type: "human" },
        reason: "Keep this unresolved Thread in its current Lane.",
      });

      const fallbackUnlock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000009", idempotencyKey: "routes:unlock-fallback", expectedWorkspaceRevision: 6,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: false, reason: "Release the unresolved Thread.", expectedThreadRevision: 2 }],
      }) });
      const fallbackUnlocked = await fallbackUnlock.json();
      assert.equal(fallbackUnlock.status, 200, JSON.stringify(fallbackUnlocked));
      assert.equal(fallbackUnlocked.placements[0].evidence.winningSource, "workspace_fallback");

      sqlite.query(`
        UPDATE organization_thread_lane_states
        SET placement_source = 'rule_revision', source_id = 'rule_revision_7', actor_id = 'agent_rule_engine', actor_type = 'agent',
            reason = 'Rule Revision 7 selected the retained Lane.'
        WHERE workspace_id = 'workspace_owner' AND account_id = 'account_a' AND thread_id = 'thread_a'
      `).run();
      const lowerSourceLock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000010", idempotencyKey: "routes:lock-rule-source", expectedWorkspaceRevision: 7,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: true, reason: "Protect the Rule-selected Lane.", expectedThreadRevision: 3 }],
      }) });
      const lowerSourceLocked = await lowerSourceLock.json();
      assert.equal(lowerSourceLock.status, 200, JSON.stringify(lowerSourceLocked));
      assert.equal(lowerSourceLocked.placements[0].evidence.winningSource, "safety_lock");
      const storedLowerSourceLock = sqlite.query(`
        SELECT placement_source, source_id, actor_id, actor_type, reason
        FROM organization_thread_lane_states
        WHERE workspace_id = 'workspace_owner' AND account_id = 'account_a' AND thread_id = 'thread_a'
      `).get() as Record<string, string>;
      assert.deepEqual(storedLowerSourceLock, {
        placement_source: "rule_revision",
        source_id: "rule_revision_7",
        actor_id: "agent_rule_engine",
        actor_type: "agent",
        reason: "Rule Revision 7 selected the retained Lane.",
      });

      const lowerSourceUnlock = await app.request("/v1/organization/apply", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        id: "0e969841-acde-4a91-acde-491000000011", idempotencyKey: "routes:unlock-rule-source", expectedWorkspaceRevision: 8,
        actions: [{ kind: "set_thread_safety_lock", accountId: "account_a", threadId: "thread_a", locked: false, reason: "Release the Rule-selected Lane.", expectedThreadRevision: 4 }],
      }) });
      const lowerSourceUnlocked = await lowerSourceUnlock.json();
      assert.equal(lowerSourceUnlock.status, 200, JSON.stringify(lowerSourceUnlocked));
      assert.deepEqual(lowerSourceUnlocked.placements[0].evidence, {
        winningSource: "rule_revision",
        sourceId: "rule_revision_7",
        precedenceLevel: "3_rule_revision",
        actor: { id: "agent_rule_engine", type: "agent" },
        reason: "Rule Revision 7 selected the retained Lane.",
      });

      const denied = await app.request("/v1/organization/query?accountId=account_private&attention=all", { headers });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: { code: "account_denied", message: "The requested Account scope is not authorized" } });
    } finally {
      sqlite.close();
    }
  });

  test("requires authentication and keeps simulate/revert routes disabled", async () => {
    assert.equal((await createApp().request("/v1/organization/describe")).status, 401);

    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-organization-disabled-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    try {
      db.insert(users).values({ id: "workspace_owner", email: "owner@example.com" }).run();
      const session = await createSession(db, "workspace_owner");
      const headers = { cookie: `orca_session=${session.token}` };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });
      for (const operation of ["simulate", "revert"]) {
        const response = await app.request(`/v1/organization/${operation}`, { method: "POST", headers });
        assert.equal(response.status, 405);
        assert.deepEqual(await response.json(), { error: { code: "operation_disabled", message: `Organization ${operation} is disabled in this read-only slice` } });
      }
    } finally {
      sqlite.close();
    }
  });
});
