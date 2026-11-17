import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { expectedUserIdHeaderName, organizationSavedQueryDefinitionSchema, organizationSavedQueryResultResponseSchema, type OrganizationSavedQueryDefinition } from "@orca/shared";
import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { collections, emails, importanceChoices, oauthAccounts, organizationSavedQueries, threads } from "../../db/schema.ts";
import { readSavedQueryResults } from "./query-results-reader.ts";
import { createQueryImportanceBaselineFixture, importanceReceipt, type QueryImportanceBaselineFixture } from "./query-importance-baseline.fixture.ts";

let f: QueryImportanceBaselineFixture;
beforeAll(async () => { f = await createQueryImportanceBaselineFixture(); await f.preconditions(); }, 20_000);
afterAll(() => f?.close());
let sequence = 0;
const enhanced = { "x-orca-importance-version": "1" };
const vary = (response: Response) => response.headers.get("vary")?.toLowerCase().split(/\s*,\s*/);

function pageUrl(limit = 30, cursor?: string, query = f.queryU) {
  const url = new URL(f.resultUrl(query), "http://synthetic.invalid");
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.pathname + url.search;
}
async function page(name: string, url = f.resultUrl(f.queryU), headers: Record<string, string> = { ...f.headersU, ...enhanced }) {
  const result = await f.request(name, url, headers);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  assert.ok(vary(result.response)?.includes("x-orca-importance-version"));
  return { ...result, body: organizationSavedQueryResultResponseSchema.parse(result.value) };
}
function saveQuery(filters: OrganizationSavedQueryDefinition["filters"]) {
  const id = `candidate-query-${++sequence}`;
  const definition = organizationSavedQueryDefinitionSchema.parse({ revision: 1, filters });
  f.client.db.insert(organizationSavedQueries).values({ id, accountId: f.queryU.accountId, name: id, revision: 9, definitionJson: JSON.stringify(definition) }).run();
  return { id, accountId: f.queryU.accountId, revision: 9 };
}
function restore(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  // Test-owned table/column names from a retained SQLite row, never a request.
  f.client.sqlite.query(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
}

test("BRE-457 importance candidate: exact header1 only, basic JSON and Vary are compatible", async () => {
  const basic = await page("basic compatibility", f.resultUrl(f.queryU), f.headersU);
  for (const version of ["0", "2", "01", "1,2"]) {
    const unknown = await page(`unknown importance ${version}`, f.resultUrl(f.queryU), { ...f.headersU, "x-orca-importance-version": version });
    assert.deepEqual(unknown.body, basic.body);
  }
  const full = await page("enhanced compatibility");
  assert.deepEqual({ ...full.body, messages: full.body.messages.map(({ importance: _importance, ...row }) => row) }, basic.body);
  assert.deepEqual(full.body.messages.map(row => row.importance?.effective).sort(), ["important", "not_important", "unreviewed"]);
  assert.ok(vary(full.response)?.includes("origin"), "Importance Vary must append to existing CORS Vary");
});

test("BRE-457 importance candidate: empty enhanced result has no fabricated metadata or totals", async () => {
  const query = saveQuery({ dataSource: "stored_mail", mailbox: "all", attention: "all", classification: "all", text: "not-a-fixture-match-98571" });
  const result = await page("empty enhanced", f.resultUrl(query));
  assert.deepEqual(result.body.messages, []);
  assert.equal(result.body.nextCursor, null);
  assert.deepEqual(Object.keys(result.body).sort(), ["accounts", "freshness", "messages", "nextCursor", "query"]);
});

test("BRE-457 importance candidate: only final accepted page requires importance state", async () => {
  const first = await page("first target", pageUrl(1));
  const unreturned = f.sourceStates().find(row => row.thread_id !== first.body.messages[0]?.threadId)!;
  const row = f.client.sqlite.query("SELECT * FROM importance_thread_state WHERE account_id=? AND thread_id=?").get(f.queryU.accountId, unreturned.thread_id) as Record<string, unknown>;
  f.client.sqlite.query("DELETE FROM importance_thread_state WHERE account_id=? AND thread_id=?").run(f.queryU.accountId, unreturned.thread_id);
  try { assert.deepEqual((await page("unreturned missing state", pageUrl(1))).body.messages, first.body.messages); }
  finally { restore("importance_thread_state", row); }
});

test("BRE-457 importance candidate: returned missing state is503, basic succeeds, no lazy repair", async () => {
  const missing = f.sourceStates()[0]!;
  const row = f.client.sqlite.query("SELECT * FROM importance_thread_state WHERE account_id=? AND thread_id=?").get(f.queryU.accountId, missing.thread_id) as Record<string, unknown>;
  f.client.sqlite.query("DELETE FROM importance_thread_state WHERE account_id=? AND thread_id=?").run(f.queryU.accountId, missing.thread_id);
  try {
    const result = await f.request("missing importance state", f.resultUrl(f.queryU), { ...f.headersU, ...enhanced });
    assert.equal(result.response.status, 503);
    assert.equal((result.value as { error: { code: string } }).error.code, "mailbox_unavailable");
    assert.equal(result.response.headers.get("cache-control"), "private, no-store");
    assert.ok(vary(result.response)?.includes("x-orca-importance-version"));
    assert.equal((await page("missing importance basic", f.resultUrl(f.queryU), f.headersU)).body.messages.length, 3);
    assert.equal(f.client.sqlite.query("SELECT thread_id FROM importance_thread_state WHERE account_id=? AND thread_id=?").get(f.queryU.accountId, missing.thread_id), null);
  } finally { restore("importance_thread_state", row); }
});

test("BRE-457 importance candidate: corrupt materialized metadata is non-success, never Unreviewed", async () => {
  const state = f.sourceStates()[0]!;
  const old = f.client.sqlite.query("SELECT participant_count FROM importance_thread_state WHERE account_id=? AND thread_id=?").get(f.queryU.accountId, state.thread_id) as { participant_count: number };
  f.client.sqlite.query("UPDATE importance_thread_state SET participant_count=-1 WHERE account_id=? AND thread_id=?").run(f.queryU.accountId, state.thread_id);
  try {
    // Hono's default unexpected-error response may be text; do not invent a JSON error contract.
    const before = f.client.sqlite.query("PRAGMA data_version").get();
    const result = await f.app.request(f.resultUrl(f.queryU), { headers: { ...f.headersU, ...enhanced } });
    assert.equal(result.status, 500);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(f.client.sqlite.query("PRAGMA data_version").get(), before);
    importanceReceipt({ name: "corrupt-importance-non-success", status: result.status, body: await result.text() });
  } finally { f.client.sqlite.query("UPDATE importance_thread_state SET participant_count=? WHERE account_id=? AND thread_id=?").run(old.participant_count, f.queryU.accountId, state.thread_id); }
});

test("BRE-457 importance candidate: enhanced projection stays in real query-only transaction", () => {
  const { sqlite } = createDatabaseClient(f.databasePath);
  let observed = false;
  try {
    const result = readSavedQueryResults(sqlite, { auth: f.sessionU, authSource: "cookie", queryId: f.queryU.id,
      query: { accountId: f.queryU.accountId, limit: 30 }, includeImportance: true, cursorSecret: process.env.SESSION_SECRET!,
      observe(metric) {
        observed = true;
        assert.equal(sqlite.inTransaction, true);
        assert.deepEqual(sqlite.query("PRAGMA query_only").get(), { query_only: 1 });
        assert.throws(() => sqlite.query("UPDATE importance_thread_state SET participant_count=0").run(), /readonly|read-only/i);
        importanceReceipt({ name: "enhanced-real-readonly", metric, queryOnly: 1, rejectedUpdate: true });
      } });
    assert.ok(result.messages.every(row => row.importance));
    assert.equal(observed, true);
    assert.deepEqual(sqlite.query("SELECT total_changes() changes").get(), { changes: 0 });
  } finally { sqlite.close(); }
});

test("BRE-457 importance candidate: tied pages repeat and cross projection mode both directions", async () => {
  const basicFirst = await page("basic first", pageUrl(1), f.headersU);
  const fullFirst = await page("full first", pageUrl(1));
  assert.equal(fullFirst.body.nextCursor, basicFirst.body.nextCursor);
  assert.ok(basicFirst.body.nextCursor);
  const fullNext = await page("basic to enhanced", pageUrl(1, basicFirst.body.nextCursor));
  const basicNext = await page("enhanced to basic", pageUrl(1, fullFirst.body.nextCursor! ), f.headersU);
  assert.deepEqual(fullNext.body.messages.map(row => row.id), basicNext.body.messages.map(row => row.id));
  assert.ok(fullNext.body.messages.every(row => row.importance));
  assert.ok(basicNext.body.messages.every(row => row.importance === undefined));
  const ids = [...basicFirst.body.messages.map(row => row.id), ...fullNext.body.messages.map(row => row.id)];
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual((await page("repeat same cursor", pageUrl(1, basicFirst.body.nextCursor))).body, fullNext.body);
});

test("BRE-457 importance candidate: importance advances freshness and invalidates cursor, not saved query", async () => {
  const before = await page("before choice change", pageUrl(1));
  assert.ok(before.body.nextCursor);
  const row = f.client.sqlite.query("SELECT choice,revision FROM importance_choices WHERE account_id=? AND kind='conversation' AND target='importance-thread-important'").get(f.queryU.accountId) as { choice: string; revision: number };
  f.client.sqlite.query("UPDATE importance_choices SET choice='not_important',revision=revision+1 WHERE account_id=? AND kind='conversation' AND target='importance-thread-important'").run(f.queryU.accountId);
  try {
    const stale = await f.request("importance changed cursor", pageUrl(1, before.body.nextCursor), { ...f.headersU, ...enhanced });
    assert.equal(stale.response.status, 400);
    assert.equal((stale.value as { error: { code: string } }).error.code, "invalid_cursor");
    const after = await page("after choice change");
    assert.deepEqual(after.body.query, before.body.query);
    assert.notEqual(after.body.freshness.revision, before.body.freshness.revision);
    const changed = after.body.messages.find(message => message.threadId === "importance-thread-important")!.importance!;
    assert.equal(changed.effective, "not_important");
    assert.equal(changed.conversation.revision, row.revision + 1);
  } finally { f.client.sqlite.query("UPDATE importance_choices SET choice=?,revision=revision+1 WHERE account_id=? AND kind='conversation' AND target='importance-thread-important'").run(row.choice, f.queryU.accountId); }
});

test("BRE-457 importance candidate: cookie/mobile own enhanced rows and foreign404 stay isolated", async () => {
  for (const kind of ["cookie", "mobile"] as const) {
    const headers = f.headersB(kind, f.currentUser);
    assert.equal((await f.request(`${kind} foreign query`, f.resultUrl(f.queryU), { ...headers, ...enhanced })).response.status, 404);
    const own = await page(`${kind} own enhanced`, f.resultUrl(f.queryB), { ...headers, ...enhanced });
    assert.deepEqual(own.body.accounts.map(account => account.id), [f.queryB.accountId]);
    assert.ok(own.body.messages.every(message => message.accountId === f.queryB.accountId && message.importance?.effective === "unreviewed"));
  }
});

test("BRE-457 importance candidate: retained conflicting account is422 before projection", async () => {
  const query = saveQuery({ dataSource: "stored_mail", mailbox: "all", attention: "all", accountId: f.queryB.accountId });
  const result = await f.request("conflicting retained account", f.resultUrl(query), { ...f.headersU, ...enhanced });
  assert.equal(result.response.status, 422);
  assert.equal((result.value as { error: { code: string } }).error.code, "invalid_saved_query");
});

test("BRE-457 importance candidate: foreign retained collection is404 without projection broadening", async () => {
  f.client.db.insert(collections).values({ id: "candidate-foreign-collection", accountId: f.queryB.accountId, name: "Foreign", color: "#70867d", position: 0 }).run();
  const query = saveQuery({ dataSource: "stored_mail", mailbox: "all", attention: "all", collectionId: "candidate-foreign-collection" });
  assert.equal((await f.request("foreign retained collection", f.resultUrl(query), { ...f.headersU, ...enhanced })).response.status, 404);
});

test("BRE-457 importance candidate: same-user different session cannot reuse enhanced cursor", async () => {
  const first = await page("session-bound first", pageUrl(1));
  assert.ok(first.body.nextCursor);
  const other = await createSession(f.client.db, f.sessionU.userId);
  const result = await f.request("other session cursor", pageUrl(1, first.body.nextCursor), { cookie: `orca_session=${other.token}`, ...enhanced });
  assert.equal(result.response.status, 400);
});

test("BRE-457 importance candidate: cookie and mobile revocation remains401 with opt-in", async () => {
  const session = await createSession(f.client.db, f.sessionU.userId);
  f.client.sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id=?").run(Date.now(), session.sessionId);
  assert.equal((await f.request("revoked cookie enhanced", f.resultUrl(f.queryU), { cookie: `orca_session=${session.token}`, ...enhanced })).response.status, 401);
  f.client.sqlite.query("UPDATE mobile_sessions SET revoked_at=? WHERE id=?").run(Date.now(), f.mobileB.sessionId);
  try { assert.equal((await f.request("revoked mobile enhanced", f.resultUrl(f.queryB), { ...f.headersB("mobile", f.currentUser), ...enhanced })).response.status, 401); }
  finally { f.client.sqlite.query("UPDATE mobile_sessions SET revoked_at=NULL WHERE id=?").run(f.mobileB.sessionId); }
});

test("BRE-457 importance candidate: missing mailbox revision stays503 and is not lazily rebuilt", async () => {
  const row = f.client.sqlite.query("SELECT * FROM mailbox_revisions WHERE account_id=?").get(f.queryU.accountId) as Record<string, unknown>;
  f.client.sqlite.query("DELETE FROM mailbox_revisions WHERE account_id=?").run(f.queryU.accountId);
  try {
    const result = await f.request("missing revision root enhanced", f.resultUrl(f.queryU), { ...f.headersU, ...enhanced });
    assert.equal(result.response.status, 503);
    assert.equal(f.client.sqlite.query("SELECT account_id FROM mailbox_revisions WHERE account_id=?").get(f.queryU.accountId), null);
  } finally { restore("mailbox_revisions", row); }
});

for (const kind of ["cookie", "mobile"] as const) {
  for (const surface of ["catalog", "results"] as const) {
    test(`BRE-457 importance candidate: ${kind} ${surface} absent/matching/malformed owner headers`, async () => {
      const matching = f.headersB(kind, f.currentUser);
      const { [expectedUserIdHeaderName]: _expected, ...absent } = matching;
      const url = surface === "catalog" ? `/v1/organization/collections-pins/query?accountId=${encodeURIComponent(f.queryB.accountId)}` : f.resultUrl(f.queryB);
      for (const headers of [absent, matching]) {
        const result = await f.request(`${kind} ${surface} compatible owner`, url, headers);
        assert.equal(result.response.status, 200);
        assert.equal(result.response.headers.get("cache-control"), "private, no-store");
      }
      for (const expected of ["", "invalid owner", "x".repeat(257)]) {
        const result = await f.request(`${kind} ${surface} malformed owner`, url, { ...matching, [expectedUserIdHeaderName]: expected });
        assert.equal(result.response.status, 400);
        assert.equal((result.value as { error: { code: string } }).error.code, "invalid_request");
        assert.equal(result.openedConnections, 1);
        assert.equal(result.response.headers.get("cache-control"), "private, no-store");
      }
    });
  }
}

for (const surface of ["catalog", "results"] as const) {
  test(`BRE-457 importance candidate: actual ${surface} CORS preflight permits existing headers`, async () => {
    const url = surface === "catalog" ? "/v1/organization/collections-pins/query" : f.resultUrl(f.queryU);
    const result = await f.app.request(url, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "x-orca-expected-user-id,x-orca-importance-version" } });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const allowed = result.headers.get("access-control-allow-headers")?.toLowerCase().split(/\s*,\s*/);
    assert.ok(allowed?.includes("x-orca-expected-user-id") && allowed.includes("x-orca-importance-version"));
    importanceReceipt({ name: "actual-cors-preflight", surface, status: result.status, allowed, browserExecuted: false });
  });
}

