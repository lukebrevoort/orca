import { organizationViewDefinitionSchema, type OrganizationViewDefinition, type FacetFilter } from "@orca/shared";
import { OrganizationViewQueryError } from "./module.ts";
type SqlBinding = string | number;
function placeholders(values: readonly unknown[]) { return values.map(() => "?").join(","); }
const ecmaScriptTrimCharacterSql = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
export function normalizedEmailSql(valueSql: string) {
  return `lower(trim(coalesce(${valueSql}, ''), ${ecmaScriptTrimCharacterSql}))`;
}
export function normalizedAddressSql(alias: string) { return normalizedEmailSql(`${alias}.from_address`); }
function normalizedDomainSql(alias: string) { const address = normalizedAddressSql(alias); return `case when instr(${address}, '@') > 0 then substr(${address}, instr(${address}, '@') + 1) else '' end`; }

function escapeLikeLiteral(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
export function effectiveClassificationSql(alias: string) {
  // Classification follows the production mailbox override key semantics.
  // Sender allowlists separately normalize ECMAScript whitespace for selected-row identity.
  const address = `lower(trim(coalesce(${alias}.from_address, '')))`;
  const domain = `case when instr(${address}, '@') > 0 then substr(${address}, instr(${address}, '@') + 1) else '' end`;
  return `coalesce(
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='message' and override.target_value=${alias}.id limit 1),
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='sender_address' and override.target_value=${address} limit 1),
    (select override.classification from human_classification_overrides override where override.account_id=${alias}.account_id and override.target_type='sender_domain' and override.target_value=${domain} limit 1),
    ${alias}.human_classification,
    'unclassified'
  )`;
}

function facetPredicate(filter: FacetFilter, params: SqlBinding[]) {
  const base = "f.workspace_id = ? AND f.facet_id = ? AND f.account_id = t.account_id AND f.thread_id = t.id";
  params.push("__WORKSPACE__", filter.facetId);
  if (filter.operator === "missing") return `NOT EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base})`;
  if (filter.operator === "present") return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base})`;
  if (!("value" in filter)) throw new OrganizationViewQueryError("A Facet value predicate is incomplete");
  const jsonValue = JSON.stringify(filter.value);
  if (filter.operator === "equals") {
    params.push(jsonValue, jsonValue);
    return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base} AND (json_extract(f.value,'$') = json_extract(?,'$') OR EXISTS (SELECT 1 FROM json_each(f.value) j WHERE j.value = json_extract(?,'$'))))`;
  }
  const literal = escapeLikeLiteral(String(filter.value).toLocaleLowerCase());
  params.push(String(filter.value).toLocaleLowerCase(), `%${literal}%`);
  return `EXISTS (SELECT 1 FROM organization_thread_facet_values f WHERE ${base} AND (lower(CAST(json_extract(f.value,'$') AS TEXT)) = ? OR EXISTS (SELECT 1 FROM json_each(f.value) j WHERE lower(CAST(j.value AS TEXT)) LIKE ? ESCAPE '\\')))`;
}

