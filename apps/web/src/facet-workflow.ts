import type {
  FacetDefinition,
  FacetFilter,
  FacetScalarValue,
  OrganizationQuery,
  ThreadFacetValue,
  WorkflowStateDefinition,
  WorkspaceThread,
} from "@orca/shared";

export type ThreadFacetDisplayValue = {
  /** Stable schema identity; labels may change without invalidating UI state. */
  id: string;
  label: string;
  value: string;
  retired: boolean;
};

export type ThreadWorkflowStateViewModel = {
  /** Stable Workflow State identity; labels may change independently. */
  id: string;
  label: string;
  retired: boolean;
};

export type ThreadFacetViewModel = {
  threadId: string;
  accountId: string;
  workflowState: ThreadWorkflowStateViewModel | null;
  rowFacets: ThreadFacetDisplayValue[];
  rowOverflowCount: number;
  detailFacets: ThreadFacetDisplayValue[];
};

export type FacetWorkflowFilterState = {
  accountId?: string;
  facet?: FacetFilter;
  workflowStateId?: string;
};

function formatScalar(value: FacetScalarValue, definition: FacetDefinition | undefined): string {
  if (definition?.valueType.kind === "enum" && typeof value === "string") {
    return definition.valueType.options.find((option) => option.id === value)?.label ?? value;
  }
  if (definition?.valueType.kind === "boolean" && typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function formatValue(value: ThreadFacetValue, definition: FacetDefinition | undefined): string {
  const values = Array.isArray(value.value) ? value.value : [value.value];
  return values.map((scalar) => formatScalar(scalar, definition)).join(" · ");
}

/**
 * Pure adapter between Organization wire contracts and BRE-326 row/detail
 * renderers. It deliberately contains no DOM, theme, or provider concerns.
 */
export function toThreadFacetViewModel(
  thread: WorkspaceThread,
  facetDefinitions: readonly FacetDefinition[],
  workflowStates: readonly WorkflowStateDefinition[],
  options: { rowFacetLimit?: number } = {},
): ThreadFacetViewModel {
  const definitionById = new Map(facetDefinitions.map((definition) => [definition.id, definition]));
  const values = thread.organization.facetValues ?? [];
  const definitionPosition = new Map(facetDefinitions.map((definition, index) => [definition.id, index]));
  const detailFacets = values
    .map((value, inputIndex) => {
      const definition = definitionById.get(value.facetId);
      return {
        inputIndex,
        position: definitionPosition.get(value.facetId) ?? Number.MAX_SAFE_INTEGER,
        display: {
          id: value.facetId,
          label: definition?.name ?? "Unknown Facet",
          value: formatValue(value, definition),
          retired: definition?.retiredAt !== null && definition?.retiredAt !== undefined,
        },
      };
    })
    .sort((left, right) => left.position - right.position || left.inputIndex - right.inputIndex)
    .map(({ display }) => display);
  const rowFacetLimit = Math.max(0, options.rowFacetLimit ?? 2);
  const workflowValue = thread.organization.workflowState ?? null;
  const workflowDefinition = workflowValue
    ? workflowStates.find((definition) => definition.id === workflowValue.stateId)
    : undefined;

  return {
    threadId: thread.id,
    accountId: thread.accountId,
    workflowState: workflowValue ? {
      id: workflowValue.stateId,
      label: workflowDefinition?.name ?? "Unknown state",
      retired: workflowDefinition?.retiredAt !== null && workflowDefinition?.retiredAt !== undefined,
    } : null,
    rowFacets: detailFacets.slice(0, rowFacetLimit),
    rowOverflowCount: Math.max(0, detailFacets.length - rowFacetLimit),
    detailFacets,
  };
}

/** Converts stable UI filter identity into the public Organization query. */
export function toOrganizationFacetQuery(
  state: FacetWorkflowFilterState,
  options: { limit?: number } = {},
): OrganizationQuery {
  return {
    ...(state.accountId ? { accountIds: [state.accountId] } : {}),
    ...(state.facet ? { facetFilters: [state.facet] } : {}),
    ...(state.workflowStateId ? { workflowStateIds: [state.workflowStateId] } : {}),
    limit: options.limit ?? 25,
  };
}
