import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import { RuleRevisionConflictError, createRuleRevisionService } from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre-314-service-"));
  directories.push(directory);
  const client = createDatabaseClient(join(directory, "rules.sqlite"));
  migrate(client.db, { migrationsFolder: migrations });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
  const service = createRuleRevisionService(createSqliteRuleRevisionRepository(client.db), {
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
  test("creates and edits by appending immutable typed revisions", () => {
    const { service, sqlite } = setup();
    try {
      const created = service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() },
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.rule.latestRevision, 1);
      assert.equal(created.revision.compiled.actions[0]?.kind, "route_lane");

      const edited = service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { ruleId: created.rule.id, expectedRuleRevision: 1, workspaceSchemaRevision: 1, source: source("Everything else", "Launch alerts") },
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
        expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source("Missing lane"),
      } });
      assert.equal(invalid.ok, false);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_rules").get() as { count: number }).count, 0);

      const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source(),
      } });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.throws(() => service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        ruleId: created.rule.id, expectedRuleRevision: 99, workspaceSchemaRevision: 1, source: source(),
      } }), RuleRevisionConflictError);
      assert.throws(() => service.compile({ actor: { id: "private", type: "human" }, workspaceId: "private", request: {
        ruleId: created.rule.id, expectedRuleRevision: 1, workspaceSchemaRevision: 1, source: source(),
      } }), RuleRevisionConflictError);
    } finally { sqlite.close(); }
  });
});
