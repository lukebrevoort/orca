import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { organizationViewCommitStatusResponseSchema, type OrganizationCapabilitySnapshot, type OrganizationViewCommitRequest } from "@orca/shared";
import { Hono } from "hono";
import type { AuthVariables } from "../../auth/middleware.ts";
import { registerOrganizationViewRoutes } from "./routes.ts";
import { createOrganizationViews, OrganizationViewAccessError } from "./module.ts";
import { createSqliteOrganizationViewsRepository } from "./sqlite-repository.ts";
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
  const proof = organizationViewCommitStatusResponseSchema.parse(await response.json());
  if (process.env.BRE478_PROOF_LOG) appendFileSync(process.env.BRE478_PROOF_LOG, `${JSON.stringify(proof)}\n`);
  return proof;
}

test("BRE-478 no-op rejection has a read-only unchanged_view proof that fences the late original", async () => {
  const f = await fixture();
  const created = await f.post("commit", await f.prepare());
  assert.equal(created.status, 200, await created.clone().text());
  const saved = await created.json();
  const command = await f.prepare("", saved.view.id);
  const before = f.snapshot();
  assert.equal((await f.post("commit", command)).status, 400);
  assert.equal(new Response("lost rejection", { status: 503 }).status, 503);
  const proof = await status(f, structuredClone(command));
  assert.equal(proof.outcome, "not_applied");
  if (proof.outcome === "not_applied") assert.equal(proof.reason, "unchanged_view");
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
  assert.equal(new Response("lost rejection", { status: 503 }).status, 503);
  const proof = await status(f, structuredClone(command));
  assert.equal(proof.outcome, "not_applied");
  if (proof.outcome === "not_applied") assert.equal(proof.reason, "workspace_advanced");
  assert.equal((await f.post("commit", command)).status, 409);
  assert.deepEqual(f.snapshot(), before);
  const fresh = await f.prepare("Newer edits");
  const response = await f.post("commit", fresh);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.view.name, "Newer edits");
  assert.deepEqual(saved.view.definition, command.draft.definition);
  const applied = await status(f, fresh);
  assert.equal(applied.outcome, "applied");
  if (applied.outcome === "applied") assert.equal(applied.viewId, saved.view.id);
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
  if (proof.outcome === "applied") assert.equal(proof.viewId, original.view.id);
  assert.deepEqual(await status(f, command), proof);
  assert.deepEqual(f.snapshot(), before);
  const removed = await f.app.request(`/v1/organization/views/${original.view.id}?expectedRevision=${original.view.revision}&expectedWorkspaceRevision=${original.workspaceRevision}&idempotencyKey=delete-original`, { method: "DELETE", headers: f.headers });
  assert.equal(removed.status, 204, await removed.clone().text());
  const afterDelete = f.snapshot();
  assert.deepEqual(await status(f, command), proof);
  assert.deepEqual(f.snapshot(), afterDelete, "receipt proof must never recreate the deleted View");
});

function service(f: Awaited<ReturnType<typeof fixture>>) {
  const client = createDatabaseClient(f.path);
  const scope = { workspaceId: "owner", accountIds: ["account"], actor: { id: "owner", type: "human" as const } };
  return { ...client, scope, views: createOrganizationViews(createSqliteOrganizationViewsRepository(client.sqlite)) };
}

async function changed(f: Awaited<ReturnType<typeof fixture>>, original: OrganizationViewCommitRequest, change: (draft: OrganizationViewCommitRequest["draft"]) => void) {
  const draft = structuredClone(original.draft);
  change(draft);
  const { definitionDigest: _digest, definitionKind: _kind, effectiveAccountIds: _accounts, summary: _summary, saveEligibility: _eligibility, preparationNotices: _notices, ...input } = draft;
  const preview = await f.post("preview", { draft: input, page: { limit: 1 } });
  assert.equal(preview.status, 200, await preview.clone().text());
  const reviewed = await preview.json();
  return { ...original, draft: reviewed.draft, confirmedZeroMatchDigest: reviewed.draft.definitionDigest } as OrganizationViewCommitRequest;
}

