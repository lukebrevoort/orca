import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { organizationProductionIncidentContextsFixture } from "@orca/shared";
import { toThreadContextViewModel, type ThreadContextRelationshipSource } from "./context-relationships.ts";

function sources(): ThreadContextRelationshipSource[] {
  return organizationProductionIncidentContextsFixture.relationships.map((relationship) => ({
    relationship,
    relationshipType: organizationProductionIncidentContextsFixture.relationshipTypes.find((type) => type.id === relationship.relationshipTypeId) ?? null,
  }));
}

describe("Thread Context relationship view model", () => {
  test("keeps authoritative ordering, stable identities, row bounds, and complete detail", () => {
    const result = toThreadContextViewModel(
      { id: "thread_production_incident", accountId: "account_operations" },
      organizationProductionIncidentContextsFixture.contexts,
      [...sources()].reverse(),
      { rowContextLimit: 1 },
    );
    assert.equal(result.relationshipCount, 2);
    assert.equal(result.rowRelationships.length, 1);
    assert.equal(result.detailRelationships.length, 2);
    assert.deepEqual(result.detailRelationships.map((item) => item.relationshipLabel), ["concerns", "affects"]);
    assert.deepEqual(result.detailRelationships.map((item) => item.contextId), ["context_orca", "context_acme"]);
    assert.equal(result.detailRelationships[0]?.direction, "thread_to_context");
  });

  test("renders empty, unknown, and retired Context states explicitly", () => {
    assert.equal(toThreadContextViewModel({ id: "thread_none", accountId: "account_operations" }, [], [], {}).relationshipCount, 0);
    const source = sources()[0]!;
    const unknown = toThreadContextViewModel({ id: source.relationship.threadId, accountId: source.relationship.accountId }, [], [{ relationship: source.relationship, relationshipType: null }]);
    assert.equal(unknown.detailRelationships[0]?.contextName, "Unavailable context");
    assert.equal(unknown.detailRelationships[0]?.relationshipLabel, "Unknown relationship");
    assert.equal(unknown.detailRelationships[0]?.unavailable, true);
    const retiredContexts = organizationProductionIncidentContextsFixture.contexts.map((context) => context.id === source.relationship.contextId ? { ...context, retiredAt: "2026-08-24T13:00:00.000Z" } : context);
    const retired = toThreadContextViewModel({ id: source.relationship.threadId, accountId: source.relationship.accountId }, retiredContexts, [source]);
    assert.equal(retired.detailRelationships[0]?.contextName, "Orca (retired)");
    assert.equal(retired.detailRelationships[0]?.retired, true);
  });

  test("fails closed for cross-Account and mismatched typed references", () => {
    const source = sources()[0]!;
    const crossAccount = { ...source, relationship: { ...source.relationship, accountId: "account_private" } };
    const mismatched = { ...source, relationshipType: { ...source.relationshipType!, contextTypeId: "type_customer" } };
    const result = toThreadContextViewModel({ id: source.relationship.threadId, accountId: source.relationship.accountId }, organizationProductionIncidentContextsFixture.contexts, [crossAccount, mismatched]);
    assert.equal(result.relationshipCount, 0);
    assert.equal(result.hasRedactedRelationships, true);
  });

  test("preserves unknown future direction as an explicit fallback", () => {
    const source = sources()[0]!;
    const future = { ...source, relationship: { ...source.relationship, direction: "future_direction" } } as unknown as ThreadContextRelationshipSource;
    const result = toThreadContextViewModel({ id: source.relationship.threadId, accountId: source.relationship.accountId }, organizationProductionIncidentContextsFixture.contexts, [future]);
    assert.equal(result.detailRelationships[0]?.direction, "unknown");
    assert.equal(result.detailRelationships[0]?.relationshipLabel, "Unknown relationship");
  });
});
