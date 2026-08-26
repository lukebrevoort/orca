import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { RuleAuthorityError, RuleRevisionConflictError, createRuleRevisionService, type RuleRevisionRepository } from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];
type RuleAppendInput = Parameters<RuleRevisionRepository["append"]>[0];

function setup(options: { tamperAuthorization?: boolean; tamperAppend?: (input: RuleAppendInput) => RuleAppendInput } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-314-service-"));
  directories.push(directory);
  const client = createDatabaseClient(join(directory, "rules.sqlite"));
  migrate(client.db, { migrationsFolder: migrations });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
  client.db.insert(oauthAccounts).values([
    { id: "owner-account", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "owner-provider" },
    { id: "private-account", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private-provider" },
  ]).run();
  const repository = createSqliteRuleRevisionRepository(client.db);
  if (options.tamperAuthorization || options.tamperAppend) {
    const append = repository.append.bind(repository);
    repository.append = (input) => {
      const tampered = structuredClone(input);
      tampered.authorizationAnchor = input.authorizationAnchor;
      if (options.tamperAuthorization) tampered.executionContext.actor.id = "forged-actor";
      return append(options.tamperAppend?.(tampered) ?? tampered);
    };
  }
  const service = createRuleRevisionService(repository, {
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    id: (() => { let value = 0; return () => `id-${++value}`; })(),
  });
  return { ...client, repository, service };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const source = (lane = "Everything else", name = "Launch mail") => `orca 1
rule "${name}"
event message.received
when subject contains "launch"
action route lane "${lane}"
because "Launch mail stays visible"`;

describe("Rule Revision service", () => {
  test("rejects destructive compiled IR substituted behind an authentic authorization anchor without writes", () => {
    const { service, sqlite } = setup({
      tamperAppend(input) {
        input.revision.compiled.actions = [{ kind: "propose_provider_deletion" }];
        input.revision.compiled.requiredCapabilities = ["provider_delete"];
        input.revision.compiled.risk = "destructive";
        return input;
      },
    });
    const persistenceState = () => ({
      rules: (sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count,
      revisions: (sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions").get() as { count: number }).count,
      changeSets: (sqlite.query("SELECT COUNT(*) count FROM organization_change_sets").get() as { count: number }).count,
      changeActions: (sqlite.query("SELECT COUNT(*) count FROM organization_change_actions").get() as { count: number }).count,
      workspaceRevision: (sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'owner'").get() as { revision: number }).revision,
    });
    try {
      const before = persistenceState();
      assert.deepEqual(before, { rules: 0, revisions: 0, changeSets: 0, changeActions: 0, workspaceRevision: 1 });
      assert.throws(() => service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ruleId: "substituted-rule", idempotencyKey: "substituted-rule-create-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() },
      }), (error: unknown) => error instanceof RuleAuthorityError && error.code === "invalid_request");
      assert.deepEqual(persistenceState(), before);
    } finally { sqlite.close(); }
  });

  test("rejects every persistence-intent mutation behind an authentic anchor without writes", () => {
    let mutate: (input: RuleAppendInput) => RuleAppendInput = (input) => input;
    const { service, sqlite } = setup({ tamperAppend: (input) => mutate(input) });
    const persistenceState = () => ({
      rules: (sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count,
      revisions: (sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions").get() as { count: number }).count,
      changeSets: (sqlite.query("SELECT COUNT(*) count FROM organization_change_sets").get() as { count: number }).count,
      changeActions: (sqlite.query("SELECT COUNT(*) count FROM organization_change_actions").get() as { count: number }).count,
      workspaceRevision: (sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'owner'").get() as { revision: number }).revision,
    });
    const changedSource = source("Everything else", "Substituted source");
    const cases: Array<[string, (input: RuleAppendInput) => RuleAppendInput]> = [
      ["request-rule-id", (input) => { input.request.ruleId = "substituted-rule"; return input; }],
      ["request-idempotency", (input) => { input.request.idempotencyKey = "substituted-key"; return input; }],
      ["request-expected-rule-revision", (input) => { input.request.expectedRuleRevision = 1; return input; }],
      ["request-workspace-revision", (input) => { input.request.workspaceSchemaRevision = 2; return input; }],
      ["request-source", (input) => { input.request.source = changedSource; return input; }],
      ["change-id", (input) => ({ ...input, changeId: "substituted-change" })],
      ["command", (input) => { input.command.id = "substituted-command"; return input; }],
      ["command-intent", (input) => { input.command.intents[0]!.resourceId = "rule:substituted-rule"; return input; }],
      ["execution-actor", (input) => { input.executionContext.actor.id = "private"; return input; }],
      ["execution-account-scope", (input) => { input.executionContext.accountIds = ["private-account"]; return input; }],
      ["execution-expected-revisions", (input) => { input.executionContext.expectedRevisions.workspace = 2; return input; }],
      ["execution-idempotency", (input) => { input.executionContext.idempotencyKey = "substituted-key"; return input; }],
      ["authority-trace", (input) => { input.authorityTrace.risk = "destructive"; return input; }],
      ["authority-trace-scope", (input) => { input.authorityTrace.scope.accountIds = ["private-account"]; return input; }],
      ["authorization-envelope-digest", (input) => ({ ...input, authorizationEnvelopeDigest: `sha256:${"0".repeat(64)}` })],
      ["expected-workspace-revision", (input) => ({ ...input, expectedWorkspaceSchemaRevision: 2 })],
      ["expected-rule-revision", (input) => ({ ...input, expectedRuleRevision: 1 })],
      ["rule-id", (input) => { input.rule.id = "substituted-rule"; return input; }],
      ["rule-workspace", (input) => { input.rule.workspaceId = "private"; return input; }],
      ["rule-name", (input) => { input.rule.name = "Substituted name"; return input; }],
      ["rule-latest-revision", (input) => { input.rule.latestRevision = 2; return input; }],
      ["rule-active-revision", (input) => { input.rule.activeRevisionId = "substituted-revision"; return input; }],
      ["rule-created-at", (input) => { input.rule.createdAt = "2026-08-25T12:00:01.000Z"; return input; }],
      ["rule-updated-at", (input) => { input.rule.updatedAt = "2026-08-25T12:00:01.000Z"; return input; }],
      ["revision-id", (input) => { input.revision.id = "substituted-revision"; return input; }],
      ["revision-rule-id", (input) => { input.revision.ruleId = "substituted-rule"; return input; }],
      ["revision-workspace", (input) => { input.revision.workspaceId = "private"; return input; }],
      ["revision-number", (input) => { input.revision.revision = 2; return input; }],
      ["revision-source", (input) => { input.revision.source = changedSource; return input; }],
      ["revision-source-digest", (input) => { input.revision.sourceDigest = `sha256:${"0".repeat(64)}`; return input; }],
      ["compiled-language-version", (input) => { (input.revision.compiled as { languageVersion: number }).languageVersion = 2; return input; }],
      ["compiled-workspace", (input) => { input.revision.compiled.workspaceId = "private"; return input; }],
      ["compiled-workspace-revision", (input) => { input.revision.compiled.workspaceSchemaRevision = 2; return input; }],
      ["compiled-name", (input) => { input.revision.compiled.name = "Substituted name"; return input; }],
      ["compiled-event", (input) => { input.revision.compiled.event.kind = "schedule.reached"; return input; }],
      ["compiled-predicate-content", (input) => { input.revision.compiled.predicates[0]!.name = "substituted-predicate"; return input; }],
      ["compiled-predicate-order", (input) => { input.revision.compiled.predicates.reverse(); return input; }],
      ["compiled-action-content", (input) => {
        const action = input.revision.compiled.actions[0];
        if (action?.kind !== "route_lane") throw new Error("Expected ordered matrix source to compile a route_lane first");
        action.laneId = "substituted-lane";
        return input;
      }],
      ["compiled-action-order", (input) => { input.revision.compiled.actions.reverse(); return input; }],
      ["compiled-because", (input) => { input.revision.compiled.because = "Substituted rationale"; return input; }],
      ["compiled-capabilities", (input) => { input.revision.compiled.requiredCapabilities = ["provider_delete"]; return input; }],
      ["compiled-risk", (input) => { input.revision.compiled.risk = "destructive"; return input; }],
      ["revision-actor", (input) => { input.revision.actor.id = "private"; return input; }],
      ["revision-created-at", (input) => { input.revision.createdAt = "2026-08-25T12:00:01.000Z"; return input; }],
    ];
    const orderedSource = `orca 1
rule "Ordered launch mail"
event message.received
predicate launch = subject contains "launch"
predicate unread = thread.unread equals true
when launch
when unread
action route lane "Everything else"
action notify digest
because "Ordered predicates and actions stay bound"`;
    const before = persistenceState();
    try {
      assert.deepEqual(before, { rules: 0, revisions: 0, changeSets: 0, changeActions: 0, workspaceRevision: 1 });
      for (const [index, [name, mutation]] of cases.entries()) {
        mutate = mutation;
        assert.throws(() => service.compile({
          actor: { id: "owner", type: "human" }, workspaceId: "owner",
          request: { ruleId: `matrix-rule-${index}`, idempotencyKey: `matrix-key-${index}`, expectedRuleRevision: null, workspaceSchemaRevision: 1, source: orderedSource },
        }), (error: unknown) => error instanceof RuleAuthorityError
          && error.code === "invalid_request"
          && /persistence intent/.test(error.message), name);
        assert.deepEqual(persistenceState(), before, name);
      }
    } finally { sqlite.close(); }
  }, 15_000);

  test("rejects a forged authorization envelope before any Rule transaction write", () => {
    const { service, sqlite } = setup({ tamperAuthorization: true });
    try {
      assert.throws(() => service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ruleId: "forged-rule", idempotencyKey: "forged-rule-create-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() },
      }), (error: unknown) => (error as { code?: string }).code === "invalid_request");
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE resource_family = 'rule'").get() as { count: number }).count, 0);
      assert.equal((sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'owner'").get() as { revision: number }).revision, 1);
    } finally { sqlite.close(); }
  });

  test("consumes one-shot Rule authorization only after transaction entry and never restores it on rollback", () => {
    const { db, repository, service, sqlite } = setup();
    const originalAppend = repository.append.bind(repository);
    const originalTransaction = db.transaction.bind(db);
    const capture = (request: Parameters<typeof service.compile>[0]["request"]) => {
      let captured: Parameters<RuleRevisionRepository["append"]>[0] | undefined;
      repository.append = (input) => {
        captured = input;
        throw new Error("captured Rule append");
      };
      assert.throws(() => service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request }), /captured Rule append/);
      repository.append = originalAppend;
      assert.ok(captured);
      return captured;
    };
    const countWrites = () => ({
      rules: (sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count,
      revisions: (sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions").get() as { count: number }).count,
      audit: (sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE resource_family = 'rule'").get() as { count: number }).count,
    });
    try {
      const beforeEntry = capture({
        ruleId: "transaction-order-rule",
        idempotencyKey: "transaction-order-rule-1",
        expectedRuleRevision: null,
        workspaceSchemaRevision: 1,
        source: source(),
      });
      db.transaction = (() => { throw new Error("forced failure before transaction closure"); }) as typeof db.transaction;
      assert.throws(() => originalAppend(beforeEntry), /forced failure before transaction closure/);
      db.transaction = originalTransaction;
      assert.equal(originalAppend(beforeEntry).ok, true);
      assert.throws(() => originalAppend(beforeEntry), (error: unknown) =>
        error instanceof RuleAuthorityError && error.code === "invalid_request" && /authorization anchor/.test(error.message));

      const rolledBack = capture({
        ruleId: "transaction-rollback-rule",
        idempotencyKey: "transaction-rollback-rule-1",
        expectedRuleRevision: null,
        workspaceSchemaRevision: 2,
        source: source("Everything else", "Rollback probe"),
      });
      const writesBeforeRollback = countWrites();
      let enteredTransactionClosure = false;
      db.transaction = ((callback) => originalTransaction((transaction) => {
        enteredTransactionClosure = true;
        callback(transaction);
        throw new Error("forced failure after Rule writes");
      })) as typeof db.transaction;
      assert.throws(() => originalAppend(rolledBack), /forced failure after Rule writes/);
      assert.equal(enteredTransactionClosure, true);
      assert.deepEqual(countWrites(), writesBeforeRollback);
      db.transaction = originalTransaction;
      assert.throws(() => originalAppend(rolledBack), (error: unknown) =>
        error instanceof RuleAuthorityError && error.code === "invalid_request" && /authorization anchor/.test(error.message));
      assert.deepEqual(countWrites(), writesBeforeRollback);
    } finally {
      repository.append = originalAppend;
      db.transaction = originalTransaction;
      sqlite.close();
    }
  });

  test("replays an exact duplicate create and rejects conflicting Rule/idempotency reuse atomically", () => {
    const { service, sqlite } = setup();
    try {
      const request = {
        ruleId: "rule-client-stable",
        idempotencyKey: "rule-create-stable-1",
        expectedRuleRevision: null,
        workspaceSchemaRevision: 1,
        source: source(),
      };
      const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request });
      const replayed = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request });
      assert.deepEqual(replayed, created);

      const counts = () => ({
        rules: (sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count,
        revisions: (sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions").get() as { count: number }).count,
        audit: (sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE resource_family = 'rule'").get() as { count: number }).count,
        workspaceRevision: (sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'owner'").get() as { revision: number }).revision,
      });
      assert.deepEqual(counts(), { rules: 1, revisions: 1, audit: 1, workspaceRevision: 2 });

      assert.throws(() => service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ...request, source: source("Everything else", "Conflicting replay") },
      }), (error: unknown) => (error as { code?: string }).code === "duplicate_idempotency_key");
      assert.throws(() => service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ...request, idempotencyKey: "rule-create-stable-2", workspaceSchemaRevision: 2 },
      }), (error: unknown) => (error as { code?: string }).code === "rule_revision_conflict");
      assert.deepEqual(counts(), { rules: 1, revisions: 1, audit: 1, workspaceRevision: 2 });
    } finally { sqlite.close(); }
  }, 15_000);

  test("creates and edits by appending immutable typed revisions", () => {
    const { service, sqlite } = setup();
    try {
      const created = service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { idempotencyKey: "create-rule-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() },
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.rule.latestRevision, 1);
      assert.equal(created.revision.compiled.actions[0]?.kind, "route_lane");

      const edited = service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ruleId: created.rule.id, idempotencyKey: "edit-rule-1", expectedRuleRevision: 1, workspaceSchemaRevision: 2, source: source("Everything else", "Launch alerts") },
      });
      assert.equal(edited.ok, true);
      if (!edited.ok) return;
      assert.equal(edited.rule.id, created.rule.id);
      assert.equal(edited.rule.latestRevision, 2);
      assert.equal(edited.revision.revision, 2);
      assert.notEqual(edited.revision.id, created.revision.id);
      assert.equal(service.get({ workspaceId: "owner", ruleId: created.rule.id }).revisions.length, 2);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions").get() as { count: number }).count, 2);
    } finally { sqlite.close(); }
  });

  test("does not persist failed compilation and rejects stale or cross-workspace edits", () => {
    const { service, sqlite } = setup();
    try {
      const invalid = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        idempotencyKey: "invalid-rule-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source("Missing lane"),
      } });
      assert.equal(invalid.ok, false);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count, 0);

      const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        idempotencyKey: "create-rule-2", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source(),
      } });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.throws(() => service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        ruleId: created.rule.id, idempotencyKey: "stale-rule-1", expectedRuleRevision: 99, workspaceSchemaRevision: 2, source: source(),
      } }), RuleRevisionConflictError);
      assert.throws(() => service.compile({ actor: { id: "private", type: "human" }, workspaceId: "private", request: {
        ruleId: created.rule.id, idempotencyKey: "cross-rule-1", expectedRuleRevision: 1, workspaceSchemaRevision: 1, source: source(),
      } }), RuleRevisionConflictError);
    } finally { sqlite.close(); }
  });
});