test("BRE-478 eligible creates, changed updates and future revisions stay unproven", async () => {
  const f = await fixture();
  const create = await f.prepare();
  assert.deepEqual(await status(f, create), { operation: "view_commit", workspaceId: "owner", retryKey: create.retryKey, expectedRevisions: create.expectedRevisions, outcome: "unknown", reason: "eligible_or_unresolved" });
  const future = { ...create, expectedRevisions: { workspace: create.expectedRevisions.workspace + 1, view: null } };
  assert.equal((await status(f, future)).outcome, "unknown");
  const saved = await (await f.post("commit", create)).json();
  const edit = await f.prepare("", saved.view.id);
  const edited = await changed(f, edit, (draft) => { draft.identity.name = "Changed"; });
  assert.equal((await status(f, edited)).outcome, "unknown");
  const futureNoop = { ...edit, expectedRevisions: { ...edit.expectedRevisions, workspace: edit.expectedRevisions.workspace + 1 } };
  assert.equal((await status(f, futureNoop)).outcome, "unknown", "future equality is possible, including unchanged Views");
  assert.equal((await f.post("commit", edited)).status, 200, "unknown does not cancel an eligible command");
});

test("BRE-478 same-key different mutation and other resource-family reservations never certify absence", async () => {
  const f = await fixture();
  const command = await f.prepare();
  assert.equal((await f.post("commit", command)).status, 200);
  const other = await changed(f, command, (draft) => { draft.identity.name = "Different body"; });
  assert.deepEqual(await status(f, other), { operation: "view_commit", workspaceId: "owner", retryKey: other.retryKey, expectedRevisions: other.expectedRevisions, outcome: "unknown", reason: "command_mismatch" });
  const db = createDatabaseClient(f.path);
  try { db.sqlite.query("UPDATE organization_change_sets SET resource_family='context' WHERE workspace_id='owner' AND idempotency_key=?").run(command.retryKey); }
  finally { db.sqlite.close(); }
  assert.equal((await status(f, command)).outcome, "unknown");
  const reserved = await status(f, command);
  if (reserved.outcome === "unknown") assert.equal(reserved.reason, "incompatible_reservation");
});

test("BRE-478 original update receipt wins over unchanged/stale observations and later edits", async () => {
  const f = await fixture();
  const created = await (await f.post("commit", await f.prepare())).json();
  const update = await changed(f, await f.prepare("", created.view.id), (draft) => { draft.skipInbox = false; draft.identity.name = "Updated"; });
  const response = await f.post("commit", update);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  const proof = await status(f, update);
  assert.equal(proof.outcome, "applied");
  if (proof.outcome === "applied") {
    assert.equal(proof.viewId, created.view.id);
    assert.equal(proof.committedViewRevision, saved.view.revision);
    assert.equal(proof.committedWorkspaceRevision, saved.workspaceRevision);
  }
  const fresh = await changed(f, await f.prepare("", saved.view.id), (draft) => { draft.identity.description = "Later mutation"; });
  assert.equal((await f.post("commit", fresh)).status, 200);
  assert.deepEqual(await status(f, update), proof);
  // Review-only fields are validated, but were never stored in the lower-level receipt binding.
  assert.deepEqual(await status(f, { ...update, confirmedZeroMatchDigest: null, draft: { ...update.draft, source: { kind: "manual", label: "Reopened" } } }), proof);
});

