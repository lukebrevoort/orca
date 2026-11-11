import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { z } from "zod";
import { inboxMessageSchema, mailAccountSchema } from "@orca/shared";
import { createSession } from "../../auth/session-store.ts";

import {
  createQueryResultsFixture, foreignAccount, ownedCollection, ownerAccount, receipt,
  secondAccount, type QueryFilters, type QueryResultsFixture,
} from "./query-results.fixture.ts";

// Independent expected wire contract: production shared schema is deliberately not added at baseline.
const resultSchema = z.object({
  query: z.object({
    id: z.string().min(1), accountId: z.string().min(1), revision: z.number().int().positive(),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evaluationProfile: z.enum(["stored-mail-v1", "legacy-pin-v1"]),
  }).strict(),
  accounts: z.array(mailAccountSchema).length(1),
  messages: z.array(inboxMessageSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
  freshness: z.object({
    revision: z.string().regex(/^mailbox-v[12]:[a-f0-9]{64}$/),
    lastSyncedAt: z.string().datetime().nullable(),
  }).strict(),
}).strict();

const stage = process.env.BRE457_QUERY_STAGE ?? "candidate";
if (!["baseline", "candidate"].includes(stage)) throw new Error("BRE457_QUERY_STAGE must be baseline or candidate");
let fixture: QueryResultsFixture;
beforeAll(async () => {
  fixture = await createQueryResultsFixture();
  await fixture.preconditions();
});
afterAll(() => fixture?.close());

async function result(queryId: string, name: string, params: Record<string, string> = {}) {
  const response = await fixture.request(fixture.url(queryId, params));
  receipt({ name, expectedStatus: 200, actualStatus: response.status });
  assert.equal(response.status, 200, `${name}: evaluator route must exist before semantic assertions can execute`);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = resultSchema.parse(await response.json());
  assert.equal(body.query.id, queryId);
  assert.equal(body.query.accountId, ownerAccount);
  assert.equal(body.query.revision, 7, "Object revision must not be replaced by definition.revision=1");
  assert.deepEqual(body.accounts.map(account => account.id), [ownerAccount]);
  assert.ok(body.messages.every(message => message.accountId === ownerAccount));
  return body;
}

if (stage === "baseline") {
  test("baseline: real authorized catalog/query exists but proposed results route is absent", async () => {
    const response = await fixture.request(fixture.url(fixture.catalogQueryId));
    receipt({
      name: "authenticated-existing-query-missing-route", expectedStatus: 404, actualStatus: response.status,
      semanticsExecuted: false, evidenceScope: "missing endpoint only; not a historical web semantic bug reproduction",
    });
    assert.equal(response.status, 404);
  });
} else {
  describe("BRE-457 approved deterministic counterexamples (candidate only)", () => {
    const cases: Array<{ name: string; filters: QueryFilters; ids: string[] }> = [
      { name: "notify-only distinguishes otherwise identical notify/focus threads", filters: { mailbox: "inbox", attention: "notify", classification: "all", text: "attention-marker" }, ids: ["notify"] },
      { name: "normal-only is independent from Inbox attention union", filters: { mailbox: "inbox", attention: "normal", classification: "all", text: "attention-marker" }, ids: ["normal"] },
      { name: "focus execution union deliberately differs from old strict-focus preview", filters: { mailbox: "inbox", attention: "focus", classification: "all", text: "attention-marker" }, ids: ["notify", "focus", "bulk-focus"] },
      { name: "formerly ignored attention on quiet is conjunctive and contradictory", filters: { mailbox: "quiet", attention: "notify", classification: "all", text: "quiet-marker" }, ids: [] },
      { name: "formerly ignored legacy collection limits All Mail", filters: { mailbox: "all", attention: "all", collectionId: ownedCollection, text: "attention-marker" }, ids: ["notify"] },
      { name: "formerly ignored explicit All Mail classification is honored", filters: { mailbox: "all", attention: "all", classification: "human", text: "attention-marker" }, ids: ["notify", "focus", "normal"] },
      { name: "legacy Focus explicit evidence never inherits mutable browser state", filters: { mailbox: "focus", attention: "all", classification: "tideline", text: "attention-marker" }, ids: ["bulk-focus"] },
      { name: "legacy Inbox absent classification defaults human", filters: { text: "attention-marker" }, ids: ["notify", "focus", "normal"] },
      { name: "legacy Focus absent classification deterministically defaults all", filters: { mailbox: "focus", attention: "all", text: "attention-marker" }, ids: ["notify", "focus", "bulk-focus"] },
      { name: "person retains non-ASCII and cross-name-address boundary plus independent text", filters: { mailbox: "all", attention: "all", sender: "élodie other@", text: "maya" }, ids: ["person"] },
      { name: "person matches subject/snippet rather than author identity", filters: { mailbox: "all", attention: "all", sender: "maya", text: "launch" }, ids: ["person"] },
      { name: "person uses JS Unicode expanding lowercase not SQLite ASCII lower", filters: { mailbox: "all", attention: "all", sender: "i\u0307stanbul", text: "unicode-marker" }, ids: ["unicode"] },
      { name: "person retains JS context-sensitive Greek lowercase", filters: { mailbox: "all", attention: "all", sender: "ος", text: "sigma-marker" }, ids: ["sigma"] },
      { name: "legacy field text uses JS non-ASCII lowercase", filters: { mailbox: "all", attention: "all", text: "élodie" }, ids: ["person"] },
      { name: "legacy text cannot cross subject/snippet newline boundary", filters: { mailbox: "all", attention: "all", text: "right\nleft" }, ids: [] },
      { name: "legacy latest representative excludes historical-only content", filters: { text: "needle", classification: "all" }, ids: [] },
      { name: "quiet latest-before-person deliberately replaces old person-before-dedup", filters: { mailbox: "quiet", attention: "all", sender: "Maya", text: "quiet-marker" }, ids: [] },
      { name: "quiet explicit classification is applied after global latest selection", filters: { mailbox: "quiet", attention: "all", classification: "tideline", text: "quiet-marker" }, ids: [] },
      { name: "hidden latest-before-person deliberately replaces old person-before-dedup", filters: { mailbox: "hidden", attention: "all", sender: "Maya", text: "hidden-marker" }, ids: [] },
      { name: "equal-time SQL tie chooses ascending ID instead of old JS descending ID", filters: { mailbox: "all", attention: "all", text: "tie-marker" }, ids: ["tie-a"] },
      { name: "equal-time winner chosen before person predicate", filters: { mailbox: "all", attention: "all", text: "tie-marker", sender: "Maya" }, ids: [] },
      { name: "archived notify conversation is excluded from legacy Inbox", filters: { classification: "all", text: "archive-marker" }, ids: [] },
      { name: "moved normal conversation is excluded from legacy Inbox", filters: { classification: "all", text: "moved-marker" }, ids: [] },
      { name: "All Mail still retains archived conversation", filters: { mailbox: "all", attention: "all", text: "archive-marker" }, ids: ["archived"] },
      { name: "stored-mail retained notify extension is conjunctive", filters: { dataSource: "stored_mail", mailbox: "inbox", attention: "notify", text: "attention-marker" }, ids: ["notify"] },
      { name: "stored-mail retained sender extension preserves broad migrated-person meaning", filters: { dataSource: "stored_mail", mailbox: "all", attention: "all", sender: "élodie other@", text: "maya" }, ids: ["person"] },
      { name: "stored-mail text preserves existing newline-concatenated search", filters: { dataSource: "stored_mail", mailbox: "all", attention: "all", text: "right\nleft" }, ids: ["boundary"] },
      { name: "stored-mail Inbox retains historical witness/latest representative", filters: { dataSource: "stored_mail", mailbox: "inbox", attention: "all", text: "needle" }, ids: ["history-new"] },
    ];
    for (const scenario of cases) {
      test(scenario.name, async () => {
        const body = await result(fixture.query(scenario.filters), scenario.name);
        assert.equal(body.query.evaluationProfile, scenario.filters.dataSource ? "stored-mail-v1" : "legacy-pin-v1");
        assert.deepEqual(body.messages.map(message => message.id).sort(), [...scenario.ids].sort());
        receipt({ name: scenario.name, semanticsExecuted: true, matchedIds: scenario.ids });
      });
    }

    test("generated stored-mail profiles delegate to existing public mailbox behavior and order", async () => {
      for (const mailbox of ["inbox", "focus", "quiet", "hidden", "all"] as const) {
        const queryId = fixture.query({ dataSource: "stored_mail", mailbox, attention: "all" });
        const params = new URLSearchParams({ accountId: ownerAccount, classification: "all", limit: "100" });
        if (mailbox !== "inbox") params.set("view", mailbox);
        const expectedResponse = await fixture.request(`/v1/inbox?${params}`);
        assert.equal(expectedResponse.status, 200);
        const expected = await expectedResponse.json() as { messages: unknown[]; accounts: unknown[]; freshness: unknown };
        const actual = await result(queryId, `generated-stored-mail-${mailbox}`, { limit: "100" });
        assert.deepEqual(actual.messages, expected.messages);
        assert.deepEqual(actual.accounts, expected.accounts);
        assert.deepEqual(actual.freshness, expected.freshness);
      }
    });

    test("strict legacy raw definition remains readable without changing its bytes", async () => {
      const raw = JSON.stringify({ mailbox: "inbox", attention: "notify", classification: "all", person: null, query: "attention-marker" });
      const queryId = fixture.rawQuery(raw);
      assert.deepEqual((await result(queryId, "strict-legacy-raw")).messages.map(message => message.id), ["notify"]);
      const stored = fixture.sqlite.query("SELECT definition_json FROM organization_saved_queries WHERE id=?").get(queryId) as { definition_json: string };
      assert.equal(stored.definition_json, raw);
    });

    test("canonical definition digest is independent from JSON formatting/key order", async () => {
      const first = await result(fixture.rawQuery('{"revision":1,"filters":{"text":"launch","sender":"maya","mailbox":"all","attention":"all"}}'), "digest-first");
      const second = await result(fixture.rawQuery('{ "filters": { "attention":"all", "mailbox":"all", "sender":"maya", "text":"launch" }, "revision":1 }'), "digest-second");
      assert.equal(first.query.definitionDigest, second.query.definitionDigest);
      assert.deepEqual(first.messages, second.messages);
    });

    test("corrupt/unknown/date/conflicting-account definitions fail closed without catalog normalization", async () => {
      for (const raw of [
        "{", "null", '{"revision":2,"filters":{}}', '{"revision":1,"filters":{"receivedAfter":"2026-01-01"}}',
        '{"revision":1,"filters":{"mailbox":"all"}}', '{"mailbox":"all","attention":"all","person":null,"query":"","date":"2026-01-01"}',
        JSON.stringify({ revision: 1, filters: { accountId: secondAccount } }),
      ]) {
        const response = await fixture.request(fixture.url(fixture.rawQuery(raw)));
        receipt({ name: "invalid-raw-definition", expectedStatus: 422, actualStatus: response.status, raw });
        assert.equal(response.status, 422);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_saved_query");
      }
    });

    test("foreign/missing account, query and collection have indistinguishable 404", async () => {
      const foreignQuery = fixture.query({}, foreignAccount);
      const otherQuery = fixture.query({}, secondAccount);
      const queryId = fixture.query({});
      const paths = [
        fixture.url("missing-query"), fixture.url(foreignQuery), fixture.url(otherQuery),
        fixture.url(queryId, { accountId: foreignAccount }), fixture.url(queryId, { accountId: "missing-account" }),
        fixture.url(fixture.query({ collectionId: "missing-collection" })),
        fixture.url(fixture.query({ collectionId: "bre457-collection-b" })),
        fixture.url(fixture.query({ collectionId: "bre457-collection-foreign" })),
      ];
      const errors: unknown[] = [];
      for (const path of paths) {
        const response = await fixture.request(path);
        receipt({ name: "foreign-or-missing", expectedStatus: 404, actualStatus: response.status });
        assert.equal(response.status, 404);
        errors.push(await response.json());
      }
      for (const error of errors) assert.deepEqual(error, errors[0]);
    });

    test("request account is mandatory; arbitrary definitions, actors and dates are rejected", async () => {
      for (const params of ["limit=1", `accountId=${ownerAccount}&actor=someone`, `accountId=${ownerAccount}&definition={}`, `accountId=${ownerAccount}&receivedAfter=2026-01-01`, `accountId=${ownerAccount}&limit=101`]) {
        const response = await fixture.request(`${fixture.url(fixture.catalogQueryId).split("?")[0]}?${params}`);
        receipt({ name: "strict-request", expectedStatus: 400, actualStatus: response.status });
        assert.equal(response.status, 400);
      }
    });

    test("repeatable keyset paging equals complete deterministic order including tied keys", async () => {
      const queryId = fixture.query({ mailbox: "all", attention: "all" });
      const expected = await result(queryId, "paging-complete", { limit: "100" });
      for (const limit of [1, 2, 3]) {
        const messages = [];
        let cursor: string | null = null;
        let pageCount = 0;
        do {
          assert.ok(++pageCount < 50, "Continuation must terminate for this fixed small fixture");
          const params: Record<string, string> = { limit: String(limit), ...(cursor ? { cursor } : {}) };
          const page = await result(queryId, "paging-next", params);
          assert.deepEqual(await result(queryId, "paging-repeat", params), page);
          messages.push(...page.messages);
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(messages, expected.messages);
        assert.equal(new Set(messages.map(message => `${message.accountId}:${message.threadId}`)).size, messages.length);
      }
    });

    test("cursor rejects changed query, account, limit, original session and public inbox cursor", async () => {
      const queryId = fixture.query({ mailbox: "all", attention: "all" });
      const first = await result(queryId, "cursor-first", { limit: "1" });
      assert.ok(first.nextCursor);
      const wrongPaths = [
        fixture.url(fixture.query({ mailbox: "all", attention: "all" }), { cursor: first.nextCursor, limit: "1" }),
        fixture.url(queryId, { cursor: first.nextCursor, limit: "2" }),
        fixture.url(fixture.query({ mailbox: "all", attention: "all" }, secondAccount), { accountId: secondAccount, cursor: first.nextCursor, limit: "1" }),
      ];
      for (const path of wrongPaths) {
        const response = await fixture.request(path);
        assert.equal(response.status, 400);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_cursor");
      }
      const otherSession = await fixture.request(fixture.url(queryId, { cursor: first.nextCursor, limit: "1" }), { cookie: `orca_session=${fixture.otherSession.token}` });
      assert.equal(otherSession.status, 400);
      const inboxResponse = await fixture.request(`/v1/inbox?accountId=${ownerAccount}&view=all&limit=1`);
      const inbox = await inboxResponse.json() as { nextCursor: string };
      assert.ok(inbox.nextCursor);
      assert.equal((await fixture.request(fixture.url(queryId, { cursor: inbox.nextCursor, limit: "1" }))).status, 400);
      assert.equal((await fixture.request(`/v1/inbox?accountId=${ownerAccount}&view=all&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
    });

    test("valid-shaped keyset tampering retains original signature and fails integrity", async () => {
      const queryId = fixture.query({ mailbox: "all", attention: "all" });
      const first = await result(queryId, "tamper-first", { limit: "1" });
      assert.ok(first.nextCursor);
      // Inspect only this test-owned opaque token. Support a JSON envelope or a
      // payload.signature envelope, including an embedded old mailbox cursor.
      function alterPosition(value: unknown, depth = 0): { value: unknown; changed: boolean } {
        if (depth > 6) return { value, changed: false };
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const object = value as Record<string, unknown>;
          if (typeof object.receivedAt === "number") return { value: { ...object, receivedAt: object.receivedAt + 1 }, changed: true };
          for (const [key, child] of Object.entries(object)) {
            const altered = alterPosition(child, depth + 1);
            if (altered.changed) return { value: { ...object, [key]: altered.value }, changed: true };
          }
        }
        if (typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value)) {
          try {
            const altered = alterPosition(JSON.parse(Buffer.from(value, "base64url").toString("utf8")), depth + 1);
            if (altered.changed) return { value: Buffer.from(JSON.stringify(altered.value)).toString("base64url"), changed: true };
          } catch { /* An ordinary non-JSON identity is not a position. */ }
        }
        return { value, changed: false };
      }
      const parts = first.nextCursor.split(".");
      const decoded = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
      const altered = alterPosition(decoded);
      assert.ok(altered.changed, "Fixture must mutate an actual valid numeric keyset timestamp, not merely corrupt encoding");
      parts[0] = Buffer.from(JSON.stringify(altered.value)).toString("base64url");
      const response = await fixture.request(fixture.url(queryId, { limit: "1", cursor: parts.join(".") }));
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_cursor");
    });

    test("unauthenticated, expired and revoked sessions cannot read saved results", async () => {
      const path = fixture.url(fixture.catalogQueryId);
      assert.equal((await fixture.request(path, {})).status, 401);
      const session = await createSession(fixture.db, "bre457-owner");
      const headers = { cookie: `orca_session=${session.token}` };
      const response = await fixture.request(path, headers);
      assert.equal(response.status, 200);
      fixture.sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id=?").run(Date.now(), session.sessionId);
      assert.equal((await fixture.request(path, headers)).status, 401);
      const expired = await createSession(fixture.db, "bre457-owner");
      fixture.sqlite.query("UPDATE sessions SET expires_at=? WHERE id=?").run(Date.now() - 1, expired.sessionId);
      assert.equal((await fixture.request(path, { cookie: `orca_session=${expired.token}` })).status, 401);
    });

    test("object revision and mailbox changes invalidate outstanding cursors", async () => {
      const queryId = fixture.query({ mailbox: "all", attention: "all" });
      const first = await result(queryId, "stale-object-first", { limit: "1" });
      assert.ok(first.nextCursor);
      fixture.sqlite.query("UPDATE organization_saved_queries SET revision=revision+1 WHERE id=?").run(queryId);
      assert.equal((await fixture.request(fixture.url(queryId, { cursor: first.nextCursor, limit: "1" }))).status, 400);
      const nextQuery = fixture.query({ mailbox: "all", attention: "all" });
      const second = await result(nextQuery, "stale-mailbox-first", { limit: "1" });
      assert.ok(second.nextCursor);
      fixture.sqlite.query("UPDATE emails SET snippet='changed mailbox' WHERE id='normal'").run();
      assert.equal((await fixture.request(fixture.url(nextQuery, { cursor: second.nextCursor, limit: "1" }))).status, 400);
      const digestQuery = fixture.query({ mailbox: "all", attention: "all" });
      const third = await result(digestQuery, "stale-digest-first", { limit: "1" });
      assert.ok(third.nextCursor);
      fixture.sqlite.query("UPDATE organization_saved_queries SET definition_json=? WHERE id=?").run(JSON.stringify({ revision: 1, filters: { mailbox: "all", attention: "all", text: "attention-marker" } }), digestQuery);
      assert.equal((await fixture.request(fixture.url(digestQuery, { cursor: third.nextCursor, limit: "1" }))).status, 400);
    });
  });
}
