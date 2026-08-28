import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { classifyOrcaActions, orcaEvaluationTraceSchema } from "@orca/shared";

import { createDatabaseClient } from "../../db/client.ts";
import * as databaseSchema from "../../db/schema.ts";
import {
  collectionThreads,
  collections,
  emails,
  oauthAccounts,
  organizationContextRelationshipTypes,
  organizationContexts,
  organizationEvaluationTraces,
  organizationContextTypes,
  organizationChangeActions,
  organizationChangeSets,
  organizationFacets,
  organizationLanePolicies,
  organizationLanes,
  organizationRuleRevisions,
  organizationRules,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadWorkflowStates,
  organizationThreadStates,
  organizationWorkflowStates,
  organizationWorkspaceStates,
  threadReminders,
  users,
} from "../../db/schema.ts";
import { persistGmailMessages } from "../../providers/gmail/sync.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { createOrganization } from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";
import { evaluateAndPersistLiveContext, evaluateLiveMessageRules, getLatestOrcaEvaluationTrace, loadLiveEvaluationInput } from "./evaluation-sqlite.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { createRuleRevisionService } from "./service.ts";
import { gmailSyncOrganizationCapability, type OrganizationSystemCapabilityAdapter } from "../system-capability.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];
const bre315TraceFixture = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../../web/public/docs/assets/bre-315-trace-fixture.json"), "utf8")) as {
  trace: Record<string, unknown> & {
    event: Record<string, unknown>;
    budget: Record<string, unknown>;
    ruleSet: { revision: number };
  };
};

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function gmailMessage(id: string, subject = "Production deploy failed", internalDate = "1787745600000"): GmailMessage {
  return {
    id,
    threadId: "provider-thread-1",
    internalDate,
    labelIds: ["INBOX"],
    snippet: subject,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Vercel <alerts@vercel.com>" },
        { name: "To", value: "Owner <owner@example.com>" },
        { name: "Subject", value: subject },
      ],
      body: { data: Buffer.from(subject).toString("base64url") },
    },
  };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-315-live-"));
  directories.push(directory);
  const client = createDatabaseClient(join(directory, "evaluation.sqlite"));
  migrate(client.db, { migrationsFolder: migrations });
  const now = new Date("2026-08-26T12:00:00.000Z");
  client.db.insert(users).values({ id: "workspace-1", email: "owner@example.com" }).run();
  client.db.insert(oauthAccounts).values({ id: "account-1", userId: "workspace-1", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider-owner" }).run();
  client.db.insert(organizationLanePolicies).values({
    workspaceId: "workspace-1", id: "policy-focus", visibility: "prominent", interruption: "notify", review: "continuous",
    retentionMode: "keep", retentionDays: null, providerDeletion: false, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationLanes).values({ workspaceId: "workspace-1", id: "lane-focus", name: "Focus", position: 1, defaultPolicyId: "policy-focus", revision: 1, createdAt: now, updatedAt: now }).run();
  client.db.insert(organizationFacets).values({
    workspaceId: "workspace-1", id: "facet-urgency", name: "Urgency", position: 0,
    valueType: JSON.stringify({ kind: "enum", options: [{ id: "urgent", label: "Urgent", position: 0, retiredAt: null }] }),
    cardinality: JSON.stringify({ kind: "single" }), isOptional: true, defaultValue: null, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationWorkflowStates).values({ workspaceId: "workspace-1", id: "state-review", name: "Needs review", position: 0, revision: 1, createdAt: now, updatedAt: now }).run();
  client.db.insert(collections).values({ id: "collection-launch", accountId: "account-1", name: "Launch", color: "#336699", position: 0, revision: 1, createdAt: now, updatedAt: now }).run();
  client.db.insert(organizationContextTypes).values({ workspaceId: "workspace-1", id: "context-type-project", name: "Project", position: 0, revision: 1, createdAt: now, updatedAt: now }).run();
  client.db.insert(organizationContextRelationshipTypes).values({
    workspaceId: "workspace-1", id: "relationship-project", contextTypeId: "context-type-project", name: "belongs to", inverseName: "contains",
    direction: "thread_to_context", position: 0, maximumPerThread: 20, revision: 1, createdAt: now, updatedAt: now,
  }).run();
  client.db.insert(organizationContexts).values({ workspaceId: "workspace-1", id: "context-orca", contextTypeId: "context-type-project", name: "Orca", revision: 1, createdAt: now, updatedAt: now }).run();

  const service = createRuleRevisionService(createSqliteRuleRevisionRepository(client.db), {
    now: () => now,
    id: (() => { let value = 0; return () => `rule-id-${++value}`; })(),
  });
  const compiled = service.compile({
    actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1",
    request: { idempotencyKey: "bre-315-production-failures", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: `orca 1
rule "Production failures"
event message.received
predicate from_vercel = sender.domain equals "vercel.com"
predicate failed = subject contains "failed"
when all(from_vercel, failed)
action route lane "Focus"
action set workflow "Needs review"
action set facet "Urgency" = "Urgent"
action add collection "Launch"
action link context "Project" "Orca"
action notify immediate
because "A failed deploy blocks work"` },
  });
  if (!compiled.ok) throw new Error(`Rule compilation failed with ${compiled.diagnostics.length} diagnostics`);
  client.db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
  return { ...client, compiled, now, service };
}

describe("message.received Rule evaluation", () => {
  test("upgrades exact BRE-315 persisted Trace JSON deterministically at replay and latest-read boundaries", async () => {
    const { db, sqlite, compiled, now } = setup();
    try {
      db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, compiled.rule.id)).run();
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("legacy-trace")],
        labelList: [], now, propagationTrigger: "sync",
      });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "legacy-trace")).get()!;
      const context = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(context);
      const legacy = structuredClone(bre315TraceFixture.trace);
      legacy.id = `evaluation:${context.event.id}:legacy-rules:7`;
      legacy.event = {
        ...legacy.event,
        id: context.event.id,
        kind: "thread.updated",
        cause: "provider",
        workspaceId: "workspace-1",
        accountId: "account-1",
        threadId: email.threadId,
        messageId: email.id,
      };
      legacy.budget = { ...legacy.budget };
      delete legacy.budget.status;
      assert.equal(orcaEvaluationTraceSchema.safeParse(legacy).success, false, "the strict current write schema must reject exact BRE-315 JSON");
      const logicalTime = new Date(now.getTime() + 1_000);
      db.insert(organizationEvaluationTraces).values({
        workspaceId: "workspace-1",
        id: String(legacy.id),
        accountId: "account-1",
        threadId: email.threadId,
        eventId: context.event.id,
        eventKind: "thread.updated",
        ruleSetRevision: legacy.ruleSet.revision,
        traceJson: JSON.stringify(legacy),
        actionsJson: "[]",
        logicalTime,
        createdAt: logicalTime,
      }).run();

      const replayed = evaluateLiveMessageRules(db, {
        accountId: "account-1",
        events: [{ messageId: email.id, kind: "thread.updated" }],
      });
      const latest = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: email.threadId });
      assert.equal(replayed.length, 1);
      assert.ok(latest);
      assert.deepEqual(replayed[0], latest);
      assert.equal(orcaEvaluationTraceSchema.safeParse(latest).success, true);
      assert.equal(latest.budget.status, "complete");
      assert.equal(latest.event.kind, "thread.updated");
      assert.equal(latest.event.id, context.event.id, "legacy Event identity preserves the original message linkage honestly");
      assert.equal("messageId" in latest.event, false);
      assert.equal(JSON.stringify(evaluateLiveMessageRules(db, { accountId: "account-1", events: [{ messageId: email.id, kind: "thread.updated" }] })[0]), JSON.stringify(latest));
    } finally { sqlite.close(); }
  }, 15_000);

  test("rejects a Lane introduced after the compiled Workspace Schema revision with zero writes", async () => {
    const { db, sqlite, service, compiled, now } = setup();
    try {
      db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, compiled.rule.id)).run();
      db.update(organizationWorkspaceStates).set({ revision: 7 }).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).run();
      const revisionSeven = service.compile({
        actor: { id: "workspace-1", type: "human" },
        workspaceId: "workspace-1",
        request: {
          idempotencyKey: "bre-316-revision-bound-lane",
          expectedRuleRevision: null,
          workspaceSchemaRevision: 7,
          source: `orca 1
rule "Revision-bound Lane"
event message.received
when subject contains "failed"
action route lane "Focus"
because "Only revision-seven resources may be referenced"`,
        },
      });
      assert.equal(revisionSeven.ok, true);
      if (!revisionSeven.ok) throw new Error("revision-seven Rule did not compile");
      assert.equal(db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()?.revision, 8);
      db.insert(organizationLanes).values({
        workspaceId: "workspace-1", id: "lane-introduced-at-8", name: "Later Lane", position: 2,
        defaultPolicyId: "policy-focus", revision: 1, createdAt: new Date(now.getTime() + 1_000), updatedAt: new Date(now.getTime() + 1_000),
      }).run();
      db.update(organizationRules).set({ activeRevisionId: revisionSeven.revision.id }).where(eq(organizationRules.id, revisionSeven.rule.id)).run();

      db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, revisionSeven.rule.id)).run();
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("revision-bound-lane")],
        labelList: [], now, propagationTrigger: "sync",
      });
      db.update(organizationRules).set({ activeRevisionId: revisionSeven.revision.id }).where(eq(organizationRules.id, revisionSeven.rule.id)).run();
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "revision-bound-lane")).get()!;
      const before = {
        changes: db.select().from(organizationChangeSets).all().length,
        actions: db.select().from(organizationChangeActions).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        threads: db.select().from(organizationThreadStates).all().length,
        lanes: db.select().from(organizationThreadLaneStates).all().length,
      };

      const context = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "message.received" });
      assert.ok(context);
      context.event.id = `${context.event.id}:tampered`;
      context.ruleSet.revisions[0]!.compiled.actions = [{ kind: "route_lane", laneId: "lane-introduced-at-8" }];
      assert.throws(() => evaluateAndPersistLiveContext(db, context), /Workspace Schema semantic binding/);
      assert.deepEqual({
        changes: db.select().from(organizationChangeSets).all().length,
        actions: db.select().from(organizationChangeActions).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        threads: db.select().from(organizationThreadStates).all().length,
        lanes: db.select().from(organizationThreadLaneStates).all().length,
      }, before);
    } finally { sqlite.close(); }
  }, 15_000);

  test("rejects schema-tampered compiled IR with zero projection, Change Set, or Trace writes", async () => {
    const { db, sqlite, compiled, now } = setup();
    try {
      db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, compiled.rule.id)).run();
      db.insert(organizationFacets).values({
        workspaceId: "workspace-1", id: "facet-required", name: "Required priority", position: 1,
        valueType: JSON.stringify({ kind: "enum", options: [{ id: "high", label: "High", position: 0, retiredAt: null }] }),
        cardinality: JSON.stringify({ kind: "single" }), isOptional: false, defaultValue: JSON.stringify("high"), revision: 1, createdAt: now, updatedAt: now,
      }).run();
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("semantic-binding")],
        labelList: [], now, propagationTrigger: "sync",
      });
      db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "semantic-binding")).get()!;
      const base = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(base);
      const before = {
        changes: db.select().from(organizationChangeSets).all().length,
        actions: db.select().from(organizationChangeActions).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        threads: db.select().from(organizationThreadStates).all().length,
        lanes: db.select().from(organizationThreadLaneStates).all().length,
        facets: db.select().from(organizationThreadFacetValues).all().length,
      };
      const cases: Array<[string, (context: NonNullable<typeof base>) => void]> = [
        ["forged Lane", (context) => { context.ruleSet.revisions[0]!.compiled.actions = [{ kind: "route_lane", laneId: "lane-forged" }]; }],
        ["invalid enum type", (context) => { context.ruleSet.revisions[0]!.compiled.actions = [{ kind: "set_facet", facetId: "facet-urgency", value: 7 }]; }],
        ["required Facet unset", (context) => { context.ruleSet.revisions[0]!.compiled.actions = [{ kind: "unset_facet", facetId: "facet-required" }]; }],
        ["missing resource", (context) => { context.ruleSet.revisions[0]!.compiled.actions = [{ kind: "set_workflow_state", stateId: "state-missing" }]; }],
        ["revision mismatch", (context) => { context.ruleSet.revisions[0]!.compiled.workspaceSchemaRevision += 1; }],
        ["forged Predicate field/Facet pairing", (context) => {
          context.ruleSet.revisions[0]!.compiled.predicates = [{
            name: null,
            expression: { kind: "exists", field: "subject", facetId: "facet-urgency", valueType: "enum", optional: true },
          }];
        }],
        ["nested Predicate semantic forgery", (context) => {
          context.ruleSet.revisions[0]!.compiled.predicates = [
            { name: "forged_leaf", expression: { kind: "compare", field: "facet:facet-urgency", facetId: "facet-urgency", operator: "contains", value: "urgent", valueType: "enum", optional: true, missingBehavior: "false" } },
            { name: "nested_not", expression: { kind: "not", predicate: "forged_leaf" } },
            { name: "nested_any", expression: { kind: "any", predicates: ["nested_not"] } },
            { name: null, expression: { kind: "all", predicates: ["nested_any"] } },
          ];
        }],
      ];

      for (const [, mutate] of cases) {
        const context = structuredClone(base);
        mutate(context);
        const revision = context.ruleSet.revisions[0]!.compiled;
        const classification = classifyOrcaActions(revision.actions);
        revision.requiredCapabilities = classification.requiredCapabilities;
        revision.risk = classification.risk;
        assert.throws(() => evaluateAndPersistLiveContext(db, context), /Workspace Schema semantic binding/);
        assert.deepEqual({
          changes: db.select().from(organizationChangeSets).all().length,
          actions: db.select().from(organizationChangeActions).all().length,
          traces: db.select().from(organizationEvaluationTraces).all().length,
          threads: db.select().from(organizationThreadStates).all().length,
          lanes: db.select().from(organizationThreadLaneStates).all().length,
          facets: db.select().from(organizationThreadFacetValues).all().length,
        }, before);
      }
    } finally { sqlite.close(); }
  }, 15_000);

  test("bounds referenced live catalogs before exhausted evaluation and performs zero writes", async () => {
    const { db, sqlite, now } = setup();
    try {
      const template = db.select().from(organizationRuleRevisions).get()!;
      for (let index = 0; index < 99; index += 1) {
        const ruleId = `zz-valid-${String(index).padStart(3, "0")}`;
        const revisionId = `${ruleId}-revision`;
        db.insert(organizationRules).values({
          workspaceId: "workspace-1", id: ruleId, name: ruleId, latestRevision: 1, activeRevisionId: revisionId,
          position: index + 1,
          createdAt: new Date(now.getTime() + index + 1), updatedAt: new Date(now.getTime() + index + 1),
        }).run();
        db.insert(organizationRuleRevisions).values({
          ...template, id: revisionId, ruleId, revision: 1, createdAt: new Date(now.getTime() + index + 1),
        }).run();
      }
      db.insert(organizationRules).values({
        workspaceId: "workspace-1", id: "zzzz-malformed", name: "malformed", latestRevision: 1,
        position: 100,
        activeRevisionId: "zzzz-malformed-revision", createdAt: new Date(now.getTime() + 1_000), updatedAt: new Date(now.getTime() + 1_000),
      }).run();
      db.insert(organizationRuleRevisions).values({
        ...template, id: "zzzz-malformed-revision", ruleId: "zzzz-malformed", revision: 1,
        compiledJson: "{not valid json", createdAt: new Date(now.getTime() + 1_000),
      }).run();
      for (let index = 0; index < 25; index += 1) {
        const ruleId = `zzzzz-growth-${String(index).padStart(3, "0")}`;
        const revisionId = `${ruleId}-revision`;
        db.insert(organizationRules).values({
          workspaceId: "workspace-1", id: ruleId, name: ruleId, latestRevision: 1, activeRevisionId: revisionId,
          position: 101 + index,
          createdAt: new Date(now.getTime() + 2_000 + index), updatedAt: new Date(now.getTime() + 2_000 + index),
        }).run();
        db.insert(organizationRuleRevisions).values({
          ...template, id: revisionId, ruleId, revision: 1, compiledJson: "{also malformed", createdAt: new Date(now.getTime() + 2_000 + index),
        }).run();
      }
      for (let index = 0; index < 250; index += 1) {
        const suffix = String(index).padStart(3, "0");
        db.insert(organizationWorkflowStates).values({
          workspaceId: "workspace-1", id: `state-unreferenced-${suffix}`, name: `Unreferenced state ${suffix}`,
          position: index + 1, revision: 1, createdAt: now, updatedAt: now,
        }).run();
        db.insert(collections).values({
          id: `collection-unreferenced-${suffix}`, accountId: "account-1", name: `Unreferenced collection ${suffix}`,
          color: "#666666", position: index + 1, revision: 1, createdAt: now, updatedAt: now,
        }).run();
        db.insert(organizationContextTypes).values({
          workspaceId: "workspace-1", id: `context-type-unreferenced-${suffix}`, name: `Unreferenced type ${suffix}`,
          position: index + 1, revision: 1, createdAt: now, updatedAt: now,
        }).run();
        db.insert(organizationContexts).values({
          workspaceId: "workspace-1", id: `context-unreferenced-${suffix}`, contextTypeId: `context-type-unreferenced-${suffix}`,
          name: `Unreferenced context ${suffix}`, revision: 1, createdAt: now, updatedAt: now,
        }).run();
      }

      const before = {
        changes: db.select().from(organizationChangeSets).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        projections: db.select().from(organizationThreadStates).all().length,
      };
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("bounded-rules")],
        labelList: [], now, propagationTrigger: "sync",
      });

      assert.equal(getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1" }), null);
      assert.deepEqual({
        changes: db.select().from(organizationChangeSets).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        projections: db.select().from(organizationThreadStates).all().length,
      }, before);
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "bounded-rules")).get();
      assert.ok(email);
      const context = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(context);
      assert.deepEqual(context.workspaceSchema.workflowStates.map(({ id }) => id), ["state-review"]);
      assert.deepEqual(context.workspaceSchema.collections.map(({ id }) => id), ["collection-launch"]);
      assert.deepEqual(context.workspaceSchema.contextTypes.map(({ id }) => id), ["context-type-project"]);
      assert.deepEqual(context.workspaceSchema.contexts.map(({ id }) => id), ["context-orca"]);
      const trace = evaluateAndPersistLiveContext(db, context);
      assert.equal(trace.ruleSet.activeRevisionCount, 126);
      assert.equal(trace.consideredRevisions.length, 100);
      assert.equal(trace.budget.ruleRevisions, 100);
      assert.equal(trace.budget.status, "exhausted");
      assert.equal(trace.budget.exhausted, true);
      assert.equal(trace.lowerLanePlacement.placementSource, "workspace_fallback");
      assert.deepEqual({
        changes: db.select().from(organizationChangeSets).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
        projections: db.select().from(organizationThreadStates).all().length,
      }, before);
    } finally { sqlite.close(); }
  }, 15_000);

  test("bounds live Collection query inputs across many owned Accounts", async () => {
    const { db, sqlite, compiled, now } = setup();
    try {
      const unrelatedAccountIds = Array.from({ length: 128 }, (_, index) => `account-unreferenced-${String(index).padStart(3, "0")}`);
      db.insert(oauthAccounts).values(unrelatedAccountIds.map((id, index) => ({
        id,
        userId: "workspace-1",
        provider: "gmail",
        providerEmail: `unreferenced-${index}@example.com`,
        providerId: `provider-unreferenced-${index}`,
      }))).run();
      db.insert(collections).values(unrelatedAccountIds.map((accountId, index) => ({
        id: `collection-account-unreferenced-${String(index).padStart(3, "0")}`,
        accountId,
        name: `Account collection ${index}`,
        color: "#666666",
        position: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }))).run();

      db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, compiled.rule.id)).run();
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("bounded-account-collections")],
        labelList: [], now, propagationTrigger: "sync",
      });
      db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "bounded-account-collections")).get();
      assert.ok(email);

      const databaseQueries: Array<{ sql: string; params: unknown[] }> = [];
      const observedDb = drizzle(sqlite, {
        schema: databaseSchema,
        logger: { logQuery: (sql, params) => databaseQueries.push({ sql, params }) },
      });
      const context = loadLiveEvaluationInput(observedDb, {
        accountId: "account-1",
        messageId: email.id,
        eventKind: "thread.updated",
      });

      assert.ok(context);
      assert.deepEqual(context.workspaceSchema.collections.map(({ id }) => id), ["collection-launch"]);
      const unrelatedAccountQueryInputs = databaseQueries
        .flatMap(({ params }) => params)
        .filter((value): value is string => typeof value === "string" && value.startsWith("account-unreferenced-"));
      assert.equal(unrelatedAccountQueryInputs.length, 0, "bounded Collection loading must not enumerate unrelated owned Account IDs into query inputs");
    } finally { sqlite.close(); }
  }, 15_000);

  test("fails closed before candidates when referenced Collections are missing or outside the Workspace", async () => {
    for (const candidate of [
      { name: "missing", collectionId: "collection-missing" },
      { name: "foreign", collectionId: "collection-foreign" },
    ]) {
      const { db, sqlite, compiled, now, service } = setup();
      try {
        db.insert(users).values({ id: "workspace-foreign", email: "foreign@example.com" }).run();
        db.insert(oauthAccounts).values({
          id: "account-foreign", userId: "workspace-foreign", provider: "gmail",
          providerEmail: "foreign@example.com", providerId: "provider-foreign",
        }).run();
        db.update(organizationRules).set({ activeRevisionId: null }).where(eq(organizationRules.id, compiled.rule.id)).run();
        db.insert(collections).values({
          id: candidate.collectionId, accountId: "account-1", name: candidate.name, color: "#663366",
          position: 1, revision: 1, createdAt: now, updatedAt: now,
        }).run();
        const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()?.revision ?? 1;
        const boundRule = service.compile({
          actor: { id: "workspace-1", type: "human" },
          workspaceId: "workspace-1",
          request: {
            idempotencyKey: `bre-316-closed-${candidate.name}-collection`,
            expectedRuleRevision: null,
            workspaceSchemaRevision: workspaceRevision,
            source: `orca 1
rule "Closed ${candidate.name} Collection"
event thread.updated
when subject contains "failed"
action add collection "${candidate.name}"
because "The bound Collection must remain owned"`,
          },
        });
        assert.equal(boundRule.ok, true);
        if (!boundRule.ok) throw new Error(`Could not compile ${candidate.name} Collection Rule`);
        if (candidate.name === "missing") {
          db.delete(collections).where(eq(collections.id, candidate.collectionId)).run();
        } else {
          db.update(collections).set({ accountId: "account-foreign" }).where(eq(collections.id, candidate.collectionId)).run();
        }
        await persistGmailMessages(db, {
          accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage(`closed-${candidate.name}-collection`)],
          labelList: [], now, propagationTrigger: "sync",
        });
        const email = db.select().from(emails).where(eq(emails.providerMessageId, `closed-${candidate.name}-collection`)).get();
        assert.ok(email);

        db.update(organizationRules).set({ activeRevisionId: boundRule.revision.id }).where(eq(organizationRules.id, boundRule.rule.id)).run();

        const durableState = () => ({
          projections: db.select().from(organizationThreadStates).all().length,
          laneProjections: db.select().from(organizationThreadLaneStates).all().length,
          workflowProjections: db.select().from(organizationThreadWorkflowStates).all().length,
          facetProjections: db.select().from(organizationThreadFacetValues).all().length,
          collectionProjections: db.select().from(collectionThreads).all().length,
          contextProjections: db.select().from(organizationThreadContextRelationships).all().length,
          reminderProjections: db.select().from(threadReminders).all().length,
          changes: db.select().from(organizationChangeSets).all().length,
          actions: db.select().from(organizationChangeActions).all().length,
          traces: db.select().from(organizationEvaluationTraces).all().length,
        });
        const before = durableState();

        assert.throws(() => evaluateLiveMessageRules(db, {
          accountId: "account-1",
          events: [{ messageId: email.id, kind: "thread.updated" }],
        }), /failed current Workspace Schema semantic binding/);
        assert.deepEqual(durableState(), before, `${candidate.name} Collection denial must produce zero projection, Change Set, Action, or Trace writes`);
      } finally { sqlite.close(); }
    }
  }, 15_000);

  test("atomically organizes a production-failure Thread and persists its complete Glass Box Trace", async () => {
    const { db, sqlite, compiled, now } = setup();
    try {
      const workspaceRevisionBefore = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("production-failure")],
        labelList: [{ id: "INBOX", name: "Inbox", type: "system" }], now, propagationTrigger: "sync",
      });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "production-failure")).get();
      assert.ok(email);
      const lane = db.select().from(organizationThreadLaneStates).where(and(eq(organizationThreadLaneStates.accountId, "account-1"), eq(organizationThreadLaneStates.threadId, email.threadId))).get();
      assert.equal(lane?.primaryLaneId, "lane-focus");
      assert.equal(lane?.placementSource, "rule_revision");
      assert.equal(lane?.sourceId, compiled.revision.id);
      assert.equal(lane?.manualOverrideLaneId, null);
      assert.equal(lane?.safetyLocked, false);
      assert.equal(db.select().from(organizationThreadWorkflowStates).where(eq(organizationThreadWorkflowStates.threadId, email.threadId)).get()?.stateId, "state-review");
      assert.equal(JSON.parse(db.select().from(organizationThreadFacetValues).where(eq(organizationThreadFacetValues.threadId, email.threadId)).get()!.value), "urgent");
      assert.ok(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, email.threadId)).get());
      assert.equal(db.select().from(organizationThreadContextRelationships).where(eq(organizationThreadContextRelationships.threadId, email.threadId)).get()?.contextId, "context-orca");

      const trace = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: email.threadId });
      assert.ok(trace);
      assert.equal(trace.reason, "A failed deploy blocks work");
      assert.equal(trace.consideredRevisions[0]?.revisionId, compiled.revision.id);
      assert.equal(trace.winners.find((winner) => winner.slot === "lane")?.action.kind, "route_lane");
      assert.equal(trace.actor.id, "system:gmail-sync");
      assert.deepEqual(trace.capabilities.actionFamilies, ["organization_thread", "organization_attention"]);

      const change = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, trace.id)).get();
      assert.ok(change, "the live system projection reserves an authoritative Change Set");
      assert.equal(change.resourceFamily, "thread");
      assert.equal(change.workspaceRevisionBefore, workspaceRevisionBefore);
      assert.equal(change.workspaceRevisionAfter, workspaceRevisionBefore + 1);
      const authority = JSON.parse(change.authorityTrace) as { decision: string; requestedResourceIds: string[] };
      assert.equal(authority.decision, "allowed");
      assert.deepEqual(authority.requestedResourceIds, [`thread:account-1:${email.threadId}`]);
      const auditedFamilies = db.select().from(organizationChangeActions).where(eq(organizationChangeActions.changeId, trace.id)).all().map((action) => action.resourceFamily);
      assert.deepEqual(new Set(auditedFamilies), new Set(["lane", "workflow_state", "facet", "collection", "context", "thread"]));
      assert.equal(db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision, workspaceRevisionBefore + 1);
      assert.equal(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, email.threadId)).get()!.revision, 1);

      const queried = createOrganization(createSqliteOrganizationRepository(db)).query({
        scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] },
        query: { threadId: email.threadId, attention: "all", classification: "all", limit: 1 },
      });
      assert.equal(queried.threads[0]?.organization.lanePlacement.primaryLaneId, "lane-focus");
      assert.equal(queried.threads[0]?.organization.lanePlacement.evidence.reason, "A failed deploy blocks work");
    } finally { sqlite.close(); }
  }, 15_000);

  test("rolls back projection and Trace evidence when the live system Capability is denied", async () => {
    const { db, sqlite, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("capability-initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "capability-initial")).get()!;
      const context = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(context);
      const stateBefore = {
        workspace: db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get(),
        thread: db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, email.threadId)).get(),
        lane: db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(),
        changes: db.select().from(organizationChangeSets).all().length,
        traces: db.select().from(organizationEvaluationTraces).all().length,
      };
      const denied: OrganizationSystemCapabilityAdapter = {
        snapshot: gmailSyncOrganizationCapability.snapshot,
        live(input) {
          const live = gmailSyncOrganizationCapability.live(input);
          return { ...live, snapshot: { ...live.snapshot, actionFamilies: ["organization_attention"] } };
        },
      };

      assert.throws(() => evaluateAndPersistLiveContext(db, context, denied), /Capability snapshot is not the current live revision/);
      assert.deepEqual(db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get(), stateBefore.workspace);
      assert.deepEqual(db.select().from(organizationThreadStates).where(eq(organizationThreadStates.threadId, email.threadId)).get(), stateBefore.thread);
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), stateBefore.lane);
      assert.equal(db.select().from(organizationChangeSets).all().length, stateBefore.changes);
      assert.equal(db.select().from(organizationEvaluationTraces).all().length, stateBefore.traces);
    } finally { sqlite.close(); }
  }, 15_000);

  test("does not overwrite a concurrent authoritative human Lane write from a stale evaluation snapshot", async () => {
    const { db, sqlite, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("stale-initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "stale-initial")).get()!;
      const stale = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(stale);
      const fallbackLaneId = (sqlite.query("SELECT fallback_lane_id value FROM organization_workspace_lane_settings WHERE workspace_id = 'workspace-1'").get() as { value: string }).value;
      const organization = createOrganization(createSqliteOrganizationRepository(db));
      organization.apply({
        scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] },
        command: {
          id: "0e969841-acde-4a91-acde-491000000315",
          idempotencyKey: "bre-315-concurrent-human-write",
          expectedWorkspaceRevision: stale.workspaceSchema.revision,
          actions: [{
            kind: "set_thread_manual_override", accountId: "account-1", threadId: email.threadId,
            laneId: fallbackLaneId, reason: "A human moved this while evaluation was pending", expectedThreadRevision: stale.thread.lanePlacement.revision,
          }],
        },
      });
      const humanLane = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get();
      const traceCount = db.select().from(organizationEvaluationTraces).all().length;

      assert.throws(() => evaluateAndPersistLiveContext(db, stale), /expected Workspace revision is stale/);
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), humanLane);
      assert.equal(db.select().from(organizationEvaluationTraces).all().length, traceCount);
    } finally { sqlite.close(); }
  }, 15_000);

  test("denies live Collection add and remove across Accounts without mutating foreign membership", async () => {
    const { db, sqlite, service, now } = setup();
    try {
      db.insert(oauthAccounts).values({ id: "account-2", userId: "workspace-1", provider: "gmail", providerEmail: "second@example.com", providerId: "provider-second" }).run();
      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const removeRule = service.compile({
        actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1",
        request: { idempotencyKey: "bre-315-cross-account-remove", expectedRuleRevision: null, workspaceSchemaRevision: workspaceRevision, source: `orca 1
rule "Remove Launch"
event thread.updated
when subject contains "failed"
action remove collection "Launch"
because "Only the owning Account may change membership"` },
      });
      assert.equal(removeRule.ok, true);
      if (!removeRule.ok) throw new Error("cross-Account remove Rule did not compile");
      db.update(organizationRules).set({ activeRevisionId: removeRule.revision.id }).where(eq(organizationRules.id, removeRule.rule.id)).run();
      await persistGmailMessages(db, { accountId: "account-2", accountEmail: "second@example.com", gmailMessages: [gmailMessage("account-2-initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "account-2-initial")).get()!;
      const receivedTrace = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-2", threadId: email.threadId });
      assert.ok(receivedTrace?.losers.some((loser) => loser.action.kind === "add_collection" && loser.reason === "account_denied"));
      assert.equal(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, email.threadId)).get(), undefined);

      db.insert(collectionThreads).values({ id: "foreign-membership", collectionId: "collection-launch", threadId: email.threadId, createdAt: now }).run();
      const updatedContext = loadLiveEvaluationInput(db, { accountId: "account-2", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(updatedContext);
      const updatedTrace = evaluateAndPersistLiveContext(db, updatedContext);
      assert.ok(updatedTrace.losers.some((loser) => loser.action.kind === "remove_collection" && loser.reason === "account_denied"));
      assert.ok(db.select().from(collectionThreads).where(eq(collectionThreads.id, "foreign-membership")).get(), "denied remove preserves the foreign Account membership");
    } finally { sqlite.close(); }
  }, 15_000);

  test("applies a live Collection remove within the Thread Account", async () => {
    const { db, sqlite, service, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("same-account-initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "same-account-initial")).get()!;
      assert.ok(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, email.threadId)).get());
      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const removeRule = service.compile({
        actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1",
        request: { idempotencyKey: "bre-315-same-account-remove", expectedRuleRevision: null, workspaceSchemaRevision: workspaceRevision, source: `orca 1
rule "Remove Launch"
event thread.updated
when subject contains "failed"
action remove collection "Launch"
because "The owning Account may change membership"` },
      });
      assert.equal(removeRule.ok, true);
      if (!removeRule.ok) throw new Error("same-Account remove Rule did not compile");
      db.update(organizationRules).set({ activeRevisionId: removeRule.revision.id }).where(eq(organizationRules.id, removeRule.rule.id)).run();
      const context = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: email.id, eventKind: "thread.updated" });
      assert.ok(context);
      const trace = evaluateAndPersistLiveContext(db, context);
      assert.ok(trace.winners.some((winner) => winner.action.kind === "remove_collection"));
      assert.equal(db.select().from(collectionThreads).where(eq(collectionThreads.threadId, email.threadId)).get(), undefined);
    } finally { sqlite.close(); }
  }, 15_000);

  test("preserves lower Rule placement while Manual Override remains the effective winner", async () => {
    const { db, sqlite, service, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "initial")).get()!;
      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const updateRule = service.compile({
        actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1",
        request: { idempotencyKey: "bre-315-thread-updated", expectedRuleRevision: null, workspaceSchemaRevision: workspaceRevision, source: `orca 1
rule "Production follow-ups"
event thread.updated
when subject contains "failed"
action route lane "Focus"
because "A failed follow-up remains focused"` },
      });
      assert.equal(updateRule.ok, true);
      if (!updateRule.ok) throw new Error("thread.updated Rule did not compile");
      db.update(organizationRules).set({ activeRevisionId: updateRule.revision.id }).where(eq(organizationRules.id, updateRule.rule.id)).run();
      const fallbackLaneId = sqlite.query("SELECT fallback_lane_id value FROM organization_workspace_lane_settings WHERE workspace_id = 'workspace-1'").get() as { value: string };
      db.update(organizationThreadLaneStates).set({
        manualOverrideLaneId: fallbackLaneId.value, manualOverrideActorId: "workspace-1", manualOverrideActorType: "human",
        manualOverrideReason: "Keep this incident in my review Lane", manualOverrideAt: now,
      }).where(and(eq(organizationThreadLaneStates.accountId, "account-1"), eq(organizationThreadLaneStates.threadId, email.threadId))).run();

      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("follow-up")], labelList: [], now: new Date("2026-08-26T12:01:00.000Z"), propagationTrigger: "push" });
      const stored = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get()!;
      assert.equal(stored.primaryLaneId, "lane-focus", "lower Rule winner is preserved beneath the Manual Override");
      assert.equal(stored.manualOverrideLaneId, fallbackLaneId.value);
      const query = createOrganization(createSqliteOrganizationRepository(db)).query({ scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] }, query: { threadId: email.threadId, limit: 1 } });
      assert.equal(query.threads[0]?.organization.lanePlacement.primaryLaneId, fallbackLaneId.value);
      assert.equal(query.threads[0]?.organization.lanePlacement.evidence.winningSource, "manual_override");
    } finally { sqlite.close(); }
  }, 15_000);

  test("keeps a Safety-Locked Lane and provenance immutable across matching and nonmatching live replay, reload, Manual Override, and unlock", async () => {
    const { db, sqlite, service, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "initial")).get()!;
      const fallbackLaneId = (sqlite.query("SELECT fallback_lane_id value FROM organization_workspace_lane_settings WHERE workspace_id = 'workspace-1'").get() as { value: string }).value;
      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const updateRule = service.compile({
        actor: { id: "workspace-1", type: "human" },
        workspaceId: "workspace-1",
        request: { idempotencyKey: "bre-315-safety-lock-replay", expectedRuleRevision: null, workspaceSchemaRevision: workspaceRevision, source: `orca 1
rule "Production follow-ups"
event thread.updated
when subject contains "failed"
action route lane "Focus"
because "A failed follow-up remains focused"` },
      });
      assert.equal(updateRule.ok, true);
      if (!updateRule.ok) throw new Error("thread.updated Rule did not compile");
      db.update(organizationRules).set({ activeRevisionId: updateRule.revision.id }).where(eq(organizationRules.id, updateRule.rule.id)).run();

      db.update(organizationThreadLaneStates).set({
        safetyLocked: true,
        safetyLockActorId: "human-safety",
        safetyLockActorType: "human",
        safetyLockReason: "Hold the incident in Focus",
        safetyLockUpdatedAt: new Date("2026-08-26T12:00:30.000Z"),
      }).where(and(eq(organizationThreadLaneStates.accountId, "account-1"), eq(organizationThreadLaneStates.threadId, email.threadId))).run();

      const lockedStorage = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get()!;
      const beforeProjectionCounts = sqlite.query(`SELECT
        (SELECT revision FROM organization_thread_states WHERE workspace_id = 'workspace-1' AND account_id = 'account-1' AND thread_id = ?) thread_revision,
        (SELECT COUNT(*) FROM organization_thread_workflow_states WHERE thread_id = ?) workflows,
        (SELECT COUNT(*) FROM organization_thread_facet_values WHERE thread_id = ?) facets,
        (SELECT COUNT(*) FROM collection_threads WHERE thread_id = ?) collections,
        (SELECT COUNT(*) FROM organization_thread_context_relationships WHERE thread_id = ?) contexts`).get(email.threadId, email.threadId, email.threadId, email.threadId, email.threadId);

      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("nonmatching-follow-up", "All systems normal", "1787745660000")], labelList: [], now: new Date("2026-08-26T12:01:00.000Z"), propagationTrigger: "push" });
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), lockedStorage, "a losing Rule/Lane Policy/Fallback candidate must not rewrite locked storage");
      assert.deepEqual(sqlite.query(`SELECT
        (SELECT revision FROM organization_thread_states WHERE workspace_id = 'workspace-1' AND account_id = 'account-1' AND thread_id = ?) thread_revision,
        (SELECT COUNT(*) FROM organization_thread_workflow_states WHERE thread_id = ?) workflows,
        (SELECT COUNT(*) FROM organization_thread_facet_values WHERE thread_id = ?) facets,
        (SELECT COUNT(*) FROM collection_threads WHERE thread_id = ?) collections,
        (SELECT COUNT(*) FROM organization_thread_context_relationships WHERE thread_id = ?) contexts`).get(email.threadId, email.threadId, email.threadId, email.threadId, email.threadId), beforeProjectionCounts, "Trace-only proposals and losing placement candidates produce zero projection writes");

      const nonmatchingTrace = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: email.threadId });
      assert.ok(nonmatchingTrace);
      assert.equal(nonmatchingTrace.event.kind, "thread.updated");
      assert.deepEqual(nonmatchingTrace.winners.find((winner) => winner.slot === "lane"), {
        candidateId: "safety-lock:lane",
        action: { kind: "route_lane", laneId: "lane-focus" },
        slot: "lane",
        precedence: "safety_lock",
        ruleOrder: 0,
        actionOrder: 0,
        actor: { id: "human-safety", type: "human" },
        reason: "Hold the incident in Focus",
        authorized: true,
      });
      assert.ok(nonmatchingTrace.losers.some((loser) => loser.precedence === "workspace_fallback"));

      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("matching-follow-up", "Production deploy failed again", "1787745720000")], labelList: [], now: new Date("2026-08-26T12:02:00.000Z"), propagationTrigger: "push" });
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), lockedStorage, "a matching Rule remains a losing Trace candidate while locked");
      const matchingTrace = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: email.threadId });
      assert.equal(matchingTrace?.consideredRevisions.find((revision) => revision.revisionId === updateRule.revision.id)?.predicateMatched, true);
      assert.equal(matchingTrace?.losers.find((loser) => loser.revisionId === updateRule.revision.id)?.winnerCandidateId, "safety-lock:lane");

      const reloaded = createOrganization(createSqliteOrganizationRepository(db)).query({ scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] }, query: { threadId: email.threadId, limit: 1 } });
      assert.equal(reloaded.threads[0]?.organization.lanePlacement.primaryLaneId, "lane-focus");
      assert.deepEqual(reloaded.threads[0]?.organization.lanePlacement.evidence, {
        winningSource: "safety_lock",
        sourceId: "lane-focus",
        precedenceLevel: "1_safety_lock",
        actor: { id: "human-safety", type: "human" },
        reason: "Hold the incident in Focus",
      });

      db.update(organizationThreadLaneStates).set({ safetyLocked: false }).where(eq(organizationThreadLaneStates.threadId, email.threadId)).run();
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("after-unlock", "All systems normal", "1787745780000")], labelList: [], now: new Date("2026-08-26T12:03:00.000Z"), propagationTrigger: "push" });
      const unlocked = createOrganization(createSqliteOrganizationRepository(db)).query({ scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] }, query: { threadId: email.threadId, limit: 1 } });
      assert.equal(unlocked.threads[0]?.organization.lanePlacement.primaryLaneId, fallbackLaneId);
      assert.equal(unlocked.threads[0]?.organization.lanePlacement.evidence.winningSource, "workspace_fallback");
    } finally { sqlite.close(); }
  }, 15_000);

  test("persists attention, retention, and deletion proposals in evaluation evidence without forbidden live projections", async () => {
    const { db, sqlite, service, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("proposal-initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "proposal-initial")).get()!;
      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const proposalRule = service.compile({
        actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1",
        request: { idempotencyKey: "bre-315-proposal-boundary", expectedRuleRevision: null, workspaceSchemaRevision: workspaceRevision, source: `orca 1
rule "Proposal boundary"
event thread.updated
when subject contains "proposal"
action notify immediate
action suppress interruption
action schedule review "P1D"
action propose retention review_after 30
action propose provider deletion
because "These remain proposals until an authoritative apply exists"` },
      });
      assert.equal(proposalRule.ok, true);
      if (!proposalRule.ok) throw new Error("proposal Rule did not compile");
      db.update(organizationRules).set({ activeRevisionId: proposalRule.revision.id }).where(eq(organizationRules.id, proposalRule.rule.id)).run();
      db.update(organizationThreadLaneStates).set({
        safetyLocked: true,
        safetyLockActorId: "human-safety",
        safetyLockActorType: "human",
        safetyLockReason: "Keep proposal review in Focus",
        safetyLockUpdatedAt: now,
      }).where(eq(organizationThreadLaneStates.threadId, email.threadId)).run();

      const laneBefore = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get();
      const projectionBefore = sqlite.query(`SELECT
        (SELECT revision FROM organization_thread_states WHERE workspace_id = 'workspace-1' AND account_id = 'account-1' AND thread_id = ?) thread_revision,
        (SELECT COUNT(*) FROM organization_thread_workflow_states WHERE thread_id = ?) workflows,
        (SELECT COUNT(*) FROM organization_thread_facet_values WHERE thread_id = ?) facets,
        (SELECT COUNT(*) FROM collection_threads WHERE thread_id = ?) collections,
        (SELECT COUNT(*) FROM organization_thread_context_relationships WHERE thread_id = ?) contexts,
        (SELECT COUNT(*) FROM thread_reminders WHERE account_id = 'account-1' AND thread_id = ?) reminders`).get(email.threadId, email.threadId, email.threadId, email.threadId, email.threadId, email.threadId);

      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("proposal-follow-up", "proposal cleanup", "1787745660000")], labelList: [], now: new Date("2026-08-26T12:01:00.000Z"), propagationTrigger: "push" });

      const row = db.select().from(organizationEvaluationTraces).where(eq(organizationEvaluationTraces.eventKind, "thread.updated")).get()!;
      const persistedActions = JSON.parse(row.actionsJson) as Array<{ kind: string }>;
      const persistedTrace = JSON.parse(row.traceJson) as { candidates: Array<{ action: { kind: string } }>; losers: Array<{ action: { kind: string }; reason: string }> };
      const proposalKinds = new Set(["notify", "suppress_interruption", "schedule_review", "propose_retention", "propose_provider_deletion"]);
      assert.deepEqual([...new Set(persistedTrace.candidates.map((candidate) => candidate.action.kind).filter((kind) => proposalKinds.has(kind)))], [
        "notify", "suppress_interruption", "schedule_review", "propose_retention", "propose_provider_deletion",
      ], "every typed proposal remains inspectable in Trace candidates");
      assert.ok(persistedActions.some((action) => action.kind === "notify"));
      assert.ok(persistedActions.some((action) => action.kind === "propose_retention"));
      assert.ok(persistedTrace.losers.some((loser) => loser.action.kind === "propose_provider_deletion" && loser.reason === "capability_denied"));
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), laneBefore);
      assert.deepEqual(sqlite.query(`SELECT
        (SELECT revision FROM organization_thread_states WHERE workspace_id = 'workspace-1' AND account_id = 'account-1' AND thread_id = ?) thread_revision,
        (SELECT COUNT(*) FROM organization_thread_workflow_states WHERE thread_id = ?) workflows,
        (SELECT COUNT(*) FROM organization_thread_facet_values WHERE thread_id = ?) facets,
        (SELECT COUNT(*) FROM collection_threads WHERE thread_id = ?) collections,
        (SELECT COUNT(*) FROM organization_thread_context_relationships WHERE thread_id = ?) contexts,
        (SELECT COUNT(*) FROM thread_reminders WHERE account_id = 'account-1' AND thread_id = ?) reminders`).get(email.threadId, email.threadId, email.threadId, email.threadId, email.threadId, email.threadId), projectionBefore);
      assert.equal(db.select().from(threadReminders).where(and(eq(threadReminders.accountId, "account-1"), eq(threadReminders.threadId, email.threadId))).all().length, 0);
      assert.ok(db.select().from(emails).where(eq(emails.providerMessageId, "proposal-follow-up")).get(), "provider mail remains present; proposal evaluation did not delete it");
    } finally { sqlite.close(); }
  }, 15_000);

  test("does not reinterpret an identical provider-message replay as thread.updated", async () => {
    const { db, sqlite, now } = setup();
    try {
      const replayed = gmailMessage("provider-replay");
      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [replayed],
        labelList: [], now, propagationTrigger: "sync",
      });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, replayed.id)).get()!;
      const laneBefore = db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get();
      const traceCountBefore = (sqlite.query("SELECT COUNT(*) count FROM organization_evaluation_traces").get() as { count: number }).count;

      await persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [replayed],
        labelList: [], now: new Date("2026-08-26T12:01:00.000Z"), propagationTrigger: "push",
      });

      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_evaluation_traces").get() as { count: number }).count, traceCountBefore);
      assert.deepEqual(db.select().from(organizationThreadLaneStates).where(eq(organizationThreadLaneStates.threadId, email.threadId)).get(), laneBefore);
    } finally { sqlite.close(); }
  }, 15_000);

  test("makes persisted Rule position authoritative for conflicting winners across reorder and reload", async () => {
    const { db, sqlite, compiled, now, service } = setup();
    try {
      const second = service.compile({ actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", request: {
        ruleId: "rule-everything-else", idempotencyKey: "bre-315-order-second", expectedRuleRevision: null, workspaceSchemaRevision: 2,
        source: `orca 1
rule "Everything else wins"
event message.received
when subject contains "failed"
action route lane "Everything else"
because "The explicit first Rule wins the Lane tie"`,
      } });
      assert.equal(second.ok, true);
      if (!second.ok) return;
      db.update(organizationRules).set({ activeRevisionId: compiled.revision.id }).where(eq(organizationRules.id, compiled.rule.id)).run();
      db.update(organizationRules).set({ activeRevisionId: second.revision.id }).where(eq(organizationRules.id, second.rule.id)).run();

      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("ordered-winner")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "ordered-winner")).get()!;
      const before = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: email.threadId });
      assert.equal(before?.winners.find(({ slot }) => slot === "lane")?.revisionId, compiled.revision.id);
      assert.deepEqual(before?.consideredRevisions.map(({ revisionId, order }) => [revisionId, order]), [[compiled.revision.id, 0], [second.revision.id, 1]]);

      const workspaceRevision = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace-1")).get()!.revision;
      const reordered = service.reorder({ actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", request: {
        idempotencyKey: "bre-315-order-swap", expectedWorkspaceRevision: workspaceRevision, expectedRuleSetRevision: 3,
        items: [{ id: second.rule.id, position: 0, expectedRevision: 1 }],
      } });
      assert.deepEqual(reordered.items.map(({ id, position }) => [id, position]), [[second.rule.id, 0], [compiled.rule.id, 1]]);

      const nextMessage = gmailMessage("ordered-after");
      nextMessage.threadId = "provider-thread-ordered-after";
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [nextMessage], labelList: [], now: new Date(now.getTime() + 1_000), propagationTrigger: "push" });
      const nextEmail = db.select().from(emails).where(eq(emails.providerMessageId, "ordered-after")).get()!;
      const reloaded = loadLiveEvaluationInput(db, { accountId: "account-1", messageId: nextEmail.id, eventKind: "message.received" });
      assert.ok(reloaded);
      assert.deepEqual(reloaded.ruleSet.revisions.map(({ revisionId, order }) => [revisionId, order]), [[second.revision.id, 0], [compiled.revision.id, 1]]);
      const after = getLatestOrcaEvaluationTrace(db, { workspaceId: "workspace-1", accountId: "account-1", threadId: nextEmail.threadId })!;
      assert.equal(after.ruleSet.revision, 4);
      assert.equal(after.winners.find(({ slot }) => slot === "lane")?.revisionId, second.revision.id);
      assert.deepEqual(after.consideredRevisions.map(({ revisionId, order }) => [revisionId, order]), [[second.revision.id, 0], [compiled.revision.id, 1]]);
    } finally { sqlite.close(); }
  }, 15_000);

  test("rolls back mail and organization state together when Trace persistence fails", async () => {
    const { db, sqlite, now } = setup();
    try {
      sqlite.exec("CREATE TRIGGER reject_evaluation_trace BEFORE INSERT ON organization_evaluation_traces BEGIN SELECT RAISE(ABORT, 'trace rejected'); END");
      await assert.rejects(() => persistGmailMessages(db, {
        accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("must-rollback")],
        labelList: [], now, propagationTrigger: "sync",
      }), /trace rejected/);
      assert.equal(db.select().from(emails).where(eq(emails.providerMessageId, "must-rollback")).get(), undefined);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_evaluation_traces").get() as { count: number }).count, 0);
    } finally { sqlite.close(); }
  }, 15_000);
});
