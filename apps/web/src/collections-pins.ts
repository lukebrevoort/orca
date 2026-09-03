import {
  organizationCollectionPinApplyRequestSchema,
  organizationCollectionPinMutationResponseSchema,
  type OrganizationCollectionPinApplyRequest,
  type OrganizationCollectionPinMutationResponse,
  type OrganizationCollectionPinQueryResponse,
  type OrganizationPin,
  type OrganizationSavedQuery,
} from "@orca/shared";

export type CollectionPinAccountContext = { id: string; label: string };

export type CollectionPinViewModel =
  | {
    kind: "collection";
    id: string;
    accountId: string;
    accountLabel: string;
    label: string;
    color: string;
    position: number;
    membership: { type: "explicit_threads"; threadIds: string[]; count: number };
  }
  | {
    kind: "pin";
    id: string;
    accountId: string;
    accountLabel: string;
    label: string;
    color: string;
    icon: OrganizationPin["icon"];
    position: number;
    shortcut:
      | { type: "query"; queryId: string; summary: string }
      | { type: "resource"; family: "thread" | "view" | "collection" | "sender"; resourceId: string; summary: string };
  };

function querySummary(query: OrganizationSavedQuery | undefined) {
  if (!query) return "Saved query unavailable";
  const filters = query.definition.filters;
  const pieces = [
    filters.text ? `Text: ${filters.text}` : null,
    filters.sender ? `Sender: ${filters.sender}` : null,
    filters.attention ? `Attention: ${filters.attention}` : null,
    filters.classification ? `Classification: ${filters.classification}` : null,
    filters.accountId ? `Account: ${filters.accountId}` : null,
    filters.collectionId ? `Space: ${filters.collectionId}` : null,
    filters.dataSource ? "Source: stored mail" : null,
  ].filter((value): value is string => value !== null);
  return pieces.join(" · ") || query.name;
}

function resourceSummary(family: "thread" | "view" | "collection" | "sender") {
  return `${family[0]?.toLocaleUpperCase()}${family.slice(1)} shortcut`;
}

export function toCollectionPinViewModels(
  state: OrganizationCollectionPinQueryResponse,
  accounts: readonly CollectionPinAccountContext[],
): CollectionPinViewModel[] {
  const accountLabels = new Map(accounts.map((account) => [account.id, account.label]));
  const accountLabel = (accountId: string) => accountLabels.get(accountId) ?? accountId;
  const queries = new Map(state.queries.map((query) => [query.id, query]));

  return [
    ...state.collections.map((collection): CollectionPinViewModel => ({
      kind: "collection",
      id: collection.id,
      accountId: collection.accountId,
      accountLabel: accountLabel(collection.accountId),
      label: collection.name,
      color: collection.color,
      position: collection.position,
      membership: { type: "explicit_threads", threadIds: [...collection.threadIds], count: collection.threadIds.length },
    })),
    ...state.pins.map((pin): CollectionPinViewModel => ({
      kind: "pin",
      id: pin.id,
      accountId: pin.accountId,
      accountLabel: accountLabel(pin.accountId),
      label: pin.label,
      color: pin.color,
      icon: pin.icon,
      position: pin.position,
      shortcut: pin.target.type === "query"
        ? { type: "query", queryId: pin.target.queryId, summary: querySummary(queries.get(pin.target.queryId)) }
        : {
          type: "resource",
          family: pin.target.resource.family,
          resourceId: pin.target.resource.id,
          summary: resourceSummary(pin.target.resource.family),
        },
    })),
  ];
}

export function buildCollectionMembershipMutation(input: {
  idempotencyKey: string;
  action: "add" | "remove";
  accountId: string;
  collectionId: string;
  threadId: string;
}): OrganizationCollectionPinApplyRequest {
  return organizationCollectionPinApplyRequestSchema.parse({
    idempotencyKey: input.idempotencyKey,
    change: {
      kind: "collection_membership",
      action: input.action,
      accountId: input.accountId,
      collectionId: input.collectionId,
      threadId: input.threadId,
    },
  });
}

export type CollectionPinMutationResult =
  | { ok: true; value: OrganizationCollectionPinMutationResponse }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export function toCollectionPinMutationResult(value: unknown): CollectionPinMutationResult {
  const success = organizationCollectionPinMutationResponseSchema.safeParse(value);
  if (success.success) return { ok: true, value: success.data };
  if (typeof value === "object" && value !== null && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const code = "code" in error && typeof error.code === "string" ? error.code : "unknown";
      const message = "message" in error && typeof error.message === "string" ? error.message : "Collections/Pins operation failed";
      return { ok: false, error: { code, message, retryable: code === "conflict" || code === "offline" } };
    }
  }
  return { ok: false, error: { code: "invalid_response", message: "Collections/Pins response was invalid", retryable: true } };
}
