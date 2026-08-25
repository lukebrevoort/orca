import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, threads, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("Context Organization REST adapter", () => {
  test("describes, applies, queries, audits, and reverts authenticated Context relationships", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-context-routes-"));
    tempDirectories.push(directory);
    const path = join(directory, "organization.sqlite");
    const client = createDatabaseClient(path);
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
    client.db.insert(oauthAccounts).values([
      { id: "account_a", userId: "owner", provider: "gmail", providerEmail: "a@example.com", providerId: "a" },
      { id: "account_b", userId: "owner", provider: "outlook", providerEmail: "b@example.com", providerId: "b" },
      { id: "account_private", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private" },
    ]).run();
    client.db.insert(threads).values([
      { id: "thread_incident", accountId: "account_a", providerThreadId: "incident", subject: "Production incident" },
      { id: "thread_private", accountId: "account_private", providerThreadId: "private", subject: "Private" },
    ]).run();
    const session = await createSession(client.db, "owner");
    client.sqlite.close();
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const apply = async (body: unknown) => {
      const response = await app.request("/v1/organization/contexts/apply", { method: "POST", headers, body: JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };

    const describe = await app.request("/v1/organization/contexts/describe", { headers });
    assert.equal(describe.status, 200);
    assert.equal((await describe.json()).semantics.contextEdges, "thread_context_only");
    const types = await apply({ idempotencyKey: "routes-types-1", expectedWorkspaceRevision: 1, actions: [{ kind: "create_context_type", name: "Project", position: 0 }] });
    const contextType = types.state.contextTypes[0];
    const relationshipTypes = await apply({ idempotencyKey: "routes-rel-types-1", expectedWorkspaceRevision: 2, actions: [{ kind: "create_relationship_type", contextTypeId: contextType.id, name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 4 }] });
    const relationshipType = relationshipTypes.state.relationshipTypes[0];
    const instances = await apply({ idempotencyKey: "routes-contexts-1", expectedWorkspaceRevision: 3, actions: [{ kind: "create_context", contextTypeId: contextType.id, name: "Orca" }] });
    const context = instances.state.contexts[0];
    const linked = await apply({ idempotencyKey: "routes-link-1", expectedWorkspaceRevision: 4, actions: [{ kind: "link_thread_context", accountId: "account_a", threadId: "thread_incident", contextId: context.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }] });
    assert.equal(linked.state.relationships[0].threadId, "thread_incident");

    const query = await app.request(`/v1/organization/contexts/query?accountId=account_a&threadId=thread_incident&contextTypeId=${contextType.id}&contextId=${context.id}`, { headers });
    assert.equal(query.status, 200);
    assert.equal((await query.json()).relationships.length, 1);
    const incompleteContextFilter = await app.request(`/v1/organization/contexts/query?contextId=${context.id}`, { headers });
    assert.equal(incompleteContextFilter.status, 400);
    const rootQuery = await app.request(`/v1/organization/query?attention=all&contextTypeId=${contextType.id}&contextId=${context.id}&contextRelationshipTypeId=${relationshipType.id}`, { headers });
    assert.equal(rootQuery.status, 200);
    const rootBody = await rootQuery.json();
    assert.deepEqual(rootBody.threads.map((thread: { id: string }) => thread.id), ["thread_incident"]);
    assert.equal(rootBody.threads[0].organization.contextRelationships[0].relationshipTypeId, relationshipType.id);
    const partialRootQuery = await app.request("/v1/organization/query?attention=all&contextDirection=thread_to_context", { headers });
    assert.equal(partialRootQuery.status, 400);
    const audit = await app.request("/v1/organization/contexts/audit", { headers });
    assert.equal((await audit.json()).changes.length, 4);

    const denied = await app.request("/v1/organization/contexts/apply", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "routes-private-1", expectedWorkspaceRevision: 5, actions: [{ kind: "link_thread_context", accountId: "account_private", threadId: "thread_private", contextId: context.id, relationshipTypeId: relationshipType.id, expectedThreadRevision: null }] }) });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: { code: "account_denied", message: "The requested Account scope is not authorized" } });
    const unchanged = await app.request("/v1/organization/contexts/query?threadId=thread_incident", { headers });
    assert.equal((await unchanged.json()).workspaceRevision, 5);

    const renamed = await apply({ idempotencyKey: "routes-rename-1", expectedWorkspaceRevision: 5, actions: [{ kind: "update_context", contextId: context.id, patch: { name: "Orca launch" }, expectedRevision: 1 }] });
    const reverted = await app.request("/v1/organization/contexts/revert", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "routes-revert-1", changeId: renamed.change.id, expectedWorkspaceRevision: 6 }) });
    const revertedText = await reverted.text();
    assert.equal(reverted.status, 200, revertedText);
    assert.equal(JSON.parse(revertedText).state.contexts.find((item: { id: string }) => item.id === context.id).name, "Orca");
  });

  test("requires authentication", async () => {
    const app = createApp();
    assert.equal((await app.request("/v1/organization/contexts/describe")).status, 401);
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 30).toString("base64");
  });
});
