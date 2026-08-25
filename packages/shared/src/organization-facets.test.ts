import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  facetDefinitionSchema,
  organizationFacetWorkflowApplySchema,
  organizationQuerySchema,
} from "./index.ts";

describe("typed Facet and Workflow contracts", () => {
  test("represents every initial Facet type with stable schema and enum-option identities", () => {
    const definitions = [
      { kind: "text", maxLength: 120 },
      { kind: "number", minimum: 0, maximum: 100, integer: false },
      { kind: "boolean" },
      { kind: "datetime" },
      { kind: "duration" },
      { kind: "email" },
      { kind: "domain" },
      {
        kind: "enum",
        options: [
          { id: "enum_urgent", label: "Urgent", position: 0, retiredAt: null },
          { id: "enum_normal", label: "Normal", position: 1, retiredAt: null },
        ],
      },
    ];

    for (const [position, valueType] of definitions.entries()) {
      const result = facetDefinitionSchema.parse({
        id: `facet_${position}`,
        name: `Facet ${position}`,
        position,
        valueType,
        cardinality: { kind: "single" },
        isOptional: true,
        defaultValue: null,
        retiredAt: null,
        revision: 1,
      });
      assert.equal(result.valueType.kind, valueType.kind);
    }
  });

  test("makes bounded lists explicit and rejects ambiguous or unbounded cardinality", () => {
    const base = {
      id: "facet_participants",
      name: "Participants",
      position: 0,
      valueType: { kind: "email", allowDisplayName: false },
      isOptional: false,
      defaultValue: ["owner@example.com"],
      retiredAt: null,
      revision: 1,
    };

    const bounded = facetDefinitionSchema.parse({
      ...base,
      cardinality: { kind: "multi", maxItems: 8 },
    });
    assert.equal(bounded.cardinality.kind, "multi");
    if (bounded.cardinality.kind === "multi") assert.equal(bounded.cardinality.maxItems, 8);
    assert.equal(facetDefinitionSchema.safeParse({
      ...base,
      cardinality: { kind: "multi" },
    }).success, false);
    assert.equal(facetDefinitionSchema.safeParse({
      ...base,
      cardinality: { kind: "multi", maxItems: 0 },
    }).success, false);
  });

  test("requires a typed default before a required Facet can enter the Workspace schema", () => {
    const required = {
      id: "facet_required",
      name: "Required",
      position: 0,
      valueType: { kind: "text", maxLength: 40 },
      cardinality: { kind: "single" },
      isOptional: false,
      retiredAt: null,
      revision: 1,
    };
    const missing = facetDefinitionSchema.safeParse({ ...required, defaultValue: null });
    assert.equal(missing.success, false);
    if (!missing.success) assert.match(missing.error.issues[0]?.message ?? "", /must declare a typed default/);
    assert.equal(facetDefinitionSchema.safeParse({ ...required, defaultValue: "unassigned" }).success, true);
  });

  test("uses explicit null only as a clear request while missing actions remain untouched", () => {
    const command = organizationFacetWorkflowApplySchema.parse({
      id: "changeset_clear",
      idempotencyKey: "clear-1",
      expectedWorkspaceRevision: 3,
      actions: [{
        kind: "set_thread_facets",
        accountId: "account_a",
        threadId: "thread_a",
        values: [
          { facetId: "facet_optional", value: null },
          { facetId: "facet_required", value: "set" },
        ],
        expectedThreadRevision: 2,
      }],
    });

    assert.equal(command.actions[0]?.kind, "set_thread_facets");
    if (command.actions[0]?.kind !== "set_thread_facets") return;
    assert.deepEqual(command.actions[0].values.map((item) => item.value), [null, "set"]);
  });

  test("accepts stable-ID Facet and Workflow filters without provider vocabulary", () => {
    const query = organizationQuerySchema.parse({
      accountIds: ["account_a"],
      facetFilters: [
        { facetId: "facet_customer", operator: "equals", value: "Acme" },
        { facetId: "facet_due", operator: "missing" },
      ],
      workflowStateIds: ["workflow_waiting"],
      limit: 25,
    });

    assert.deepEqual(query.workflowStateIds, ["workflow_waiting"]);
    assert.equal(JSON.stringify(query).includes("gmail"), false);
  });

  test("does not admit send, delete, or provider-specific actions", () => {
    for (const action of [
      { kind: "send_mail", accountId: "account_a", threadId: "thread_a" },
      { kind: "delete_provider_mail", provider: "gmail", providerMessageId: "message_a" },
    ]) {
      const result = organizationFacetWorkflowApplySchema.safeParse({
        id: "changeset_forbidden",
        idempotencyKey: "forbidden-1",
        expectedWorkspaceRevision: 1,
        actions: [action],
      });
      assert.equal(result.success, false);
    }
  });
});
