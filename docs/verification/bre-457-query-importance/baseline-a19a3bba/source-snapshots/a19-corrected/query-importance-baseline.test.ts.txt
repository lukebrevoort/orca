import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "bun:test";
import { organizationSavedQueryResultResponseSchema } from "@orca/shared";
import { createQueryImportanceBaselineFixture, importanceReceipt, type QueryImportanceBaselineFixture } from "./query-importance-baseline.fixture.ts";

const stage = process.env.BRE457_IMPORTANCE_STAGE ?? "extension";
if (!["controls", "extension"].includes(stage)) throw new Error("BRE457_IMPORTANCE_STAGE must be controls or extension");
let fixture: QueryImportanceBaselineFixture;
beforeAll(async () => { fixture = await createQueryImportanceBaselineFixture(); await fixture.preconditions(); }, 20_000);
afterAll(() => fixture?.close());

if (stage === "controls") {
  test("BRE-457 importance baseline: real auth/catalog/default/Inbox/source-state controls", () => {
    assert.ok(fixture.queryU.id && fixture.queryB.id);
    importanceReceipt({ name: "controls-test-complete", complete: true });
  });
} else {
  test("BRE-457 extension: version1 query rows project actual retained importance", async () => {
    const actual = await fixture.request("extension importance projection", fixture.resultUrl(fixture.queryU), {
      ...fixture.headersU, "x-orca-importance-version": "1",
    });
    assert.equal(actual.response.status, 200, "The existing endpoint must succeed before projection assertions");
    const body = organizationSavedQueryResultResponseSchema.parse(actual.value);
    const states = fixture.sourceStates();
    const missing = body.messages.filter(row => row.importance === undefined).map(row => row.threadId);
    importanceReceipt({ name: "extension-projection", expectedStatus: 200, actualStatus: actual.response.status,
      queryId: body.query.id, actualRows: body.messages.length, missingImportanceThreads: missing,
      sourceEffectiveValues: states.map(row => row.effective).sort(), comparisonExecuted: true,
      evidenceScope: "additive importance projection; existing endpoint200, not endpoint absence or old UI reproduction" });
    assert.equal(body.messages.length, states.length);
    assert.deepEqual(missing, [], "Opted-in success must contain actual importance for every returned row");
    for (const state of states) {
      const importance = body.messages.find(row => row.threadId === state.thread_id)?.importance;
      assert.ok(importance);
      assert.equal(importance.effective, state.effective);
      assert.equal(importance.conversation.choice, state.choice);
      assert.equal(importance.conversation.revision, state.choice_revision ?? 0);
      assert.equal(importance.accountRevision, state.account_revision);
    }
    assert.ok(actual.response.headers.get("vary")?.toLowerCase().split(/\s*,\s*/).includes("x-orca-importance-version"));
    assert.equal(actual.response.headers.get("cache-control"), "private, no-store");
  });

  for (const kind of ["cookie", "mobile"] as const) {
    for (const surface of ["catalog", "results"] as const) {
      test(`BRE-457 extension: ${kind} B own ${surface} rejects original owner U`, async () => {
        const query = fixture.queryB;
        const path = surface === "catalog"
          ? `/v1/organization/collections-pins/query?accountId=${encodeURIComponent(query.accountId)}`
          : fixture.resultUrl(query);
        const actual = await fixture.request(`extension ${kind} ${surface} owner fence`, path, fixture.headersB(kind));
        importanceReceipt({ name: "extension-owner-fence", kind, surface, expectedStatus: 409, actualStatus: actual.response.status,
          observedScope: actual.value, openedConnections: actual.openedConnections, comparisonExecuted: true,
          evidenceScope: "B authenticated and requesting B's own proven scope with expected U; missing original-owner precondition, not anonymous/foreign-account disclosure" });
        assert.equal(actual.response.status, 409, "Original-owner mismatch must be rejected before domain/catalog access");
        assert.deepEqual(actual.value, { error: { code: "session_owner_changed", message: "The signed-in account changed. Reload before continuing." } });
        assert.equal(actual.response.headers.get("cache-control"), "private, no-store");
        assert.equal(actual.openedConnections, 1, "Only authentication connection may open on owner mismatch");
      });
    }
  }
}
