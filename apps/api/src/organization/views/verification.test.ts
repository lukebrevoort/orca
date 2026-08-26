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
import { buildOrganizationViewDetailQuery, buildOrganizationViewPageKeyQuery, type OrganizationViewPageKey } from "./sqlite-repository.ts";

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
    .run("facet_owner", "owner", "Owner facet", 0, JSON.stringify({ kind: "text" }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
  sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("facet_foreign", "foreign", "Foreign facet", 0, JSON.stringify({ kind: "text" }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
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
  const response = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as OrganizationView;
}

describe("BRE-313 independent View lifecycle verification", () => {
  test("edits definitions, reorders atomically, and removes with optimistic revisions", { timeout: 30_000 }, async () => {
    const { app, headers, path } = await setup();
    const first = await createView(app, headers, { name: "First", position: 0, definition: { revision: 1 } });
    const second = await createView(app, headers, { name: "Second", position: 1, definition: { revision: 1 } });

    const edited = await app.request(`/v1/organization/views/${first.id}`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 1, patch: { definition: { revision: 1, thread: { readState: "unread" } } } }) });
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).definition.thread, { readState: "unread" });

    const reordered = await app.request("/v1/organization/views/reorder", { method: "POST", headers, body: JSON.stringify({ items: [
      { id: first.id, expectedRevision: 2, position: 1 },
      { id: second.id, expectedRevision: 1, position: 0 },
    ] }) });
    assert.equal(reordered.status, 200, await reordered.clone().text());
    const reorderedBody = await reordered.json();
    assert.deepEqual(reorderedBody.items.map((view: { id: string }) => view.id), [second.id, first.id]);

    const beforeConflict = createDatabaseClient(path);
    const snapshot = beforeConflict.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY id").all();
    beforeConflict.sqlite.close();
    const stale = await app.request("/v1/organization/views/reorder", { method: "POST", headers, body: JSON.stringify({ items: [
      { id: first.id, expectedRevision: 2, position: 0 },
      { id: second.id, expectedRevision: 2, position: 1 },
    ] }) });
    assert.equal(stale.status, 409);
    const afterConflict = createDatabaseClient(path);
    assert.deepEqual(afterConflict.sqlite.query("SELECT id,position,revision FROM organization_views WHERE workspace_id='owner' ORDER BY id").all(), snapshot);
    afterConflict.sqlite.close();

    const staleRemove = await app.request(`/v1/organization/views/${second.id}?expectedRevision=1`, { method: "DELETE", headers });
    assert.equal(staleRemove.status, 409);
    assert.equal((await app.request(`/v1/organization/views/${second.id}/results`, { headers })).status, 200);
    const removed = await app.request(`/v1/organization/views/${second.id}?expectedRevision=2`, { method: "DELETE", headers });
    assert.equal(removed.status, 204);
    assert.equal((await app.request(`/v1/organization/views/${second.id}/results`, { headers })).status, 404);
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
      const denied = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ name: `Foreign ${item.label}`, definition: item.definition }) });
      assert.equal(denied.status, 403, `${item.label}: ${await denied.clone().text()}`);
      assert.equal((await denied.json()).error.code, item.code);
    }
    const verify = createDatabaseClient(path);
    assert.equal((verify.sqlite.query("SELECT COUNT(*) AS count FROM organization_views WHERE workspace_id='owner'").get() as { count: number }).count, 0);
    verify.sqlite.close();

    const owned = await createView(app, headers, { name: "Owned", definition: { revision: 1, laneIds: [ownerLane] } });
    const deniedUpdate = await app.request(`/v1/organization/views/${owned.id}`, { method: "PATCH", headers, body: JSON.stringify({ expectedRevision: 1, patch: { definition: { revision: 1, workflowStateIds: ["workflow_foreign"] } } }) });
    assert.equal(deniedUpdate.status, 403);
    const afterUpdate = createDatabaseClient(path);
    assert.equal((afterUpdate.sqlite.query("SELECT revision FROM organization_views WHERE workspace_id='owner' AND id=?").get(owned.id) as { revision: number }).revision, 1);
    afterUpdate.sqlite.close();
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
