import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { organizationViewBounds, type OrganizationView } from "@orca/shared";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, threads, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { createOrganizationViews } from "./module.ts";
import { buildOrganizationViewDetailQuery, buildOrganizationViewPageKeyQuery, type OrganizationViewPageKey } from "./sqlite-repository.ts";
import { createSqliteOrganizationViewsRepository } from "./sqlite-repository.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

async function setup() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-live-views-verification-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "views.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
  client.db.insert(oauthAccounts).values([
    { id: "account_a", userId: "owner", provider: "gmail", providerEmail: "a@example.com", providerId: "a" },
    { id: "account_b", userId: "owner", provider: "outlook", providerEmail: "b@example.com", providerId: "b" },
    { id: "account_foreign", userId: "foreign", provider: "gmail", providerEmail: "foreign@example.com", providerId: "foreign" },
  ]).run();
  const tied = new Date("2026-08-25T18:00:00.000Z");
  client.db.insert(threads).values([
    { id: "thread_b", accountId: "account_a", providerThreadId: "a-b", subject: "A / B", latestReceivedAt: tied, createdAt: tied },
    { id: "thread_a", accountId: "account_a", providerThreadId: "a-a", subject: "A / A", latestReceivedAt: tied, createdAt: tied },
    { id: "thread_c", accountId: "account_b", providerThreadId: "b-c", subject: "B / C", latestReceivedAt: tied, createdAt: tied },
    { id: "thread_created", accountId: "account_b", providerThreadId: "b-created", subject: "Created fallback", latestReceivedAt: null, createdAt: new Date("2026-08-24T18:00:00.000Z") },
    { id: "thread_foreign", accountId: "account_foreign", providerThreadId: "foreign", subject: "Foreign", latestReceivedAt: tied, createdAt: tied },
  ]).run();

  const sqlite = client.sqlite;
  const now = tied.getTime();
  const ownerLane = (sqlite.query("SELECT id FROM organization_lanes WHERE workspace_id='owner' ORDER BY position,id LIMIT 1").get() as { id: string }).id;
  const foreignLane = (sqlite.query("SELECT id FROM organization_lanes WHERE workspace_id='foreign' ORDER BY position,id LIMIT 1").get() as { id: string }).id;
  sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("facet_owner", "owner", "Owner facet", 0, JSON.stringify({ kind: "text", maxLength: 200 }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
  sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("facet_foreign", "foreign", "Foreign facet", 0, JSON.stringify({ kind: "text", maxLength: 200 }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
  sqlite.query("INSERT INTO organization_workflow_states (id,workspace_id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("workflow_owner", "owner", "Owner state", 0, 1, now, now);
  sqlite.query("INSERT INTO organization_workflow_states (id,workspace_id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("workflow_foreign", "foreign", "Foreign state", 0, 1, now, now);
  for (const workspaceId of ["owner", "foreign"]) {
    const suffix = workspaceId === "owner" ? "owner" : "foreign";
    sqlite.query("INSERT INTO organization_context_types (workspace_id,id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(workspaceId, `context_type_${suffix}`, `${suffix} type`, 0, 1, now, now);
    sqlite.query("INSERT INTO organization_context_relationship_types (workspace_id,id,context_type_id,name,inverse_name,direction,position,maximum_per_thread,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(workspaceId, `relationship_${suffix}`, `context_type_${suffix}`, "concerns", "has work", "thread_to_context", 0, 10, 1, now, now);
    sqlite.query("INSERT INTO organization_contexts (workspace_id,id,context_type_id,name,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(workspaceId, `context_${suffix}`, `context_type_${suffix}`, `${suffix} context`, 1, now, now);
  }

  const session = await createSession(client.db, "owner");
  sqlite.close();
  const app = createApp({ dbFactory: () => createDatabaseClient(path) });
  const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
  return { app, headers, ownerLane, foreignLane, path };
}

async function createView(app: ReturnType<typeof createApp>, headers: Record<string, string>, body: unknown) {
  const input = body as Record<string, unknown>;
  const list = await app.request("/v1/organization/views", { headers });
  const workspaceRevision = (await list.json()).workspaceRevision as number;
  const response = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({
    idempotencyKey: `verification:create:${crypto.randomUUID()}`,
    expectedWorkspaceRevision: workspaceRevision,
    ...input,
  }) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as OrganizationView;
}

describe("BRE-313 independent View lifecycle verification", () => {
  test("edits definitions, reorders atomically, and removes with optimistic revisions", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const first = await createView(app, headers, { name: "First", position: 0, definition: { revision: 1 } });
    const second = await createView(app, headers, { name: "Second", position: 1, definition: { revision: 1 } });

    const edited = await app.request(`/v1/organization/views/${first.id}`, { method: "PATCH", headers, body: JSON.stringify({ idempotencyKey: "lifecycle-edit", expectedWorkspaceRevision: 3, expectedRevision: 1, patch: { definition: { revision: 1, thread: { readState: "unread" } } } }) });
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).definition.thread, { readState: "unread" });

    const reordered = await app.request("/v1/organization/views/reorder", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "lifecycle-reorder", expectedWorkspaceRevision: 4, items: [
      { id: first.id, expectedRevision: 2, position: 1 },
      { id: second.id, expectedRevision: 1, position: 0 },
    ] }) });
    assert.equal(reordered.status, 200, await reordered.clone().text());
    const reorderedBody = await reordered.json();
    assert.deepEqual(reorderedBody.items.map((view: { id: string }) => view.id), [second.id, first.id]);

    const beforeConflict = createDatabaseClient(path);
    const snapshot = beforeConflict.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY id").all();
    beforeConflict.sqlite.close();
    const stale = await app.request("/v1/organization/views/reorder", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "lifecycle-stale-reorder", expectedWorkspaceRevision: 5, items: [
      { id: first.id, expectedRevision: 2, position: 0 },
      { id: second.id, expectedRevision: 2, position: 1 },
    ] }) });
    assert.equal(stale.status, 409);
    const afterConflict = createDatabaseClient(path);
    assert.deepEqual(afterConflict.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY id").all(), snapshot);
    afterConflict.sqlite.close();

    const staleRemove = await app.request(`/v1/organization/views/${second.id}?expectedRevision=1&expectedWorkspaceRevision=5&idempotencyKey=lifecycle-stale-remove`, { method: "DELETE", headers });
    assert.equal(staleRemove.status, 409);
    assert.equal((await app.request(`/v1/organization/views/${second.id}/results`, { headers })).status, 200);
    const removed = await app.request(`/v1/organization/views/${second.id}?expectedRevision=2&expectedWorkspaceRevision=5&idempotencyKey=lifecycle-remove`, { method: "DELETE", headers });
    assert.equal(removed.status, 204);
    assert.equal((await app.request(`/v1/organization/views/${second.id}/results`, { headers })).status, 404);
  });

  test("keeps one canonical Workspace ordering across arbitrary positions and partial reorder", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const assertCanonical = () => {
      const verify = createDatabaseClient(path);
      const rows = verify.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY position").all() as Array<{ id: string; position: number; revision: number }>;
      assert.deepEqual(rows.map((row) => row.position), rows.map((_, index) => index));
      assert.equal(new Set(rows.map((row) => row.position)).size, rows.length);
      verify.sqlite.close();
      return rows;
    };

    const first = await createView(app, headers, { name: "First", position: 0, definition: { revision: 1 } });
    const second = await createView(app, headers, { name: "Second", position: 0, definition: { revision: 1 } });
    const third = await createView(app, headers, { name: "Third", position: 99, definition: { revision: 1 } });
    const fourth = await createView(app, headers, { name: "Fourth", position: 1, definition: { revision: 1 } });
    let rows = assertCanonical();
    assert.deepEqual(rows.map((row) => row.id), [second.id, fourth.id, first.id, third.id]);

    const firstRevision = rows.find((row) => row.id === first.id)!.revision;
    const moved = await app.request(`/v1/organization/views/${first.id}`, { method: "PATCH", headers, body: JSON.stringify({ idempotencyKey: "position-move", expectedWorkspaceRevision: 5, expectedRevision: firstRevision, patch: { position: 99 } }) });
    assert.equal(moved.status, 200, await moved.clone().text());
    rows = assertCanonical();
    assert.deepEqual(rows.map((row) => row.id), [second.id, fourth.id, third.id, first.id]);

    const secondRow = rows.find((row) => row.id === second.id)!;
    const thirdRow = rows.find((row) => row.id === third.id)!;
    const partial = await app.request("/v1/organization/views/reorder", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "position-partial", expectedWorkspaceRevision: 6, items: [
      { id: third.id, expectedRevision: thirdRow.revision, position: 0 },
      { id: second.id, expectedRevision: secondRow.revision, position: 3 },
    ] }) });
    assert.equal(partial.status, 200, await partial.clone().text());
    rows = assertCanonical();
    assert.deepEqual(rows.map((row) => row.id), [third.id, fourth.id, first.id, second.id]);

    const removeTarget = rows.find((row) => row.id === fourth.id)!;
    const removed = await app.request(`/v1/organization/views/${fourth.id}?expectedRevision=${removeTarget.revision}&expectedWorkspaceRevision=7&idempotencyKey=position-remove`, { method: "DELETE", headers });
    assert.equal(removed.status, 204, await removed.clone().text());
    assert.deepEqual(assertCanonical().map((row) => row.id), [third.id, first.id, second.id]);

    const audit = createDatabaseClient(path);
    const changes = audit.sqlite.query("SELECT id,authority_trace FROM organization_change_sets WHERE workspace_id='owner' AND resource_family='view' ORDER BY workspace_revision_before").all() as Array<{ id: string; authority_trace: string }>;
    for (const change of changes) {
      const trace = JSON.parse(change.authority_trace) as { requestedResourceIds: string[]; expectedRevisions: { resources: Record<string, number> } };
      const actions = audit.sqlite.query("SELECT resource_id,before_json FROM organization_change_actions WHERE workspace_id='owner' AND change_id=? ORDER BY position").all(change.id) as Array<{ resource_id: string; before_json: string | null }>;
      for (const action of actions) {
        assert.ok(trace.requestedResourceIds.includes(action.resource_id), `${change.id} mutated ${action.resource_id} outside its authorized command`);
        if (action.before_json !== null) {
          assert.equal(trace.expectedRevisions.resources[action.resource_id], (JSON.parse(action.before_json) as OrganizationView).revision, `${change.id} did not CAS ${action.resource_id}`);
        }
      }
    }
    audit.sqlite.close();
  });

  test("CAS-protects every collateral View before lifecycle canonicalization with zero command writes", { timeout: 30_000 }, async () => {
    for (const operation of ["create", "update", "reorder", "remove"] as const) {
      const { app, headers, path } = await setup();
      const first = await createView(app, headers, { name: `${operation} first`, position: 0, definition: { revision: 1 } });
      const second = await createView(app, headers, { name: `${operation} second`, position: 1, definition: { revision: 1 } });
      const third = await createView(app, headers, { name: `${operation} third`, position: 2, definition: { revision: 1 } });
      const client = createDatabaseClient(path);
      const base = createSqliteOrganizationViewsRepository(client.sqlite);
      const injectCollateralRace = () => client.sqlite.query("UPDATE organization_views SET revision=revision+1 WHERE workspace_id='owner' AND id=?").run(second.id);
      const repository = {
        ...base,
        create(input: Parameters<typeof base.create>[0]) { if (operation === "create") injectCollateralRace(); return base.create(input); },
        update(input: Parameters<typeof base.update>[0]) { if (operation === "update") injectCollateralRace(); return base.update(input); },
        reorder(input: Parameters<typeof base.reorder>[0]) { if (operation === "reorder") injectCollateralRace(); return base.reorder(input); },
        remove(input: Parameters<typeof base.remove>[0]) { if (operation === "remove") injectCollateralRace(); return base.remove(input); },
      };
      const organization = createOrganizationViews(repository, { newViewId: () => `view_${operation}_race`, newChangeId: () => `change_${operation}_race` });
      const before = client.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY position").all() as Array<{ id: string; position: number; revision: number }>;
      const beforeWorkspaceRevision = (client.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id='owner'").get() as { revision: number }).revision;
      const beforeChanges = (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE workspace_id='owner'").get() as { count: number }).count;
      const beforeActions = (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE workspace_id='owner'").get() as { count: number }).count;
      const scope = { workspaceId: "owner", accountIds: ["account_a", "account_b"], actor: { id: "owner", type: "human" as const } };

      assert.throws(() => {
        if (operation === "create") organization.create({ scope, request: { idempotencyKey: "race-create", expectedWorkspaceRevision: 4, name: "Racing create", position: 0, definition: { revision: 1 } } });
        if (operation === "update") organization.update({ scope, viewId: first.id, request: { idempotencyKey: "race-update", expectedWorkspaceRevision: 4, expectedRevision: first.revision, patch: { position: 2 } } });
        if (operation === "reorder") organization.reorder({ scope, request: { idempotencyKey: "race-reorder", expectedWorkspaceRevision: 4, items: [
          { id: first.id, expectedRevision: first.revision, position: 2 },
          { id: third.id, expectedRevision: third.revision, position: 1 },
        ] } });
        if (operation === "remove") organization.remove({ scope, viewId: first.id, request: { idempotencyKey: "race-remove", expectedWorkspaceRevision: 4, expectedRevision: first.revision } });
      }, /revision|stale|changed/i, operation);

      const after = client.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY position").all() as Array<{ id: string; position: number; revision: number }>;
      assert.deepEqual(after, before.map((view) => view.id === second.id ? { ...view, revision: view.revision + 1 } : view), operation);
      assert.equal((client.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id='owner'").get() as { revision: number }).revision, beforeWorkspaceRevision, operation);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE workspace_id='owner'").get() as { count: number }).count, beforeChanges, operation);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE workspace_id='owner'").get() as { count: number }).count, beforeActions, operation);
      client.sqlite.close();
    }
  });

  test("routes every View lifecycle mutation through one atomic Organization authority change set", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const list = await app.request("/v1/organization/views", { headers });
    assert.equal((await list.json()).workspaceRevision, 1);
    const createRequest = { idempotencyKey: "view-authority-create", expectedWorkspaceRevision: 1, name: "Authorized", position: 0, definition: { revision: 1 } };
    const createdResponse = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify(createRequest) });
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const created = await createdResponse.json() as OrganizationView;
    const replay = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify(createRequest) });
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), created);
    const conflictingReuse = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ ...createRequest, name: "Substituted" }) });
    assert.equal(conflictingReuse.status, 409);
    const stale = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ ...createRequest, idempotencyKey: "view-authority-stale", name: "Stale" }) });
    assert.equal(stale.status, 409);

    const updateRequest = { idempotencyKey: "view-authority-update", expectedWorkspaceRevision: 2, expectedRevision: 1, patch: { name: "Authorized edit" } };
    const updatedResponse = await app.request(`/v1/organization/views/${created.id}`, { method: "PATCH", headers, body: JSON.stringify(updateRequest) });
    assert.equal(updatedResponse.status, 200, await updatedResponse.clone().text());
    const updated = await updatedResponse.json() as OrganizationView;
    assert.equal(updated.revision, 2);
    assert.deepEqual(await (await app.request(`/v1/organization/views/${created.id}`, { method: "PATCH", headers, body: JSON.stringify(updateRequest) })).json(), updated);

    const removeUrl = `/v1/organization/views/${created.id}?expectedRevision=2&expectedWorkspaceRevision=3&idempotencyKey=view-authority-remove`;
    assert.equal((await app.request(removeUrl, { method: "DELETE", headers })).status, 204);
    assert.equal((await app.request(removeUrl, { method: "DELETE", headers })).status, 204);

    const verify = createDatabaseClient(path);
    assert.equal((verify.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id='owner'").get() as { revision: number }).revision, 4);
    const changes = verify.sqlite.query("SELECT idempotency_key,resource_family,operation,workspace_revision_before,workspace_revision_after,authority_trace FROM organization_change_sets WHERE workspace_id='owner' ORDER BY workspace_revision_before").all() as Array<Record<string, unknown>>;
    assert.deepEqual(changes.map((change) => [change.idempotency_key, change.resource_family, change.operation, change.workspace_revision_before, change.workspace_revision_after]), [
      ["view-authority-create", "view", "apply", 1, 2],
      ["view-authority-update", "view", "apply", 2, 3],
      ["view-authority-remove", "view", "apply", 3, 4],
    ]);
    for (const change of changes) {
      const trace = JSON.parse(change.authority_trace as string) as { actor: { id: string; type: string }; capabilitySnapshot: { id: string }; requestedResourceFamilies: string[]; decision: string };
      assert.deepEqual(trace.actor, { id: "owner", type: "human" });
      assert.equal(trace.capabilitySnapshot.id, "first_party:human:owner");
      assert.deepEqual(trace.requestedResourceFamilies, ["view"]);
      assert.equal(trace.decision, "allowed");
    }
    assert.ok((verify.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE workspace_id='owner' AND resource_family='view'").get() as { count: number }).count >= 3);
    verify.sqlite.close();
  });

  test("fails closed with zero writes when an authorized View envelope is tampered before commit", { timeout: 30_000 }, async () => {
    const { path } = await setup();
    const cases: Array<[string, (authorization: any) => void]> = [
      ["actor", (authorization) => { authorization.executionContext.actor.id = "foreign"; }],
      ["workspace", (authorization) => { authorization.executionContext.workspaceId = "foreign"; }],
      ["idempotency", (authorization) => { authorization.executionContext.idempotencyKey = "substituted"; }],
      ["revision", (authorization) => { authorization.executionContext.expectedRevisions.workspace = 2; }],
      ["command", (authorization) => { authorization.command.intents[0].changes = { substituted: true }; }],
    ];
    for (const [name, tamper] of cases) {
      const client = createDatabaseClient(path);
      const beforeCounts = {
        views: (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count,
        changes: (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE workspace_id='owner'").get() as { count: number }).count,
        actions: (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE workspace_id='owner'").get() as { count: number }).count,
        workspaces: (client.sqlite.query("SELECT COUNT(*) AS count FROM organization_workspace_states WHERE workspace_id='owner'").get() as { count: number }).count,
      };
      const base = createSqliteOrganizationViewsRepository(client.sqlite);
      const repository = {
        ...base,
        create(input: Parameters<typeof base.create>[0]) {
          const authorization = structuredClone(input.authorization);
          tamper(authorization);
          return base.create({ ...input, authorization });
        },
      };
      const organization = createOrganizationViews(repository, { newViewId: () => `view_tamper_${name}`, newChangeId: () => `change_tamper_${name}` });
      assert.throws(() => organization.create({
        scope: { workspaceId: "owner", accountIds: ["account_a", "account_b"], actor: { id: "owner", type: "human" } },
        request: { idempotencyKey: `tamper-${name}`, expectedWorkspaceRevision: 1, name: `Tamper ${name}`, definition: { revision: 1 } },
      }), /modified|validation|scope|Actor|Workspace|command|authority/i, name);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count, beforeCounts.views, name);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE workspace_id='owner'").get() as { count: number }).count, beforeCounts.changes, name);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_actions WHERE workspace_id='owner'").get() as { count: number }).count, beforeCounts.actions, name);
      assert.equal((client.sqlite.query("SELECT COUNT(*) AS count FROM organization_workspace_states WHERE workspace_id='owner'").get() as { count: number }).count, beforeCounts.workspaces, name);
      client.sqlite.close();
    }
  });

  test("rejects every foreign stable resource family without persisting or revising a View", { timeout: 30_000 }, async () => {
    const { app, foreignLane, headers, ownerLane, path } = await setup();
    const definitions = [
      { label: "Account", definition: { revision: 1, accountIds: ["account_foreign"] }, code: "account_denied" },
      { label: "Lane", definition: { revision: 1, laneIds: [foreignLane] }, code: "resource_denied" },
      { label: "Facet", definition: { revision: 1, facetFilters: [{ facetId: "facet_foreign", operator: "present" }] }, code: "resource_denied" },
      { label: "Workflow", definition: { revision: 1, workflowStateIds: ["workflow_foreign"] }, code: "resource_denied" },
      { label: "Context type", definition: { revision: 1, contextFilters: [{ context: { contextTypeId: "context_type_foreign", contextId: "context_foreign" }, relationshipTypeId: "relationship_foreign" }] }, code: "resource_denied" },
      { label: "Context", definition: { revision: 1, contextFilters: [{ context: { contextTypeId: "context_type_owner", contextId: "context_foreign" }, relationshipTypeId: "relationship_owner" }] }, code: "resource_denied" },
      { label: "Relationship", definition: { revision: 1, contextFilters: [{ context: { contextTypeId: "context_type_owner", contextId: "context_owner" }, relationshipTypeId: "relationship_foreign" }] }, code: "resource_denied" },
      { label: "Thread", definition: { revision: 1, thread: { ids: ["thread_foreign"] } }, code: "resource_denied" },
    ];
    for (const item of definitions) {
      const denied = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: `foreign-${item.label}`, expectedWorkspaceRevision: 1, name: `Foreign ${item.label}`, definition: item.definition }) });
      assert.equal(denied.status, 403, `${item.label}: ${await denied.clone().text()}`);
      assert.equal((await denied.json()).error.code, item.code);
    }
    const verify = createDatabaseClient(path);
    assert.equal((verify.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count, 0);
    verify.sqlite.close();

    const owned = await createView(app, headers, { name: "Owned", definition: { revision: 1, laneIds: [ownerLane] } });
    const deniedUpdate = await app.request(`/v1/organization/views/${owned.id}`, { method: "PATCH", headers, body: JSON.stringify({ idempotencyKey: "foreign-update", expectedWorkspaceRevision: 2, expectedRevision: 1, patch: { definition: { revision: 1, workflowStateIds: ["workflow_foreign"] } } }) });
    assert.equal(deniedUpdate.status, 403);
    const afterUpdate = createDatabaseClient(path);
    assert.equal((afterUpdate.sqlite.query("SELECT revision FROM organization_views WHERE workspace_id='owner' AND id=?").get(owned.id) as { revision: number }).revision, 1);
    afterUpdate.sqlite.close();
  });

  test("validates owned Facet filters authoritatively while accepting repeated multi-value filters", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const seeded = createDatabaseClient(path);
    const now = Date.parse("2026-08-25T16:00:00.000Z");
    seeded.sqlite.query("UPDATE organization_facets SET cardinality=? WHERE workspace_id='owner' AND id='facet_owner'")
      .run(JSON.stringify({ kind: "multi", maxItems: 5 }));
    seeded.sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("facet_number", "owner", "Score", 1, JSON.stringify({ kind: "number", integer: true }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
    seeded.sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("facet_enum", "owner", "State", 2, JSON.stringify({ kind: "enum", options: [
        { id: "active", label: "Active", position: 0, retiredAt: null },
        { id: "retired", label: "Retired", position: 1, retiredAt: "2026-08-20T00:00:00.000Z" },
      ] }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
    seeded.sqlite.close();

    const repeated = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "facet-repeated", expectedWorkspaceRevision: 1, name: "Repeated", definition: { revision: 1, facetFilters: [
      { facetId: "facet_owner", operator: "contains", value: "alpha" },
      { facetId: "facet_owner", operator: "contains", value: "beta" },
    ] } }) });
    assert.equal(repeated.status, 201, await repeated.clone().text());

    const before = createDatabaseClient(path);
    const beforeCount = (before.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count;
    before.sqlite.close();
    const invalid = [
      { label: "operator", definition: { revision: 1, facetFilters: [{ facetId: "facet_number", operator: "contains", value: 7 }] }, status: 400 },
      { label: "value type", definition: { revision: 1, facetFilters: [{ facetId: "facet_number", operator: "equals", value: "7" }] }, status: 400 },
      { label: "retired enum", definition: { revision: 1, facetFilters: [{ facetId: "facet_enum", operator: "equals", value: "retired" }] }, status: 400 },
      { label: "foreign", definition: { revision: 1, facetFilters: [{ facetId: "facet_foreign", operator: "present" }] }, status: 403 },
    ];
    for (const item of invalid) {
      const denied = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: `facet-invalid-${item.label}`, expectedWorkspaceRevision: 2, name: item.label, definition: item.definition }) });
      assert.equal(denied.status, item.status, `${item.label}: ${await denied.clone().text()}`);
    }
    const after = createDatabaseClient(path);
    assert.equal((after.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count, beforeCount);
    after.sqlite.close();
  });

  test("rejects malformed but correctly fingerprinted cursor fields at the HTTP boundary with zero mutation", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const view = await createView(app, headers, { name: "All", definition: { revision: 1 } });
    const first = await app.request(`/v1/organization/views/${view.id}/results?limit=1`, { headers });
    assert.equal(first.status, 200);
    const cursor = (await first.json()).nextCursor as string;
    const valid = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const cases: Array<[string, unknown]> = [
      ["accountId", {}], ["accountId", []], ["accountId", null], ["accountId", 7], ["accountId", "x".repeat(201)],
      ["threadId", {}], ["threadId", []], ["threadId", null], ["threadId", 7], ["threadId", "x".repeat(201)],
      ["receivedAt", {}], ["receivedAt", []], ["receivedAt", null], ["receivedAt", "1724608800000"], ["receivedAt", 1.5], ["receivedAt", -1], ["receivedAt", Number.MAX_SAFE_INTEGER],
      ["fingerprint", {}], ["fingerprint", []], ["fingerprint", null], ["fingerprint", 7], ["fingerprint", "not-a-sha256"],
      ["version", {}], ["version", []], ["version", null], ["version", "1"], ["version", 2],
      ["unexpected", true],
    ];
    for (const [field, value] of cases) {
      const malformed = Buffer.from(JSON.stringify({ ...valid, [field]: value }), "utf8").toString("base64url");
      const response = await app.request(`/v1/organization/views/${view.id}/results?limit=1&cursor=${encodeURIComponent(malformed)}`, { headers });
      assert.equal(response.status, 400, `${field}=${JSON.stringify(value)}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), { error: { code: "invalid_cursor", message: "The View cursor does not match this live definition or Account scope" } });
    }
    const verify = createDatabaseClient(path);
    assert.deepEqual(verify.sqlite.query("SELECT revision,position FROM organization_views WHERE workspace_id='owner' AND id=?").get(view.id), { revision: 1, position: 0 });
    verify.sqlite.close();
  });

  test("rejects non-canonical base64url cursors before query binding", { timeout: 30_000 }, async () => {
    const { app, headers } = await setup();
    const view = await createView(app, headers, { name: "All", definition: { revision: 1 } });
    const first = await app.request(`/v1/organization/views/${view.id}/results?limit=1`, { headers });
    const cursor = (await first.json()).nextCursor as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(cursor.at(-1)!);
    const unusedBits = cursor.length % 4 === 2 ? 4 : cursor.length % 4 === 3 ? 2 : 0;
    assert.notEqual(unusedBits, 0, "fixture cursor must expose unused terminal base64 bits");
    const nonCanonicalLast = alphabet[(lastIndex >> unusedBits << unusedBits) | 1]!;
    const nonCanonical = `${cursor.slice(0, -1)}${nonCanonicalLast}`;
    assert.deepEqual(Buffer.from(nonCanonical, "base64url"), Buffer.from(cursor, "base64url"));

    for (const malformed of [`${cursor}!`, `${cursor}$`, `${cursor}=`, ` ${cursor}`, `${cursor}\n`, nonCanonical]) {
      const response = await app.request(`/v1/organization/views/${view.id}/results?limit=1&cursor=${encodeURIComponent(malformed)}`, { headers });
      assert.equal(response.status, 400, `${JSON.stringify(malformed)}: ${await response.clone().text()}`);
      assert.equal((await response.json()).error.code, "invalid_cursor");
    }
  });

  test("matches subject and Facet contains predicates as LIKE literals", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const seeded = createDatabaseClient(path);
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    seeded.sqlite.query("INSERT INTO threads (id,account_id,provider_thread_id,subject,latest_received_at,created_at) VALUES (?,?,?,?,?,?)")
      .run("thread_percent_literal", "account_a", "percent-literal", "Deploy 100% ready", now, now);
    seeded.sqlite.query("INSERT INTO threads (id,account_id,provider_thread_id,subject,latest_received_at,created_at) VALUES (?,?,?,?,?,?)")
      .run("thread_percent_wildcard", "account_a", "percent-wildcard", "Deploy 100X ready", now - 1, now - 1);
    seeded.sqlite.query("INSERT INTO threads (id,account_id,provider_thread_id,subject,latest_received_at,created_at) VALUES (?,?,?,?,?,?)")
      .run("thread_underscore_literal", "account_a", "underscore-literal", "under_score", now - 2, now - 2);
    seeded.sqlite.query("INSERT INTO threads (id,account_id,provider_thread_id,subject,latest_received_at,created_at) VALUES (?,?,?,?,?,?)")
      .run("thread_underscore_wildcard", "account_a", "underscore-wildcard", "underXscore", now - 3, now - 3);
    seeded.sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("facet_literal", "owner", "Literal", 1, JSON.stringify({ kind: "text", maxLength: 100 }), JSON.stringify({ kind: "multi", maxItems: 5 }), 1, 1, now, now);
    for (const [threadId, value] of [["thread_percent_literal", ["100%"]], ["thread_percent_wildcard", ["100X"]], ["thread_underscore_literal", ["under_score"]], ["thread_underscore_wildcard", ["underXscore"]]] as const) {
      seeded.sqlite.query("INSERT INTO organization_thread_facet_values (workspace_id,facet_id,account_id,thread_id,value,updated_at) VALUES (?,?,?,?,?,?)")
        .run("owner", "facet_literal", "account_a", threadId, JSON.stringify(value), now);
    }
    seeded.sqlite.close();

    for (const [name, definition, expected] of [
      ["Subject percent", { revision: 1, thread: { subjectContains: "100%" } }, ["thread_percent_literal"]],
      ["Subject underscore", { revision: 1, thread: { subjectContains: "under_score" } }, ["thread_underscore_literal"]],
      ["Facet percent", { revision: 1, facetFilters: [{ facetId: "facet_literal", operator: "contains", value: "100%" }] }, ["thread_percent_literal"]],
      ["Facet underscore", { revision: 1, facetFilters: [{ facetId: "facet_literal", operator: "contains", value: "under_score" }] }, ["thread_underscore_literal"]],
    ] as const) {
      const view = await createView(app, headers, { name, definition });
      const response = await app.request(`/v1/organization/views/${view.id}/results?limit=25`, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json()).items.map((item: { threadId: string }) => item.threadId), expected);
    }
  });

  test("uses exact indexed stable ordering through timestamp ties and null latest timestamps", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const view = await createView(app, headers, { name: "All", definition: { revision: 1 } });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.request(`/v1/organization/views/${view.id}/results?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers });
      assert.equal(response.status, 200, await response.clone().text());
      const page = await response.json();
      ids.push(...page.items.map((item: { accountId: string; threadId: string }) => `${item.accountId}:${item.threadId}`));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(ids, ["account_a:thread_a", "account_a:thread_b", "account_b:thread_c", "account_b:thread_created"]);

    const scope = { workspaceId: "owner", accountIds: ["account_a", "account_b"], actor: { id: "owner", type: "human" as const } };
    const verify = createDatabaseClient(path);
    for (const limit of [1, 2, 3, 4, 9, 25, 50, 100]) {
      const productionPageQuery = buildOrganizationViewPageKeyQuery({ scope, view, query: { limit } });
      const plan = verify.sqlite.query(`EXPLAIN QUERY PLAN ${productionPageQuery.sql}`).all(...productionPageQuery.params) as Array<{ detail: string }>;
      const evidence = plan.map((row) => row.detail).join("\n");
      assert.match(evidence, /SCAN t USING (?:COVERING )?INDEX threads_view_order_idx/, `limit + 1 = ${limit + 1}\n${evidence}`);
      assert.doesNotMatch(evidence, /USE TEMP B-TREE/, `limit + 1 = ${limit + 1}\n${evidence}`);
    }

    const productionPageQuery = buildOrganizationViewPageKeyQuery({ scope, view, query: { limit: organizationViewBounds.maximumResultsPerPage } });
    const pageKeys = (verify.sqlite.query(productionPageQuery.sql).all(...productionPageQuery.params) as OrganizationViewPageKey[])
      .slice(0, organizationViewBounds.maximumResultsPerPage);
    const detailQuery = buildOrganizationViewDetailQuery(pageKeys);
    const detailPlan = verify.sqlite.query(`EXPLAIN QUERY PLAN ${detailQuery.sql}`).all(...detailQuery.params) as Array<{ detail: string }>;
    const detailRows = verify.sqlite.query(detailQuery.sql).all(...detailQuery.params) as Array<{ accountId: string; threadId: string; senderEmail: string; humanSignal: number | null }>;
    verify.sqlite.close();
    assert.equal(detailQuery.params.length, pageKeys.length);
    const detailEvidence = detailPlan.map((row) => row.detail).join("\n");
    assert.match(detailEvidence, /(?:CO-ROUTINE|MATERIALIZE) requested/);
    assert.match(detailEvidence, new RegExp(`SCAN ${pageKeys.length} CONSTANT ROWS`));
    assert.match(detailEvidence, /SEARCH t USING INDEX sqlite_autoindex_threads_1 \(id=\?\)/);
    assert.deepEqual(new Set(detailRows.map((row) => `${row.accountId}:${row.threadId}`)), new Set(ids));
    assert.ok(detailRows.every((row) => typeof row.senderEmail === "string" && (row.humanSignal === null || typeof row.humanSignal === "number")));

    const maximumKeys = Array.from({ length: organizationViewBounds.maximumResultsPerPage }, (_, index) => ({ threadId: `thread_${index}` }));
    assert.equal(buildOrganizationViewDetailQuery(maximumKeys).params.length, organizationViewBounds.maximumResultsPerPage);
    assert.throws(() => buildOrganizationViewDetailQuery([...maximumKeys, { threadId: "thread_overflow" }]), /requires 1-100 page keys/);
  });
});
