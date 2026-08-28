import { createHash } from "node:crypto";

import {
  validateFacetScalarValue,
  type FacetDefinition,
  type FacetFilter,
  type FacetScalarValue,
  type FacetValueType,
  type OrganizationFacetWorkflowAction,
  type ThreadFacetValue,
  type ThreadWorkflowState,
  type WorkflowStateDefinition,
} from "@orca/shared";

export { validateFacetScalarValue } from "@orca/shared";

export type FacetWorkflowThreadSnapshot = {
  accountId: string;
  threadId: string;
  facetValues: ThreadFacetValue[];
  workflowState: ThreadWorkflowState | null;
  revision: number | null;
};

export type FacetWorkflowSnapshot = {
  workspaceRevision: number;
  facetDefinitions: FacetDefinition[];
  workflowStates: WorkflowStateDefinition[];
  threads: FacetWorkflowThreadSnapshot[];
};

export type FacetWorkflowValidationIssue = {
  code:
    | "account_denied"
    | "cardinality_exceeded"
    | "cardinality_mismatch"
    | "duplicate_identity"
    | "duplicate_name"
    | "duplicate_position"
    | "facet_not_found"
    | "facet_retired"
    | "invalid_value"
    | "required_value_missing"
    | "thread_not_found"
    | "workflow_state_not_found"
    | "workflow_state_retired";
  path: string;
  message: string;
};

export class FacetWorkflowValidationError extends Error {
  readonly code = "validation_error" as const;