test("BRE-478 no-op predicate includes every persisted field and complete definition, exclusively for commit", async () => {
  const f = await fixture();
  const saved = await (await f.post("commit", await f.prepare())).json();
  const original = await f.prepare("", saved.view.id);
  const variants: Array<(draft: OrganizationViewCommitRequest["draft"]) => void> = [
    (draft) => { draft.identity.name = "Other"; },
    (draft) => { draft.identity.description = "Other"; },
    (draft) => { draft.identity.color = "#123456"; },
    (draft) => { draft.identity.position += 1; },
    (draft) => { draft.skipInbox = !draft.skipInbox; },
    (draft) => { draft.definition.thread!.subjectContains = "Other"; },
    (draft) => { draft.definition.sender!.addresses!.push("other@example.com"); },
  ];
  for (const change of variants) assert.equal((await status(f, await changed(f, original, change))).outcome, "unknown");
  const db = service(f);
  try {
    const lower = db.views.update({ scope: db.scope, viewId: saved.view.id, request: {
      idempotencyKey: "lower-patch-is-not-commit", expectedWorkspaceRevision: original.expectedRevisions.workspace, expectedRevision: original.expectedRevisions.view,
      patch: { ...original.draft.identity, skipInbox: original.draft.skipInbox, definition: original.draft.definition },
    } });
    assert.equal(lower.revision, saved.view.revision + 1, "equivalent lower-level PATCH is intentionally a write");
  } finally { db.sqlite.close(); }
  assert.equal((await status(f, original)).outcome, "not_applied", "workspace advancement still fences the original commit");
});

test("BRE-478 malformed binding, foreign account, and unauthenticated requests provide no proof", async () => {
  const f = await fixture();
  const command = await f.prepare();
  const before = f.snapshot();
  const invalid = [
    { ...command, workspaceId: "foreign" },
    { ...command, actor: { type: "human", id: "foreign" } },
    { ...command, draft: { ...command.draft, summary: ["forged"] } },
    { ...command, draft: { ...command.draft, definitionDigest: `sha256:${"0".repeat(64)}` } },
    { ...command, draft: { ...command.draft, effectiveAccountIds: ["foreign-account"] } },
  ];
  for (const body of invalid) {
    const response = await f.post("commit-status", body);
    assert.equal(response.status, 400);
    assert.equal(organizationViewCommitStatusResponseSchema.safeParse(await response.json()).success, false);
  }
  const unauthorized = await f.app.request("/v1/organization/views/commit-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  assert.equal(unauthorized.status, 401);
  const db = service(f);
  try { assert.throws(() => db.views.commitStatus({ scope: { ...db.scope, workspaceId: "foreign" }, request: command }), OrganizationViewAccessError); }
  finally { db.sqlite.close(); }
  assert.deepEqual(f.snapshot(), before);
});

test("BRE-478 corrupt receipt/authority/revision/response cannot fall through to not_applied", async () => {
  const f = await fixture();
  const command = await f.prepare();
  assert.equal((await f.post("commit", command)).status, 200);
  const db = createDatabaseClient(f.path);
  try {
    const row = db.sqlite.query("SELECT * FROM organization_change_sets WHERE idempotency_key=?").get(command.retryKey) as Record<string, string | number>;
    const corruptions: Array<[string, string | number]> = [
      ["command_json", "{"], ["command_json", "{}"], ["command_json", JSON.stringify({ request: JSON.parse(String(row.command_json)).request, response: null })],
      ["authority_trace", "{}"], ["authority_trace", "{"], ["command_digest", `sha256:${"0".repeat(64)}`],
      ["workspace_revision_before", 999], ["workspace_revision_after", 999], ["operation", "revert"], ["status", "pending"],
      ["command_json", JSON.stringify({ request: JSON.parse(String(row.command_json)).request, response: { ...JSON.parse(String(row.command_json)).response, id: "wrong-original-id" } })],
    ];
    for (const [column, value] of corruptions) {
      db.sqlite.query(`UPDATE organization_change_sets SET ${column}=? WHERE idempotency_key=?`).run(value, command.retryKey);
      const before = f.snapshot();
      const proof = await status(f, command);
      assert.equal(proof.outcome, "unknown", column);
      if (proof.outcome === "unknown") assert.equal(proof.reason, "invalid_receipt", column);
      assert.deepEqual(f.snapshot(), before);
      db.sqlite.query(`UPDATE organization_change_sets SET ${column}=? WHERE idempotency_key=?`).run(row[column]!, command.retryKey);
    }
  } finally { db.sqlite.close(); }
});

test("BRE-478 status executes with SQLite writes disabled, no lazy state, no body reads; guard has positive control", async () => {
  const f = await fixture();
  const command = await f.prepare();
  const statements: string[] = [];
  const changes: number[] = [];
  const readonlyApp = createApp({ dbFactory: () => {
    const client = createDatabaseClient(f.path);
    client.sqlite.exec("PRAGMA query_only=ON");
    const query = client.sqlite.query.bind(client.sqlite);
    client.sqlite.query = ((sql: string) => { statements.push(sql); return query(sql); }) as typeof client.sqlite.query;
    const close = client.sqlite.close.bind(client.sqlite);
    client.sqlite.close = (() => {
      changes.push((query("SELECT total_changes() AS count").get() as { count: number }).count);
      close();
    }) as typeof client.sqlite.close;
    return client;
  } });
  const before = f.snapshot();
  const response = await readonlyApp.request("/v1/organization/views/commit-status", { method: "POST", headers: f.headers, body: JSON.stringify(command) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).outcome, "unknown");
  assert.ok(changes.length >= 2, "auth and status connections were independently observed");
  assert.ok(changes.every((count) => count === 0));
  assert.equal(statements.some((sql) => /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)), false);
  assert.equal(statements.some((sql) => /\b(emails|body_text|body_html|provider_payload)\b/i.test(sql)), false);
  assert.deepEqual(f.snapshot(), before);
  const control = createDatabaseClient(f.path);
  try {
    control.sqlite.exec("PRAGMA query_only=ON");
    assert.throws(() => control.sqlite.query("UPDATE organization_workspace_states SET revision=revision WHERE workspace_id='owner'").run(), /readonly|read-only/i);
    control.sqlite.exec("PRAGMA query_only=OFF");
    control.sqlite.query("DELETE FROM organization_workspace_states WHERE workspace_id='owner'").run();
  } finally { control.sqlite.close(); }
  const noStateBefore = f.snapshot();
  const noStateResponse = await readonlyApp.request("/v1/organization/views/commit-status", { method: "POST", headers: f.headers, body: JSON.stringify(command) });
  assert.equal(noStateResponse.status, 200, await noStateResponse.clone().text());
  assert.equal((await noStateResponse.json()).reason, "workspace_unavailable");
  assert.deepEqual(f.snapshot(), noStateBefore, "missing workspace state is never lazily inserted");
  const db = service(f);
  try {
    const repository = createSqliteOrganizationViewsRepository(db.sqlite);
    const forbidden = () => { throw new Error("status must not evaluate mail or use independent reads"); };
    const isolated = createOrganizationViews({ ...repository, evaluate: forbidden, validateDefinition: forbidden, replay: forbidden, get: forbidden, getWorkspaceRevision: forbidden, getAuthorityState: forbidden, list: forbidden });
    assert.equal(isolated.commitStatus({ scope: db.scope, request: command }).outcome, "unknown");
  } finally { db.sqlite.close(); }
});

