import { describe, expect, test } from "bun:test";

import { organizationFallbackPlacementFixture, type FacetDefinition, type WorkflowStateDefinition, type WorkspaceThread } from "@orca/shared";

import { toOrganizationFacetQuery, toThreadFacetViewModel } from "./facet-workflow.ts";

const facets: FacetDefinition[] = [
  {
    id: "facet_priority",
    name: "Priority",
    position: 0,
    valueType: {
      kind: "enum",
      options: [
        { id: "priority_high", label: "High", position: 0, retiredAt: null },
        { id: "priority_low", label: "Low", position: 1, retiredAt: null },
      ],
    },
    cardinality: { kind: "single" },
    isOptional: false,
    defaultValue: "priority_low",
    retiredAt: null,
    revision: 1,
  },
  {
    id: "facet_contacts",
    name: "Contacts",
    position: 1,
    valueType: { kind: "email", allowDisplayName: false },
    cardinality: { kind: "multi", maxItems: 4 },
    isOptional: true,
    defaultValue: null,
    retiredAt: null,
    revision: 1,
  },
  {
    id: "facet_internal",
    name: "Internal",
    position: 2,
    valueType: { kind: "boolean" },
    cardinality: { kind: "single" },
    isOptional: true,
    defaultValue: null,
    retiredAt: "2026-08-24T06:00:00.000Z",
    revision: 2,
  },
];

const workflowStates: WorkflowStateDefinition[] = [{
  id: "workflow_waiting",
  name: "Waiting",
  position: 0,
  retiredAt: null,
  revision: 1,
}];

const thread = {
  id: "thread_a",
  accountId: "account_a",
  subject: "Launch",
  latestReceivedAt: "2026-08-24T05:00:00.000Z",
  messageCount: 1,
  readState: "unread",
  organization: {
    attentionBehavior: "normal",
    humanSignal: 8,
    humanClassification: null,
    lanePlacement: { ...organizationFallbackPlacementFixture, accountId: "account_a", threadId: "thread_a" },
    facetValues: [
      { facetId: "facet_contacts", value: ["ada@example.com", "bea@example.com"], updatedAt: "2026-08-24T05:30:00.000Z" },
      { facetId: "facet_priority", value: "priority_high", updatedAt: "2026-08-24T05:30:00.000Z" },
      { facetId: "facet_internal", value: true, updatedAt: "2026-08-24T05:30:00.000Z" },
    ],
    workflowState: { stateId: "workflow_waiting", updatedAt: "2026-08-24T05:30:00.000Z" },
  },
  messages: [],
} satisfies WorkspaceThread;

describe("Facet and Workflow UI integration seam", () => {
  test("builds stable-ID row and detail models in schema order", () => {
    const model = toThreadFacetViewModel(thread, facets, workflowStates, { rowFacetLimit: 2 });

    expect(model.threadId).toBe("thread_a");
    expect(model.workflowState).toEqual({ id: "workflow_waiting", label: "Waiting", retired: false });
    expect(model.rowFacets).toEqual([
      { id: "facet_priority", label: "Priority", value: "High", retired: false },
      { id: "facet_contacts", label: "Contacts", value: "ada@example.com · bea@example.com", retired: false },
    ]);
    expect(model.rowOverflowCount).toBe(1);
    expect(model.detailFacets[2]).toEqual({ id: "facet_internal", label: "Internal", value: "Yes", retired: true });
  });

  test("omits missing optional Facets without losing missing-filter identity", () => {
    const model = toThreadFacetViewModel({
      ...thread,
      organization: { ...thread.organization, facetValues: [] },
    }, facets, workflowStates);

    expect(model.detailFacets).toEqual([]);
    expect(toOrganizationFacetQuery({
      accountId: "account_b",
      facet: { facetId: "facet_contacts", operator: "missing" },
      workflowStateId: "workflow_waiting",
    })).toEqual({
      accountIds: ["account_b"],
      facetFilters: [{ facetId: "facet_contacts", operator: "missing" }],
      workflowStateIds: ["workflow_waiting"],
      limit: 25,
    });
  });

  test("keeps enum and workflow identity even when definitions are unavailable", () => {
    const model = toThreadFacetViewModel(thread, [], []);

    expect(model.detailFacets[0]).toEqual({ id: "facet_contacts", label: "Unknown Facet", value: "ada@example.com · bea@example.com", retired: false });
    expect(model.workflowState).toEqual({ id: "workflow_waiting", label: "Unknown state", retired: false });
  });
});
