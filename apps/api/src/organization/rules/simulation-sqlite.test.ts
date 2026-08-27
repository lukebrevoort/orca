import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { createApp } from "../../index.ts";
import {
  emails,
  collectionThreads,
  collections,
  mcpConnections,
  mcpOAuthClients,
  mcpOrganizationApprovals,
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationContexts,
  organizationContextRelationshipTypes,
  organizationContextTypes,
  organizationFacets,
  organizationLanePolicies,
  organizationLanes,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
  organizationThreadFacetValues,
  organizationThreadContextRelationships,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
  threads,
  users,
} from "../../db/schema.ts";
import { persistGmailMessages } from "../../providers/gmail/sync.ts";
import { createOrganization } from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { createRuleRevisionService } from "./service.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { createHistoricalRuleSimulationService } from "./simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./simulation-sqlite.ts";
import {
  bre317ActionSupport,
  createSqliteRuleChangeSetService,
  sqliteRuleChangeSetCapabilitySource,
  type RuleChangeSetCapabilitySource,
} from "./change-set-sqlite.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];
const replayCapabilityStates = sqliteTable("g2_replay_capability_state", {
  workspaceId: text("workspace_id").primaryKey(),
  revoked: integer("revoked").notNull(),
});

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

function message(): GmailMessage {
  return {
    id: "provider-message-production-failure",
    threadId: "provider-thread-production-failure",
    internalDate: "1787745600000",
    labelIds: ["INBOX"],
    snippet: "Production checkout failed",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Deploys <alerts@vercel.com>" },
        { name: "To", value: "Owner <owner@example.com>" },
        { name: "Subject", value: "Production checkout failed" },
      ],
      body: { data: Buffer.from("Production checkout failed").toString("base64url") },
    },
  };
}

