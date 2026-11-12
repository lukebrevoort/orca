import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accountFixture } from "./fixtures.ts";
import { organizationSavedQueryResultQuerySchema, organizationSavedQueryResultResponseSchema } from "./organization-saved-query-results.ts";

describe("saved-query result additive wire contract", () => {
  test("requires selected account, bounds pages, and rejects definitions/actors/dates", () => {
    assert.deepEqual(organizationSavedQueryResultQuerySchema.parse({ accountId: "account-a" }), { accountId: "account-a", limit: 30 });
    for (const request of [
      {}, { accountId: "a", limit: 0 }, { accountId: "a", limit: 101 }, { accountId: "a", cursor: "" },
      { accountId: "a", definition: {} }, { accountId: "a", actor: "human" }, { accountId: "a", receivedAfter: "2026-01-01" },
    ]) assert.equal(organizationSavedQueryResultQuerySchema.safeParse(request).success, false);
  });
  test("strict response carries object provenance and loaded rows, never aggregate counts", () => {
    const response = {
      query: { id: "query-a", accountId: accountFixture.id, revision: 7, definitionDigest: "a".repeat(64), evaluationProfile: "legacy-pin-v1" },
      accounts: [accountFixture], messages: [], nextCursor: null,
      freshness: { revision: `mailbox-v2:${"b".repeat(64)}`, lastSyncedAt: null },
    };
    assert.equal(organizationSavedQueryResultResponseSchema.parse(response).query.revision, 7);
    assert.equal(organizationSavedQueryResultResponseSchema.safeParse({ ...response, counts: { all: 0 } }).success, false);
    assert.equal(organizationSavedQueryResultResponseSchema.safeParse({ ...response, accounts: [] }).success, false);
    assert.equal(organizationSavedQueryResultResponseSchema.safeParse({ ...response, accounts: [accountFixture, accountFixture] }).success, false);
    assert.equal(organizationSavedQueryResultResponseSchema.safeParse({ ...response, query: { ...response.query, revision: 0 } }).success, false);
  });
});