test("BRE-478 Account revoked while route req.json is held is rechecked before proof", async () => {
  const f = await fixture();
  const command = await f.prepare();
  let opened!: () => void;
  const ready = new Promise<void>((resolveReady) => { opened = resolveReady; });
  let opens = 0;
  const app = new Hono<{ Variables: AuthVariables }>();
  registerOrganizationViewRoutes(app, { dbFactory: () => {
    const client = createDatabaseClient(f.path);
    if (++opens === 2) queueMicrotask(opened);
    return client;
  } });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const pending = app.request(new Request("http://localhost/v1/organization/views/commit-status", { method: "POST", headers: f.headers, body: stream, duplex: "half" } as RequestInit));
  await ready;
  const db = createDatabaseClient(f.path);
  try { db.sqlite.query("DELETE FROM oauth_accounts WHERE id='account'").run(); } finally { db.sqlite.close(); }
  const before = f.snapshot();
  body.enqueue(new TextEncoder().encode(JSON.stringify(command))); body.close();
  const response = await pending;
  assert.equal(response.status, 403, await response.clone().text());
  assert.equal(organizationViewCommitStatusResponseSchema.safeParse(await response.json()).success, false);
  assert.deepEqual(f.snapshot(), before);
});

function agentService(f: Awaited<ReturnType<typeof fixture>>, afterSnapshot?: () => void) {
  const client = createDatabaseClient(f.path);
  const scope = { workspaceId: "owner", accountIds: ["account"], actor: { id: "agent", type: "agent" as const } };
  const snapshot: OrganizationCapabilitySnapshot = {
    id: "grant", revision: 1, actor: scope.actor, scope: { workspaceId: "owner", accountIds: ["account"] },
    operations: ["query", "apply"], resourceFamilies: ["mail", "thread", "view"], actionFamilies: ["organization_read", "organization_structure"],
  };
  let revoked = false;
  let inTransaction = 0;
  const source = { load(_scope: unknown, executor?: unknown) {
    if (executor) { inTransaction++; afterSnapshot?.(); }
    return { snapshot, revokedAt: revoked ? "2026-11-11T00:00:00Z" : null };
  } };
  const views = createOrganizationViews(createSqliteOrganizationViewsRepository(client.sqlite), { agentCapabilitySource: source });
  const command = () => {
    const prepared = views.prepare({ scope, input: { kind: "typed_definition", source: { kind: "manual", label: "Agent synthetic" }, identity: { name: "Agent View" }, definition: { revision: 1, accountIds: ["account"], thread: { subjectContains: "Agent" } } } });
    return { draft: prepared.draft, retryKey: crypto.randomUUID(), expectedRevisions: { workspace: prepared.workspaceRevision, view: null }, confirmedZeroMatchDigest: prepared.draft.definitionDigest };
  };
  return { ...client, scope, snapshot, views, command, revoke: () => { revoked = true; }, transactionLoads: () => inTransaction };
}

