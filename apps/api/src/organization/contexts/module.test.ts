import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, threads, users } from "../../db/schema.ts";
import { createOrganization } from "../module.ts";
import { OrganizationAuthorityError } from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";
import {
  OrganizationContextsAccessError,
  OrganizationContextsConflictError,
  OrganizationContextsValidationError,
} from "./module.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "orca-context-module-"));
  tempDirectories.push(directory);
  const client = createDatabaseClient(join(directory, "organization.sqlite"));
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  client.db.insert(users).values([
    { id: "workspace_owner", email: "owner@example.com" },
    { id: "workspace_private", email: "private@example.com" },
  ]).run();
  client.db.insert(oauthAccounts).values([
    { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "a@example.com", providerId: "provider-a" },
    { id: "account_b", userId: "workspace_owner", provider: "outlook", providerEmail: "b@example.com", providerId: "provider-b" },
    { id: "account_private", userId: "workspace_private", provider: "gmail", providerEmail: "private@example.com", providerId: "provider-private" },
  ]).run();
  client.db.insert(threads).values([
    { id: "thread_incident", accountId: "account_a", providerThreadId: "incident", subject: "Production incident" },
    { id: "thread_deploy", accountId: "account_b", providerThreadId: "deploy", subject: "Deployment" },
    { id: "thread_private", accountId: "account_private", providerThreadId: "private", subject: "Private" },
  ]).run();
  const repository = createSqliteOrganizationRepository(client.db);
  const contexts = createOrganization(repository).contexts;
  assert.ok(contexts);
  const scope = {
    actor: { id: "workspace_owner", type: "human" as const },
    workspaceId: "workspace_owner",
    accountIds: ["account_a", "account_b"],
  };
  return { ...client, contexts, scope };
}

