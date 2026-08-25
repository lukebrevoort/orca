import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { OrganizationFacetWorkflowAction } from "@orca/shared";

import {
  FacetWorkflowValidationError,
  applyFacetWorkflowActions,
  validateFacetFilters,
  type FacetWorkflowSnapshot,
} from "./facet-workflow.ts";

const emptySnapshot: FacetWorkflowSnapshot = {
  workspaceRevision: 1,
  facetDefinitions: [],
  workflowStates: [],
  threads: [{
    accountId: "account_a",
    threadId: "thread_a",
    facetValues: [],
    workflowState: null,
    revision: null,
  }],
};

const context = {
  workspaceId: "workspace_owner",
  authorizedAccountIds: ["account_a", "account_b"],
  now: "2026-08-24T06:00:00.000Z",
};

describe("deep Facet and Workflow module", () => {
  test("defines stable schemas and independently applies typed values and Workflow State", () => {
    const actions: OrganizationFacetWorkflowAction[] = [
      {
        kind: "define_facet",
        id: "facet_customer",
        name: "Customer",
        position: 0,
        valueType: { kind: "domain" },
        cardinality: { kind: "single" },
        isOptional: false,
        defaultValue: "unknown.example",
      },
      { kind: "define_workflow_state", id: "workflow_waiting", name: "Waiting", position: 0 },
      {
        kind: "set_thread_facets",
        accountId: "account_a",
        threadId: "thread_a",
        values: [{ facetId: "facet_customer", value: "example.com" }],
        expectedThreadRevision: null,
      },
      {
        kind: "set_thread_workflow_state",
        accountId: "account_a",
        threadId: "thread_a",
        stateId: "workflow_waiting",
        expectedThreadRevision: null,
      },
    ];

    const next = applyFacetWorkflowActions(emptySnapshot, actions, context);

    assert.equal(next.workspaceRevision, 2);
    assert.deepEqual(next.facetDefinitions.map(({ id, revision }) => [id, revision]), [["facet_customer", 1]]);
    assert.deepEqual(next.workflowStates.map(({ id, revision }) => [id, revision]), [["workflow_waiting", 1]]);
    assert.deepEqual(next.threads[0]?.facetValues[0], {
      facetId: "facet_customer",
      value: "example.com",
      updatedAt: context.now,
    });
    assert.deepEqual(next.threads[0]?.workflowState, { stateId: "workflow_waiting", updatedAt: context.now });
    assert.deepEqual(emptySnapshot, {
      workspaceRevision: 1,
      facetDefinitions: [],
      workflowStates: [],
      threads: [{ accountId: "account_a", threadId: "thread_a", facetValues: [], workflowState: null, revision: null }],
    });
  });

  test("validates every scalar type and cardinality at one actionable Organization seam", () => {
    const cases: Array<[string, OrganizationFacetWorkflowAction["kind"] extends never ? never : unknown, unknown, boolean]> = [
      ["text", { kind: "text", maxLength: 4 }, "orca", true],
      ["text-too-long", { kind: "text", maxLength: 4 }, "orcas", false],
      ["number", { kind: "number", minimum: 1, maximum: 5, integer: true }, 3, true],
      ["number-fraction", { kind: "number", minimum: 1, maximum: 5, integer: true }, 3.5, false],
      ["boolean", { kind: "boolean" }, true, true],
      ["datetime", { kind: "datetime" }, "2026-08-24T06:00:00.000Z", true],
      ["datetime-invalid", { kind: "datetime" }, "tomorrow", false],
      ["duration", { kind: "duration" }, "PT45M", true],
      ["duration-invalid", { kind: "duration" }, "45 minutes", false],
      ["email", { kind: "email", allowDisplayName: false }, "person@example.com", true],
      ["email-invalid", { kind: "email", allowDisplayName: false }, "person", false],
      ["domain", { kind: "domain" }, "sub.example.com", true],
      ["domain-invalid", { kind: "domain" }, "https://example.com", false],
      ["enum", { kind: "enum", options: [{ id: "opt_a", label: "A", position: 0, retiredAt: null }] }, "opt_a", true],
      ["enum-label-not-id", { kind: "enum", options: [{ id: "opt_a", label: "A", position: 0, retiredAt: null }] }, "A", false],
    ];

    for (const [id, valueType, value, valid] of cases) {
      const actions = [
        {
          kind: "define_facet" as const,
          id: `facet_${id}`,
          name: id,
          position: 0,
          valueType,
          cardinality: { kind: "single" as const },
          isOptional: true,
          defaultValue: null,
        },
        {
          kind: "set_thread_facets" as const,
          accountId: "account_a",
          threadId: "thread_a",
          values: [{ facetId: `facet_${id}`, value }],
          expectedThreadRevision: null,
        },
      ] as OrganizationFacetWorkflowAction[];
      if (valid) assert.doesNotThrow(() => applyFacetWorkflowActions(emptySnapshot, actions, context), id);
      else assert.throws(
        () => applyFacetWorkflowActions(emptySnapshot, actions, context),
        (error) => error instanceof FacetWorkflowValidationError
          && error.issues.some((issue) => issue.path.includes("actions[1].values[0].value")),
        id,
      );
    }
  });

  test("enforces single/multi and optional/missing semantics without partial state", () => {
    const snapshot = applyFacetWorkflowActions(emptySnapshot, [
      {
        kind: "define_facet",
        id: "facet_required",
        name: "Required",
        position: 0,
        valueType: { kind: "text", maxLength: 20 },
        cardinality: { kind: "single" },
        isOptional: false,
        defaultValue: "unset",
      },
      {
        kind: "define_facet",
        id: "facet_optional_list",
        name: "Optional list",
        position: 1,
        valueType: { kind: "email", allowDisplayName: false },
        cardinality: { kind: "multi", maxItems: 2 },
        isOptional: true,
        defaultValue: null,
      },
    ], context);
    assert.deepEqual(snapshot.threads[0]?.facetValues, [{
      facetId: "facet_required",
      value: "unset",
      updatedAt: context.now,
    }]);
    const original = structuredClone(snapshot);

    assert.throws(
      () => applyFacetWorkflowActions(snapshot, [{
        kind: "set_thread_facets",
        accountId: "account_a",
        threadId: "thread_a",
        values: [
          { facetId: "facet_optional_list", value: ["a@example.com", "b@example.com", "c@example.com"] },
          { facetId: "facet_required", value: null },
        ],
        expectedThreadRevision: null,
      }], context),
      (error) => error instanceof FacetWorkflowValidationError
        && error.issues.some((issue) => issue.code === "cardinality_exceeded")
        && error.issues.some((issue) => issue.code === "required_value_missing"),
    );
    assert.deepEqual(snapshot, original);

    const cleared = applyFacetWorkflowActions(snapshot, [{
      kind: "set_thread_facets",
      accountId: "account_a",
      threadId: "thread_a",
      values: [{ facetId: "facet_optional_list", value: null }],
      expectedThreadRevision: null,
    }], context);
    assert.deepEqual(cleared.threads[0]?.facetValues, [{
      facetId: "facet_required",
      value: "unset",
      updatedAt: context.now,
    }]);
  });

  test("renames, reorders, and retires by stable identity while rejecting retired assignments", () => {
    const defined = applyFacetWorkflowActions(emptySnapshot, [
      { kind: "define_facet", id: "facet_a", name: "A", position: 0, valueType: { kind: "boolean" }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
      { kind: "define_facet", id: "facet_b", name: "B", position: 1, valueType: { kind: "boolean" }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
    ], context);
    const changed = applyFacetWorkflowActions(defined, [
      { kind: "update_facet", facetId: "facet_a", name: "Renamed", position: 1, retired: true, expectedRevision: 1 },
      { kind: "update_facet", facetId: "facet_b", position: 0, expectedRevision: 1 },
    ], context);

    assert.deepEqual(changed.facetDefinitions.map(({ id, name, position, retiredAt, revision }) => ({ id, name, position, retiredAt, revision })), [
      { id: "facet_b", name: "B", position: 0, retiredAt: null, revision: 2 },
      { id: "facet_a", name: "Renamed", position: 1, retiredAt: context.now, revision: 2 },
    ]);
    assert.throws(
      () => applyFacetWorkflowActions(changed, [{
        kind: "set_thread_facets",
        accountId: "account_a",
        threadId: "thread_a",
        values: [{ facetId: "facet_a", value: true }],
        expectedThreadRevision: null,
      }], context),
      (error) => error instanceof FacetWorkflowValidationError
        && error.issues.some((issue) => issue.code === "facet_retired"),
    );
  });

  test("renames, reorders, and retires Workflow States independently of Thread Facets", () => {
    const defined = applyFacetWorkflowActions(emptySnapshot, [
      { kind: "define_workflow_state", id: "workflow_open", name: "Open", position: 0 },
      { kind: "define_workflow_state", id: "workflow_waiting", name: "Waiting", position: 1 },
    ], context);
    const changed = applyFacetWorkflowActions(defined, [
      { kind: "update_workflow_state", stateId: "workflow_open", name: "In progress", position: 1, expectedRevision: 1 },
      { kind: "update_workflow_state", stateId: "workflow_waiting", position: 0, retired: true, expectedRevision: 1 },
    ], context);

    assert.deepEqual(changed.workflowStates.map(({ id, name, position, retiredAt, revision }) => ({ id, name, position, retiredAt, revision })), [
      { id: "workflow_waiting", name: "Waiting", position: 0, retiredAt: context.now, revision: 2 },
      { id: "workflow_open", name: "In progress", position: 1, retiredAt: null, revision: 2 },
    ]);
    assert.deepEqual(changed.facetDefinitions, []);
    assert.throws(
      () => applyFacetWorkflowActions(changed, [{
        kind: "set_thread_workflow_state",
        accountId: "account_a",
        threadId: "thread_a",
        stateId: "workflow_waiting",
        expectedThreadRevision: null,
      }], context),
      (error) => error instanceof FacetWorkflowValidationError
        && error.issues.some((issue) => issue.code === "workflow_state_retired"),
    );
  });

  test("fails closed for out-of-scope Accounts and mismatched Thread ownership", () => {
    assert.throws(
      () => applyFacetWorkflowActions(emptySnapshot, [{
        kind: "set_thread_workflow_state",
        accountId: "account_private",
        threadId: "thread_a",
        stateId: null,
        expectedThreadRevision: null,
      }], context),
      (error) => error instanceof FacetWorkflowValidationError
        && error.issues.some((issue) => issue.code === "account_denied"),
    );
    assert.throws(
      () => applyFacetWorkflowActions(emptySnapshot, [{
        kind: "set_thread_workflow_state",
        accountId: "account_b",
        threadId: "thread_a",
        stateId: null,
        expectedThreadRevision: null,
      }], context),
      (error) => error instanceof FacetWorkflowValidationError
        && error.issues.some((issue) => issue.code === "thread_not_found"),
    );
  });

  test("validates query operators and values against the referenced schema while keeping retired history queryable", () => {
    const definitions = [{
      id: "facet_flag",
      name: "Flag",
      position: 0,
      valueType: { kind: "boolean" as const },
      cardinality: { kind: "single" as const },
      isOptional: true,
      defaultValue: null,
      retiredAt: context.now,
      revision: 2,
    }];
    assert.doesNotThrow(() => validateFacetFilters(definitions, [{ facetId: "facet_flag", operator: "equals", value: true }]));
    assert.throws(
      () => validateFacetFilters(definitions, [{ facetId: "facet_flag", operator: "equals", value: "true" }]),
      (error) => error instanceof FacetWorkflowValidationError && error.issues[0]?.code === "invalid_value",
    );
    assert.throws(
      () => validateFacetFilters(definitions, [{ facetId: "facet_flag", operator: "contains", value: true }]),
      (error) => error instanceof FacetWorkflowValidationError && error.issues[0]?.path.endsWith("operator"),
    );
  });
});