async function setup(actionSource = `action route lane "Focus"
action set facet "Severity" = "Critical"
action notify immediate`) {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-317-simulation-"));
  directories.push(directory);
  const path = join(directory, "simulation.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: migrations });
  const now = new Date("2026-08-26T12:00:00.000Z");
  client.db.insert(users).values({ id: "workspace-1", email: "owner@example.com" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account-1", userId: "workspace-1", provider: "gmail",
    providerEmail: "owner@example.com", providerId: "provider-owner",
  }).run();
  client.db.insert(organizationLanePolicies).values({
    workspaceId: "workspace-1", id: "policy-focus", visibility: "prominent", interruption: "notify", review: "continuous",
    retentionMode: "keep", retentionDays: null, providerDeletion: false, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationLanes).values({
    workspaceId: "workspace-1", id: "lane-focus", name: "Focus", position: 1,
    defaultPolicyId: "policy-focus", revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationFacets).values({
    workspaceId: "workspace-1", id: "facet-severity", name: "Severity", position: 0,
    valueType: JSON.stringify({ kind: "enum", options: [{ id: "critical", label: "Critical", position: 0, retiredAt: null }] }),
    cardinality: JSON.stringify({ kind: "single" }), isOptional: true, defaultValue: null,
    retiredAt: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationWorkflowStates).values({
    workspaceId: "workspace-1", id: "state-review", name: "Needs review", position: 0,
    retiredAt: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(collections).values({
    id: "collection-launch", accountId: "account-1", name: "Launch", color: "#336699",
    position: 0, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationContextTypes).values({
    workspaceId: "workspace-1", id: "context-type-project", name: "Project", position: 0,
    retiredAt: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationContextRelationshipTypes).values({
    workspaceId: "workspace-1", id: "relationship-project", contextTypeId: "context-type-project",
    name: "belongs to", inverseName: "contains", direction: "thread_to_context", position: 0,
    maximumPerThread: 20, retiredAt: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationContexts).values({
    workspaceId: "workspace-1", id: "context-orca", contextTypeId: "context-type-project",
    name: "Orca", retiredAt: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();

  const rules = createRuleRevisionService(createSqliteRuleRevisionRepository(client.db), {
    now: () => now,
    id: (() => { let value = 0; return () => `bre-317-id-${++value}`; })(),
  });
  const compiled = rules.compile({
    actor: { id: "workspace-1", type: "human" },
    workspaceId: "workspace-1",
    request: {
      idempotencyKey: "compile-production-failure",
      expectedRuleRevision: null,
      workspaceSchemaRevision: 1,
      source: `orca 1
rule "Production failures"
event message.received
when subject contains "failed"
${actionSource}
because "A production failure needs a human"`,
    },
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error("Rule compilation failed");

  await persistGmailMessages(client.db, {
    accountId: "account-1",
    accountEmail: "owner@example.com",
    gmailMessages: [message()],
    labelList: [],
    now,
    propagationTrigger: "sync",
  });
  const storedEmail = client.db.select().from(emails).where(eq(emails.providerMessageId, message().id)).get()!;
  return { ...client, path, compiled, threadId: storedEmail.threadId };
}

function snapshot(db: Awaited<ReturnType<typeof setup>>["db"]) {
  const tables = {
    users, oauthAccounts, threads, emails, organizationWorkspaceStates,
    organizationRules, organizationRuleRevisions, organizationRuleSets, organizationChangeSets, organizationChangeActions,
    organizationThreadLaneStates, organizationThreadFacetValues, organizationThreadWorkflowStates,
    collectionThreads, organizationThreadContextRelationships, organizationThreadStates,
  };
  return Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, {
    count: db.select({ count: sql<number>`count(*)` }).from(table).get()!.count,
    rows: db.select().from(table).all(),
  }]));
}

function validCapability(db: Awaited<ReturnType<typeof setup>>["db"]) {
  return sqliteRuleChangeSetCapabilitySource.load(db, { workspaceId: "workspace-1" })!.snapshot;
}

function prepareActivation(fixture: Awaited<ReturnType<typeof setup>>, idempotencyKey: string) {
  const actor = { id: "workspace-1", type: "human" as const };
  const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(fixture.db)).simulate({
    actor,
    workspaceId: "workspace-1",
    request: {
      ruleId: fixture.compiled.rule.id,
      revisionId: fixture.compiled.revision.id,
      workspaceSchemaRevision: fixture.compiled.revision.compiled.workspaceSchemaRevision,
      accountIds: ["account-1"],
      maximumThreads: 500,
    },
  });
  const ruleSet = fixture.db.select().from(organizationRuleSets)
    .where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
  return {
    actor,
    request: {
      ruleId: fixture.compiled.rule.id,
      revisionId: fixture.compiled.revision.id,
      simulationId: simulation.simulationId,
      accountIds: ["account-1"],
      maximumThreads: 500,
      expectedWorkspaceRevision: simulation.binding.workspaceRevision,
      expectedRuleRevision: fixture.compiled.rule.latestRevision,
      expectedRuleSetRevision: ruleSet.revision,
      idempotencyKey,
    },
  };
}

function installReplayCapabilityMarker(fixture: Awaited<ReturnType<typeof setup>>) {
  fixture.sqlite.exec(`
    CREATE TABLE g2_replay_capability_state (workspace_id TEXT PRIMARY KEY, revoked INTEGER NOT NULL);
    INSERT INTO g2_replay_capability_state (workspace_id, revoked) VALUES ('workspace-1', 0);
  `);
  const other = createDatabaseClient(fixture.path);
  const source = (revokeAfterFirstLoad: boolean): RuleChangeSetCapabilitySource => {
    let loads = 0;
    return {
      load(executor, input) {
        const row = executor.select({ revoked: replayCapabilityStates.revoked }).from(replayCapabilityStates)
          .where(eq(replayCapabilityStates.workspaceId, input.workspaceId)).get();
        const capability = sqliteRuleChangeSetCapabilitySource.load(executor, input);
        loads += 1;
        if (revokeAfterFirstLoad && loads === 1) {
          other.sqlite.exec("UPDATE g2_replay_capability_state SET revoked=1 WHERE workspace_id='workspace-1'");
        }
        return capability ? { ...capability, revokedAt: row?.revoked ? "2026-08-26T12:01:00.000Z" : null } : null;
      },
    };
  };
  return {
    other,
    source,
    revoke() { other.sqlite.exec("UPDATE g2_replay_capability_state SET revoked=1 WHERE workspace_id='workspace-1'"); },
  };
}

describe("BRE-317 SQLite historical Simulation adapter", () => {
  test("evaluates persisted historical mail and leaves every mail, projection, revision, and audit row unchanged", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const before = snapshot(db);
      const service = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));
      const result = service.simulate({
        actor: { id: "workspace-1", type: "human" },
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });

      const workspaceBefore = db.select().from(organizationWorkspaceStates).get()!;
      const laneBefore = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, threadId)).get()!;
      assert.equal(result.state, "simulated");
      assert.equal(result.binding.workspaceRevision, workspaceBefore.revision);
      assert.equal(result.counts.evaluatedThreads, 1);
      assert.equal(result.representativeThreads[0]?.threadId, threadId);
      assert.equal(result.laneChanges[0]?.fromLaneId, laneBefore.primaryLaneId);
      assert.equal(result.laneChanges[0]?.toLaneId, "lane-focus");
      assert.deepEqual(result.facetChanges, [{ facetId: "facet-severity", operation: "set", count: 1 }]);
      assert.deepEqual(snapshot(db), before);
    } finally {
      sqlite.close();
    }
  }, 15_000);
});

describe("BRE-317 atomic Rule activation", () => {
  test("rejects an arbitrary self-asserted Capability with zero writes", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const forgedCapability = {
        id: "attacker-self-asserted-capability",
        revision: 999,
        actor,
        scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
        operations: ["simulate", "apply", "revert"] as const,
        resourceFamilies: ["rule", "thread", "lane", "facet", "change_set", "trace", "audit"] as const,
        actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"] as const,
      };
      const before = snapshot(db);

      assert.throws(
        () => createSqliteRuleChangeSetService(db).activate({
          actor,
          capabilitySnapshot: forgedCapability,
          workspaceId: "workspace-1",
          request: {
            ruleId: compiled.rule.id,
            revisionId: compiled.revision.id,
            simulationId: simulation.simulationId,
            accountIds: ["account-1"],
            maximumThreads: 500,
            expectedWorkspaceRevision: simulation.binding.workspaceRevision,
            expectedRuleRevision: compiled.rule.latestRevision,
            expectedRuleSetRevision: ruleSet.revision,
            idempotencyKey: "activate-forged-capability",
          },
        }),
        /Capability snapshot is not the current live revision/,
      );
      assert.deepEqual(snapshot(db), before);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("denies stale, revoked, missing, and mis-scoped live authority with zero writes", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor, workspaceId: "workspace-1", request: {
          ruleId: compiled.rule.id, revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"], maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const request = {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision, expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "authority-variant",
      };
      const live = validCapability(db);
      const variants = [
        ["stale revision", { ...live, revision: live.revision + 1 }],
        ["wrong Actor", { ...live, actor: { id: "attacker", type: "human" as const } }],
        ["wrong audience", { ...live, actor: { id: live.actor.id, type: "agent" as const } }],
        ["wrong Workspace", { ...live, scope: { ...live.scope, workspaceId: "workspace-2" } }],
        ["wrong Account", { ...live, scope: { ...live.scope, accountIds: ["account-2"] } }],
        ["wrong operation", { ...live, operations: ["simulate", "revert"] as const }],
        ["wrong resource scope", { ...live, resourceFamilies: live.resourceFamilies.filter((family) => family !== "rule") }],
        ["wrong action/risk scope", { ...live, actionFamilies: live.actionFamilies.filter((family) => family !== "organization_thread") }],
      ] as const;
      for (const [name, capabilitySnapshot] of variants) {
        const before = snapshot(db);
        assert.throws(
          () => createSqliteRuleChangeSetService(db).activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: { ...request, idempotencyKey: `deny-${name}` } }),
          /different Actor identity or type|Capability snapshot is not the current live revision/,
          name,
        );
        assert.deepEqual(snapshot(db), before, `${name} denial must write nothing`);
      }

      for (const [name, capabilitySource, expected] of [
        ["revoked", { load: () => ({ snapshot: live, revokedAt: "2026-08-26T12:00:00.000Z" }) }, /live Capability has been revoked/],
        ["missing", { load: () => null }, /No current live Capability/],
      ] as const) {
        const before = snapshot(db);
        assert.throws(
          () => createSqliteRuleChangeSetService(db, { capabilitySource }).activate({ actor, capabilitySnapshot: live, workspaceId: "workspace-1", request: { ...request, idempotencyKey: `deny-${name}` } }),
          expected,
        );
        assert.deepEqual(snapshot(db), before, `${name} denial must write nothing`);
      }

      let resolutions = 0;
      const beforeRace = snapshot(db);
      assert.throws(
        () => createSqliteRuleChangeSetService(db, {
          capabilitySource: { load: () => ++resolutions === 1 ? { snapshot: live, revokedAt: null } : { snapshot: live, revokedAt: "2026-08-26T12:00:01.000Z" } },
        }).activate({ actor, capabilitySnapshot: live, workspaceId: "workspace-1", request: { ...request, idempotencyKey: "deny-revoked-during-commit" } }),
        /live Capability has been revoked/,
      );
      assert.equal(resolutions, 2, "live authority is resolved again inside the SQLite transaction");
      assert.deepEqual(snapshot(db), beforeRace, "transaction-side revocation must roll back every write");
    } finally { sqlite.close(); }
  }, 30_000);

  test("projects a winning Workflow State action and increments the Thread revision", async () => {
    const { db, sqlite, compiled, threadId } = await setup(`action set workflow "Needs review"`);
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      assert.equal(simulation.counts.affectedThreads, 1);
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;

      const service = createSqliteRuleChangeSetService(db, {
        id: (() => { let value = 0; return () => `workflow-change-${++value}`; })(),
      });
      const activationRequest = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulation.simulationId,
        accountIds: ["account-1"],
        maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-workflow-state",
      };
      const applied = service.activate({
        actor,
        capabilitySnapshot: validCapability(db),
        workspaceId: "workspace-1",
        request: activationRequest,
      });

      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, threadId)).get()?.stateId, "state-review");
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 2);
      const applyActions = db.select().from(organizationChangeActions).where(eq(organizationChangeActions.changeId, applied.changeSetId)).all();
      assert.deepEqual(applyActions.map(({ position, actionKind }) => ({ position, actionKind })), [
        { position: 0, actionKind: "activate_rule_revision" },
        { position: 1, actionKind: "set_workflow_state" },
      ]);
      const inverse = JSON.parse(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()!.inverseJson);
      assert.deepEqual(inverse.threads[0].beforeWorkflow, null);
      assert.deepEqual(inverse.threads[0].beforeCollections, []);
      assert.deepEqual(inverse.threads[0].beforeContexts, []);

      const afterApply = snapshot(db);
      assert.deepEqual(service.activate({ actor, capabilitySnapshot: validCapability(db), workspaceId: "workspace-1", request: activationRequest }), applied);
      assert.deepEqual(snapshot(db), afterApply);

      const reverted = service.revert({
        actor,
        capabilitySnapshot: validCapability(db),
        workspaceId: "workspace-1",
        request: {
          changeSetId: applied.changeSetId,
          accountIds: ["account-1"],
          expectedWorkspaceRevision: applied.workspaceRevisionAfter,
          idempotencyKey: "revert-workflow-state",
        },
      });
      assert.equal(reverted.status, "reverted");
      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, threadId)).get(), undefined);
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 3);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("projects Collection and Context winners in evaluator order and compensates them", async () => {
    const { db, sqlite, compiled, threadId } = await setup(`action set workflow "Needs review"
action add collection "Launch"
action link context "Project" "Orca"`);
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor, workspaceId: "workspace-1", request: {
          ruleId: compiled.rule.id, revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"], maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db, { id: (() => { let value = 0; return () => `complete-change-${++value}`; })() });
      const applied = service.activate({ actor, capabilitySnapshot: validCapability(db), workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision, expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-complete-projections",
      } });

      assert.ok(db.select().from(collectionThreads).where(and(eq(collectionThreads.collectionId, "collection-launch"), eq(collectionThreads.threadId, threadId))).get());
      assert.ok(db.select().from(organizationThreadContextRelationships).where(and(
        eq(organizationThreadContextRelationships.contextId, "context-orca"), eq(organizationThreadContextRelationships.threadId, threadId),
      )).get());
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 2);
      const actions = db.select().from(organizationChangeActions).where(eq(organizationChangeActions.changeId, applied.changeSetId)).all();
      assert.deepEqual(actions.map(({ position, actionKind }) => ({ position, actionKind })), [
        { position: 0, actionKind: "activate_rule_revision" },
        { position: 1, actionKind: "set_workflow_state" },
        { position: 2, actionKind: "add_collection" },
        { position: 3, actionKind: "link_context" },
      ]);
      const inverse = JSON.parse(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()!.inverseJson);
      assert.deepEqual(inverse.threads[0].beforeCollections, [{ collectionId: "collection-launch", membership: null }]);
      assert.deepEqual(inverse.threads[0].beforeContexts, [{ contextTypeId: "context-type-project", contextId: "context-orca", relationship: null }]);

      service.revert({ actor, capabilitySnapshot: validCapability(db), workspaceId: "workspace-1", request: {
        changeSetId: applied.changeSetId, accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter, idempotencyKey: "revert-complete-projections",
      } });
      assert.equal(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, threadId)).get(), undefined);
      assert.equal(db.select().from(organizationThreadContextRelationships).where(eq(organizationThreadContextRelationships.threadId, threadId)).get(), undefined);
      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, threadId)).get(), undefined);
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 3);
    } finally { sqlite.close(); }
  }, 15_000);

  test("keeps the BRE-317 planner exhaustive over every production evaluator Action kind", () => {
    assert.deepEqual(Object.keys(bre317ActionSupport).sort(), [
      "add_collection", "link_context", "notify", "propose_provider_deletion", "propose_retention",
      "remove_collection", "route_lane", "schedule_review", "set_facet", "set_workflow_state",
      "suppress_interruption", "unlink_context", "unset_facet",
    ]);
    assert.deepEqual(Object.entries(bre317ActionSupport).filter(([, support]) => support === "projected").map(([kind]) => kind).sort(), [
      "add_collection", "link_context", "remove_collection", "route_lane", "set_facet",
      "set_workflow_state", "unlink_context", "unset_facet",
    ]);
  });

  test("applies one exact successful Simulation atomically and replays the same idempotency key", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const simulationService = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));
      const simulationRequest = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account-1"],
        maximumThreads: 500,
      };
      const simulation = simulationService.simulate({ actor, workspaceId: "workspace-1", request: simulationRequest });
      assert.equal(simulation.state, "simulated");
      const ruleSetBefore = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const capabilitySnapshot = validCapability(db);
      const request = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulation.simulationId,
        accountIds: ["account-1"],
        maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSetBefore.revision,
        idempotencyKey: "activate-production-failure-r1",
      };
      const service = createSqliteRuleChangeSetService(db);
      const applied = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request });

      assert.equal(applied.status, "active");
      assert.equal(applied.operation, "apply");
      assert.equal(applied.risk, "medium");
      assert.equal(applied.workspaceRevisionBefore, simulation.binding.workspaceRevision);
      assert.equal(applied.workspaceRevisionAfter, simulation.binding.workspaceRevision + 1);
      assert.equal(applied.ruleSetRevisionAfter, ruleSetBefore.revision + 1);
      assert.equal(applied.traceCount, 1);
      assert.equal(db.select().from(organizationRules).where(eq(organizationRules.id, compiled.rule.id)).get()?.activeRevisionId, compiled.revision.id);
      assert.equal(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, threadId)).get()?.primaryLaneId, "lane-focus");
      assert.equal(db.select().from(organizationThreadFacetValues).where(eq(organizationThreadFacetValues.threadId, threadId)).get()?.value, JSON.stringify("critical"));
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 2);

      const afterApply = snapshot(db);
      const replay = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request });
      assert.deepEqual(replay, applied);
      assert.deepEqual(snapshot(db), afterApply);

      const stored = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()!;
      assert.equal(stored.operation, "apply");
      assert.equal(stored.resourceFamily, "rule");
      assert.equal(stored.workspaceRevisionAfter, applied.workspaceRevisionAfter);
      assert.equal(db.select({ count: sql<number>`count(*)` }).from(organizationChangeActions).where(eq(organizationChangeActions.changeId, applied.changeSetId)).get()?.count, 3);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("denies an exact activation replay when the authoritative Capability was removed after commit", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const request = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulation.simulationId,
        accountIds: ["account-1"],
        maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-before-capability-removal",
      };
      const applied = createSqliteRuleChangeSetService(db).activate({
        actor,
        capabilitySnapshot,
        workspaceId: "workspace-1",
        request,
      });
      assert.equal(applied.status, "active");
      const beforeReplay = snapshot(db);

      assert.throws(
        () => createSqliteRuleChangeSetService(db, { capabilitySource: { load: () => null } }).activate({
          actor,
          capabilitySnapshot,
          workspaceId: "workspace-1",
          request,
        }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "capability_missing",
      );
      assert.deepEqual(snapshot(db), beforeReplay);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("revalidates every activation replay Capability dimension before returning stored lifecycle evidence", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const request = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulation.simulationId,
        accountIds: ["account-1"],
        maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-replay-authority-matrix",
      };
      const applied = createSqliteRuleChangeSetService(db).activate({
        actor,
        capabilitySnapshot,
        workspaceId: "workspace-1",
        request,
      });
      const afterApply = snapshot(db);

      assert.deepEqual(createSqliteRuleChangeSetService(db).activate({
        actor, capabilitySnapshot, workspaceId: "workspace-1", request,
      }), applied);
      assert.deepEqual(snapshot(db), afterApply, "an authorized exact replay must remain write-free");

      const wrongActor = { ...capabilitySnapshot, actor: { id: "attacker", type: "human" as const } };
      const wrongAudience = { ...capabilitySnapshot, actor: { id: actor.id, type: "agent" as const } };
      const wrongWorkspace = { ...capabilitySnapshot, scope: { ...capabilitySnapshot.scope, workspaceId: "workspace-2" } };
      const wrongAccount = { ...capabilitySnapshot, scope: { ...capabilitySnapshot.scope, accountIds: ["account-2"] } };
      const wrongOperation = { ...capabilitySnapshot, operations: capabilitySnapshot.operations.filter((operation) => operation !== "apply") };
      const wrongResource = { ...capabilitySnapshot, resourceFamilies: capabilitySnapshot.resourceFamilies.filter((family) => family !== "rule") };
      const wrongActionRisk = { ...capabilitySnapshot, actionFamilies: capabilitySnapshot.actionFamilies.filter((family) => family !== "organization_structure") };
      const variants = [
        ["revoked", capabilitySnapshot, { snapshot: capabilitySnapshot, revokedAt: "2026-08-26T12:00:00.000Z" }, "capability_revoked"],
        ["stale", capabilitySnapshot, { snapshot: { ...capabilitySnapshot, revision: capabilitySnapshot.revision + 1 }, revokedAt: null }, "capability_stale"],
        ["wrong Actor", wrongActor, { snapshot: wrongActor, revokedAt: null }, "actor_mismatch"],
        ["wrong audience", wrongAudience, { snapshot: wrongAudience, revokedAt: null }, "actor_mismatch"],
        ["wrong Workspace", wrongWorkspace, { snapshot: wrongWorkspace, revokedAt: null }, "workspace_denied"],
        ["wrong Account", wrongAccount, { snapshot: wrongAccount, revokedAt: null }, "account_denied"],
        ["wrong operation", wrongOperation, { snapshot: wrongOperation, revokedAt: null }, "missing_operation_capability"],
        ["wrong resource scope", wrongResource, { snapshot: wrongResource, revokedAt: null }, "resource_family_denied"],
        ["wrong action/risk scope", wrongActionRisk, { snapshot: wrongActionRisk, revokedAt: null }, "action_family_denied"],
      ] as const;
      for (const [name, claimed, live, code] of variants) {
        assert.throws(
          () => createSqliteRuleChangeSetService(db, { capabilitySource: { load: () => live } }).activate({
            actor, capabilitySnapshot: claimed, workspaceId: "workspace-1", request,
          }),
          (error: unknown) => error instanceof Error && "code" in error && error.code === code,
          name,
        );
        assert.deepEqual(snapshot(db), afterApply, `${name} replay denial must write nothing`);
      }

      const collidingRequest = { ...request, maximumThreads: request.maximumThreads - 1 };
      assert.throws(
        () => createSqliteRuleChangeSetService(db).activate({
          actor, capabilitySnapshot, workspaceId: "workspace-1", request: collidingRequest,
        }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "duplicate_idempotency_key",
      );
      assert.throws(
        () => createSqliteRuleChangeSetService(db, {
          capabilitySource: { load: () => ({ snapshot: capabilitySnapshot, revokedAt: "2026-08-26T12:00:00.000Z" }) },
        }).activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: collidingRequest }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "capability_revoked",
      );
      assert.throws(
        () => createSqliteRuleChangeSetService(db).revert({
          actor,
          capabilitySnapshot,
          workspaceId: "workspace-1",
          request: {
            changeSetId: applied.changeSetId,
            accountIds: ["account-1"],
            expectedWorkspaceRevision: applied.workspaceRevisionAfter,
            idempotencyKey: request.idempotencyKey,
          },
        }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "duplicate_idempotency_key",
      );
      assert.deepEqual(snapshot(db), afterApply, "activation command collisions must remain write-free and fail closed on authority");

      const storedApply = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()!;
      const legacyApplyEnvelope = JSON.parse(storedApply.commandJson);
      delete legacyApplyEnvelope.command;
      db.update(organizationChangeSets).set({ commandJson: JSON.stringify(legacyApplyEnvelope) })
        .where(eq(organizationChangeSets.id, applied.changeSetId)).run();
      const legacyApplySnapshot = snapshot(db);
      assert.deepEqual(createSqliteRuleChangeSetService(db).activate({
        actor, capabilitySnapshot, workspaceId: "workspace-1", request,
      }), applied);
      assert.deepEqual(snapshot(db), legacyApplySnapshot, "pre-fix activation evidence must replay without writes");
    } finally {
      sqlite.close();
    }
  }, 30_000);

  test("fails with zero writes for stale binding, authority denial, Account isolation, and a mid-transaction SQLite abort", async () => {
    for (const failure of ["stale", "authority", "account", "rollback"] as const) {
      const { db, sqlite, compiled } = await setup();
      try {
        const actor = { id: "workspace-1", type: "human" as const };
        const simulationService = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));
        const simulation = simulationService.simulate({
          actor,
          workspaceId: "workspace-1",
          request: {
            ruleId: compiled.rule.id,
            revisionId: compiled.revision.id,
            workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
            accountIds: ["account-1"],
            maximumThreads: 500,
          },
        });
        const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
        const capabilitySnapshot = failure === "authority"
          ? { ...validCapability(db), actionFamilies: ["organization_read", "organization_structure"] as const }
          : validCapability(db);
        const request = {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          simulationId: failure === "stale" ? `sha256:${"0".repeat(64)}` : simulation.simulationId,
          accountIds: failure === "account" ? ["account-not-owned"] : ["account-1"],
          maximumThreads: 500,
          expectedWorkspaceRevision: simulation.binding.workspaceRevision,
          expectedRuleRevision: compiled.rule.latestRevision,
          expectedRuleSetRevision: ruleSet.revision,
          idempotencyKey: `activate-failure-${failure}`,
        };
        if (failure === "rollback") {
          sqlite.run(`CREATE TRIGGER bre317_abort_facet BEFORE INSERT ON organization_thread_facet_values BEGIN SELECT RAISE(ABORT, 'injected BRE-317 facet failure'); END`);
        }
        const before = snapshot(db);
        const service = createSqliteRuleChangeSetService(db, { id: () => `change-failure-${failure}` });
        assert.throws(
          () => service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request }),
          failure === "authority" ? /Capability snapshot is not the current live revision/
            : failure === "account" ? /Account scope is not owned/
              : failure === "rollback" ? /injected BRE-317 facet failure/
                : /exact current successful Simulation/,
        );
        assert.deepEqual(snapshot(db), before, `${failure} must not partially mutate Rule, Thread, Workspace, or audit state`);
      } finally {
        sqlite.close();
      }
    }
  }, 30_000);

  test("rolls back a forced Workflow projection failure and rejects an unsupported future winner before writes", async () => {
    for (const failure of ["workflow_rollback", "unsupported_action"] as const) {
      const { db, sqlite, compiled } = await setup(`action set workflow "Needs review"`);
      try {
        const actor = { id: "workspace-1", type: "human" as const };
        const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({ actor, workspaceId: "workspace-1", request: {
          ruleId: compiled.rule.id, revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"], maximumThreads: 500,
        } });
        const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
        if (failure === "workflow_rollback") {
          sqlite.run(`CREATE TRIGGER bre317_abort_workflow BEFORE INSERT ON organization_thread_workflow_states BEGIN SELECT RAISE(ABORT, 'injected BRE-317 workflow failure'); END`);
        } else {
          const row = db.select().from(organizationRuleRevisions).where(eq(organizationRuleRevisions.id, compiled.revision.id)).get()!;
          const tampered = JSON.parse(row.compiledJson);
          tampered.actions = [{ kind: "future_projection_action", targetId: "silently-dropped" }];
          sqlite.run(`DROP TRIGGER organization_rule_revisions_no_update`);
          db.update(organizationRuleRevisions).set({ compiledJson: JSON.stringify(tampered) }).where(eq(organizationRuleRevisions.id, compiled.revision.id)).run();
        }
        const before = snapshot(db);
        assert.throws(
          () => createSqliteRuleChangeSetService(db).activate({ actor, capabilitySnapshot: validCapability(db), workspaceId: "workspace-1", request: {
            ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
            accountIds: ["account-1"], maximumThreads: 500,
            expectedWorkspaceRevision: simulation.binding.workspaceRevision,
            expectedRuleRevision: compiled.rule.latestRevision, expectedRuleSetRevision: ruleSet.revision,
            idempotencyKey: `activate-${failure}`,
          } }),
          failure === "workflow_rollback" ? /injected BRE-317 workflow failure/ : /Invalid input|future_projection_action/,
        );
        assert.deepEqual(snapshot(db), before, `${failure} must preserve all projections, revisions, and audit rows`);
      } finally { sqlite.close(); }
    }
  }, 15_000);

  test("reports a newer Thread revision conflict instead of compensating Workflow state", async () => {
    const { db, sqlite, compiled, threadId } = await setup(`action set workflow "Needs review"`);
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({ actor, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account-1"], maximumThreads: 500,
      } });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db, { id: () => "workflow-conflict" });
      const applied = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision, expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "workflow-conflict-apply",
      } });
      db.update(organizationThreadStates).set({ revision: 3 }).where(eq(organizationThreadStates.threadId, threadId)).run();
      const before = snapshot(db);
      assert.throws(
        () => service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
          changeSetId: applied.changeSetId, accountIds: ["account-1"],
          expectedWorkspaceRevision: applied.workspaceRevisionAfter, idempotencyKey: "workflow-conflict-revert",
        } }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "compensation_conflict",
      );
      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, threadId)).get()?.stateId, "state-review");
      assert.deepEqual(snapshot(db), before);
    } finally { sqlite.close(); }
  }, 15_000);
});