  constructor(readonly issues: FacetWorkflowValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "FacetWorkflowValidationError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Binds every typed semantic field and action order into the authority command. */
export function digestFacetWorkflowActions(actions: readonly OrganizationFacetWorkflowAction[]): string {
  return `sha256:${createHash("sha256").update(canonicalJson(actions)).digest("hex")}`;
}

function cloneSnapshot(snapshot: FacetWorkflowSnapshot): FacetWorkflowSnapshot {
  return structuredClone(snapshot);
}

function validateFacetValue(
  definition: FacetDefinition,
  value: FacetScalarValue | FacetScalarValue[],
  path: string,
  issues: FacetWorkflowValidationIssue[],
): boolean {
  const initialIssueCount = issues.length;
  const values = Array.isArray(value) ? value : [value];
  if (definition.cardinality.kind === "single" && Array.isArray(value)) {
    issues.push({ code: "cardinality_mismatch", path, message: `Facet ${definition.name} accepts exactly one value` });
  }
  if (definition.cardinality.kind === "multi" && !Array.isArray(value)) {
    issues.push({ code: "cardinality_mismatch", path, message: `Facet ${definition.name} requires a list of values` });
  }
  if (definition.cardinality.kind === "multi" && values.length > definition.cardinality.maxItems) {
    issues.push({ code: "cardinality_exceeded", path, message: `Facet ${definition.name} accepts at most ${definition.cardinality.maxItems} values` });
  }
  for (const scalar of values) {
    const message = validateFacetScalarValue(definition.valueType, scalar);
    if (message) issues.push({ code: "invalid_value", path, message: `Facet ${definition.name} ${message}` });
  }
  return issues.length === initialIssueCount;
}

/** Runtime semantics shared by REST query decoding and Organization reads. */
export function validateFacetFilters(
  definitions: readonly FacetDefinition[],
  filters: readonly FacetFilter[],
): void {
  const issues: FacetWorkflowValidationIssue[] = [];
  for (const [index, filter] of filters.entries()) {
    const definition = definitions.find((candidate) => candidate.id === filter.facetId);
    if (!definition) {
      issues.push({ code: "facet_not_found", path: `facetFilters[${index}].facetId`, message: `Facet ${filter.facetId} does not exist` });
      continue;
    }
    // Retired definitions remain queryable so historical assignments are not hidden.
    if (!("value" in filter)) continue;
    if (filter.operator === "contains" && !["text", "email", "domain"].includes(definition.valueType.kind)) {
      issues.push({
        code: "invalid_value",
        path: `facetFilters[${index}].operator`,
        message: `Facet ${definition.name} supports equals, present, and missing but not contains`,
      });
      continue;
    }
    const message = validateFacetScalarValue(definition.valueType, filter.value);
    if (message) issues.push({ code: "invalid_value", path: `facetFilters[${index}].value`, message: `Facet ${definition.name} ${message}` });
  }
  if (issues.length > 0) throw new FacetWorkflowValidationError(issues);
}

function validateDefinitionUniqueness(
  kind: "Facet" | "Workflow State",
  definitions: ReadonlyArray<{ id: string; name: string; position: number }>,
  issues: FacetWorkflowValidationIssue[],
) {
  for (const field of ["name", "position"] as const) {
    const seen = new Map<string | number, string>();
    for (const definition of definitions) {
      const key = field === "name" ? definition.name.trim().toLocaleLowerCase() : definition.position;
      const previous = seen.get(key);
      if (previous) {
        issues.push({
          code: field === "name" ? "duplicate_name" : "duplicate_position",
          path: `${kind === "Facet" ? "facetDefinitions" : "workflowStates"}.${definition.id}.${field}`,
          message: `${kind} ${field} conflicts with ${previous}`,
        });
      } else {
        seen.set(key, definition.id);
      }
    }
  }
}

export function applyFacetWorkflowActions(
  snapshot: FacetWorkflowSnapshot,
  actions: readonly OrganizationFacetWorkflowAction[],
  context: { workspaceId: string; authorizedAccountIds: readonly string[]; now: string },
): FacetWorkflowSnapshot {
  const next = cloneSnapshot(snapshot);
  const issues: FacetWorkflowValidationIssue[] = [];
  const authorized = new Set(context.authorizedAccountIds);
  const touchedThreads = new Set<string>();

  for (const [actionIndex, action] of actions.entries()) {
    const actionPath = `actions[${actionIndex}]`;
    switch (action.kind) {
      case "define_facet": {
        if (next.facetDefinitions.some((definition) => definition.id === action.id)) {
          issues.push({ code: "duplicate_identity", path: `${actionPath}.id`, message: `Facet ${action.id} already exists` });
          break;
        }
        next.facetDefinitions.push({
          id: action.id,
          name: action.name,
          position: action.position,
          valueType: action.valueType,
          cardinality: action.cardinality,
          isOptional: action.isOptional,
          defaultValue: action.defaultValue,
          retiredAt: null,
          revision: 1,
        });
        const created = next.facetDefinitions.at(-1)!;
        if (created.defaultValue !== null) validateFacetValue(created, created.defaultValue, `${actionPath}.defaultValue`, issues);
        break;
      }
      case "update_facet": {
        const definition = next.facetDefinitions.find((candidate) => candidate.id === action.facetId);
        if (!definition) {
          issues.push({ code: "facet_not_found", path: `${actionPath}.facetId`, message: `Facet ${action.facetId} does not exist` });
          break;
        }
        if (action.name !== undefined) definition.name = action.name;
        if (action.position !== undefined) definition.position = action.position;
        if (action.retired !== undefined) definition.retiredAt = action.retired ? context.now : null;
        definition.revision += 1;
        break;
      }
      case "define_workflow_state": {
        if (next.workflowStates.some((definition) => definition.id === action.id)) {
          issues.push({ code: "duplicate_identity", path: `${actionPath}.id`, message: `Workflow State ${action.id} already exists` });
          break;
        }
        next.workflowStates.push({
          id: action.id,
          name: action.name,
          position: action.position,
          retiredAt: null,
          revision: 1,
        });
        break;
      }
      case "update_workflow_state": {
        const definition = next.workflowStates.find((candidate) => candidate.id === action.stateId);
        if (!definition) {
          issues.push({ code: "workflow_state_not_found", path: `${actionPath}.stateId`, message: `Workflow State ${action.stateId} does not exist` });
          break;
        }
        if (action.name !== undefined) definition.name = action.name;
        if (action.position !== undefined) definition.position = action.position;
        if (action.retired !== undefined) definition.retiredAt = action.retired ? context.now : null;
        definition.revision += 1;
        break;
      }
      case "set_thread_facets": {
        if (!authorized.has(action.accountId)) {
          issues.push({ code: "account_denied", path: `${actionPath}.accountId`, message: `Account ${action.accountId} is outside the authorized scope` });
          break;
        }
        const thread = next.threads.find((candidate) => candidate.threadId === action.threadId && candidate.accountId === action.accountId);
        if (!thread) {
          issues.push({ code: "thread_not_found", path: `${actionPath}.threadId`, message: `Thread ${action.threadId} does not exist in Account ${action.accountId}` });
          break;
        }
        let threadChanged = false;
        for (const [valueIndex, update] of action.values.entries()) {
          const path = `${actionPath}.values[${valueIndex}].value`;
          const definition = next.facetDefinitions.find((candidate) => candidate.id === update.facetId);
          if (!definition) {
            issues.push({ code: "facet_not_found", path: `${actionPath}.values[${valueIndex}].facetId`, message: `Facet ${update.facetId} does not exist` });
            continue;
          }
          if (update.value === null) {
            if (!definition.isOptional) {
              issues.push({ code: "required_value_missing", path, message: `Facet ${definition.name} is required and cannot be cleared` });
              continue;
            }
            thread.facetValues = thread.facetValues.filter((existing) => existing.facetId !== definition.id);
            threadChanged = true;
            continue;
          }
          if (definition.retiredAt !== null) {
            issues.push({ code: "facet_retired", path, message: `Facet ${definition.name} is retired and cannot accept new values` });
            continue;
          }
          if (!validateFacetValue(definition, update.value, path, issues)) continue;
          const stored: ThreadFacetValue = { facetId: definition.id, value: update.value, updatedAt: context.now };
          const existingIndex = thread.facetValues.findIndex((existing) => existing.facetId === definition.id);
          if (existingIndex >= 0) thread.facetValues[existingIndex] = stored;
          else thread.facetValues.push(stored);
          threadChanged = true;
        }
        if (threadChanged) touchedThreads.add(`${thread.accountId}\u0000${thread.threadId}`);
        break;
      }
      case "set_thread_workflow_state": {
        if (!authorized.has(action.accountId)) {
          issues.push({ code: "account_denied", path: `${actionPath}.accountId`, message: `Account ${action.accountId} is outside the authorized scope` });
          break;
        }
        const thread = next.threads.find((candidate) => candidate.threadId === action.threadId && candidate.accountId === action.accountId);
        if (!thread) {
          issues.push({ code: "thread_not_found", path: `${actionPath}.threadId`, message: `Thread ${action.threadId} does not exist in Account ${action.accountId}` });
          break;
        }
        if (action.stateId === null) {
          thread.workflowState = null;
          touchedThreads.add(`${thread.accountId}\u0000${thread.threadId}`);
          break;
        }
        const definition = next.workflowStates.find((candidate) => candidate.id === action.stateId);
        if (!definition) {
          issues.push({ code: "workflow_state_not_found", path: `${actionPath}.stateId`, message: `Workflow State ${action.stateId} does not exist` });
          break;
        }
        if (definition.retiredAt !== null) {
          issues.push({ code: "workflow_state_retired", path: `${actionPath}.stateId`, message: `Workflow State ${definition.name} is retired and cannot be assigned` });
          break;
        }
        thread.workflowState = { stateId: definition.id, updatedAt: context.now };
        touchedThreads.add(`${thread.accountId}\u0000${thread.threadId}`);
        break;
      }
    }
  }

  validateDefinitionUniqueness("Facet", next.facetDefinitions, issues);
  validateDefinitionUniqueness("Workflow State", next.workflowStates, issues);
  for (const definition of next.facetDefinitions.filter((candidate) => !candidate.isOptional && candidate.retiredAt === null && candidate.defaultValue !== null)) {
    const defaultValue = definition.defaultValue;
    if (defaultValue === null) continue;
    for (const thread of next.threads) {
      if (thread.facetValues.some((value) => value.facetId === definition.id)) continue;
      thread.facetValues.push({
        facetId: definition.id,
        value: structuredClone(defaultValue),
        updatedAt: context.now,
      });
      touchedThreads.add(`${thread.accountId}\u0000${thread.threadId}`);
    }
  }
  for (const thread of next.threads) {
    if (!touchedThreads.has(`${thread.accountId}\u0000${thread.threadId}`)) continue;
    const previous = snapshot.threads.find((candidate) => candidate.accountId === thread.accountId && candidate.threadId === thread.threadId);
    thread.revision = (previous?.revision ?? 0) + 1;
  }
  for (const definition of next.facetDefinitions.filter((candidate) => !candidate.isOptional && candidate.retiredAt === null)) {
    for (const thread of next.threads) {
      if (definition.defaultValue === null && !thread.facetValues.some((value) => value.facetId === definition.id)) {
        issues.push({
          code: "required_value_missing",
          path: `threads.${thread.threadId}.facetValues.${definition.id}`,
          message: `Required Facet ${definition.name} must have a typed default or explicit value on every Thread`,
        });
      }
    }
  }
  if (issues.length > 0) throw new FacetWorkflowValidationError(issues);

  next.workspaceRevision += 1;
  next.facetDefinitions.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  next.workflowStates.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  for (const thread of next.threads) thread.facetValues.sort((left, right) => left.facetId.localeCompare(right.facetId));
  return next;
}
