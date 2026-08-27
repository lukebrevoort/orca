import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { OrganizationCapabilitySnapshot } from "@orca/shared";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import type { OrganizationAgentCapabilitySource, OrganizationLiveCapability } from "../agent-capability.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";
import {
  RuleAuthorityError,
  RuleRevisionConflictError,
  RuleRevisionCursorError,
  RuleRevisionCursorStaleError,
  createRuleRevisionService,
  type RuleRevisionRepository,
} from "./service.ts";

const migrations = resolve(import.meta.dir, "../../../drizzle");
const directories: string[] = [];
type RuleAppendInput = Parameters<RuleRevisionRepository["append"]>[0];
type RuleReorderInput = Parameters<RuleRevisionRepository["reorder"]>[0];
type PersistedRuleRevision = {
  workspace_schema_revision: number;
  language_version: number;
  source: string;
  source_digest: string;
  compiled_json: string;
  required_capabilities: string;
  risk: string;
  actor_id: string;
  actor_type: string;
  created_at: number;
};

function setup(options: { agentCapabilitySource?: OrganizationAgentCapabilitySource; tamperAuthorization?: boolean; tamperAppend?: (input: RuleAppendInput) => RuleAppendInput; tamperReorder?: (input: RuleReorderInput, sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]) => RuleReorderInput } = {}) {
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
  if (options.tamperReorder) {
    const reorder = repository.reorder.bind(repository);
    repository.reorder = (input) => {
      const tampered = structuredClone(input);
      tampered.authorizationAnchor = input.authorizationAnchor;
      return reorder(options.tamperReorder!(tampered, client.sqlite));
    };
  }
  const service = createRuleRevisionService(repository, {
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    id: (() => { let value = 0; return () => `id-${++value}`; })(),
    ...(options.agentCapabilitySource ? { agentCapabilitySource: options.agentCapabilitySource } : {}),
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
  test("reauthorizes exact agent Rule replays transactionally and rejects agent reorder replays", () => {
    const actor = { id: "external-client", type: "agent" as const };
    const baseline: OrganizationCapabilitySnapshot = {
      id: "persisted-rule-grant", revision: 1, actor,
      scope: { workspaceId: "owner", accountIds: ["owner-account"] },
      operations: ["query", "apply"],
      resourceFamilies: ["rule", "audit", "change_set"],
      actionFamilies: ["organization_read", "organization_structure"],
    };
    let live: OrganizationLiveCapability | null = { snapshot: baseline, revokedAt: null };
    let transactionLoads = 0;
    const agentCapabilitySource: OrganizationAgentCapabilitySource = { load(_scope, executor) { if (executor) transactionLoads += 1; return live; } };
    const { service, repository, sqlite } = setup({ agentCapabilitySource });
    const request = { ruleId: "agent-rule", idempotencyKey: "agent-rule-replay", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() };
    try {
      const first = service.compile({ actor, workspaceId: "owner", accountIds: ["owner-account"], request });
      assert.deepEqual(service.compile({ actor, workspaceId: "owner", accountIds: ["owner-account"], request }), first);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE idempotency_key=?").get(request.idempotencyKey) as { count: number }).count, 1);
      assert.throws(() => createRuleRevisionService(repository).compile({ actor, workspaceId: "owner", accountIds: ["owner-account"], request }), RuleAuthorityError);
      assert.throws(() => service.compile({ actor, workspaceId: "owner", accountIds: ["owner-account"], request: { ...request, source: source("Everything else", "Conflict") } }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "duplicate_idempotency_key");
      const denials: Array<[string, () => void]> = [
        ["revoked", () => { live = { snapshot: structuredClone(baseline), revokedAt: "2026-08-26T00:00:00.000Z" }; }],
        ["downgraded", () => { const snapshot = structuredClone(baseline); snapshot.operations = ["query"]; live = { snapshot, revokedAt: null }; }],
        ["account removed", () => { live = null; }],
      ];
      for (const [name, deny] of denials) { live = { snapshot: structuredClone(baseline), revokedAt: null }; deny(); assert.throws(() => service.compile({ actor, workspaceId: "owner", accountIds: ["owner-account"], request }), RuleAuthorityError, name); }
      assert.ok(transactionLoads >= 2);

      live = { snapshot: structuredClone(baseline), revokedAt: null };
      const human = { id: "owner", type: "human" as const };
      const humanSetup = setup();
      try {
        const created = humanSetup.service.compile({ actor: human, workspaceId: "owner", request: { ruleId: "ordered-rule", idempotencyKey: "ordered-create", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() } });
        assert.ok(created.ok);
        const reorderRequest = { idempotencyKey: "ordered-replay", expectedWorkspaceRevision: 2, expectedRuleSetRevision: 2, items: [{ id: "ordered-rule", position: 0, expectedRevision: 1 }] };
        const ordered = humanSetup.service.reorder({ actor: human, workspaceId: "owner", request: reorderRequest });
        assert.deepEqual(humanSetup.service.reorder({ actor: human, workspaceId: "owner", request: reorderRequest }), ordered);
        assert.throws(() => humanSetup.service.reorder({ actor, workspaceId: "owner", request: reorderRequest }), (error: unknown) => error instanceof RuleAuthorityError && error.code === "actor_operation_denied");
      } finally { humanSetup.sqlite.close(); }
    } finally { sqlite.close(); }
  }, 15_000);

  test("denies a direct external-agent compile without an explicit Capability source", () => {
    const { service, sqlite } = setup();
    try {
      assert.throws(() => service.compile({ actor: { id: "external-client", type: "agent" }, workspaceId: "owner", accountIds: ["owner-account"], request: {
        idempotencyKey: "direct-agent-denied",
        expectedRuleRevision: null,
        workspaceSchemaRevision: 1,
        source: source(),
      } }), (error: unknown) => error instanceof RuleAuthorityError && error.code === "missing_operation_capability");
      assert.equal((sqlite.query("SELECT COUNT(*) AS count FROM organization_rule_revisions").get() as { count: number }).count, 0);
    } finally { sqlite.close(); }
  });

  test("paginates a large immutable history with a canonical Rule/head-bound keyset cursor", () => {
    const { service, sqlite } = setup();
    try {
      const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        ruleId: "growth-rule", idempotencyKey: "growth-rule-create", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source(),
      } });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const persisted = sqlite.query("SELECT * FROM organization_rule_revisions WHERE workspace_id = ? AND rule_id = ? AND revision = 1").get("owner", created.rule.id) as PersistedRuleRevision;
      const insert = sqlite.prepare(`INSERT INTO organization_rule_revisions
        (workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      sqlite.transaction(() => {
        for (let revision = 2; revision <= 120; revision += 1) {
          insert.run(
            "owner", `growth-revision-${revision}`, created.rule.id, revision,
            persisted.workspace_schema_revision, persisted.language_version, persisted.source,
            persisted.source_digest, persisted.compiled_json, persisted.required_capabilities,
            persisted.risk, persisted.actor_id, persisted.actor_type, Number(persisted.created_at) + revision,
          );
        }
        sqlite.query("UPDATE organization_rules SET latest_revision = 120 WHERE workspace_id = ? AND id = ?").run("owner", created.rule.id);
        sqlite.query("INSERT INTO organization_rules (workspace_id,id,name,latest_revision,active_revision_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run("owner", "other-growth-rule", "Other", 1, null, 1, Number(persisted.created_at), Number(persisted.created_at));
        insert.run(
          "owner", "other-growth-revision", "other-growth-rule", 1,
          persisted.workspace_schema_revision, persisted.language_version, persisted.source,
          persisted.source_digest, persisted.compiled_json, persisted.required_capabilities,
          persisted.risk, persisted.actor_id, persisted.actor_type, Number(persisted.created_at),
        );
      })();

      const first = service.get({ workspaceId: "owner", ruleId: created.rule.id, query: { limit: 25 } });
      assert.equal(first.limit, 25);
      assert.deepEqual(first.revisions.map((revision) => revision.revision), Array.from({ length: 25 }, (_, index) => index + 1));
      assert.equal(typeof first.nextCursor, "string");

      const second = service.get({ workspaceId: "owner", ruleId: created.rule.id, query: { limit: 25, cursor: first.nextCursor! } });
      assert.deepEqual(second.revisions.map((revision) => revision.revision), Array.from({ length: 25 }, (_, index) => index + 26));
      assert.equal(typeof second.nextCursor, "string");

      assert.throws(() => service.get({ workspaceId: "owner", ruleId: created.rule.id, query: { cursor: "not canonical base64url" } }), RuleRevisionCursorError);
      assert.throws(() => service.get({ workspaceId: "owner", ruleId: "other-growth-rule", query: { cursor: first.nextCursor! } }), RuleRevisionCursorError);

      sqlite.query("UPDATE organization_rules SET latest_revision = 121 WHERE workspace_id = ? AND id = ?").run("owner", created.rule.id);
      insert.run(
        "owner", "growth-revision-121", created.rule.id, 121,
        persisted.workspace_schema_revision, persisted.language_version, persisted.source,
        persisted.source_digest, persisted.compiled_json, persisted.required_capabilities,
        persisted.risk, persisted.actor_id, persisted.actor_type, Number(persisted.created_at) + 121,
      );
      assert.throws(() => service.get({ workspaceId: "owner", ruleId: created.rule.id, query: { cursor: first.nextCursor! } }), RuleRevisionCursorStaleError);
    } finally { sqlite.close(); }
  });

  test("appends in constant-history work without parsing old revision blobs or materializing Workspace idempotency keys", () => {
    const { repository, service, sqlite } = setup();
    try {
      const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        ruleId: "constant-work-rule", idempotencyKey: "constant-work-create", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source(),
      } });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const persisted = sqlite.query("SELECT * FROM organization_rule_revisions WHERE workspace_id = ? AND rule_id = ? AND revision = 1").get("owner", created.rule.id) as PersistedRuleRevision;
      const insertRevision = sqlite.prepare(`INSERT INTO organization_rule_revisions
        (workspace_id,id,rule_id,revision,workspace_schema_revision,language_version,source,source_digest,compiled_json,required_capabilities,risk,actor_id,actor_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertChange = sqlite.prepare(`INSERT INTO organization_change_sets
        (workspace_id,id,idempotency_key,command_digest,authority_trace,resource_family,operation,command_json,workspace_revision_before,workspace_revision_after,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      sqlite.transaction(() => {
        for (let revision = 2; revision <= 300; revision += 1) {
          insertRevision.run(
            "owner", `constant-work-revision-${revision}`, created.rule.id, revision,
            persisted.workspace_schema_revision, persisted.language_version, persisted.source,
            persisted.source_digest, revision === 299 ? "not-json" : persisted.compiled_json,
            persisted.required_capabilities, persisted.risk, persisted.actor_id, persisted.actor_type,
            Number(persisted.created_at) + revision,
          );
        }
        sqlite.query("UPDATE organization_rules SET latest_revision = 300 WHERE workspace_id = ? AND id = ?").run("owner", created.rule.id);
        for (let index = 0; index < 1_000; index += 1) {
          insertChange.run("owner", `unrelated-change-${index}`, `unrelated-key-${index}`, "digest", "{}", "context", "apply", "{}", 1, 1, Number(persisted.created_at) + index);
        }
      })();

      const idempotencyPlan = sqlite.query("EXPLAIN QUERY PLAN SELECT id FROM organization_change_sets WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1")
        .all("owner", "constant-work-edit") as Array<{ detail: string }>;
      assert.match(idempotencyPlan.map((row) => row.detail).join("\n"), /organization_change_sets_workspace_idempotency_unique_idx/);
      const revisionPlan = sqlite.query("EXPLAIN QUERY PLAN SELECT * FROM organization_rule_revisions WHERE workspace_id = ? AND rule_id = ? AND revision > ? AND revision <= ? ORDER BY revision LIMIT ?")
        .all("owner", created.rule.id, 0, 300, 26) as Array<{ detail: string }>;
      assert.match(revisionPlan.map((row) => row.detail).join("\n"), /organization_rule_revisions_rule_revision_unique_idx/);

      const authority = repository.getAuthorityState("owner", { ruleId: created.rule.id, idempotencyKey: "constant-work-edit" });
      assert.equal(authority.idempotencyKeyReserved, false);
      assert.deepEqual(authority.resourceRevisions, { [`rule:${created.rule.id}`]: 300, "rule_order:owner": 2 });
      assert.equal(repository.getAuthorityState("owner", { ruleId: created.rule.id, idempotencyKey: "unrelated-key-999" }).idempotencyKeyReserved, true);

      const edited = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        ruleId: created.rule.id,
        idempotencyKey: "constant-work-edit",
        expectedRuleRevision: 300,
        workspaceSchemaRevision: 2,
        source: source("Everything else", "Constant work edit"),
      } });
      assert.equal(edited.ok, true);
      if (edited.ok) assert.equal(edited.revision.revision, 301);
    } finally { sqlite.close(); }
  }, 15_000);

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

  test("keeps G1-passing compiled revisions inactive until the later Simulation activation gate", () => {
    const { service, sqlite } = setup();
    try {
      const compiled = service.compile({
        actor: { id: "owner", type: "human" }, workspaceId: "owner",
        request: { idempotencyKey: "g1-inactive-rule", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source() },
      });

      assert.equal(compiled.ok, true);
      if (!compiled.ok) return;
      assert.equal(compiled.rule.activeRevisionId, null);
      assert.equal((sqlite.query("SELECT active_revision_id FROM organization_rules WHERE workspace_id='owner' AND id=?").get(compiled.rule.id) as { active_revision_id: string | null }).active_revision_id, null);
    } finally { sqlite.close(); }
  });

  test("fails closed on stale Workspace, Rule Set, direct Rule, collateral snapshot, and reorder tamper", () => {
    const cases: Array<[string, (input: RuleReorderInput, sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]) => void]> = [
      ["workspace race", (_input, sqlite) => { sqlite.query("UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id='owner'").run(); }],
      ["Rule Set race", (_input, sqlite) => { sqlite.query("UPDATE organization_rule_sets SET revision=revision+1 WHERE workspace_id='owner'").run(); }],
      ["direct Rule race", (input, sqlite) => { sqlite.query("UPDATE organization_rules SET latest_revision=latest_revision+1 WHERE workspace_id='owner' AND id=?").run(input.request.items[0]!.id); }],
      ["collateral position race", (input, sqlite) => { const collateral = input.plan.expected.items.find(({ id }) => id !== input.request.items[0]!.id)!; sqlite.query("UPDATE organization_rules SET position=99 WHERE workspace_id='owner' AND id=?").run(collateral.id); }],
      ["mid-flight create", (_input, sqlite) => { sqlite.query("INSERT INTO organization_rules(workspace_id,id,name,latest_revision,position) VALUES ('owner','mid-flight','Mid flight',1,3)").run(); }],
      ["command tamper", (input) => { input.command.intents[0]!.changes!.ruleCount = 99; }],
      ["envelope tamper", (input) => { input.executionContext.actor.id = "private"; }],
      ["target digest tamper", (input) => { (input.plan as { targetOrderDigest: string }).targetOrderDigest = `order-v1:${"0".repeat(64)}`; }],
      ["collateral snapshot tamper", (input) => { input.plan.expected.items[1]!.revision += 1; }],
    ];
    for (const [name, mutate] of cases) {
      let afterRace: unknown;
      const state = (sqlite: ReturnType<typeof createDatabaseClient>["sqlite"]) => ({
        workspace: sqlite.query("SELECT * FROM organization_workspace_states WHERE workspace_id='owner'").get(),
        root: sqlite.query("SELECT * FROM organization_rule_sets WHERE workspace_id='owner'").get(),
        rules: sqlite.query("SELECT id,position,latest_revision FROM organization_rules WHERE workspace_id='owner' ORDER BY id").all(),
        changes: sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE workspace_id='owner'").get(),
        actions: sqlite.query("SELECT COUNT(*) count FROM organization_change_actions WHERE workspace_id='owner'").get(),
        traces: sqlite.query("SELECT COUNT(*) count FROM organization_evaluation_traces WHERE workspace_id='owner'").get(),
      });
      const { service, sqlite } = setup({ tamperReorder(input, database) { mutate(input, database); afterRace = state(database); return input; } });
      try {
        for (let index = 0; index < 3; index += 1) {
          const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
            ruleId: `race-rule-${index}`, idempotencyKey: `race-create-${index}`, expectedRuleRevision: null, workspaceSchemaRevision: index + 1, source: source("Everything else", `Race ${index}`),
          } });
          assert.equal(created.ok, true);
        }
        assert.throws(() => service.reorder({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
          idempotencyKey: `race-reorder-${name}`, expectedWorkspaceRevision: 4, expectedRuleSetRevision: 4,
          items: [{ id: "race-rule-2", position: 0, expectedRevision: 1 }],
        } }), (error: unknown) => error instanceof Error, name);
        assert.deepEqual(state(sqlite), afterRace, name);
      } finally { sqlite.close(); }
    }
  }, 30_000);

  test("keeps 101-Rule create and reorder authority/audit evidence below 100 intents and actions", () => {
    const { service, sqlite } = setup();
    try {
      for (let index = 0; index < 101; index += 1) {
        const created = service.compile({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
          ruleId: `growth-order-${String(index).padStart(3, "0")}`, idempotencyKey: `growth-order-create-${index}`, expectedRuleRevision: null,
          workspaceSchemaRevision: index + 1, source: source("Everything else", `Growth ${index}`),
        } });
        assert.equal(created.ok, true);
      }
      const createChange = sqlite.query("SELECT id,authority_trace FROM organization_change_sets WHERE workspace_id='owner' AND idempotency_key='growth-order-create-100'").get() as { id: string; authority_trace: string };
      assert.equal((JSON.parse(createChange.authority_trace) as { requestedResourceIds: string[] }).requestedResourceIds.length, 2);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_change_actions WHERE workspace_id='owner' AND change_id=?").get(createChange.id) as { count: number }).count, 2);

      const reordered = service.reorder({ actor: { id: "owner", type: "human" }, workspaceId: "owner", request: {
        idempotencyKey: "growth-order-reorder", expectedWorkspaceRevision: 102, expectedRuleSetRevision: 102,
        items: [{ id: "growth-order-100", position: 0, expectedRevision: 1 }],
      } });
      assert.equal(reordered.items.length, 101);
      assert.equal(reordered.items[0]?.id, "growth-order-100");
      const reorderChange = sqlite.query("SELECT id,authority_trace FROM organization_change_sets WHERE workspace_id='owner' AND idempotency_key='growth-order-reorder'").get() as { id: string; authority_trace: string };
      assert.equal((JSON.parse(reorderChange.authority_trace) as { requestedResourceIds: string[] }).requestedResourceIds.length, 1);
      assert.equal((sqlite.query("SELECT COUNT(*) count FROM organization_change_actions WHERE workspace_id='owner' AND change_id=?").get(reorderChange.id) as { count: number }).count, 1);
    } finally { sqlite.close(); }
  }, 30_000);

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