test("BRE-478 live agent grant and receipt actor authority are required inside status snapshot", async () => {
  const f = await fixture();
  const agent = agentService(f);
  try {
    const command = agent.command();
    agent.views.commit({ scope: agent.scope, request: command });
    assert.equal(agent.views.commitStatus({ scope: agent.scope, request: command }).outcome, "applied");
    const before = f.snapshot();
    agent.revoke();
    assert.throws(() => agent.views.commitStatus({ scope: agent.scope, request: command }), OrganizationViewAccessError);
    assert.ok(agent.transactionLoads() > 0);
    const human = service(f);
    try { assert.equal(human.views.commitStatus({ scope: human.scope, request: command }).outcome, "unknown", "human cannot claim another actor's receipt"); }
    finally { human.sqlite.close(); }
    assert.deepEqual(f.snapshot(), before);
  } finally { agent.sqlite.close(); }
  let enabled = false;
  let revoke!: () => void;
  const racing = agentService(f, () => { if (enabled) revoke(); });
  revoke = racing.revoke;
  try {
    const command = racing.command();
    enabled = true;
    assert.throws(() => racing.views.commitStatus({ scope: racing.scope, request: command }), OrganizationViewAccessError, "revocation after preflight must be observed by transaction-live grant load");
  } finally { racing.sqlite.close(); }
});

test("BRE-478 single snapshot cannot mix absent receipt with revision from a competing original commit", async () => {
  const f = await fixture();
  let enabled = false;
  let original!: OrganizationViewCommitRequest;
  let competingViews!: ReturnType<typeof createOrganizationViews>;
  let competingScope!: ReturnType<typeof agentService>["scope"];
  let committed = false;
  const primary = agentService(f, () => {
    if (enabled && !committed) {
      committed = true;
      competingViews.commit({ scope: competingScope, request: original });
    }
  });
  const competing = agentService(f);
  competingViews = competing.views; competingScope = competing.scope;
  try {
    original = primary.command();
    enabled = true;
    // The transaction has already read owner before its live grant callback:
    // a separate WAL writer now commits while the read snapshot stays old.
    const proof = primary.views.commitStatus({ scope: primary.scope, request: original });
    assert.equal(committed, true);
    assert.equal(proof.outcome, "unknown", "must not combine old absence with new advanced revision into false not_applied");
    const after = f.snapshot();
    assert.equal(primary.views.commitStatus({ scope: primary.scope, request: original }).outcome, "applied");
    assert.deepEqual(f.snapshot(), after);
    const replay = competing.views.commit({ scope: competing.scope, request: original });
    assert.equal(replay.view.id, (competing.sqlite.query("SELECT id FROM organization_views WHERE workspace_id='owner'").get() as { id: string }).id);
    assert.equal((competing.sqlite.query("SELECT COUNT(*) AS count FROM organization_change_sets WHERE idempotency_key=?").get(original.retryKey) as { count: number }).count, 1);
  } finally { primary.sqlite.close(); competing.sqlite.close(); }
});

