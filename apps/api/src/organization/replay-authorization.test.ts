import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { OrganizationCapabilitySnapshot } from "@orca/shared";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, organizationChangeSets, users } from "../db/schema.ts";
import type { OrganizationAgentCapabilitySource, OrganizationLiveCapability } from "./agent-capability.ts";
import { OrganizationCollectionsPinsAccessError, OrganizationCollectionsPinsConflictError, createOrganizationCollectionsPins } from "./collections-pins/module.ts";
import { createSqliteOrganizationCollectionsPinsRepository } from "./collections-pins/sqlite-repository.ts";
import { OrganizationContextsAccessError, OrganizationContextsConflictError, createOrganizationContexts } from "./contexts/module.ts";
import { createSqliteOrganizationContextsRepository } from "./contexts/sqlite-repository.ts";
import { OrganizationViewAccessError, OrganizationViewConflictError, createOrganizationViews } from "./views/module.ts";
import { createSqliteOrganizationViewsRepository } from "./views/sqlite-repository.ts";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-replay-authorization-"));
  directories.push(directory);
  const path = join(directory, "organization.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values({ id: "workspace", email: "owner@example.com" }).run();
  client.db.insert(oauthAccounts).values({ id: "account", userId: "workspace", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider" }).run();
  const actor = { id: "mcp-client", type: "agent" as const };
  const scope = { actor, workspaceId: "workspace", accountIds: ["account"] };
  const baseline: OrganizationCapabilitySnapshot = {
    id: "persisted-grant", revision: 1, actor,
    scope: { workspaceId: "workspace", accountIds: ["account"] },
    operations: ["describe", "query", "simulate", "apply", "revert"],
    resourceFamilies: ["view", "collection", "shortcut", "saved_query", "context", "rule"],
    actionFamilies: ["organization_read", "organization_structure"],
  };
  let current: OrganizationLiveCapability | null = { snapshot: baseline, revokedAt: null };
  let transactionLoads = 0;
  const source: OrganizationAgentCapabilitySource = {
    load(_scope, executor) { if (executor) transactionLoads += 1; return current; },
  };
  const reset = () => { current = { snapshot: structuredClone(baseline), revokedAt: null }; };
  const revoke = () => { current = { snapshot: structuredClone(baseline), revokedAt: "2026-08-26T00:00:00.000Z" }; };
  const denyCases: Array<[string, () => void]> = [
    ["revocation", () => { current = { snapshot: structuredClone(baseline), revokedAt: "2026-08-26T00:00:00.000Z" }; }],
    ["operation downgrade", () => { const snapshot = structuredClone(baseline); snapshot.operations = ["query"]; current = { snapshot, revokedAt: null }; }],
    ["action downgrade", () => { const snapshot = structuredClone(baseline); snapshot.actionFamilies = ["organization_read"]; current = { snapshot, revokedAt: null }; }],
    ["account removal", () => { current = null; }],
    ["actor mismatch", () => { const snapshot = structuredClone(baseline); snapshot.actor.id = "other-client"; current = { snapshot, revokedAt: null }; }],
    ["workspace mismatch", () => { const snapshot = structuredClone(baseline); snapshot.scope.workspaceId = "other-workspace"; current = { snapshot, revokedAt: null }; }],
  ];
  const count = (key: string) => client.db.select().from(organizationChangeSets).all().filter((row) => row.idempotencyKey === key).length;
  return { ...client, path, scope, source, reset, revoke, denyCases, count, transactionLoads: () => transactionLoads };
}

describe("BRE-318 transaction-live agent replay authorization", () => {
  test("View duplicate return reauthorizes after another connection commits and revokes between preflight and transaction entry", () => {
    const f = fixture();
    const competing = createDatabaseClient(f.path);
    try {
      const primary = createSqliteOrganizationViewsRepository(f.sqlite);
      const secondary = createSqliteOrganizationViewsRepository(competing.sqlite);
      let interleaved = false;
      const repository = {
        ...primary,
        create(input: Parameters<typeof primary.create>[0]) {
          if (!interleaved) {
            interleaved = true;
            secondary.create(input);
            f.revoke();
          }
          return primary.create(input);
        },
      };
      const service = createOrganizationViews(repository, { agentCapabilitySource: f.source, newViewId: () => "raced-view", newChangeId: () => "raced-change", now: () => new Date("2026-08-26T00:00:00.000Z") });
      const request = { idempotencyKey: "view-duplicate-race", expectedWorkspaceRevision: 1, name: "Raced", position: 0, definition: { revision: 1, accountIds: ["account"] } };
      assert.throws(() => service.create({ scope: f.scope, request }), OrganizationViewAccessError);
      assert.equal(interleaved, true);
      assert.equal(f.count(request.idempotencyKey), 1);
    } finally {
      competing.sqlite.close();
      f.sqlite.close();
    }
  });

  test("View replay is identical and write-free only while the exact persisted grant remains live", () => {
    const f = fixture();
    try {
      const repository = createSqliteOrganizationViewsRepository(f.sqlite);
      const service = createOrganizationViews(repository, { agentCapabilitySource: f.source, newViewId: () => "view", newChangeId: () => "view-change", now: () => new Date("2026-08-26T00:00:00.000Z") });
      const request = { idempotencyKey: "view-replay", expectedWorkspaceRevision: 1, name: "Replay", position: 0, definition: { revision: 1, accountIds: ["account"] } };
      const first = service.create({ scope: f.scope, request });
      assert.deepEqual(service.create({ scope: f.scope, request }), first);
      assert.equal(f.count(request.idempotencyKey), 1);
      assert.throws(() => createOrganizationViews(repository).create({ scope: f.scope, request }), OrganizationViewAccessError);
      assert.throws(() => service.create({ scope: f.scope, request: { ...request, name: "Conflict" } }), OrganizationViewConflictError);
      for (const [name, deny] of f.denyCases) { f.reset(); deny(); assert.throws(() => service.create({ scope: f.scope, request }), OrganizationViewAccessError, name); assert.equal(f.count(request.idempotencyKey), 1, name); }
      assert.ok(f.transactionLoads() >= 2);
    } finally { f.sqlite.close(); }
  });

  test("Collection/Pin replay is identical and write-free only while the exact persisted grant remains live", () => {
    const f = fixture();
    try {
      const repository = createSqliteOrganizationCollectionsPinsRepository(f.db);
      const service = createOrganizationCollectionsPins(repository, { agentCapabilitySource: f.source, newChangeId: () => "collection-change", newResourceId: () => "collection", now: () => new Date("2026-08-26T00:00:00.000Z") });
      const request = { idempotencyKey: "collection-replay", change: { kind: "collection" as const, action: "create" as const, accountId: "account", collection: { name: "Replay", color: "#336699" } } };
      const first = service.apply({ scope: f.scope, request, expectedWorkspaceRevision: 1 });
      assert.deepEqual(service.apply({ scope: f.scope, request, expectedWorkspaceRevision: 1 }), first);
      assert.equal(f.count(request.idempotencyKey), 1);
      assert.throws(() => createOrganizationCollectionsPins(repository).apply({ scope: f.scope, request, expectedWorkspaceRevision: 1 }), OrganizationCollectionsPinsAccessError);
      assert.throws(() => service.apply({ scope: f.scope, request: { ...request, change: { ...request.change, collection: { ...request.change.collection, name: "Conflict" } } }, expectedWorkspaceRevision: 1 }), OrganizationCollectionsPinsConflictError);
      for (const [name, deny] of f.denyCases) { f.reset(); deny(); assert.throws(() => service.apply({ scope: f.scope, request, expectedWorkspaceRevision: 1 }), OrganizationCollectionsPinsAccessError, name); assert.equal(f.count(request.idempotencyKey), 1, name); }
      assert.ok(f.transactionLoads() >= 2);
    } finally { f.sqlite.close(); }
  });

  test("Collection/Pin transaction duplicate rejects cached authority committed by another Actor", () => {
    const f = fixture();
    const competing = createDatabaseClient(f.path);
    try {
      const otherActor = { id: "other-mcp-client", type: "agent" as const };
      const otherSnapshot = { ...structuredClone((f.source.load(f.scope)!).snapshot), id: "other-grant", actor: otherActor };
      const otherScope = { ...f.scope, actor: otherActor };
      const otherSource: OrganizationAgentCapabilitySource = { load: () => ({ snapshot: otherSnapshot, revokedAt: null }) };
      const secondary = createOrganizationCollectionsPins(createSqliteOrganizationCollectionsPinsRepository(competing.db), {
        agentCapabilitySource: otherSource, newChangeId: () => "other-change", newResourceId: () => "shared-collection", now: () => new Date("2026-08-26T00:00:00.000Z"),
      });
      const primary = createSqliteOrganizationCollectionsPinsRepository(f.db);
      const originalApply = primary.apply.bind(primary);
      let interleaved = false;
      primary.apply = (input) => {
        if (!interleaved) {
          interleaved = true;
          secondary.apply({ scope: otherScope, request, expectedWorkspaceRevision: 1 });
        }
        return originalApply(input);
      };
      const service = createOrganizationCollectionsPins(primary, { agentCapabilitySource: f.source, newChangeId: () => "primary-change", newResourceId: () => "shared-collection", now: () => new Date("2026-08-26T00:00:00.000Z") });
      const request = { idempotencyKey: "collection-actor-race", change: { kind: "collection" as const, action: "create" as const, accountId: "account", collection: { name: "Raced", color: "#336699" } } };
      assert.throws(() => service.apply({ scope: f.scope, request, expectedWorkspaceRevision: 1 }), OrganizationCollectionsPinsAccessError);
      assert.equal(interleaved, true);
      assert.equal(f.count(request.idempotencyKey), 1);
    } finally { competing.sqlite.close(); f.sqlite.close(); }
  });

  test("Context replay is identical and write-free only while the exact persisted grant remains live", () => {
    const f = fixture();
    try {
      const repository = createSqliteOrganizationContextsRepository(f.db);
      const service = createOrganizationContexts(repository, { agentCapabilitySource: f.source, newId: (() => { let id = 0; return () => `context-${++id}`; })(), now: () => new Date("2026-08-26T00:00:00.000Z") });
      const request = { idempotencyKey: "context-replay", expectedWorkspaceRevision: 1, actions: [{ kind: "create_context_type" as const, name: "Project", position: 0 }] };
      const first = service.apply({ scope: f.scope, request });
      assert.deepEqual(service.apply({ scope: f.scope, request }), first);
      assert.equal(f.count(request.idempotencyKey), 1);
      assert.throws(() => createOrganizationContexts(repository).apply({ scope: f.scope, request }), OrganizationContextsAccessError);
      assert.throws(() => service.apply({ scope: f.scope, request: { ...request, actions: [{ ...request.actions[0], name: "Conflict" }] } }), OrganizationContextsConflictError);
      for (const [name, deny] of f.denyCases) { f.reset(); deny(); assert.throws(() => service.apply({ scope: f.scope, request }), OrganizationContextsAccessError, name); assert.equal(f.count(request.idempotencyKey), 1, name); }
      assert.ok(f.transactionLoads() >= 2);
    } finally { f.sqlite.close(); }
  });
});
