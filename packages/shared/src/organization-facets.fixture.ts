import type {
  FacetDefinition,
  OrganizationFacetWorkflowApply,
  WorkflowStateDefinition,
} from "./organization-facets.ts";

export const organizationFacetDefinitionsFixture = [
  {
    id: "facet_customer",
    name: "Customer",
    position: 0,
    valueType: { kind: "domain" },
    cardinality: { kind: "single" },
    isOptional: false,
    defaultValue: "unknown.example",
    retiredAt: null,
    revision: 1,
  },
  {
    id: "facet_priority",
    name: "Priority",
    position: 1,
    valueType: {
      kind: "enum",
      options: [
        { id: "priority_high", label: "High", position: 0, retiredAt: null },
        { id: "priority_normal", label: "Normal", position: 1, retiredAt: null },
      ],
    },
    cardinality: { kind: "single" },
    isOptional: true,
    defaultValue: null,
    retiredAt: null,
    revision: 1,
  },
  {
    id: "facet_contacts",
    name: "Contacts",
    position: 2,
    valueType: { kind: "email", allowDisplayName: false },
    cardinality: { kind: "multi", maxItems: 4 },
    isOptional: true,
    defaultValue: null,
    retiredAt: null,
    revision: 1,
  },
] satisfies FacetDefinition[];

export const organizationWorkflowStatesFixture = [
  { id: "workflow_open", name: "Open", position: 0, retiredAt: null, revision: 1 },
  { id: "workflow_waiting", name: "Waiting", position: 1, retiredAt: null, revision: 1 },
  { id: "workflow_resolved", name: "Resolved", position: 2, retiredAt: null, revision: 1 },
] satisfies WorkflowStateDefinition[];

/** One Workspace-wide, cross-Account command suitable for demos and contract tests. */
export const organizationFacetWorkflowApplyFixture = {
  id: "changeset_fixture",
  idempotencyKey: "fixture-typed-facets-v1",
  expectedWorkspaceRevision: 1,
  actions: [
    ...organizationFacetDefinitionsFixture.map(({ id, name, position, valueType, cardinality, isOptional, defaultValue }) => ({
      kind: "define_facet" as const,
      id,
      name,
      position,
      valueType,
      cardinality,
      isOptional,
      defaultValue,
    })),
    ...organizationWorkflowStatesFixture.map(({ id, name, position }) => ({
      kind: "define_workflow_state" as const,
      id,
      name,
      position,
    })),
    {
      kind: "set_thread_facets" as const,
      accountId: "account_a",
      threadId: "thread_a",
      values: [
        { facetId: "facet_customer", value: "acme.example" },
        { facetId: "facet_priority", value: "priority_high" },
      ],
      expectedThreadRevision: null,
    },
    {
      kind: "set_thread_workflow_state" as const,
      accountId: "account_a",
      threadId: "thread_a",
      stateId: "workflow_waiting",
      expectedThreadRevision: null,
    },
    {
      kind: "set_thread_facets" as const,
      accountId: "account_b",
      threadId: "thread_b",
      values: [
        { facetId: "facet_customer", value: "globex.example" },
        { facetId: "facet_contacts", value: ["ada@example.com", "bea@example.com"] },
      ],
      expectedThreadRevision: null,
    },
  ],
} satisfies OrganizationFacetWorkflowApply;
