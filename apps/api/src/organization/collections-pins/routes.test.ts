import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { collections, oauthAccounts, organizationChangeSets, organizationWorkspaceStates, threads, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("Collections/Pins Organization REST adapter", { timeout: 20_000 }, () => {
  test("queries, applies, audits, and reverts through authenticated Organization operations", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 30).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-collections-pins-routes-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    try {
      db.insert(users).values([
        { id: "workspace_owner", email: "owner@example.com" },
        { id: "workspace_private", email: "private@example.com" },
      ]).run();
      db.insert(oauthAccounts).values([
        { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "a@example.com", providerId: "provider-a" },
        { id: "account_b", userId: "workspace_owner", provider: "outlook", providerEmail: "b@example.com", providerId: "provider-b" },
        { id: "account_private", userId: "workspace_private", provider: "gmail", providerEmail: "private@example.com", providerId: "provider-private" },
      ]).run();
      db.insert(threads).values([
        { id: "thread_a", accountId: "account_a", providerThreadId: "thread-source-a", subject: "A", latestReceivedAt: new Date(), messageCount: 1 },
        { id: "thread_b", accountId: "account_b", providerThreadId: "thread-source-b", subject: "B", latestReceivedAt: new Date(), messageCount: 1 },
        { id: "thread_private", accountId: "account_private", providerThreadId: "thread-source-private", subject: "Private", latestReceivedAt: new Date(), messageCount: 1 },
      ]).run();
      db.insert(collections).values([
        { id: "collection_a", accountId: "account_a", name: "A", color: "#70867d", position: 0 },
        { id: "collection_b", accountId: "account_b", name: "B", color: "#83728d", position: 0 },
        { id: "collection_private", accountId: "account_private", name: "Private", color: "#70867d", position: 0 },
      ]).run();
      const session = await createSession(db, "workspace_owner");
      const privateSession = await createSession(db, "workspace_private");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });

      const corsQuery = await app.request("/v1/organization/collections-pins/query", {
        headers: { ...headers, origin: "http://localhost:5173" },
      });
      assert.equal(corsQuery.headers.get("access-control-allow-origin"), "http://localhost:5173");
      const preflight = await app.request("/v1/organization/collections-pins/apply", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5173");

      const primaryDescribe = await app.request("/v1/organization/describe", { headers });
      assert.equal(primaryDescribe.status, 200);
      const primaryDescription = await primaryDescribe.json();
      assert.equal(primaryDescription.workspaceSchema.revision, 2);
      assert.deepEqual(primaryDescription.collectionsPins?.semantics, {
        collections: "explicit_thread_membership",
        pins: "stable_shortcut_identity",
      });

      const describe = await app.request("/v1/organization/collections-pins/describe", { headers });
      assert.equal(describe.status, 200);
      assert.deepEqual((await describe.json()).authority, { sendMail: false, deleteProviderMail: false });

      const workspace = await app.request("/v1/organization/collections-pins/query", { headers });
      assert.equal(workspace.status, 200);
      assert.deepEqual((await workspace.json()).collections.map((item: { id: string; accountId: string }) => [item.id, item.accountId]), [
        ["collection_a", "account_a"],
        ["collection_b", "account_b"],
      ]);
      const denied = await app.request("/v1/organization/collections-pins/query?accountId=account_private", { headers });
      assert.equal(denied.status, 403);

      const appliedResponse = await app.request("/v1/organization/collections-pins/apply", {
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotencyKey: "route-membership-add",
          change: { kind: "collection_membership", action: "add", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" },
        }),
      });
      assert.equal(appliedResponse.status, 200);
      const applied = await appliedResponse.json();
      assert.deepEqual(applied.state.collections.find((item: { id: string }) => item.id === "collection_b").threadIds, ["thread_b"]);

      const auditResponse = await app.request("/v1/organization/collections-pins/audit", { headers });
      assert.equal(auditResponse.status, 200);
      assert.equal((await auditResponse.json()).changes.length, 1);

      const reverted = await app.request("/v1/organization/collections-pins/revert", {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: "route-membership-revert", changeId: applied.change.id }),
      });
      assert.equal(reverted.status, 200);
      assert.deepEqual((await reverted.json()).state.collections.find((item: { id: string }) => item.id === "collection_b").threadIds, []);

      const collectionBody = (idempotencyKey: string, accountId: string, extra: Record<string, unknown> = {}) => JSON.stringify({
        idempotencyKey,
        change: { kind: "collection", action: "create", accountId, collection: { name: "Shared label", color: "#70867d", ...extra } },
      });
      const ownerCreate = await app.request("/v1/organization/collections-pins/apply", {
        method: "POST", headers, body: collectionBody("owner-create", "account_a"),
      });
      assert.equal(ownerCreate.status, 200);
      const ownerId = (await ownerCreate.json()).change.resourceId;
      const privateHeaders = { ...headers, cookie: `orca_session=${privateSession.token}` };
      const privateCreate = await app.request("/v1/organization/collections-pins/apply", {
        method: "POST", headers: privateHeaders, body: collectionBody("private-create", "account_private"),
      });
      assert.equal(privateCreate.status, 200);
      assert.notEqual((await privateCreate.json()).change.resourceId, ownerId);

      const callerId = await app.request("/v1/organization/collections-pins/apply", {
        method: "POST", headers, body: collectionBody("caller-id", "account_a", { id: "collection_private" }),
      });
      assert.equal(callerId.status, 400);

      const duplicateName = await app.request("/v1/organization/collections-pins/apply", {
        method: "POST", headers, body: collectionBody("duplicate-name", "account_a"),
      });
      assert.equal(duplicateName.status, 409);
      const publicError = JSON.stringify(await duplicateName.json());
      assert.equal(publicError.includes("UNIQUE"), false);
      assert.equal(publicError.includes("organization_saved_queries"), false);
      const auditBeforeLegacy = await app.request("/v1/organization/collections-pins/audit", { headers });
      const auditBeforeLegacyCount = (await auditBeforeLegacy.json()).changes.length;

      const legacyCollectionResponse = await app.request("/v1/collections", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Legacy bridge", color: "#70867d" }),
      });
      assert.equal(legacyCollectionResponse.status, 201);
      const legacyCollection = await legacyCollectionResponse.json();
      assert.equal((await app.request(`/v1/collections/${legacyCollection.id}/threads/thread_a`, { method: "PUT", headers })).status, 200);
      const renamedCollection = await app.request(`/v1/collections/${legacyCollection.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ name: "Legacy bridge renamed" }),
      });
      assert.equal(renamedCollection.status, 200);

      const legacyFilter = JSON.stringify({
        mailbox: "inbox", attention: "focus", classification: "human", person: null, query: "launch",
      });
      const legacyPinResponse = await app.request("/v1/pins", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "filter", targetId: legacyFilter, label: "Legacy focus", icon: "search", color: "#70867d" }),
      });
      assert.equal(legacyPinResponse.status, 201);
      const legacyPin = await legacyPinResponse.json();
      const renamedPin = await app.request(`/v1/pins/${legacyPin.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ label: "Legacy focus renamed" }),
      });
      assert.equal(renamedPin.status, 200);

      const coexistence = await app.request("/v1/organization/collections-pins/query?accountId=account_a", { headers });
      assert.equal(coexistence.status, 200);
      const coexistenceState = await coexistence.json();
      assert.deepEqual(coexistenceState.collections.find((item: { id: string }) => item.id === legacyCollection.id)?.threadIds, ["thread_a"]);
      const stablePin = coexistenceState.pins.find((item: { id: string }) => item.id === legacyPin.id);
      assert.equal(stablePin.target.type, "query");
      assert.equal(coexistenceState.queries.find((item: { id: string }) => item.id === stablePin.target.queryId)?.definition.filters.mailbox, "inbox");
      assert.equal(coexistenceState.queries.find((item: { id: string }) => item.id === stablePin.target.queryId)?.definition.filters.attention, "focus");
      const compatibilityPins = await app.request("/v1/pins", { headers });
      const compatibilityPin = (await compatibilityPins.json()).find((item: { id: string }) => item.id === legacyPin.id);
      assert.deepEqual(JSON.parse(compatibilityPin.targetId), JSON.parse(legacyFilter));

      assert.equal((await app.request(`/v1/collections/${legacyCollection.id}/threads/thread_a`, { method: "DELETE", headers })).status, 204);
      assert.equal((await app.request(`/v1/pins/${legacyPin.id}`, { method: "DELETE", headers })).status, 204);
      assert.equal((await app.request(`/v1/collections/${legacyCollection.id}`, { method: "DELETE", headers })).status, 204);
      const coexistenceAudit = await app.request("/v1/organization/collections-pins/audit", { headers });
      const coexistenceChanges = (await coexistenceAudit.json()).changes;
      assert.equal(coexistenceChanges.length - auditBeforeLegacyCount, 8);
      const authorityRecords = db.select().from(organizationChangeSets).where(eq(organizationChangeSets.workspaceId, "workspace_owner")).all();
      assert.equal(authorityRecords.length, coexistenceChanges.length);
      const requestedFamilies = authorityRecords.flatMap((record) => {
        const trace = JSON.parse(record.authorityTrace) as { requestedResourceFamilies: string[] };
        return trace.requestedResourceFamilies;
      });
      assert.equal(requestedFamilies.includes("collection"), true);
      assert.equal(requestedFamilies.includes("shortcut"), true);
      assert.equal(requestedFamilies.includes("saved_query"), true);
      assert.equal(requestedFamilies.includes("mail"), false);
      assert.equal(db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, "workspace_owner")).get()?.revision, 1 + coexistenceChanges.filter((item: { workspaceId: string }) => item.workspaceId === "workspace_owner").length);

      const organizationReplayBody = JSON.stringify({
        idempotencyKey: "route-replay",
        change: { kind: "collection", action: "create", accountId: "account_a", collection: { name: "Replay", color: "#70867d" } },
      });
      const [firstOrganizationReplay, concurrentOrganizationReplay] = await Promise.all([
        app.request("/v1/organization/collections-pins/apply", { method: "POST", headers, body: organizationReplayBody }),
        app.request("/v1/organization/collections-pins/apply", { method: "POST", headers, body: organizationReplayBody }),
      ]);
      assert.equal(firstOrganizationReplay.status, 200);
      assert.equal(concurrentOrganizationReplay.status, 200);
      assert.equal((await firstOrganizationReplay.json()).change.id, (await concurrentOrganizationReplay.json()).change.id);
      const sequentialOrganizationReplay = await app.request("/v1/organization/collections-pins/apply", { method: "POST", headers, body: organizationReplayBody });
      assert.equal(sequentialOrganizationReplay.status, 200);

      const replayHeaders = { ...headers, "Idempotency-Key": "legacy-route-replay" };
      const legacyReplayBody = JSON.stringify({ name: "Legacy replay", color: "#83728d" });
      const [firstLegacyReplay, concurrentLegacyReplay] = await Promise.all([
        app.request("/v1/collections", { method: "POST", headers: replayHeaders, body: legacyReplayBody }),
        app.request("/v1/collections", { method: "POST", headers: replayHeaders, body: legacyReplayBody }),
      ]);
      assert.equal(firstLegacyReplay.status, 201);
      assert.equal(concurrentLegacyReplay.status, 201);
      assert.equal((await firstLegacyReplay.json()).id, (await concurrentLegacyReplay.json()).id);
      const sequentialLegacyReplay = await app.request("/v1/collections", { method: "POST", headers: replayHeaders, body: legacyReplayBody });
      assert.equal(sequentialLegacyReplay.status, 201);
    } finally {
      sqlite.close();
    }
  });

  test("requires authentication and validates mutation bodies", async () => {
    const app = createApp();
    assert.equal((await app.request("/v1/organization/collections-pins/query")).status, 401);
    assert.equal((await app.request("/v1/organization/collections-pins/apply", { method: "POST" })).status, 401);
  });
});
