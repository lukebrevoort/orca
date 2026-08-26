import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { RuleRevisionConflictError, createRuleRevisionService } from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];

function setup(options: { tamperAuthorization?: boolean } = {}) {
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
  if (options.tamperAuthorization) {
    const append = repository.append.bind(repository);
    repository.append = (input) => {
      const tampered = structuredClone(input);
      tampered.executionContext.actor.id = "forged-actor";
      return append(tampered);
    };
  }
  const service = createRuleRevisionService(repository, {
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    id: (() => { let value = 0; return () => `id-${++value}`; })(),
  });
  return { ...client, service };
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
