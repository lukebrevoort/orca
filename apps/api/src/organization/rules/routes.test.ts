import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

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
  test("compiles, lists immutable revisions, reports diagnostics, and isolates Workspaces", async () => {
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-rule-routes-"));
    directories.push(directory);
    const path = join(directory, "rules.sqlite");
    const client = createDatabaseClient(path);
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "private", email: "private@example.com" }]).run();
    const ownerSession = await createSession(client.db, "owner");
    const privateSession = await createSession(client.db, "private");
    client.sqlite.close();
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const ownerHeaders = { cookie: `orca_session=${ownerSession.token}`, "content-type": "application/json" };

    assert.equal((await app.request("/v1/organization/rules/compile", { method: "POST" })).status, 401);
    const createdResponse = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ expectedRuleRevision: null, workspaceSchemaRevision: 1, source }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201, JSON.stringify(created));
    assert.equal(created.revision.compiled.actions[0].laneId.length > 0, true);

    const listed = await app.request(`/v1/organization/rules/${created.rule.id}`, { headers: ownerHeaders });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).revisions.length, 1);

    const invalid = await app.request("/v1/organization/rules/compile", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ expectedRuleRevision: null, workspaceSchemaRevision: 1, source: source.replace('"Everything else"', '"Missing"') }),
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
  });
});