test("BRE-478 stale proof remains durable after subsequent competing workspace writes", async () => {
  const f = await fixture();
  const original = await f.prepare();
  assert.equal((await f.post("commit", await f.prepare("First competing"))).status, 200);
  assert.equal((await status(f, original)).outcome, "not_applied");
  assert.equal((await f.post("commit", await f.prepare("Second competing"))).status, 200);
  const before = f.snapshot();
  assert.equal((await f.post("commit", original)).status, 409);
  assert.deepEqual(f.snapshot(), before);
});

async function holdOriginal(f: Awaited<ReturnType<typeof fixture>>, command: OrganizationViewCommitRequest) {
  let opened!: () => void;
  const ready = new Promise<void>((resolveReady) => { opened = resolveReady; });
  let opens = 0;
  const app = new Hono<{ Variables: AuthVariables }>();
  registerOrganizationViewRoutes(app, { dbFactory: () => {
    const client = createDatabaseClient(f.path);
    if (++opens === 2) queueMicrotask(opened);
    return client;
  } });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  const pending = app.request(new Request("http://localhost/v1/organization/views/commit", { method: "POST", headers: f.headers, body: stream, duplex: "half" } as RequestInit));
  await ready;
  return async () => { body.enqueue(new TextEncoder().encode(JSON.stringify(command))); body.close(); return pending; };
}

test("BRE-478 original HTTP request held before execution remains fenced when released after proof", async () => {
  const f = await fixture();
  const saved = await (await f.post("commit", await f.prepare())).json();
  const noop = await f.prepare("", saved.view.id);
  const finishNoop = await holdOriginal(f, noop);
  assert.equal((await status(f, noop)).outcome, "not_applied");
  const beforeNoop = f.snapshot();
  assert.equal((await finishNoop()).status, 400);
  assert.deepEqual(f.snapshot(), beforeNoop);
  const stale = await f.prepare();
  const finishStale = await holdOriginal(f, stale);
  assert.equal((await f.post("commit", await f.prepare("Intervening mutation"))).status, 200);
  assert.equal((await status(f, stale)).outcome, "not_applied");
  const beforeStale = f.snapshot();
  assert.equal((await finishStale()).status, 409);
  assert.deepEqual(f.snapshot(), beforeStale);
});

test("BRE-478 missing/foreign target without matching receipt stays unproven even after Workspace advances", async () => {
  const f = await fixture();
  const saved = await (await f.post("commit", await f.prepare())).json();
  const original = await f.prepare("", saved.view.id);
  assert.equal((await f.post("commit", await f.prepare("Advance"))).status, 200);
  const foreign = { ...original, draft: { ...original.draft, viewId: "foreign-or-missing" } };
  const before = f.snapshot();
  const response = await f.post("commit-status", foreign);
  assert.equal(response.status, 404, await response.clone().text());
  assert.equal(organizationViewCommitStatusResponseSchema.safeParse(await response.json()).success, false);
  assert.deepEqual(f.snapshot(), before);
});