describe("Context Organization module", () => {
  test("relates one production-incident Thread to a project and customer without duplicating the Thread", () => {
    const { contexts, scope, db, sqlite } = setup();
    try {
      const definedTypes = contexts.apply({ scope, request: {
        idempotencyKey: "contexts-types-1",
        expectedWorkspaceRevision: 1,
        actions: [
          { kind: "create_context_type", name: "Project", position: 0 },
          { kind: "create_context_type", name: "Customer", position: 1 },
        ],
      } });
      const projectType = definedTypes.state.contextTypes.find((type) => type.name === "Project")!;
      const customerType = definedTypes.state.contextTypes.find((type) => type.name === "Customer")!;
      assert.notEqual(projectType.id, "Project");

      const definedRelationships = contexts.apply({ scope, request: {
        idempotencyKey: "contexts-relationship-types-1",
        expectedWorkspaceRevision: 2,
        actions: [
          { kind: "create_relationship_type", contextTypeId: projectType.id, name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 4 },
          { kind: "create_relationship_type", contextTypeId: customerType.id, name: "affects", inverseName: "has incident", direction: "thread_to_context", position: 1, maximumPerThread: 2 },
        ],
      } });
      const projectRelationshipType = definedRelationships.state.relationshipTypes.find((type) => type.contextTypeId === projectType.id)!;
      const customerRelationshipType = definedRelationships.state.relationshipTypes.find((type) => type.contextTypeId === customerType.id)!;

      const createdContexts = contexts.apply({ scope, request: {
        idempotencyKey: "contexts-instances-1",
        expectedWorkspaceRevision: 3,
        actions: [
          { kind: "create_context", contextTypeId: projectType.id, name: "Orca" },
          { kind: "create_context", contextTypeId: customerType.id, name: "Acme" },
        ],
      } });
      const project = createdContexts.state.contexts.find((context) => context.name === "Orca")!;
      const customer = createdContexts.state.contexts.find((context) => context.name === "Acme")!;

      const linked = contexts.apply({ scope, request: {
        idempotencyKey: "contexts-links-1",
        expectedWorkspaceRevision: 4,
        actions: [
          { kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: project.id, relationshipTypeId: projectRelationshipType.id, expectedThreadRevision: null },
          { kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: customer.id, relationshipTypeId: customerRelationshipType.id, expectedThreadRevision: null },
        ],
      } });

      assert.equal(linked.state.relationships.length, 2);
      assert.equal(new Set(linked.state.relationships.map((relationship) => relationship.threadId)).size, 1);
      assert.equal(linked.state.threadRevisions.find((thread) => thread.threadId === "thread_incident")?.revision, 1);
      const queried = contexts.query({ scope, query: { threadId: "thread_incident" } });
      assert.deepEqual(queried.contexts.map((context) => context.name), ["Acme", "Orca"]);
      assert.deepEqual(queried.relationships.map((relationship) => relationship.contextId).sort(), [customer.id, project.id].sort());
      const accountBOnly = { ...scope, accountIds: ["account_b"] };
      const deniedByScope = contexts.query({ scope: accountBOnly, query: {
        contextRef: { contextTypeId: projectType.id, contextId: project.id },
        relationshipTypeId: projectRelationshipType.id,
      } });
      assert.deepEqual(deniedByScope.relationships, []);
      assert.deepEqual(deniedByScope.threadRevisions, []);

      const organization = createOrganization(createSqliteOrganizationRepository(db));
      const described = organization.describe({ scope });
      assert.equal(described.workspaceSchema.revision, 3);
      assert.deepEqual(described.contexts?.semantics, { stableIdentity: true, arbitraryFields: false, contextEdges: "thread_context_only" });
      const projected = organization.query({ scope, query: {
        attention: "all",
        contextFilters: [{ context: { contextTypeId: projectType.id, contextId: project.id }, relationshipTypeId: projectRelationshipType.id }],
      } });
      assert.deepEqual(projected.threads.map((thread) => thread.id), ["thread_incident"]);
      assert.equal(projected.threads[0]?.organization.contextRelationships?.length, 2);
      assert.equal(projected.contexts?.find((context) => context.id === project.id)?.name, "Orca");
      const directionMiss = organization.query({ scope, query: {
        attention: "all",
        contextFilters: [{ context: { contextTypeId: projectType.id, contextId: project.id }, relationshipTypeId: projectRelationshipType.id, direction: "context_to_thread" }],
      } });
      assert.deepEqual(directionMiss.threads, [], "Context filters participate in the cursor/cache fingerprint");
    } finally {
      sqlite.close();
    }
  });

  test("rejects unauthorized, missing, retired, cyclic, and excessive links without partial writes", () => {
    const { contexts, scope, sqlite } = setup();
    try {
      const typeResult = contexts.apply({ scope, request: {
        idempotencyKey: "guard-type-1", expectedWorkspaceRevision: 1,
        actions: [{ kind: "create_context_type", name: "Project", position: 0 }],
      } });
      const contextType = typeResult.state.contextTypes[0]!;
      const relationshipTypeResult = contexts.apply({ scope, request: {
        idempotencyKey: "guard-rel-type-1", expectedWorkspaceRevision: 2,
        actions: [{ kind: "create_relationship_type", contextTypeId: contextType.id, name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 1 }],
      } });
      const relationshipType = relationshipTypeResult.state.relationshipTypes[0]!;
      const contextResult = contexts.apply({ scope, request: {
        idempotencyKey: "guard-contexts-1", expectedWorkspaceRevision: 3,
        actions: [
          { kind: "create_context", contextTypeId: contextType.id, name: "Orca" },
          { kind: "create_context", contextTypeId: contextType.id, name: "Apollo" },
        ],
      } });
      const [apollo, orca] = [...contextResult.state.contexts].sort((left, right) => left.name.localeCompare(right.name));
      const linked = contexts.apply({ scope, request: {
        idempotencyKey: "guard-link-1", expectedWorkspaceRevision: 4,
        actions: [{ kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: orca!.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }],
      } });

      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "guard-fanout-1", expectedWorkspaceRevision: 5,
        actions: [
          { kind: "update_context", contextId: orca!.id, patch: { name: "Changed" }, expectedRevision: 1 },
          { kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: apollo!.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: 1 },
        ],
      } }), (error) => error instanceof OrganizationContextsValidationError && error.code === "fan_out_exceeded");
      assert.equal(contexts.query({ scope, query: { contextRef: { contextTypeId: contextType.id, contextId: orca!.id }, includeRetired: true } }).contexts[0]?.name, "Orca");

      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "guard-private-1", expectedWorkspaceRevision: 5,
        actions: [{ kind: "link_thread_context", accountId: "account_private", threadId: "thread_private", contextId: apollo!.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }],
      } }), OrganizationContextsAccessError);
      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "guard-missing-1", expectedWorkspaceRevision: 5,
        actions: [{ kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: "missing", relationshipTypeId: relationshipType.id, expectedThreadRevision: 1 }],
      } }), (error) => error instanceof OrganizationContextsValidationError && error.code === "missing_reference");
      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "guard-cycle-1", expectedWorkspaceRevision: 5,
        actions: [{ kind: "link_thread_context", accountId: "account_a", threadId: apollo!.id, contextId: apollo!.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }],
      } }), (error) => error instanceof OrganizationContextsValidationError && error.code === "cycle_detected");
      const retired = contexts.apply({ scope, request: {
        idempotencyKey: "guard-retire-linked-1", expectedWorkspaceRevision: 5,
        actions: [{ kind: "update_context", contextId: orca!.id, patch: { retired: true }, expectedRevision: 1 }],
      } });
      assert.equal(retired.state.relationships.length, 1);
      assert.equal(contexts.query({ scope, query: { includeRetired: true, contextRef: { contextTypeId: contextType.id, contextId: orca!.id } } }).contexts[0]?.retiredAt !== null, true);
      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "guard-link-retired-1", expectedWorkspaceRevision: 6,
        actions: [{ kind: "link_thread_context", accountId: "account_b", threadId: "thread_deploy", contextId: orca!.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }],
      } }), (error) => error instanceof OrganizationContextsValidationError && error.code === "retired_resource");
      const unlinked = contexts.apply({ scope, request: {
        idempotencyKey: "guard-unlink-retired-1", expectedWorkspaceRevision: 6,
        actions: [{ kind: "unlink_thread_context", accountId: "account_a", threadId: "thread_incident", relationshipId: linked.state.relationships[0]!.id, expectedThreadRevision: 1, expectedRelationshipRevision: 1 }],
      } });
      assert.equal(unlinked.state.relationships.length, 0, "retired history remains unlinkable without deleting the Context");
      assert.equal(contexts.query({ scope, query: {} }).workspaceRevision, 7);
    } finally {
      sqlite.close();
    }
  });

  test("replays identical idempotent changes and causally reverts a rename", () => {
    const { contexts, scope, sqlite } = setup();
    try {
      const created = contexts.apply({ scope, request: {
        idempotencyKey: "revert-type-1", expectedWorkspaceRevision: 1,
        actions: [{ kind: "create_context_type", name: "Project", position: 0 }],
      } });
      const contextType = created.state.contextTypes[0]!;
      const replay = contexts.apply({ scope, request: {
        idempotencyKey: "revert-type-1", expectedWorkspaceRevision: 1,
        actions: [{ kind: "create_context_type", name: "Project", position: 0 }],
      } });
      assert.equal(replay.change.id, created.change.id);
      assert.throws(() => contexts.apply({ scope, request: {
        idempotencyKey: "revert-type-1", expectedWorkspaceRevision: 2,
        actions: [{ kind: "update_context_type", contextTypeId: contextType.id, patch: { name: "Wrong" }, expectedRevision: 1 }],
      } }), OrganizationContextsConflictError);

      const renamed = contexts.apply({ scope, request: {
        idempotencyKey: "rename-type-1", expectedWorkspaceRevision: 2,
        actions: [{ kind: "update_context_type", contextTypeId: contextType.id, patch: { name: "Initiative" }, expectedRevision: 1 }],
      } });
      assert.equal(renamed.state.contextTypes[0]?.name, "Initiative");
      const reverted = contexts.revert({ scope, request: {
        idempotencyKey: "revert-rename-1", changeId: renamed.change.id, expectedWorkspaceRevision: 3,
      } });
      assert.equal(reverted.state.contextTypes[0]?.name, "Project");
      assert.equal(reverted.change.revertsChangeId, renamed.change.id);
      assert.equal(contexts.audit({ scope })[1]?.revertedByChangeId, reverted.change.id);
    } finally {
      sqlite.close();
    }
  });

  test("revalidates the exact typed action payload inside the SQLite transaction", () => {
    const { scope, db, sqlite } = setup();
    try {
      const baseRepository = createSqliteOrganizationRepository(db);
      const baseContexts = baseRepository.contexts!;
      const tamperingRepository = {
        ...baseRepository,
        contexts: {
          ...baseContexts,
          apply(input: Parameters<typeof baseContexts.apply>[0]) {
            const actions = input.request.actions.map((action, index) => index === 0 && action.kind === "create_context_type" ? { ...action, name: "Tampered after authority" } : action);
            return baseContexts.apply({ ...input, request: { ...input.request, actions } });
          },
        },
      };
      const tampered = createOrganization(tamperingRepository).contexts!;
      assert.throws(() => tampered.apply({ scope, request: {
        idempotencyKey: "tamper-context-1", expectedWorkspaceRevision: 1,
        actions: [{ kind: "create_context_type", name: "Project", position: 0 }],
      } }), (error) => error instanceof OrganizationAuthorityError && error.code === "invalid_request" && /exact ordered typed Context actions/.test(error.message));

      const applied = createOrganization(baseRepository).contexts!.apply({ scope, request: {
        idempotencyKey: "tamper-context-1", expectedWorkspaceRevision: 1,
        actions: [{ kind: "create_context_type", name: "Project", position: 0 }],
      } });
      assert.equal(applied.state.contextTypes[0]?.name, "Project");
    } finally {
      sqlite.close();
    }
  });
});