/** Exact live View conditions, also used by sender census and Inbox policy. */
export function viewPredicates(scope: { workspaceId: string; accountIds: readonly string[] }, input: { definition: OrganizationViewDefinition }) {
  const definition = organizationViewDefinitionSchema.parse(input.definition);
  const owned = new Set(scope.accountIds);
  const accountIds = [...(definition.accountIds ?? scope.accountIds)].sort();
  if (accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationViewQueryError("The View Account scope is no longer authorized");
  const conditions: string[] = [`oa.user_id = ?`, `t.account_id IN (${placeholders(accountIds)})`];
  const params: SqlBinding[] = [scope.workspaceId, ...accountIds];
  if (definition.laneIds) { conditions.push(`lane.primary_lane_id IN (${placeholders(definition.laneIds)})`); params.push(...definition.laneIds); }
  if (definition.workflowStateIds) { conditions.push(`EXISTS (SELECT 1 FROM organization_thread_workflow_states workflow WHERE workflow.workspace_id=? AND workflow.account_id=t.account_id AND workflow.thread_id=t.id AND workflow.state_id IN (${placeholders(definition.workflowStateIds)}))`); params.push(scope.workspaceId, ...definition.workflowStateIds); }
  for (const filter of definition.facetFilters ?? []) {
    const filterParams: SqlBinding[] = [];
    conditions.push(facetPredicate(filter, filterParams));
    params.push(...filterParams.map((value) => value === "__WORKSPACE__" ? scope.workspaceId : value));
  }
  for (const filter of definition.contextFilters ?? []) {
    conditions.push("EXISTS (SELECT 1 FROM organization_thread_context_relationships context_edge WHERE context_edge.workspace_id=? AND context_edge.account_id=t.account_id AND context_edge.thread_id=t.id AND context_edge.context_type_id=? AND context_edge.context_id=? AND context_edge.relationship_type_id=?" + (filter.direction ? " AND context_edge.direction=?" : "") + ")");
    params.push(scope.workspaceId, filter.context.contextTypeId, filter.context.contextId, filter.relationshipTypeId, ...(filter.direction ? [filter.direction] : []));
  }
  if (definition.thread?.ids) { conditions.push(`t.id IN (${placeholders(definition.thread.ids)})`); params.push(...definition.thread.ids); }
  if (definition.thread?.subjectContains) { conditions.push("lower(COALESCE(t.subject,'')) LIKE ? ESCAPE '\\'"); params.push(`%${escapeLikeLiteral(definition.thread.subjectContains.toLocaleLowerCase())}%`); }
  if (definition.thread?.readState) { conditions.push("t.is_read = ?"); params.push(definition.thread.readState === "read" ? 1 : 0); }

  const emailConditions: string[] = ["e.account_id=t.account_id", "e.thread_id=t.id"];
  const signal = definition.humanSignal;
  if (signal?.minimumScore !== undefined) { emailConditions.push("e.human_signal >= ?"); params.push(signal.minimumScore); }
  if (signal?.maximumScore !== undefined) { emailConditions.push("e.human_signal <= ?"); params.push(signal.maximumScore); }
  if (signal?.classifications) { emailConditions.push(`${effectiveClassificationSql("e")} IN (${placeholders(signal.classifications)})`); params.push(...signal.classifications); }
  if (signal?.evidenceReasonCodes) { emailConditions.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(e.human_classification_reasons,'[]')) reason WHERE reason.value IN (${placeholders(signal.evidenceReasonCodes)}))`); params.push(...signal.evidenceReasonCodes); }
  if (definition.sender) {
    const senderParts: string[] = [];
    if (definition.sender.addresses) { senderParts.push(`${normalizedAddressSql("e")} IN (${placeholders(definition.sender.addresses)})`); params.push(...definition.sender.addresses); }
    if (definition.sender.domains) { senderParts.push(`${normalizedDomainSql("e")} IN (${placeholders(definition.sender.domains)})`); params.push(...definition.sender.domains); }
    emailConditions.push(`(${senderParts.join(" OR ")})`);
  }
  if (definition.date?.receivedAfter) { emailConditions.push("e.received_at >= ?"); params.push(Date.parse(definition.date.receivedAfter)); }
  if (definition.date?.receivedBefore) { emailConditions.push("e.received_at <= ?"); params.push(Date.parse(definition.date.receivedBefore)); }

  return { conditions, emailConditions, params, accountIds };
}


/** The same correlated message must witness all sender/date/signal clauses. */
export function threadMatchPredicate(scope: { workspaceId: string; accountIds: readonly string[] }, input: { definition: OrganizationViewDefinition }) {
  const result = viewPredicates(scope, input);
  if (result.emailConditions.length > 2) result.conditions.push(`EXISTS (SELECT 1 FROM emails e WHERE ${result.emailConditions.join(" AND ")})`);
  return result;
}
