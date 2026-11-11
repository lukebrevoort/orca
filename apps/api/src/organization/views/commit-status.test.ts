import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { OrganizationViewCommitRequest } from "@orca/shared";
import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function fixture() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-bre478-"));
  directories.push(directory);
  const path = join(directory, "fixture.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
  client.db.insert(oauthAccounts).values([
    { id: "account", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "owner" },
    { id: "foreign-account", userId: "foreign", provider: "gmail", providerEmail: "foreign@example.com", providerId: "foreign" },
  ]).run();
  const session = await createSession(client.db, "owner");
  client.sqlite.close();
  const app = createApp({ dbFactory: () => createDatabaseClient(path) });
  const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
  const post = (operation: string, body: unknown) => app.request(`/v1/organization/views/${operation}`, { method: "POST", headers, body: JSON.stringify(body) });
  const prepare = async (name = "Original", viewId?: string): Promise<OrganizationViewCommitRequest> => {
    const response = await post("prepare", viewId ? { kind: "saved_view", viewId } : {
      kind: "typed_definition", source: { kind: "manual", label: "Synthetic recovery" }, identity: { name }, skipInbox: true,
      definition: { revision: 1, accountIds: ["account"], sender: { addresses: ["human@example.com"] }, thread: { subjectContains: "Advanced", readState: "unread" } },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const prepared = await response.json();
    return { draft: prepared.draft, expectedRevisions: { workspace: prepared.workspaceRevision, view: prepared.draft.viewRevision }, retryKey: crypto.randomUUID(), confirmedZeroMatchDigest: prepared.draft.definitionDigest };
  };
  const snapshot = () => {
    const db = createDatabaseClient(path);
    try {
      const tables = db.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return tables.map(({ name }) => [name, db.sqlite.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
    } finally { db.sqlite.close(); }
  };
  return { app, headers, post, prepare, snapshot, path };
}

async function status(f: Awaited<ReturnType<typeof fixture>>, command: OrganizationViewCommitRequest) {
  const response = await f.post("commit-status", command);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test("BRE-478 no-op rejection has a read-only unchanged_view proof that fences the late original", async () => {
  const f = await fixture();
  const created = await f.post("commit", await f.prepare());
  assert.equal(created.status, 200, await created.clone().text());
  const saved = await created.json();
  const command = await f.prepare("", saved.view.id);
  const before = f.snapshot();
  assert.equal((await f.post("commit", command)).status, 400);
  const proof = await status(f, command);
  assert.equal(proof.outcome, "not_applied");
  assert.equal(proof.reason, "unchanged_view");
  assert.equal(proof.operation, "view_commit");
  assert.equal(proof.workspaceId, "owner");
  assert.equal(proof.retryKey, command.retryKey);
  assert.equal((await f.post("commit", command)).status, 400, "late immutable original remains rejected");
  assert.deepEqual(f.snapshot(), before);
});

test("BRE-478 stale create has a workspace_advanced proof and fresh save preserves the complete definition", async () => {
  const f = await fixture();
  const command = await f.prepare();
  assert.equal((await f.post("commit", await f.prepare("Competing"))).status, 200);
  const before = f.snapshot();
  assert.equal((await f.post("commit", command)).status, 409);
  const proof = await status(f, command);
  assert.equal(proof.outcome, "not_applied");
  assert.equal(proof.reason, "workspace_advanced");
  assert.equal((await f.post("commit", command)).status, 409);
  assert.deepEqual(f.snapshot(), before);
  const fresh = await f.prepare("Newer edits");
  const response = await f.post("commit", fresh);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.view.name, "Newer edits");
  assert.deepEqual(saved.view.definition, command.draft.definition);
  assert.equal((await status(f, fresh)).viewId, saved.view.id);
});

test("BRE-478 lost acknowledgement resolves to original receipt even after current View deletion", async () => {
  const f = await fixture();
  const command = await f.prepare();
  const delivered = await f.post("commit", command);
  assert.equal(delivered.status, 200, await delivered.clone().text());
  const original = await delivered.json();
  // The client receives 503 instead of the successful commit response.
  const lostAck = new Response("transport replaced acknowledgement", { status: 503 });
  assert.equal(lostAck.status, 503);
  const before = f.snapshot();
  const proof = await status(f, structuredClone(command));
  assert.equal(proof.outcome, "applied");
  assert.equal(proof.viewId, original.view.id);
  assert.deepEqual(await status(f, command), proof);
  assert.deepEqual(f.snapshot(), before);
  const removed = await f.app.request(`/v1/organization/views/${original.view.id}?expectedRevision=${original.view.revision}&expectedWorkspaceRevision=${original.workspaceRevision}&idempotencyKey=delete-original`, { method: "DELETE", headers: f.headers });
  assert.equal(removed.status, 204, await removed.clone().text());
  const afterDelete = f.snapshot();
  assert.deepEqual(await status(f, command), proof);
  assert.deepEqual(f.snapshot(), afterDelete, "receipt proof must never recreate the deleted View");
});
