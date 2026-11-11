import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { createApp } from "../index.ts";

// Run this actual HTTP/SQLite regression before adding policy routes.
// No mocked application responses, external delivery, mail or credentials.
test("BRE-455 explicit open-app adoption persists and reconciles without replaying old settings", async () => {
  const prior = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "bre455-synthetic-only-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-bre455-red-"));
  const path = join(dir, "fixture.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.com'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','u@example.com')");
    const session = await createSession(db, "u");
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const endpoint = "/v1/notifications/installations/browser";
    const initial = await app.request(`${endpoint}?channel=open_app`, { headers });
    assert.equal(initial.status, 200, "authenticated policy status must be available; baseline is a real HTTP404");
    const initialBody = await initial.json() as { revision: number; policy: unknown };
    assert.equal(initialBody.revision, 0);
    assert.equal(initialBody.policy, null, "reading status cannot adopt a policy");
    const operationId = randomUUID();
    const command = { channel: "open_app", policyVersion: 1, enabled: true, accountIds: ["a"], permission: "granted", expectedRevision: 0, operationId };
    const adopted = await app.request(endpoint, { method: "PUT", headers, body: JSON.stringify(command) });
    assert.equal(adopted.status, 200);
    const first = await adopted.json() as { appliedRevision: number; current: { revision: number; policy: unknown } };
    assert.equal(first.appliedRevision, 1);
    assert.deepEqual(first.current.policy, { version: 1, kind: "important_only", enabled: true, accountIds: ["a"] });
    const disabled = await app.request(endpoint, { method: "PUT", headers, body: JSON.stringify({ ...command, enabled: false, expectedRevision: 1, operationId: randomUUID() }) });
    assert.equal(disabled.status, 200);
    const retry = await app.request(endpoint, { method: "PUT", headers, body: JSON.stringify(command) });
    assert.equal(retry.status, 200);
    const result = await retry.json() as { status: string; appliedRevision: number; current: { revision: number; policy: { enabled: boolean } } };
    assert.equal(result.status, "superseded");
    assert.equal(result.appliedRevision, 1);
    assert.equal(result.current.revision, 2);
    assert.equal(result.current.policy.enabled, false, "retry cannot re-enable notifications after a newer explicit disable");
  } finally {
    sqlite.close(); rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