test("BRE-457 importance candidate: All Mail generated and legacy Unicode rows share importance projection", async () => {
  f.client.sqlite.query("UPDATE emails SET from_name='ÉLODIE' WHERE id='importance-message-important'").run();
  try {
    const all = saveQuery({ dataSource: "stored_mail", mailbox: "all", attention: "all", classification: "all" });
    assert.equal((await page("generated all importance", f.resultUrl(all))).body.messages.length, 3);
    const legacy = saveQuery({ mailbox: "all", attention: "all", classification: "all", sender: "élodie important@synthetic.example" });
    const result = await page("legacy Unicode importance", f.resultUrl(legacy));
    assert.deepEqual(result.body.messages.map(message => message.id), ["importance-message-important"]);
    assert.equal(result.body.query.evaluationProfile, "legacy-pin-v1");
    assert.equal(result.body.messages[0]?.importance?.effective, "important");
  } finally { f.client.sqlite.query("UPDATE emails SET from_name='important' WHERE id='importance-message-important'").run(); }
});

test("BRE-457 importance candidate: same-user accounts sharing exact sender retain opposite choices", async () => {
  const accountId = "candidate-second-owned-account", threadId = "candidate-second-owned-thread";
  f.client.db.insert(oauthAccounts).values({ id: accountId, userId: f.sessionU.userId, provider: "gmail", providerId: accountId, providerEmail: "second@synthetic.example" }).run();
  f.client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, messageCount: 1 }).run();
  f.client.db.insert(emails).values({ id: "candidate-second-owned-message", accountId, threadId, providerMessageId: "candidate-second-owned-message", fromAddress: "important@synthetic.example", humanClassification: "likely_human", receivedAt: new Date() }).run();
  f.client.db.insert(importanceChoices).values({ accountId, kind: "conversation", target: threadId, choice: "not_important", revision: 1, updatedAt: Date.now() }).run();
  const id = "candidate-second-owned-query";
  f.client.db.insert(organizationSavedQueries).values({ id, accountId, name: id, revision: 4, definitionJson: JSON.stringify(organizationSavedQueryDefinitionSchema.parse({ revision: 1, filters: { dataSource: "stored_mail", mailbox: "all", attention: "all", accountId } })) }).run();
  const catalog = await f.request("second owned catalog", `/v1/organization/collections-pins/query?accountId=${accountId}`, f.headersU);
  assert.equal(catalog.response.status, 200);
  const selected = (catalog.value as { queries: Array<{ id: string; accountId: string; revision: number }> }).queries.find(query => query.id === id)!;
  assert.ok(selected);
  const result = await page("second owned enhanced", f.resultUrl(selected));
  assert.deepEqual(result.body.accounts.map(account => account.id), [accountId]);
  assert.equal(result.body.messages.length, 1);
  assert.equal(result.body.messages[0]?.importance?.effective, "not_important");
  assert.equal((await page("original account enhanced")).body.messages.find(row => row.threadId === "importance-thread-important")?.importance?.effective, "important");
});

test("BRE-457 importance candidate: batched full provenance remains truthful beyond20 preferences", async () => {
  for (let i = 0; i < 25; i += 1) {
    const address = `participant${String(i).padStart(2, "0")}@synthetic.example`;
    f.client.db.insert(emails).values({ id: `importance-participant-${i}`, providerMessageId: `importance-participant-${i}`,
      accountId: f.queryU.accountId, threadId: "importance-thread-important", fromAddress: address,
      receivedAt: new Date("2026-10-01T00:00:00Z"), humanClassification: "likely_human" }).run();
    f.client.db.insert(importanceChoices).values({ accountId: f.queryU.accountId, kind: "sender", target: address, choice: "not_important", revision: 1, updatedAt: Date.now() }).run();
  }
  const result = await page("many contributing preferences");
  const importance = result.body.messages.find(message => message.threadId === "importance-thread-important")!.importance!;
  assert.equal(importance.effective, "important", "Conversation override still wins");
  assert.equal(importance.preferences.length, 20);
  assert.equal(importance.preferencesTruncated, true);
  assert.equal(importance.participantCounts.notImportant, 25);
  assert.equal(importance.participantCounts.total, 26);
});