describe("BRE-317 compensating Rule Change Set revert", () => {
  test("rejects forged and transaction-revoked revert authority with zero writes", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({ actor, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account-1"], maximumThreads: 500,
      } });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const applied = createSqliteRuleChangeSetService(db, { id: () => "authority-apply" }).activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision, expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "authority-apply",
      } });
      const request = {
        changeSetId: applied.changeSetId, accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter, idempotencyKey: "forged-revert",
      };
      const beforeForged = snapshot(db);
      assert.throws(
        () => createSqliteRuleChangeSetService(db).revert({
          actor, capabilitySnapshot: { ...capabilitySnapshot, id: "attacker-self-asserted-capability", revision: 999 },
          workspaceId: "workspace-1", request,
        }),
        /Capability snapshot is not the current live revision/,
      );
      assert.deepEqual(snapshot(db), beforeForged);

      let resolutions = 0;
      const beforeRace = snapshot(db);
      assert.throws(
        () => createSqliteRuleChangeSetService(db, {
          capabilitySource: { load: () => ++resolutions === 1 ? { snapshot: capabilitySnapshot, revokedAt: null } : null },
        }).revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: { ...request, idempotencyKey: "revoked-during-revert" } }),
        /No current live Capability/,
      );
      assert.equal(resolutions, 2);
      assert.deepEqual(snapshot(db), beforeRace);
    } finally { sqlite.close(); }
  }, 15_000);

  test("appends an idempotent compensating Change Set and restores projections without erasing audit history", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulationService = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));
      const simulation = simulationService.simulate({ actor, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account-1"], maximumThreads: 500,
      } });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const originalLaneId = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, threadId)).get()!.primaryLaneId;
      const service = createSqliteRuleChangeSetService(db, {
        id: (() => { let value = 0; return () => `change-bre-317-${++value}`; })(),
        now: (() => { let value = 0; return () => new Date(1787745600000 + value++ * 1000); })(),
      });
      const applied = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-before-revert",
      } });
      const countAfterApply = db.select({ count: sql<number>`count(*)` }).from(organizationChangeSets).get()!.count;

      const revertRequest = {
        changeSetId: applied.changeSetId,
        accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter,
        idempotencyKey: "revert-production-failure",
      };
      const reverted = service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: revertRequest });

      assert.equal(reverted.status, "reverted");
      assert.equal(reverted.operation, "revert");
      assert.equal(reverted.revertsChangeSetId, applied.changeSetId);
      assert.equal(reverted.workspaceRevisionBefore, applied.workspaceRevisionAfter);
      assert.equal(reverted.workspaceRevisionAfter, applied.workspaceRevisionAfter + 1);
      assert.equal(db.select().from(organizationRules).where(eq(organizationRules.id, compiled.rule.id)).get()?.activeRevisionId, null);
      assert.equal(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, threadId)).get()?.primaryLaneId, originalLaneId);
      assert.equal(db.select().from(organizationThreadFacetValues).where(eq(organizationThreadFacetValues.threadId, threadId)).get(), undefined);
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, threadId)).get()?.revision, 3);
      assert.equal(db.select({ count: sql<number>`count(*)` }).from(organizationChangeSets).get()!.count, countAfterApply + 1);
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()?.status, "reverted");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, reverted.changeSetId)).get()?.revertsChangeId, applied.changeSetId);

      const afterRevert = snapshot(db);
      assert.deepEqual(service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: revertRequest }), reverted);
      assert.deepEqual(snapshot(db), afterRevert);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("revalidates every revert replay Capability dimension before returning stored lifecycle evidence", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db);
      const applied = service.activate({
        actor,
        capabilitySnapshot,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          simulationId: simulation.simulationId,
          accountIds: ["account-1"],
          maximumThreads: 500,
          expectedWorkspaceRevision: simulation.binding.workspaceRevision,
          expectedRuleRevision: compiled.rule.latestRevision,
          expectedRuleSetRevision: ruleSet.revision,
          idempotencyKey: "activate-before-revert-replay-matrix",
        },
      });
      const request = {
        changeSetId: applied.changeSetId,
        accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter,
        idempotencyKey: "revert-replay-authority-matrix",
      };
      const reverted = service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request });
      const afterRevert = snapshot(db);

      assert.deepEqual(service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request }), reverted);
      assert.deepEqual(snapshot(db), afterRevert, "an authorized exact revert replay must remain write-free");

      const wrongActor = { ...capabilitySnapshot, actor: { id: "attacker", type: "human" as const } };
      const wrongAudience = { ...capabilitySnapshot, actor: { id: actor.id, type: "agent" as const } };
      const wrongWorkspace = { ...capabilitySnapshot, scope: { ...capabilitySnapshot.scope, workspaceId: "workspace-2" } };
      const wrongAccount = { ...capabilitySnapshot, scope: { ...capabilitySnapshot.scope, accountIds: ["account-2"] } };
      const wrongOperation = { ...capabilitySnapshot, operations: capabilitySnapshot.operations.filter((operation) => operation !== "revert") };
      const wrongResource = { ...capabilitySnapshot, resourceFamilies: capabilitySnapshot.resourceFamilies.filter((family) => family !== "rule") };
      const wrongActionRisk = { ...capabilitySnapshot, actionFamilies: capabilitySnapshot.actionFamilies.filter((family) => family !== "organization_structure") };
      const variants = [
        ["missing", capabilitySnapshot, null, "capability_missing"],
        ["revoked", capabilitySnapshot, { snapshot: capabilitySnapshot, revokedAt: "2026-08-26T12:00:00.000Z" }, "capability_revoked"],
        ["stale", capabilitySnapshot, { snapshot: { ...capabilitySnapshot, revision: capabilitySnapshot.revision + 1 }, revokedAt: null }, "capability_stale"],
        ["wrong Actor", wrongActor, { snapshot: wrongActor, revokedAt: null }, "actor_mismatch"],
        ["wrong audience", wrongAudience, { snapshot: wrongAudience, revokedAt: null }, "actor_mismatch"],
        ["wrong Workspace", wrongWorkspace, { snapshot: wrongWorkspace, revokedAt: null }, "workspace_denied"],
        ["wrong Account", wrongAccount, { snapshot: wrongAccount, revokedAt: null }, "account_denied"],
        ["wrong operation", wrongOperation, { snapshot: wrongOperation, revokedAt: null }, "missing_operation_capability"],
        ["wrong resource scope", wrongResource, { snapshot: wrongResource, revokedAt: null }, "resource_family_denied"],
        ["wrong action/risk scope", wrongActionRisk, { snapshot: wrongActionRisk, revokedAt: null }, "action_family_denied"],
      ] as const;
      for (const [name, claimed, live, code] of variants) {
        assert.throws(
          () => createSqliteRuleChangeSetService(db, { capabilitySource: { load: () => live } }).revert({
            actor, capabilitySnapshot: claimed, workspaceId: "workspace-1", request,
          }),
          (error: unknown) => error instanceof Error && "code" in error && error.code === code,
          name,
        );
        assert.deepEqual(snapshot(db), afterRevert, `${name} revert replay denial must write nothing`);
      }

      const collidingRequest = { ...request, changeSetId: "different-change-set" };
      assert.throws(
        () => createSqliteRuleChangeSetService(db).revert({
          actor, capabilitySnapshot, workspaceId: "workspace-1", request: collidingRequest,
        }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "duplicate_idempotency_key",
      );
      assert.throws(
        () => createSqliteRuleChangeSetService(db, {
          capabilitySource: { load: () => ({ snapshot: capabilitySnapshot, revokedAt: "2026-08-26T12:00:00.000Z" }) },
        }).revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: collidingRequest }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "capability_revoked",
      );
      assert.deepEqual(snapshot(db), afterRevert, "revert command collisions must remain write-free and fail closed on authority");

      const storedRevert = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, reverted.changeSetId)).get()!;
      const legacyRevertEnvelope = JSON.parse(storedRevert.commandJson);
      delete legacyRevertEnvelope.command;
      db.update(organizationChangeSets).set({ commandJson: JSON.stringify(legacyRevertEnvelope) })
        .where(eq(organizationChangeSets.id, reverted.changeSetId)).run();
      const legacyRevertSnapshot = snapshot(db);
      assert.deepEqual(createSqliteRuleChangeSetService(db).revert({
        actor, capabilitySnapshot, workspaceId: "workspace-1", request,
      }), reverted);
      assert.deepEqual(snapshot(db), legacyRevertSnapshot, "pre-fix revert evidence must replay without writes");
    } finally {
      sqlite.close();
    }
  }, 30_000);

  test("reverts pre-fix Lane and Facet Change Sets without disturbing projections absent from legacy evidence", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const seededAt = new Date("2026-08-26T12:00:01.000Z");
      db.insert(organizationThreadWorkflowStates).values({
        workspaceId: "workspace-1", accountId: "account-1", threadId,
        stateId: "state-review", updatedAt: seededAt,
      }).run();
      db.insert(collectionThreads).values({
        id: "legacy-membership", collectionId: "collection-launch", threadId, createdAt: seededAt,
      }).run();
      db.insert(organizationThreadContextRelationships).values({
        workspaceId: "workspace-1", id: "legacy-context", accountId: "account-1", threadId,
        contextTypeId: "context-type-project", contextId: "context-orca",
        relationshipTypeId: "relationship-project", direction: "thread_to_context",
        revision: 1, createdAt: seededAt, updatedAt: seededAt,
      }).run();
      db.update(organizationThreadStates).set({ revision: 2, updatedAt: seededAt })
        .where(eq(organizationThreadStates.threadId, threadId)).run();
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db, { id: (() => { let value = 0; return () => `legacy-change-${++value}`; })() });
      const applied = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulation.simulationId,
        accountIds: ["account-1"],
        maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-legacy-evidence",
      } });
      const stored = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, applied.changeSetId)).get()!;
      const legacyInverse = JSON.parse(stored.inverseJson) as { threads: Array<Record<string, unknown>> };
      for (const thread of legacyInverse.threads) {
        delete thread.beforeWorkflow;
        delete thread.beforeCollections;
        delete thread.beforeContexts;
      }
      db.update(organizationChangeSets).set({ inverseJson: JSON.stringify(legacyInverse) })
        .where(eq(organizationChangeSets.id, applied.changeSetId)).run();

      const reverted = service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        changeSetId: applied.changeSetId,
        accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter,
        idempotencyKey: "revert-legacy-evidence",
      } });
      assert.equal(reverted.status, "reverted");
      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, threadId)).get()?.stateId, "state-review");
      assert.equal(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, threadId)).get()?.id, "legacy-membership");
      assert.equal(db.select().from(organizationThreadContextRelationships).where(eq(organizationThreadContextRelationships.threadId, threadId)).get()?.id, "legacy-context");
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("reports exact newer-state compensation conflicts and performs no partial revert", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulationService = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db));
      const simulation = simulationService.simulate({ actor, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account-1"], maximumThreads: 500,
      } });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db, { id: () => "change-conflict" });
      const applied = service.activate({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
        ruleId: compiled.rule.id, revisionId: compiled.revision.id, simulationId: simulation.simulationId,
        accountIds: ["account-1"], maximumThreads: 500,
        expectedWorkspaceRevision: simulation.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSet.revision,
        idempotencyKey: "activate-before-conflict",
      } });
      db.update(organizationThreadStates).set({ revision: 3 }).where(eq(organizationThreadStates.threadId, threadId)).run();
      const before = snapshot(db);

      assert.throws(
        () => service.revert({ actor, capabilitySnapshot, workspaceId: "workspace-1", request: {
          changeSetId: applied.changeSetId,
          accountIds: ["account-1"],
          expectedWorkspaceRevision: applied.workspaceRevisionAfter,
          idempotencyKey: "revert-conflicted",
        } }),
        (error: unknown) => error instanceof Error
          && "code" in error && error.code === "compensation_conflict"
          && "conflicts" in error && Array.isArray(error.conflicts)
          && error.conflicts.some((conflict) => conflict.resourceId === `thread:account-1:${threadId}` && conflict.expectedRevision === 2 && conflict.actualRevision === 3),
      );
      assert.deepEqual(snapshot(db), before);
    } finally {
      sqlite.close();
    }
  }, 15_000);

  test("preserves newer unrelated human intent while compensating only the original touched resources", async () => {
    const { db, sqlite, compiled } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = validCapability(db);
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).simulate({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        },
      });
      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const service = createSqliteRuleChangeSetService(db, {
        id: (() => { let value = 0; return () => `g2-unrelated-${++value}`; })(),
      });
      const applied = service.activate({
        actor,
        capabilitySnapshot,
        workspaceId: "workspace-1",
        request: {
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          simulationId: simulation.simulationId,
          accountIds: ["account-1"],
          maximumThreads: 500,
          expectedWorkspaceRevision: simulation.binding.workspaceRevision,
          expectedRuleRevision: compiled.rule.latestRevision,
          expectedRuleSetRevision: ruleSet.revision,
          idempotencyKey: "g2-activate-before-unrelated",
        },
      });

      const human = createOrganization(createSqliteOrganizationRepository(db));
      const unrelated = human.apply({
        scope: { actor, workspaceId: "workspace-1", accountIds: ["account-1"] },
        command: {
          id: "g2-unrelated-human-change",
          idempotencyKey: "g2-unrelated-human-change",
          expectedWorkspaceRevision: applied.workspaceRevisionAfter,
          actions: [{ kind: "define_workflow_state", id: "state-unrelated-human", name: "Human follow-up", position: 99 }],
        },
      });
      assert.equal(unrelated.workspaceRevision, applied.workspaceRevisionAfter + 1);

      const reverted = service.revert({
        actor,
        capabilitySnapshot,
        workspaceId: "workspace-1",
        request: {
          changeSetId: applied.changeSetId,
          accountIds: ["account-1"],
          expectedWorkspaceRevision: unrelated.workspaceRevision,
          idempotencyKey: "g2-revert-after-unrelated",
        },
      });
      assert.equal(reverted.status, "reverted");
      assert.equal(db.select().from(organizationWorkflowStates).where(eq(organizationWorkflowStates.id, "state-unrelated-human")).get()?.name, "Human follow-up");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "g2-unrelated-human-change")).get()?.status, "applied");
    } finally { sqlite.close(); }
  }, 15_000);
});

