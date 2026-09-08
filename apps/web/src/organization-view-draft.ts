import type { OrganizationViewDefinition, FacetDefinition, FacetScalarValue } from "@orca/shared";
export type ClauseKind = "account" | "lane" | "read" | "human" | "sender" | "subject" | "workflow" | "facet" | "context" | "date";
export type ViewDraftFields = {
  editingDefinition: OrganizationViewDefinition | null;
  activeClauses: ClauseKind[];
  accountIds: string[]; laneIds: string[]; workflowStateIds: string[];
  facetId: string; facetOperator: "missing" | "present" | "equals" | "contains"; facetValue: string;
  contextTypeId: string; contextId: string; relationshipTypeId: string;
  minimumSignal: string; senderAddress: string; senderDomain: string;
  receivedAfter: string; receivedBefore: string; subjectContains: string; readState: "read" | "unread";
};
export function hydrateViewDraft(definition: OrganizationViewDefinition): ViewDraftFields {
  const facet = definition.facetFilters?.[0]; const context = definition.contextFilters?.[0];
  return { editingDefinition: definition, activeClauses: clauseKinds(definition), accountIds: definition.accountIds ?? [], laneIds: definition.laneIds ?? [], workflowStateIds: definition.workflowStateIds ?? [],
    facetId: facet?.facetId ?? "", facetOperator: facet?.operator ?? "equals", facetValue: facet && "value" in facet ? String(facet.value) : "",
    contextTypeId: context?.context.contextTypeId ?? "", contextId: context?.context.contextId ?? "", relationshipTypeId: context?.relationshipTypeId ?? "",
    minimumSignal: definition.humanSignal?.minimumScore?.toString() ?? "", senderAddress: definition.sender?.addresses?.join(", ") ?? "", senderDomain: definition.sender?.domains?.join(", ") ?? "",
    receivedAfter: dateValue(definition.date?.receivedAfter), receivedBefore: dateValue(definition.date?.receivedBefore), subjectContains: definition.thread?.subjectContains ?? "", readState: definition.thread?.readState ?? "unread" };
}
function clauseKinds(definition?: OrganizationViewDefinition): ClauseKind[] {
  if (!definition) return [];
  return [
    definition.accountIds?.length ? "account" : null,
    definition.laneIds?.length ? "lane" : null,
    definition.thread?.readState ? "read" : null,
    definition.humanSignal ? "human" : null,
    definition.sender ? "sender" : null,
    definition.thread?.subjectContains ? "subject" : null,
    definition.workflowStateIds?.length ? "workflow" : null,
    definition.facetFilters?.length ? "facet" : null,
    definition.contextFilters?.length ? "context" : null,
    definition.date ? "date" : null,
  ].filter((kind): kind is ClauseKind => kind !== null);
}
function dateValue(value?: string) { return value?.slice(0, 10) ?? ""; }
function isoDate(value: string, end = false) { return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString(); }

function unique(values: string[]) { return [...new Set(values.filter(Boolean))]; }
function facetScalarFromInput(definition: FacetDefinition | undefined, value: string): FacetScalarValue {
  if (definition?.valueType.kind === "number") return Number(value);
  if (definition?.valueType.kind === "boolean") return value === "true";
  return value;
}
export function materializeViewDraft(state: ViewDraftFields, facetDefinitions: readonly FacetDefinition[]): OrganizationViewDefinition {
  const { editingDefinition, activeClauses, accountIds, laneIds, workflowStateIds, facetId, facetOperator, facetValue, contextTypeId, contextId, relationshipTypeId, minimumSignal, senderAddress, senderDomain, receivedAfter, receivedBefore, subjectContains, readState } = state;
  const activeSet = new Set(activeClauses);
  const original = editingDefinition;
  const definition: OrganizationViewDefinition = { revision: 1 };
  if (activeSet.has("account") && accountIds.length) definition.accountIds = unique(accountIds);
  if (activeSet.has("lane") && laneIds.length) definition.laneIds = unique(laneIds);
  if (activeSet.has("workflow") && workflowStateIds.length) definition.workflowStateIds = unique(workflowStateIds);
  if (activeSet.has("facet") && facetId && (facetOperator === "missing" || facetOperator === "present" || facetValue !== "")) {
    const current = original?.facetFilters?.[0];
    const selected = facetDefinitions.find((facet) => facet.id === facetId);
    const typedValue = facetScalarFromInput(selected, facetValue);
    const first = facetOperator === "missing" || facetOperator === "present"
      ? { facetId, operator: facetOperator }
      : { facetId, operator: facetOperator, value: typedValue };
    definition.facetFilters = [first, ...(current ? original?.facetFilters?.slice(1) ?? [] : [])];
  }
  if (activeSet.has("context") && contextTypeId && contextId && relationshipTypeId) {
    definition.contextFilters = [{ context: { contextTypeId, contextId }, relationshipTypeId, ...(original?.contextFilters?.[0]?.direction ? { direction: original.contextFilters[0].direction } : {}) }, ...(original?.contextFilters?.slice(1) ?? [])];
  }
  if (activeSet.has("human")) {
    const humanSignal = { ...(original?.humanSignal ?? {}) };
    if (minimumSignal) humanSignal.minimumScore = Number(minimumSignal); else delete humanSignal.minimumScore;
    if (Object.keys(humanSignal).length) definition.humanSignal = humanSignal;
  }
  if (activeSet.has("sender")) {
    const addresses = unique(senderAddress.split(",").map((item) => item.trim()));
    const domains = unique(senderDomain.split(",").map((item) => item.trim().toLocaleLowerCase()));
    if (addresses.length || domains.length) definition.sender = { ...(addresses.length ? { addresses } : {}), ...(domains.length ? { domains } : {}) };
  }
  if (activeSet.has("date")) {
    const date = { ...(original?.date ?? {}) };
    if (receivedAfter) date.receivedAfter = receivedAfter === dateValue(original?.date?.receivedAfter) ? original!.date!.receivedAfter : isoDate(receivedAfter); else delete date.receivedAfter;
    if (receivedBefore) date.receivedBefore = receivedBefore === dateValue(original?.date?.receivedBefore) ? original!.date!.receivedBefore : isoDate(receivedBefore, true); else delete date.receivedBefore;
    if (Object.keys(date).length) definition.date = date;
  }
  const thread = { ...(original?.thread ?? {}) };
  if (activeSet.has("subject") && subjectContains.trim()) thread.subjectContains = subjectContains.trim(); else delete thread.subjectContains;
  if (activeSet.has("read")) thread.readState = readState; else delete thread.readState;
  if (Object.keys(thread).length) definition.thread = thread;
  const baseline = hydrateViewDraft(original ?? { revision: 1 });
  const unchanged = (...keys: Array<keyof ViewDraftFields>) => keys.every((key) => JSON.stringify(state[key]) === JSON.stringify(baseline[key]));
  if (activeSet.has("facet") && unchanged("facetId", "facetOperator", "facetValue") && original?.facetFilters) definition.facetFilters = original.facetFilters;
  if (activeSet.has("context") && unchanged("contextTypeId", "contextId", "relationshipTypeId") && original?.contextFilters) definition.contextFilters = original.contextFilters;
  return definition;
}
