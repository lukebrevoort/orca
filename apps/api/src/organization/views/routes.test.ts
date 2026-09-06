import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("BRE-313 live Views REST adapter", () => {
  test("creates unlimited definitions, evaluates them live across authorized Accounts, and paginates stably", { timeout: 20_000 }, async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-live-views-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "views.sqlite");
    const client = createDatabaseClient(path);
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
    client.db.insert(oauthAccounts).values([
      { id: "account_gmail", userId: "owner", provider: "gmail", providerEmail: "owner@gmail.example", providerId: "gmail" },
      { id: "account_outlook", userId: "owner", provider: "outlook", providerEmail: "owner@outlook.example", providerId: "outlook" },
      { id: "account_private", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private" },
    ]).run();
    client.db.insert(threads).values([
      { id: "thread_failure", accountId: "account_gmail", providerThreadId: "failure", subject: "Unresolved production failure", latestReceivedAt: new Date("2026-08-25T18:00:00.000Z"), messageCount: 1, isRead: false },
      { id: "thread_customer", accountId: "account_outlook", providerThreadId: "customer", subject: "Customer escalation", latestReceivedAt: new Date("2026-08-25T17:00:00.000Z"), messageCount: 1, isRead: false },
      { id: "thread_news", accountId: "account_gmail", providerThreadId: "news", subject: "August newsletter", latestReceivedAt: new Date("2026-08-24T17:00:00.000Z"), messageCount: 1, isRead: true },
      { id: "thread_private", accountId: "account_private", providerThreadId: "private", subject: "Unresolved production failure", latestReceivedAt: new Date("2026-08-25T19:00:00.000Z"), messageCount: 1, isRead: false },
    ]).run();
    client.db.insert(emails).values([
      { id: "email_failure", accountId: "account_gmail", threadId: "thread_failure", providerMessageId: "failure", fromAddress: "deploy@status.example.com", fromName: "Deploy monitor", subject: "Unresolved production failure", receivedAt: new Date("2026-08-25T18:00:00.000Z"), isRead: false, humanSignal: 3, humanClassification: "automated_or_bulk", humanClassificationReasons: JSON.stringify(["provider_transactional_signal"]) },
      { id: "email_customer", accountId: "account_outlook", threadId: "thread_customer", providerMessageId: "customer", fromAddress: "ops@acme.example", fromName: "Ari Ops", subject: "Customer escalation", receivedAt: new Date("2026-08-25T17:00:00.000Z"), isRead: false, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: JSON.stringify(["direct_recipient"]) },
      { id: "email_news", accountId: "account_gmail", threadId: "thread_news", providerMessageId: "news", fromAddress: "news@bulk.example", fromName: "Bulk", subject: "August newsletter", receivedAt: new Date("2026-08-24T17:00:00.000Z"), isRead: true, humanSignal: 1, humanClassification: "automated_or_bulk", humanClassificationReasons: JSON.stringify(["list_unsubscribe_header"]) },
      { id: "email_private", accountId: "account_private", threadId: "thread_private", providerMessageId: "private", fromAddress: "private@example.com", subject: "Private", receivedAt: new Date("2026-08-25T19:00:00.000Z"), isRead: false, humanSignal: 10, humanClassification: "likely_human", humanClassificationReasons: JSON.stringify(["direct_recipient"]) },
    ]).run();

    const sqlite = client.sqlite;
    const timestamp = Date.parse("2026-08-25T16:00:00.000Z");
    sqlite.query("INSERT INTO organization_lane_policies (workspace_id,id,visibility,interruption,review,retention_mode,provider_deletion,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("owner", "policy_focus", "standard", "notify", "daily", "keep", 0, 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_lanes (workspace_id,id,name,position,default_policy_id,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("owner", "lane_focus", "Focus", 1, "policy_focus", 1, timestamp, timestamp);
    sqlite.query("UPDATE organization_thread_lane_states SET primary_lane_id = 'lane_focus', placement_source = 'rule_revision', source_id = 'rule_customer_focus' WHERE workspace_id = 'owner' AND account_id = 'account_outlook' AND thread_id = 'thread_customer'").run();
    sqlite.query("INSERT INTO organization_workflow_states (id,workspace_id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("workflow_unresolved", "owner", "Unresolved", 0, 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_thread_workflow_states (workspace_id,thread_id,account_id,state_id,updated_at) VALUES (?,?,?,?,?)")
      .run("owner", "thread_customer", "account_outlook", "workflow_unresolved", timestamp);
    sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("facet_urgency", "owner", "Urgency", 0, JSON.stringify({ kind: "enum", options: [{ id: "urgent", label: "Urgent", position: 0, retiredAt: null }] }), JSON.stringify({ kind: "single" }), 1, 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_thread_facet_values (workspace_id,facet_id,account_id,thread_id,value,updated_at) VALUES (?,?,?,?,?,?)")
      .run("owner", "facet_urgency", "account_outlook", "thread_customer", JSON.stringify("urgent"), timestamp);
    sqlite.query("INSERT INTO organization_context_types (workspace_id,id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("owner", "context_type_project", "Project", 0, 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_context_relationship_types (workspace_id,id,context_type_id,name,inverse_name,direction,position,maximum_per_thread,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("owner", "relationship_concerns", "context_type_project", "concerns", "has work", "thread_to_context", 0, 10, 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_contexts (workspace_id,id,context_type_id,name,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("owner", "context_orca", "context_type_project", "Orca", 1, timestamp, timestamp);
    sqlite.query("INSERT INTO organization_thread_context_relationships (workspace_id,id,account_id,thread_id,context_type_id,context_id,relationship_type_id,direction,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("owner", "context_edge_customer", "account_outlook", "thread_customer", "context_type_project", "context_orca", "relationship_concerns", "thread_to_context", 1, timestamp, timestamp);

    const session = await createSession(client.db, "owner");
    sqlite.close();
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const createView = async (body: unknown) => {
      const workspaceRevision = (await (await app.request("/v1/organization/views", { headers })).json()).workspaceRevision as number;
      const response = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: `routes:create:${crypto.randomUUID()}`, expectedWorkspaceRevision: workspaceRevision, ...(body as object) }) });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      return JSON.parse(text) as { id: string };
    };

    const exact = await createView({ name: "Urgent humans", color: "#0b9b84", position: 0, definition: {
      revision: 1, accountIds: ["account_gmail", "account_outlook"], laneIds: ["lane_focus"],
      facetFilters: [{ facetId: "facet_urgency", operator: "equals", value: "urgent" }],
      contextFilters: [{ context: { contextTypeId: "context_type_project", contextId: "context_orca" }, relationshipTypeId: "relationship_concerns" }],
      workflowStateIds: ["workflow_unresolved"], humanSignal: { minimumScore: 7, classifications: ["likely_human"], evidenceReasonCodes: ["direct_recipient"] },
      sender: { domains: ["acme.example"] }, date: { receivedAfter: "2026-08-20T00:00:00.000Z" }, thread: { readState: "unread" },
    } });
    const weekly = await createView({ name: "Weekly production review", color: "#b44c42", position: 1, definition: { revision: 1, thread: { subjectContains: "production failure" } } });
    const sameThread = await createView({ name: "Unread work", color: "#6aa9f5", position: 2, definition: { revision: 1, thread: { ids: ["thread_customer"], readState: "unread" } } });
    const allWork = await createView({ name: "All work", color: "#70867d", position: 3, definition: { revision: 1 } });

    const exactPage = await app.request(`/v1/organization/views/${exact.id}/results?limit=25`, { headers });
    assert.equal(exactPage.status, 200);
    assert.deepEqual((await exactPage.json()).items.map((item: { threadId: string }) => item.threadId), ["thread_customer"]);
    const weeklyPage = await app.request(`/v1/organization/views/${weekly.id}/results?limit=25`, { headers });
    assert.deepEqual((await weeklyPage.json()).items.map((item: { threadId: string }) => item.threadId), ["thread_failure"]);
    const sameThreadPage = await app.request(`/v1/organization/views/${sameThread.id}/results?limit=25`, { headers });
    assert.deepEqual((await sameThreadPage.json()).items.map((item: { threadId: string }) => item.threadId), ["thread_customer"]);

    const changed = createDatabaseClient(path);
    changed.sqlite.query("UPDATE organization_thread_facet_values SET value = ? WHERE workspace_id = 'owner' AND account_id = 'account_outlook' AND thread_id = 'thread_customer'").run(JSON.stringify("normal"));
    changed.sqlite.close();
    const livePage = await app.request(`/v1/organization/views/${exact.id}/results?limit=25`, { headers });
    assert.deepEqual((await livePage.json()).items, []);

    const overridden = createDatabaseClient(path);
    overridden.sqlite.query("INSERT INTO human_classification_overrides (id,account_id,target_type,target_value,classification,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("override_domain", "account_gmail", "sender_domain", "status.example.com", "likely_human", "user_choice", timestamp, timestamp);
    overridden.sqlite.query("INSERT INTO human_classification_overrides (id,account_id,target_type,target_value,classification,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("override_address", "account_gmail", "sender_address", "deploy@status.example.com", "uncertain", "user_choice", timestamp, timestamp);
    overridden.sqlite.query("INSERT INTO human_classification_overrides (id,account_id,target_type,target_value,classification,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("override_message", "account_gmail", "message", "email_failure", "likely_human", "user_choice", timestamp, timestamp);
    overridden.sqlite.close();
    const classificationDraft = {
      mode: "create", viewId: null, source: { kind: "manual", label: "Classification parity" },
      identity: { name: "Override-aware", description: "", color: "#70867d", position: 4 },
      definition: { revision: 1, humanSignal: { classifications: ["likely_human"] }, thread: { subjectContains: "production failure" } }, unsupportedClauses: [],
    };
    const overridePreview = await app.request("/v1/organization/views/preview", { method: "POST", headers, body: JSON.stringify({ draft: classificationDraft, page: { limit: 25 } }) });
    assert.equal(overridePreview.status, 200, await overridePreview.clone().text());
    assert.deepEqual((await overridePreview.json()).results.items.map((item: { threadId: string }) => item.threadId), ["thread_failure"], "message override must win over address and domain overrides");
    const removedMessageOverride = createDatabaseClient(path);
    removedMessageOverride.sqlite.query("DELETE FROM human_classification_overrides WHERE id='override_message'").run();
    removedMessageOverride.sqlite.close();
    assert.deepEqual((await (await app.request("/v1/organization/views/preview", { method: "POST", headers, body: JSON.stringify({ draft: classificationDraft, page: { limit: 25 } }) })).json()).results.items, [], "address override must win over the domain override");
    const removedAddressOverride = createDatabaseClient(path);
    removedAddressOverride.sqlite.query("DELETE FROM human_classification_overrides WHERE id='override_address'").run();
    removedAddressOverride.sqlite.close();
    assert.deepEqual((await (await app.request("/v1/organization/views/preview", { method: "POST", headers, body: JSON.stringify({ draft: classificationDraft, page: { limit: 25 } }) })).json()).results.items.map((item: { threadId: string }) => item.threadId), ["thread_failure"], "domain override must replace the raw classification when no narrower override exists");

    const firstPage = await app.request(`/v1/organization/views/${allWork.id}/results?limit=1`, { headers });
    const firstBody = await firstPage.json();
    assert.equal(firstBody.items[0].threadId, "thread_failure");
    assert.equal(typeof firstBody.nextCursor, "string");
    const secondPage = await app.request(`/v1/organization/views/${allWork.id}/results?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, { headers });
    const secondBody = await secondPage.json();
    assert.equal(secondBody.items[0].threadId, "thread_customer");
    assert.notEqual(secondBody.items[0].threadId, firstBody.items[0].threadId);
    const invalidCursor = await app.request(`/v1/organization/views/${allWork.id}/results?limit=1&cursor=not-a-cursor`, { headers });
    assert.equal(invalidCursor.status, 400);

    const expandedScope = createDatabaseClient(path);
    expandedScope.db.insert(oauthAccounts).values({ id: "account_new", userId: "owner", provider: "gmail", providerEmail: "new@gmail.example", providerId: "new" }).run();
    expandedScope.sqlite.close();
    const staleScopeCursor = await app.request(`/v1/organization/views/${allWork.id}/results?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, { headers });
    assert.equal(staleScopeCursor.status, 400);
    assert.equal((await staleScopeCursor.json()).error.code, "invalid_cursor");

    const updated = await app.request(`/v1/organization/views/${allWork.id}`, { method: "PATCH", headers, body: JSON.stringify({ idempotencyKey: "routes-update", expectedWorkspaceRevision: 5, expectedRevision: 1, patch: { name: "All current work" } }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).revision, 2);
    const staleRevisionCursor = await app.request(`/v1/organization/views/${allWork.id}/results?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, { headers });
    assert.equal(staleRevisionCursor.status, 400);
    assert.equal((await staleRevisionCursor.json()).error.code, "invalid_cursor");
    const staleUpdate = await app.request(`/v1/organization/views/${allWork.id}`, { method: "PATCH", headers, body: JSON.stringify({ idempotencyKey: "routes-stale-update", expectedWorkspaceRevision: 6, expectedRevision: 1, patch: { name: "Stale rename" } }) });
    assert.equal(staleUpdate.status, 409);

    const bulk = createDatabaseClient(path);
    const insertView = bulk.sqlite.query("INSERT INTO organization_views (workspace_id,id,name,description,color,position,definition,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    bulk.sqlite.transaction(() => {
      for (let index = 0; index < 105; index += 1) insertView.run("owner", `view_unlimited_${index}`, `Unlimited ${index}`, "", "#70867d", index + 4, JSON.stringify({ revision: 1 }), 1, timestamp, timestamp);
    })();
    bulk.sqlite.close();
    const listed = await app.request("/v1/organization/views", { headers });
    assert.equal((await listed.json()).items.length, 109);

    const denied = await app.request("/v1/organization/views", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "routes-private", expectedWorkspaceRevision: 6, name: "Private leak", definition: { revision: 1, accountIds: ["account_private"] } }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "account_denied");
  });

  test("requires authentication", async () => {
    const app = createApp();
    assert.equal((await app.request("/v1/organization/views")).status, 401);
  });
});
