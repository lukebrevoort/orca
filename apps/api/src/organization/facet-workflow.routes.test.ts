import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, organizationChangeSets, threads, users } from "../db/schema.ts";
import { createApp } from "../index.ts";
import { OrganizationAuthorityError, createOrganization, type OrganizationRepository } from "./module.ts";
import { createSqliteOrganizationRepository } from "./sqlite-repository.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("Facet and Workflow Organization REST adapter", () => {
  test("applies and queries a cross-Account typed change set without partial writes", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-facet-workflow-routes-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "organization.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
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
        { id: "thread_a", accountId: "account_a", providerThreadId: "provider-thread-a", subject: "Alpha", latestReceivedAt: new Date("2026-08-24T05:00:00.000Z"), messageCount: 1 },
        { id: "thread_b", accountId: "account_b", providerThreadId: "provider-thread-b", subject: "Beta", latestReceivedAt: new Date("2026-08-24T04:00:00.000Z"), messageCount: 1 },
        { id: "thread_private", accountId: "account_private", providerThreadId: "provider-thread-private", subject: "Private", latestReceivedAt: new Date("2026-08-24T03:00:00.000Z"), messageCount: 1 },
      ]).run();
      db.insert(emails).values([
        { id: "message_a", accountId: "account_a", threadId: "thread_a", providerMessageId: "message-a", subject: "Alpha", receivedAt: new Date("2026-08-24T05:00:00.000Z") },
        { id: "message_b", accountId: "account_b", threadId: "thread_b", providerMessageId: "message-b", subject: "Beta", receivedAt: new Date("2026-08-24T04:00:00.000Z") },
        { id: "message_private", accountId: "account_private", threadId: "thread_private", providerMessageId: "message-private", subject: "Private", receivedAt: new Date("2026-08-24T03:00:00.000Z") },
      ]).run();
      const session = await createSession(db, "workspace_owner");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath) });

      const initialCommand = {
        id: "changeset_initial",
        idempotencyKey: "typed-initial-1",
        expectedWorkspaceRevision: 1,
        actions: [
          { kind: "define_facet", id: "facet_customer", name: "Customer", position: 0, valueType: { kind: "text", maxLength: 80 }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
          { kind: "define_facet", id: "facet_score", name: "Score", position: 1, valueType: { kind: "number", minimum: 0, maximum: 10, integer: true }, cardinality: { kind: "single" }, isOptional: false, defaultValue: 0 },
          { kind: "define_facet", id: "facet_code", name: "Code", position: 2, valueType: { kind: "text", maxLength: 20 }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
          { kind: "define_workflow_state", id: "workflow_waiting", name: "Waiting", position: 0 },
          { kind: "set_thread_facets", accountId: "account_a", threadId: "thread_a", values: [{ facetId: "facet_customer", value: "true" }, { facetId: "facet_score", value: 8 }, { facetId: "facet_code", value: "42" }], expectedThreadRevision: null },
          { kind: "set_thread_facets", accountId: "account_b", threadId: "thread_b", values: [{ facetId: "facet_customer", value: "00123" }, { facetId: "facet_score", value: 6 }], expectedThreadRevision: null },
          { kind: "set_thread_workflow_state", accountId: "account_a", threadId: "thread_a", stateId: "workflow_waiting", expectedThreadRevision: null },
        ],
      };
      const applied = await app.request("/v1/organization/apply", {
        method: "POST",
        headers,
        body: JSON.stringify(initialCommand),
      });
      const appliedText = await applied.text();
      assert.equal(applied.status, 200, appliedText);
      const result = JSON.parse(appliedText);
      assert.equal(result.workspaceRevision, 2);
      assert.deepEqual(result.facetDefinitions.map((facet: { id: string }) => facet.id), ["facet_customer", "facet_score", "facet_code"]);
      const persistedChangeSet = db.select().from(organizationChangeSets).get();
      assert.equal(persistedChangeSet?.commandDigest.startsWith("sha256:"), true);
      assert.deepEqual(JSON.parse(persistedChangeSet?.authorityTrace ?? "{}").decision, "allowed");

      const duplicate = await app.request("/v1/organization/apply", { method: "POST", headers, body: JSON.stringify(initialCommand) });
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).error.code, "duplicate_idempotency_key");

      const workspace = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=present", { headers });
      assert.equal(workspace.status, 200);
      const workspaceBody = await workspace.json();
      assert.deepEqual(workspaceBody.threads.map((thread: { id: string }) => thread.id), ["thread_a", "thread_b"]);
      assert.deepEqual(workspaceBody.threads[0].organization.workflowState.stateId, "workflow_waiting");

      const filtered = await app.request("/v1/organization/query?attention=all&accountId=account_b&facetId=facet_customer&facetOperator=equals&facetValueJson=%2200123%22", { headers });
      assert.deepEqual((await filtered.json()).threads.map((thread: { id: string }) => thread.id), ["thread_b"]);
      const booleanLookingString = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=equals&facetValueJson=%22true%22", { headers });
      assert.deepEqual((await booleanLookingString.json()).threads.map((thread: { id: string }) => thread.id), ["thread_a"]);
      const numericLookingString = await app.request("/v1/organization/query?attention=all&facetId=facet_code&facetOperator=equals&facetValueJson=%2242%22", { headers });
      assert.deepEqual((await numericLookingString.json()).threads.map((thread: { id: string }) => thread.id), ["thread_a"]);
      const unknownFacet = await app.request("/v1/organization/query?attention=all&facetId=facet_unknown&facetOperator=present", { headers });
      assert.equal(unknownFacet.status, 400);
      assert.equal((await unknownFacet.json()).error.issues[0].code, "facet_not_found");

      db.insert(threads).values({ id: "thread_future", accountId: "account_a", providerThreadId: "provider-thread-future", subject: "Future", latestReceivedAt: new Date("2026-08-24T06:00:00.000Z"), messageCount: 1 }).run();
      db.insert(emails).values({ id: "message_future", accountId: "account_a", threadId: "thread_future", providerMessageId: "message-future", subject: "Future", receivedAt: new Date("2026-08-24T06:00:00.000Z") }).run();
      const futureDefault = await app.request("/v1/organization/query?attention=all&accountId=account_a&facetId=facet_score&facetOperator=equals&facetValueJson=0", { headers });
      assert.deepEqual((await futureDefault.json()).threads.map((thread: { id: string }) => thread.id), ["thread_future"]);

      const invalid = await app.request("/v1/organization/apply", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "changeset_invalid",
          idempotencyKey: "typed-invalid-1",
          expectedWorkspaceRevision: 2,
          actions: [
            { kind: "set_thread_facets", accountId: "account_a", threadId: "thread_a", values: [{ facetId: "facet_customer", value: "Changed" }], expectedThreadRevision: 1 },
            { kind: "set_thread_facets", accountId: "account_b", threadId: "thread_b", values: [{ facetId: "facet_score", value: "not-a-number" }], expectedThreadRevision: 1 },
          ],
        }),
      });
      assert.equal(invalid.status, 400);
      const invalidBody = await invalid.json();
      assert.equal(invalidBody.error.code, "validation_error");
      assert.match(invalidBody.error.issues[0].path, /^actions\[1\]/);

      const unchanged = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=equals&facetValueJson=%22true%22", { headers });
      assert.deepEqual((await unchanged.json()).threads.map((thread: { id: string }) => thread.id), ["thread_a"]);

      const retired = await app.request("/v1/organization/apply", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "changeset_retire", idempotencyKey: "typed-retire-1", expectedWorkspaceRevision: 2, actions: [{ kind: "update_facet", facetId: "facet_customer", retired: true, expectedRevision: 1 }] }),
      });
      assert.equal(retired.status, 200, await retired.text());
      const historical = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=equals&facetValueJson=%22true%22", { headers });
      assert.deepEqual((await historical.json()).threads.map((thread: { id: string }) => thread.id), ["thread_a"]);

      const denied = await app.request("/v1/organization/apply", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "changeset_denied",
          idempotencyKey: "typed-denied-1",
          expectedWorkspaceRevision: 3,
          actions: [{ kind: "set_thread_workflow_state", accountId: "account_private", threadId: "thread_private", stateId: null, expectedThreadRevision: null }],
        }),
      });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, "account_denied");

      const privateSession = await createSession(db, "workspace_private");
      const privateHeaders = { cookie: `orca_session=${privateSession.token}`, "content-type": "application/json" };
      const privateApplied = await app.request("/v1/organization/apply", {
        method: "POST",
        headers: privateHeaders,
        body: JSON.stringify({
          id: "private_changeset_initial",
          idempotencyKey: "private-typed-initial-1",
          expectedWorkspaceRevision: 1,
          actions: [
            { kind: "define_facet", id: "facet_customer", name: "Private customer", position: 0, valueType: { kind: "text", maxLength: 80 }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
            { kind: "define_workflow_state", id: "workflow_waiting", name: "Private waiting", position: 0 },
            { kind: "set_thread_facets", accountId: "account_private", threadId: "thread_private", values: [{ facetId: "facet_customer", value: "private" }], expectedThreadRevision: null },
            { kind: "set_thread_workflow_state", accountId: "account_private", threadId: "thread_private", stateId: "workflow_waiting", expectedThreadRevision: null },
          ],
        }),
      });
      assert.equal(privateApplied.status, 200, await privateApplied.text());
      const privateQuery = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=equals&facetValueJson=%22private%22", { headers: privateHeaders });
      const privateBody = await privateQuery.json();
      assert.deepEqual(privateBody.threads.map((thread: { id: string }) => thread.id), ["thread_private"]);
      assert.equal(privateBody.facetDefinitions[0].name, "Private customer");
      const ownerIsolation = await app.request("/v1/organization/query?attention=all&facetId=facet_customer&facetOperator=equals&facetValueJson=%22private%22", { headers });
      assert.deepEqual((await ownerIsolation.json()).threads, []);

      const baseRepository = createSqliteOrganizationRepository(db);
      const tamperingRepository: OrganizationRepository = {
        ...baseRepository,
        applyFacetWorkflow(input) {
          const tamperedActions = input.actions.map((action, index) => index === 0 && action.kind === "define_workflow_state"
            ? { ...action, name: "Tampered after authorization" }
            : action);
          return baseRepository.applyFacetWorkflow!({ ...input, actions: tamperedActions });
        },
      };
      assert.throws(
        () => createOrganization(tamperingRepository).apply({
          scope: { actor: { id: "workspace_owner", type: "human" }, workspaceId: "workspace_owner", accountIds: ["account_a", "account_b"] },
          command: {
            id: "changeset_tamper_probe",
            idempotencyKey: "tamper-probe-1",
            expectedWorkspaceRevision: 3,
            actions: [{ kind: "define_workflow_state", id: "workflow_probe", name: "Authorized label", position: 1 }],
          },
        }),
        (error) => error instanceof OrganizationAuthorityError && error.code === "invalid_request" && /exact typed/.test(error.message),
      );
    } finally {
      sqlite.close();
    }
  });
});
