import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads,
  collections,
  emails,
  oauthAccounts,
  organizationContextRelationshipTypes,
  organizationContexts,
  organizationContextTypes,
  organizationFacets,
  organizationLanePolicies,
  organizationLanes,
  organizationRules,
  organizationThreadContextRelationships,
  organizationThreadFacetValues,
  organizationThreadLaneStates,
  organizationThreadWorkflowStates,
  organizationWorkflowStates,
  users,
} from "../../db/schema.ts";
import { persistGmailMessages } from "../../providers/gmail/sync.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { createOrganization } from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";
import { getLatestOrcaEvaluationTrace } from "./evaluation-sqlite.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { createRuleRevisionService } from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function gmailMessage(id: string, subject = "Production deploy failed"): GmailMessage {
  return {
    id,
    threadId: "provider-thread-1",
    internalDate: "1787745600000",
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
    request: { expectedRuleRevision: null, workspaceSchemaRevision: 1, source: `orca 1
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
  return { ...client, compiled, now };
}

describe("message.received Rule evaluation", () => {
  test("atomically organizes a production-failure Thread and persists its complete Glass Box Trace", async () => {
    const { db, sqlite, compiled, now } = setup();
    try {
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
      assert.equal(trace.reason, "Production failures: A failed deploy blocks work");
      assert.equal(trace.consideredRevisions[0]?.revisionId, compiled.revision.id);
      assert.equal(trace.winners.find((winner) => winner.slot === "lane")?.action.kind, "route_lane");
      assert.equal(trace.actor.id, "system:gmail-sync");
      assert.deepEqual(trace.capabilities.actionFamilies, ["organization_thread", "organization_attention"]);

      const queried = createOrganization(createSqliteOrganizationRepository(db)).query({
        scope: { actor: { id: "workspace-1", type: "human" }, workspaceId: "workspace-1", accountIds: ["account-1"] },
        query: { threadId: email.threadId, attention: "all", classification: "all", limit: 1 },
      });
      assert.equal(queried.threads[0]?.organization.lanePlacement.primaryLaneId, "lane-focus");
      assert.equal(queried.threads[0]?.organization.lanePlacement.evidence.reason, "A failed deploy blocks work");
    } finally { sqlite.close(); }
  }, 15_000);

  test("preserves lower Rule placement while Manual Override remains the effective winner", async () => {
    const { db, sqlite, now } = setup();
    try {
      await persistGmailMessages(db, { accountId: "account-1", accountEmail: "owner@example.com", gmailMessages: [gmailMessage("initial")], labelList: [], now, propagationTrigger: "sync" });
      const email = db.select().from(emails).where(eq(emails.providerMessageId, "initial")).get()!;
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