test("BRE-478 existing expiring-session renewal changes authentication only, outside domain classifier", async () => {
  const f = await fixture();
  const command = await f.prepare();
  const client = createDatabaseClient(f.path);
  const session = await createSession(client.db, "owner", 60_000);
  client.sqlite.close();
  const before = f.snapshot();
  const response = await f.app.request("/v1/organization/views/commit-status", {
    method: "POST", headers: { ...f.headers, cookie: `orca_session=${session.token}` }, body: JSON.stringify(command),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(response.headers.get("set-cookie"));
  const after = f.snapshot();
  assert.notDeepEqual(after.find(([name]) => name === "sessions"), before.find(([name]) => name === "sessions"));
  assert.deepEqual(after.filter(([name]) => name !== "sessions"), before.filter(([name]) => name !== "sessions"), "renewal cannot mutate Views, receipts, reservations, Workspace, messages or other domain state");
});

test("BRE-478 recovery and fresh save preserve every advanced definition facet", async () => {
  const f = await fixture();
  const client = createDatabaseClient(f.path);
  const now = Date.parse("2026-11-11T00:00:00Z");
  let laneId: string;
  try {
    laneId = (client.sqlite.query("SELECT id FROM organization_lanes WHERE workspace_id='owner' ORDER BY position LIMIT 1").get() as { id: string }).id;
    client.sqlite.query("INSERT INTO organization_facets (id,workspace_id,name,position,value_type,cardinality,is_optional,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("facet", "owner", "Urgency", 0, JSON.stringify({ kind: "text", maxLength: 200 }), JSON.stringify({ kind: "single" }), 1, 1, now, now);
    client.sqlite.query("INSERT INTO organization_workflow_states (id,workspace_id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("workflow", "owner", "Waiting", 0, 1, now, now);
    client.sqlite.query("INSERT INTO organization_context_types (workspace_id,id,name,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("owner", "context-type", "Project", 0, 1, now, now);
    client.sqlite.query("INSERT INTO organization_context_relationship_types (workspace_id,id,context_type_id,name,inverse_name,direction,position,maximum_per_thread,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("owner", "relationship", "context-type", "concerns", "has work", "thread_to_context", 0, 10, 1, now, now);
    client.sqlite.query("INSERT INTO organization_contexts (workspace_id,id,context_type_id,name,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("owner", "context", "context-type", "Orca", 1, now, now);
  } finally { client.sqlite.close(); }
  const definition = {
    revision: 1, accountIds: ["account"], laneIds: [laneId], facetFilters: [{ facetId: "facet", operator: "equals", value: "urgent" }],
    contextFilters: [{ context: { contextTypeId: "context-type", contextId: "context" }, relationshipTypeId: "relationship", direction: "thread_to_context" }],
    workflowStateIds: ["workflow"], humanSignal: { minimumScore: 3, maximumScore: 9, classifications: ["likely_human"], evidenceReasonCodes: ["direct_recipient"] },
    sender: { addresses: ["human@example.com", "other@example.com"], domains: ["example.com"] },
    date: { receivedAfter: "2026-01-01T00:00:00.000Z", receivedBefore: "2026-12-31T00:00:00.000Z" },
    thread: { subjectContains: "Advanced", readState: "unread" },
  };
  const preparedResponse = await f.post("prepare", { kind: "typed_definition", source: { kind: "search", label: "Advanced source" }, identity: { name: "Advanced", description: "Complete definition", color: "#123456", position: 0 }, skipInbox: true, definition });
  assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
  const prepared = await preparedResponse.json();
  const command = { draft: prepared.draft, retryKey: "advanced-create", expectedRevisions: { workspace: prepared.workspaceRevision, view: null }, confirmedZeroMatchDigest: prepared.draft.definitionDigest };
  const savedResponse = await f.post("commit", command);
  assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
  const saved = await savedResponse.json();
  assert.deepEqual(saved.view.definition, definition);
  const noop = await f.prepare("", saved.view.id);
  assert.equal((await f.post("commit", noop)).status, 400);
  assert.equal((await status(f, noop)).outcome, "not_applied");
  const newer = await changed(f, await f.prepare("", saved.view.id), (draft) => { draft.identity.name = "Newer user edits preserved"; });
  const updatedResponse = await f.post("commit", newer);
  assert.equal(updatedResponse.status, 200, await updatedResponse.clone().text());
  const updated = await updatedResponse.json();
  assert.equal(updated.view.name, "Newer user edits preserved");
  assert.deepEqual(updated.view.definition, definition);
  assert.equal((await f.post("commit", noop)).status, 409, "old original stays fenced after fresh save");
});
