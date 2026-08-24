import type {
  OrganizationContext,
  OrganizationContextRelationshipDirection,
  OrganizationContextRelationshipType,
  OrganizationThreadContextRelationship,
  WorkspaceThread,
} from "@orca/shared";

export type ThreadContextRelationshipSource = {
  relationship: OrganizationThreadContextRelationship;
  relationshipType: OrganizationContextRelationshipType | null;
};

export type ThreadContextRelationshipViewModel = {
  id: string;
  threadId: string;
  accountId: string;
  contextId: string;
  contextTypeId: string;
  contextName: string;
  relationshipTypeId: string;
  relationshipLabel: string;
  direction: OrganizationContextRelationshipDirection | "unknown";
  retired: boolean;
  unavailable: boolean;
};

export type ThreadContextViewModel = {
  threadId: string;
  accountId: string;
  rowRelationships: ThreadContextRelationshipViewModel[];
  detailRelationships: ThreadContextRelationshipViewModel[];
  relationshipCount: number;
  hasRedactedRelationships: boolean;
};

function direction(value: unknown): OrganizationContextRelationshipDirection | "unknown" {
  return value === "thread_to_context" || value === "context_to_thread" ? value : "unknown";
}

function label(type: OrganizationContextRelationshipType | null, value: OrganizationContextRelationshipDirection | "unknown") {
  if (!type || value === "unknown") return "Unknown relationship";
  return value === "thread_to_context" ? type.name : type.inverseName;
}

/** Pure renderer seam. It never fetches, mutates, navigates, or trusts cross-Account edges. */
export function toThreadContextViewModel(
  thread: Pick<WorkspaceThread, "id" | "accountId">,
  contexts: readonly OrganizationContext[],
  relationships: readonly ThreadContextRelationshipSource[],
  options: { rowContextLimit?: number } = {},
): ThreadContextViewModel {
  const contextById = new Map(contexts.map((context) => [context.id, context]));
  const hasRedactedRelationships = relationships.some(({ relationship }) => relationship.threadId === thread.id && relationship.accountId !== thread.accountId);
  const detailRelationships = relationships.flatMap(({ relationship, relationshipType }): ThreadContextRelationshipViewModel[] => {
    if (relationship.threadId !== thread.id || relationship.accountId !== thread.accountId) return [];
    const context = contextById.get(relationship.contextId) ?? null;
    if (context && context.contextTypeId !== relationship.contextTypeId) return [];
    if (relationshipType && (relationshipType.id !== relationship.relationshipTypeId || relationshipType.contextTypeId !== relationship.contextTypeId)) return [];
    const typedDirection = direction((relationship as { direction: unknown }).direction);
    return [{
      id: relationship.id,
      threadId: relationship.threadId,
      accountId: relationship.accountId,
      contextId: relationship.contextId,
      contextTypeId: relationship.contextTypeId,
      contextName: context ? `${context.name}${context.retiredAt ? " (retired)" : ""}` : "Unavailable context",
      relationshipTypeId: relationship.relationshipTypeId,
      relationshipLabel: label(relationshipType, typedDirection),
      direction: typedDirection,
      retired: Boolean(context?.retiredAt || relationshipType?.retiredAt),
      unavailable: context === null || relationshipType === null,
    }];
  }).sort((left, right) => {
    const leftType = relationships.find(({ relationship }) => relationship.id === left.id)?.relationshipType;
    const rightType = relationships.find(({ relationship }) => relationship.id === right.id)?.relationshipType;
    return (leftType?.position ?? Number.MAX_SAFE_INTEGER) - (rightType?.position ?? Number.MAX_SAFE_INTEGER)
      || left.contextName.localeCompare(right.contextName)
      || left.id.localeCompare(right.id);
  });
  const rowContextLimit = Math.max(0, Math.min(10, options.rowContextLimit ?? 3));
  return {
    threadId: thread.id,
    accountId: thread.accountId,
    rowRelationships: detailRelationships.slice(0, rowContextLimit),
    detailRelationships,
    relationshipCount: detailRelationships.length,
    hasRedactedRelationships,
  };
}