describe("BRE-319 cached Change Set replay authority", () => {
  test("denies an outer apply replay when a separate connection revokes authority after preflight", async () => {
    const fixture = await setup();
    const marker = installReplayCapabilityMarker(fixture);
    try {
      const input = prepareActivation(fixture, "g2-outer-apply-replay");
      const capabilitySnapshot = validCapability(fixture.db);
      const applied = createSqliteRuleChangeSetService(fixture.db).activate({
        ...input, capabilitySnapshot, workspaceId: "workspace-1",
      });
      assert.throws(() => createSqliteRuleChangeSetService(fixture.db, { capabilitySource: marker.source(true) }).activate({
        ...input, capabilitySnapshot, workspaceId: "workspace-1",
      }), /live Capability has been revoked/);
      assert.equal(fixture.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey)).all().length, 1);
      assert.equal(applied.operation, "apply");
    } finally {
      marker.other.sqlite.close();
      fixture.sqlite.close();
    }
  }, 15_000);

  test("denies an outer revert replay when a separate connection revokes authority after preflight", async () => {
    const fixture = await setup();
    const marker = installReplayCapabilityMarker(fixture);
    try {
      const activation = prepareActivation(fixture, "g2-outer-revert-original");
      const capabilitySnapshot = validCapability(fixture.db);
      const service = createSqliteRuleChangeSetService(fixture.db);
      const applied = service.activate({ ...activation, capabilitySnapshot, workspaceId: "workspace-1" });
      const request = {
        changeSetId: applied.changeSetId,
        accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter,
        idempotencyKey: "g2-outer-revert-replay",
      };
      const reverted = service.revert({ actor: activation.actor, capabilitySnapshot, workspaceId: "workspace-1", request });
      assert.throws(() => createSqliteRuleChangeSetService(fixture.db, { capabilitySource: marker.source(true) }).revert({
        actor: activation.actor, capabilitySnapshot, workspaceId: "workspace-1", request,
      }), /live Capability has been revoked/);
      assert.equal(fixture.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, request.idempotencyKey)).all().length, 1);
      assert.equal(reverted.operation, "revert");
    } finally {
      marker.other.sqlite.close();
      fixture.sqlite.close();
    }
  }, 15_000);

  test("denies an inner apply duplicate committed by a separate connection after the outer replay miss", async () => {
    const fixture = await setup();
    const marker = installReplayCapabilityMarker(fixture);
    try {
      const input = prepareActivation(fixture, "g2-inner-apply-replay");
      const capabilitySnapshot = validCapability(fixture.db);
      const winner = createSqliteRuleChangeSetService(marker.other.db);
      const originalTransaction = fixture.db.transaction.bind(fixture.db);
      let raced = false;
      fixture.db.transaction = ((callback, config) => {
        if (!raced) {
          raced = true;
          winner.activate({ ...input, capabilitySnapshot: validCapability(marker.other.db), workspaceId: "workspace-1" });
          marker.revoke();
        }
        return originalTransaction(callback, config);
      }) as typeof fixture.db.transaction;
      assert.throws(() => createSqliteRuleChangeSetService(fixture.db, { capabilitySource: marker.source(false) }).activate({
        ...input, capabilitySnapshot, workspaceId: "workspace-1",
      }), /live Capability has been revoked/);
      assert.equal(raced, true);
      assert.equal(fixture.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey)).all().length, 1);
    } finally {
      marker.other.sqlite.close();
      fixture.sqlite.close();
    }
  }, 15_000);

  test("denies an inner agent replay when another connection owns the winner's durable approval", async () => {
    const fixture = await setup();
    const other = createDatabaseClient(fixture.path);
    try {
      const input = prepareActivation(fixture, "g2-inner-approval-connection-replay");
      const actor = { id: "g2-agent-client", type: "agent" as const };
      const humanCapability = validCapability(fixture.db);
      const capabilitySnapshot = { ...humanCapability, id: "g2-agent-capability", actor };
      const capabilitySource: RuleChangeSetCapabilitySource = {
        load: () => ({ snapshot: capabilitySnapshot, revokedAt: null }),
      };
      fixture.db.insert(mcpOAuthClients).values({ id: actor.id, name: "G2 client", redirectUris: "[]" }).run();
      fixture.db.insert(mcpConnections).values([
        { id: "g2-connection-a", userId: "workspace-1", clientId: actor.id, resource: "https://api.orca.test/mcp", scopes: "organization:control" },
        { id: "g2-connection-b", userId: "workspace-1", clientId: actor.id, resource: "https://api.orca.test/mcp", scopes: "organization:control" },
      ]).run();
      const simulation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(fixture.db)).prepare({
        actor,
        workspaceId: "workspace-1",
        request: {
          ruleId: input.request.ruleId,
          revisionId: input.request.revisionId,
          workspaceSchemaRevision: fixture.compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: input.request.accountIds,
          maximumThreads: input.request.maximumThreads,
        },
      }).report;
      const approval = {
        source: "oauth_organization_control_grant" as const,
        simulationId: input.request.simulationId,
        acknowledgedRisk: simulation.risk,
      };
      const approvalGrant = {
        connectionId: "g2-connection-a",
        clientId: actor.id,
        approverUserId: "workspace-1",
        expiresAt: new Date(Date.now() + 600_000),
      };
      const originalTransaction = fixture.db.transaction.bind(fixture.db);
      let raced = false;
      fixture.db.transaction = ((callback, config) => {
        if (!raced) {
          raced = true;
          createSqliteRuleChangeSetService(other.db, { capabilitySource }).activate({
            actor, capabilitySnapshot, workspaceId: "workspace-1", request: input.request, approval, approvalGrant,
          });
          other.db.update(mcpOrganizationApprovals).set({ connectionId: "g2-connection-b" }).run();
        }
        return originalTransaction(callback, config);
      }) as typeof fixture.db.transaction;
      assert.throws(() => createSqliteRuleChangeSetService(fixture.db, { capabilitySource }).activate({
        actor, capabilitySnapshot, workspaceId: "workspace-1", request: input.request, approval, approvalGrant,
      }), (error: unknown) => error instanceof Error && "code" in error && error.code === "approval_required");
      assert.equal(raced, true);
      assert.equal(fixture.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey)).all().length, 1);
    } finally {
      other.sqlite.close();
      fixture.sqlite.close();
    }
  }, 15_000);

  test("denies an inner revert duplicate committed by a separate connection after the outer replay miss", async () => {
    const fixture = await setup();
    const marker = installReplayCapabilityMarker(fixture);
    try {
      const activation = prepareActivation(fixture, "g2-inner-revert-original");
      const capabilitySnapshot = validCapability(fixture.db);
      const applied = createSqliteRuleChangeSetService(fixture.db).activate({
        ...activation, capabilitySnapshot, workspaceId: "workspace-1",
      });
      const request = {
        changeSetId: applied.changeSetId,
        accountIds: ["account-1"],
        expectedWorkspaceRevision: applied.workspaceRevisionAfter,
        idempotencyKey: "g2-inner-revert-replay",
      };
      const winner = createSqliteRuleChangeSetService(marker.other.db);
      const originalTransaction = fixture.db.transaction.bind(fixture.db);
      let raced = false;
      fixture.db.transaction = ((callback, config) => {
        if (!raced) {
          raced = true;
          winner.revert({ actor: activation.actor, capabilitySnapshot: validCapability(marker.other.db), workspaceId: "workspace-1", request });
          marker.revoke();
        }
        return originalTransaction(callback, config);
      }) as typeof fixture.db.transaction;
      assert.throws(() => createSqliteRuleChangeSetService(fixture.db, { capabilitySource: marker.source(false) }).revert({
        actor: activation.actor, capabilitySnapshot, workspaceId: "workspace-1", request,
      }), /live Capability has been revoked/);
      assert.equal(raced, true);
      assert.equal(fixture.db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, request.idempotencyKey)).all().length, 1);
    } finally {
      marker.other.sqlite.close();
      fixture.sqlite.close();
    }
  }, 15_000);
});

