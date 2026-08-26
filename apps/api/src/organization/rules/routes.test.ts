import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { RULE_COMPILE_BODY_LIMIT_BYTES } from "./routes.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

const source = `orca 1
rule "Launch mail"
event message.received
when subject contains "launch"
action route lane "Everything else"
because "Launch mail stays visible"`;

describe("Rule Revision REST adapter", () => {
  test("authenticates before enforcing a byte-exact streamed compile envelope without opening the Rule service database", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-rule-body-limit-"));
    directories.push(directory);
    const path = join(directory, "rules.sqlite");
    const setupClient = createDatabaseClient(path);
    migrate(setupClient.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    setupClient.db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
    const session = await createSession(setupClient.db, "owner");
    setupClient.sqlite.close();

    let databaseOpens = 0;
    const app = createApp({ dbFactory: () => {
      databaseOpens += 1;
      return createDatabaseClient(path);
    } });
    const authenticatedHeaders = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const envelopeAt = (size: number) => {
      const base = JSON.stringify({
        idempotencyKey: "body-limit-probe",
        expectedRuleRevision: null,
        workspaceSchemaRevision: 1,
        source,
        unknown: "",
      });
      assert.ok(Buffer.byteLength(base) <= size);
      return base.replace('"unknown":""', `"unknown":"${"x".repeat(size - Buffer.byteLength(base))}"`);
    };
    const streamed = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/v1/organization/rules/compile", {
      method: "POST",
      headers: { ...authenticatedHeaders, ...headers },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(body);
          const midpoint = Math.floor(bytes.length / 2);
          controller.enqueue(bytes.slice(0, midpoint));
          controller.enqueue(bytes.slice(midpoint));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    const unauthorized = await app.request("/v1/organization/rules/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelopeAt(RULE_COMPILE_BODY_LIMIT_BYTES + 1),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(databaseOpens, 0);

    const exact = await app.request(streamed(envelopeAt(RULE_COMPILE_BODY_LIMIT_BYTES)));
    assert.equal(exact.status, 400);
    assert.equal((await exact.json()).error.code, "validation_error");
    assert.equal(databaseOpens, 2, "auth and the normal route handler each open one database");

    const oversizedUnknown = await app.request(streamed(envelopeAt(RULE_COMPILE_BODY_LIMIT_BYTES + 1)));
    assert.equal(oversizedUnknown.status, 413);
    assert.deepEqual(await oversizedUnknown.json(), { error: { code: "payload_too_large", message: "Rule compile request exceeds the bounded JSON envelope" } });
    assert.equal(databaseOpens, 3, "oversized input opens only the authentication database");

    const oversizedSource = JSON.stringify({
      idempotencyKey: "oversized-source",
      expectedRuleRevision: null,
      workspaceSchemaRevision: 1,
      source: "x".repeat(RULE_COMPILE_BODY_LIMIT_BYTES),
    });
    const missingLength = await app.request(streamed(oversizedSource));
    assert.equal(missingLength.status, 413);
    assert.equal(databaseOpens, 4);

    const lyingLength = await app.request(streamed(oversizedSource, { "content-length": "16" }));
    assert.equal(lyingLength.status, 413);
    assert.equal(databaseOpens, 5, "a lying Content-Length cannot reach the Rule service database");
  });

  test("compiles, lists immutable revisions, reports diagnostics, and isolates Workspaces", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-rule-routes-"));
    directories.push(directory);
    const path = join(directory, "rules.sqlite");
    const client = createDatabaseClient(path);
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
    client.db.insert(oauthAccounts).values([
      { id: "owner-account", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "owner-provider" },
      { id: "private-account", userId: "private", provider: "gmail", providerEmail: "private@example.com", providerId: "private-provider" },
    ]).run();
    const ownerSession = await createSession(client.db, "owner");
    const privateSession = await createSession(client.db, "private");
    client.sqlite.close();
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const ownerHeaders = { cookie: `orca_session=${ownerSession.token}`, "content-type": "application/json" };

    assert.equal((await app.request("/v1/organization/rules/compile", { method: "POST" })).status, 401);
    const createdResponse = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ ruleId: "route-rule-stable", idempotencyKey: "route-rule-create-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    assert.equal(created.revision.compiled.actions[0].laneId.length > 0, true);

    const replayResponse = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ ruleId: "route-rule-stable", idempotencyKey: "route-rule-create-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source }),
    });
    assert.equal(replayResponse.status, 201);
    assert.deepEqual(await replayResponse.json(), created);

    const conflictingReplay = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ ruleId: "route-rule-stable", idempotencyKey: "route-rule-create-1", expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source.replace("Launch mail", "Changed replay") }),
    });
    assert.equal(conflictingReplay.status, 409);
    assert.equal((await conflictingReplay.json()).error.code, "duplicate_idempotency_key");

    const listed = await app.request(`/v1/organization/rules/${created.rule.id}`, { headers: ownerHeaders });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.equal(listedBody.revisions.length, 1);
    assert.equal(listedBody.limit, 50);
    assert.equal(listedBody.nextCursor, null);
    assert.equal((await app.request(`/v1/organization/rules/${created.rule.id}?limit=101`, { headers: ownerHeaders })).status, 400);
    const malformedCursor = await app.request(`/v1/organization/rules/${created.rule.id}?cursor=not%20canonical`, { headers: ownerHeaders });
    assert.equal(malformedCursor.status, 400);
    assert.equal((await malformedCursor.json()).error.code, "invalid_cursor");

    const invalid = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ idempotencyKey: "route-rule-invalid-1", expectedRuleRevision: null, workspaceSchemaRevision: 2, source: source.replace('"Everything else"', '"Missing"') }),
    });
    assert.equal(invalid.status, 422);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.diagnostics[0].phase, "resolve");
    assert.equal(invalidBody.diagnostics[0].span.start.line, 5);

    const denied = await app.request(`/v1/organization/rules/${created.rule.id}`, {
      headers: { cookie: `orca_session=${privateSession.token}` },
    });
    assert.equal(denied.status, 404);

    const crossWorkspaceEdit = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: { cookie: `orca_session=${privateSession.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ruleId: created.rule.id, idempotencyKey: "private-cross-rule-1", expectedRuleRevision: 1, workspaceSchemaRevision: 1, source }),
    });
    assert.equal(crossWorkspaceEdit.status, 404);

    const secondResponse = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ ruleId: created.rule.id, idempotencyKey: "route-rule-edit-2", expectedRuleRevision: 1, workspaceSchemaRevision: 2, source: source.replace("Launch mail", "Launch mail revision two") }),
    });
    assert.equal(secondResponse.status, 200, JSON.stringify(await secondResponse.clone().json()));
    const firstPageResponse = await app.request(`/v1/organization/rules/${created.rule.id}?limit=1`, { headers: ownerHeaders });
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json();
    assert.deepEqual(firstPage.revisions.map((revision: { revision: number }) => revision.revision), [1]);
    assert.equal(typeof firstPage.nextCursor, "string");
    const continuationResponse = await app.request(`/v1/organization/rules/${created.rule.id}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: ownerHeaders });
    assert.equal(continuationResponse.status, 200);
    const continuation = await continuationResponse.json();
    assert.deepEqual(continuation.revisions.map((revision: { revision: number }) => revision.revision), [2]);
    assert.equal(continuation.nextCursor, null);

    const thirdResponse = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ ruleId: created.rule.id, idempotencyKey: "route-rule-edit-3", expectedRuleRevision: 2, workspaceSchemaRevision: 3, source: source.replace("Launch mail", "Launch mail revision three") }),
    });
    assert.equal(thirdResponse.status, 200, JSON.stringify(await thirdResponse.clone().json()));
    const staleCursor = await app.request(`/v1/organization/rules/${created.rule.id}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: ownerHeaders });
    assert.equal(staleCursor.status, 409);
    assert.equal((await staleCursor.json()).error.code, "stale_cursor");

    const verification = createDatabaseClient(path);
    try {
      assert.equal((verification.sqlite.query("SELECT COUNT(*) count FROM organization_rules WHERE workspace_id = 'owner'").get() as { count: number }).count, 1);
      assert.equal((verification.sqlite.query("SELECT COUNT(*) count FROM organization_rule_revisions WHERE workspace_id = 'owner'").get() as { count: number }).count, 3);
      assert.equal((verification.sqlite.query("SELECT COUNT(*) count FROM organization_change_sets WHERE workspace_id = 'owner' AND resource_family = 'rule'").get() as { count: number }).count, 3);
      assert.equal((verification.sqlite.query("SELECT revision FROM organization_workspace_states WHERE workspace_id = 'owner'").get() as { revision: number }).revision, 4);
      assert.equal((verification.sqlite.query("SELECT COUNT(*) count FROM organization_rules WHERE workspace_id = 'private'").get() as { count: number }).count, 0);
    } finally { verification.sqlite.close(); }
  }, 20_000);
});
