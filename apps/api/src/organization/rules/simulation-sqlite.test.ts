import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { createApp } from "../../index.ts";
import {
  emails,
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationFacets,
  organizationLanePolicies,
  organizationLanes,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadStates,
  organizationWorkspaceStates,
  threads,
  users,
} from "../../db/schema.ts";
import { persistGmailMessages } from "../../providers/gmail/sync.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { createRuleRevisionService } from "./service.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { createHistoricalRuleSimulationService } from "./simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./simulation-sqlite.ts";
import { createSqliteRuleChangeSetService } from "./change-set-sqlite.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];

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

async function setup() {
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
action route lane "Focus"
action set facet "Severity" = "Critical"
action notify immediate
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
    organizationThreadLaneStates, organizationThreadFacetValues, organizationThreadStates,
  };
  return Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, {
    count: db.select({ count: sql<number>`count(*)` }).from(table).get()!.count,
    rows: db.select().from(table).all(),
  }]));
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
      const capabilitySnapshot = {
        id: "capability-bre-317-human",
        revision: 4,
        actor,
        scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
        operations: ["simulate", "apply", "revert"] as const,
        resourceFamilies: ["rule", "thread", "lane", "facet", "change_set", "trace", "audit"] as const,
        actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"] as const,
      };
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
        const capabilitySnapshot = {
          id: "capability-bre-317-human",
          revision: 4,
          actor,
          scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
          operations: ["simulate", "apply", "revert"] as const,
          resourceFamilies: ["rule", "thread", "lane", "facet", "change_set", "trace", "audit"] as const,
          actionFamilies: (failure === "authority"
            ? ["organization_read", "organization_structure"]
            : ["organization_read", "organization_structure", "organization_thread", "organization_attention"]) as Array<"organization_read" | "organization_structure" | "organization_thread" | "organization_attention">,
        };
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
          failure === "authority" ? /outside the Capability snapshot/
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
});

describe("BRE-317 compensating Rule Change Set revert", () => {
  test("appends an idempotent compensating Change Set and restores projections without erasing audit history", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = {
        id: "capability-bre-317-human", revision: 4, actor,
        scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
        operations: ["simulate", "apply", "revert"] as const,
        resourceFamilies: ["rule", "thread", "lane", "facet", "change_set", "trace", "audit"] as const,
        actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"] as const,
      };
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

  test("reports exact newer-state compensation conflicts and performs no partial revert", async () => {
    const { db, sqlite, compiled, threadId } = await setup();
    try {
      const actor = { id: "workspace-1", type: "human" as const };
      const capabilitySnapshot = {
        id: "capability-bre-317-human", revision: 4, actor,
        scope: { workspaceId: "workspace-1", accountIds: ["account-1"] },
        operations: ["simulate", "apply", "revert"] as const,
        resourceFamilies: ["rule", "thread", "lane", "facet", "change_set", "trace", "audit"] as const,
        actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"] as const,
      };
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