describe("BRE-317 historical production-failure REST lifecycle", () => {
  test("simulates, approves, applies, explains, and reverts through authenticated production adapters", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 47).toString("base64");
    const { db, sqlite, path, compiled, threadId } = await setup();
    try {
      const session = await createSession(db, "workspace-1");
      const app = createApp({ dbFactory: () => createDatabaseClient(path) });
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const simulationResponse = await app.request(`/v1/organization/rules/${compiled.rule.id}/simulate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
          accountIds: ["account-1"],
          maximumThreads: 500,
        }),
      });
      const simulation = await simulationResponse.json();
      assert.equal(simulationResponse.status, 200, JSON.stringify(simulation));
      assert.equal(simulation.state, "simulated");
      assert.equal(simulation.representativeThreads[0].threadId, threadId);

      const ruleSet = db.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, "workspace-1")).get()!;
      const activationResponse = await app.request(`/v1/organization/rules/${compiled.rule.id}/activate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ruleId: compiled.rule.id,
          revisionId: compiled.revision.id,
          simulationId: simulation.simulationId,
          accountIds: ["account-1"],
          maximumThreads: 500,
          expectedWorkspaceRevision: simulation.binding.workspaceRevision,
          expectedRuleRevision: compiled.rule.latestRevision,
          expectedRuleSetRevision: ruleSet.revision,
          idempotencyKey: "route-activate-production-failure",
        }),
      });
      const activated = await activationResponse.json();
      assert.equal(activationResponse.status, 200, JSON.stringify(activated));
      assert.equal(activated.status, "active");

      const explanationResponse = await app.request(`/v1/organization/change-sets/${activated.changeSetId}`, { headers });
      const explanation = await explanationResponse.json();
      assert.equal(explanationResponse.status, 200, JSON.stringify(explanation));
      assert.equal(explanation.changeSet.status, "active");
      assert.equal(explanation.trace.length, 1);
      assert.equal(explanation.actions.length, 3);
      assert.equal(explanation.inverse.threads[0].threadId, threadId);
      assert.equal(explanation.resultingRevisions.workspace, activated.workspaceRevisionAfter);

      const revertResponse = await app.request(`/v1/organization/change-sets/${activated.changeSetId}/revert`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          changeSetId: activated.changeSetId,
          accountIds: ["account-1"],
          expectedWorkspaceRevision: activated.workspaceRevisionAfter,
          idempotencyKey: "route-revert-production-failure",
        }),
      });
      const reverted = await revertResponse.json();
      assert.equal(revertResponse.status, 200, JSON.stringify(reverted));
      assert.equal(reverted.status, "reverted");
      assert.equal(reverted.revertsChangeSetId, activated.changeSetId);

      const revertedExplanation = await (await app.request(`/v1/organization/change-sets/${activated.changeSetId}`, { headers })).json();
      assert.equal(revertedExplanation.changeSet.status, "reverted");
      assert.equal(revertedExplanation.changeSet.revertedByChangeId, reverted.changeSetId);
    } finally {
      sqlite.close();
    }
  }, 20_000);
});
