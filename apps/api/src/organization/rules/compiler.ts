import {
  orcaCompiledRuleRevisionSchema,
  orcaCompilerLimits,
  orcaEventKindSchema,
  type FacetValueType,
  type OrcaCompileInput,
  type OrcaCompileResult,
  type OrcaCompiledAction,
  type OrcaCompiledPredicateExpression,
  type OrcaCompiledRuleRevision,
  type OrcaDiagnostic,
  type OrcaScalarType,
  type OrcaSourceSpan,
  type OrcaWorkspaceSnapshot,
} from "@orca/shared";

import { validateFacetScalarValue } from "../facet-workflow.ts";

export { orcaCompilerLimits };
export type {
  OrcaCompileInput,
  OrcaCompileResult,
  OrcaCompiledAction,
  OrcaCompiledPredicateExpression,
  OrcaCompiledRuleRevision,
  OrcaDiagnostic,
  OrcaSourcePosition,
  OrcaSourceSpan,
  OrcaWorkspaceSnapshot,
} from "@orca/shared";

type ScalarKind = OrcaScalarType;
type WorkspaceValueType = FacetValueType;
type CompiledLiteral = Extract<OrcaCompiledPredicateExpression, { kind: "compare" }>["value"];
type ComparisonOperator = Extract<OrcaCompiledPredicateExpression, { kind: "compare" }>["operator"];

type LocatedLine = { text: string; trimmed: string; line: number; offset: number };
type UnresolvedPredicate = { name: string | null; expression: string; location: LocatedLine };

const fields: Record<string, { type: ScalarKind; optional: boolean }> = {
  subject: { type: "text", optional: true },
  "sender.domain": { type: "domain", optional: true },
  "sender.email": { type: "email", optional: true },
  "thread.message_count": { type: "number", optional: false },
  "thread.unread": { type: "boolean", optional: false },
  "thread.latest_received_at": { type: "datetime", optional: true },
  "thread.human_signal": { type: "number", optional: true },
};

function locatedLines(source: string): LocatedLine[] {
  let offset = 0;
  return source.split("\n").map((text, index) => {
    const line = { text, trimmed: text.trim(), line: index + 1, offset };
    offset += text.length + 1;
    return line;
  });
}

function span(line: LocatedLine, start = line.text.search(/\S|$/), length = Math.max(1, line.text.trim().length)): OrcaSourceSpan {
  const column = Math.max(0, start) + 1;
  return {
    start: { offset: line.offset + column - 1, line: line.line, column },
    end: { offset: line.offset + column - 1 + length, line: line.line, column: column + length },
  };
}

function diagnostic(line: LocatedLine, phase: OrcaDiagnostic["phase"], code: string, message: string, hint?: string): OrcaDiagnostic {
  return { severity: "error", phase, code, message, span: span(line), ...(hint ? { hint } : {}) };
}

function quoted(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseLiteral(source: string): CompiledLiteral | undefined {
  const string = quoted(source);
  if (string !== null) return string;
  if (source === "true") return true;
  if (source === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(source)) return Number(source);
  return undefined;
}

function parseComparisonOperator(source: string): ComparisonOperator | null {
  switch (source) {
    case "equals":
    case "contains":
    case "greater_than":
    case "less_than":
      return source;
    default:
      return null;
  }
}

function sameName(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function resolveNamed<T extends { id: string; name: string }>(items: T[], name: string): T | "ambiguous" | undefined {
  const matches = items.filter((item) => sameName(item.name, name));
  return matches.length > 1 ? "ambiguous" : matches[0];
}

function splitArguments(source: string): string[] | null {
  const values = source.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : null;
}

function expressionDepths(definitions: ReadonlyMap<string, UnresolvedPredicate>): ReadonlyMap<string, number> {
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const definitionDepth = (name: string): number => {
    const memoized = depths.get(name);
    if (memoized !== undefined) return memoized;
    if (visiting.has(name)) return Number.POSITIVE_INFINITY;
    const definition = definitions.get(name);
    if (!definition) return 0;
    visiting.add(name);
    const depth = expressionDepth(definition.expression);
    visiting.delete(name);
    depths.set(name, depth);
    return depth;
  };

  const expressionDepth = (expression: string): number => {
    const ref = /^([a-z][a-z0-9_]*)$/.exec(expression)?.[1];
    if (ref) return 1 + definitionDepth(ref);
    const group = /^(?:all|any)\((.*)\)$/.exec(expression);
    if (group) {
      return 1 + Math.max(...(splitArguments(group[1]!) ?? []).map((name) => 1 + definitionDepth(name)), 0);
    }
    const not = /^not\((.*)\)$/.exec(expression);
    return not ? 1 + expressionDepth(not[1]!.trim()) : 1;
  };

  for (const name of definitions.keys()) definitionDepth(name);
  return depths;
}

function expressionNodeCount(expression: string): number {
  const group = /^(?:all|any)\((.*)\)$/.exec(expression);
  if (group) return 1 + (splitArguments(group[1]!)?.length ?? 0);
  return /^not\((.*)\)$/.test(expression) ? 2 : 1;
}

function canonicalFacetLiteral(valueType: WorkspaceValueType, literal: CompiledLiteral): CompiledLiteral | undefined {
  const value = valueType.kind === "enum" && typeof literal === "string"
    ? valueType.options.find((option) => option.retiredAt === null && sameName(option.label, literal))?.id
    : literal;
  if (value === undefined || validateFacetScalarValue(valueType, value) !== null) return undefined;
  return value;
}

function builtinValueType(kind: ScalarKind): WorkspaceValueType | undefined {
  switch (kind) {
    case "text": return { kind: "text", maxLength: 10_000 };
    case "number": return { kind: "number", integer: false };
    case "boolean": return { kind: "boolean" };
    case "datetime": return { kind: "datetime" };
    case "duration": return { kind: "duration" };
    case "email": return { kind: "email", allowDisplayName: false };
    case "domain": return { kind: "domain" };
    case "enum": return undefined;
  }
}

function compileExpression(
  unresolved: UnresolvedPredicate,
  workspace: OrcaWorkspaceSnapshot,
  definitions: ReadonlyMap<string, UnresolvedPredicate>,
  diagnostics: OrcaDiagnostic[],
): OrcaCompiledPredicateExpression | null {
  const source = unresolved.expression;
  const bare = /^([a-z][a-z0-9_]*)$/.exec(source)?.[1];
  if (bare) {
    if (!definitions.has(bare)) {
      diagnostics.push(diagnostic(unresolved.location, "resolve", "unknown_predicate", `Predicate '${bare}' is not defined.`, "Define it with `predicate name = ...` before using it."));
      return null;
    }
    return { kind: "reference", predicate: bare };
  }
  const group = /^(all|any)\((.*)\)$/.exec(source);
  if (group) {
    const names = splitArguments(group[2]!);
    if (!names || names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) {
      diagnostics.push(diagnostic(unresolved.location, "parse", "invalid_predicate_group", `${group[1]}(...) accepts only named, parameterless predicates.`));
      return null;
    }
    for (const name of names) if (!definitions.has(name)) diagnostics.push(diagnostic(unresolved.location, "resolve", "unknown_predicate", `Predicate '${name}' is not defined.`));
    return diagnostics.length ? null : { kind: group[1] === "all" ? "all" : "any", predicates: names };
  }
  const not = /^not\(\s*([a-z][a-z0-9_]*)\s*\)$/.exec(source);
  if (not) {
    if (!definitions.has(not[1]!)) {
      diagnostics.push(diagnostic(unresolved.location, "resolve", "unknown_predicate", `Predicate '${not[1]}' is not defined.`));
      return null;
    }
    return { kind: "not", predicate: not[1]! };
  }
  const facetExistence = /^(exists|missing)\s+facet\s+("(?:[^"\\]|\\.)*")$/.exec(source);
  if (facetExistence) {
    const name = quoted(facetExistence[2]!);
    const facet = name === null ? undefined : resolveNamed(workspace.facets, name);
    if (!facet || facet === "ambiguous") {
      diagnostics.push(diagnostic(unresolved.location, "resolve", facet === "ambiguous" ? "ambiguous_resource" : "unknown_resource", `Facet ${facet === "ambiguous" ? "name is ambiguous" : `'${name ?? ""}' does not exist`} in Workspace revision ${workspace.revision}.`));
      return null;
    }
    if (!facet.optional && facetExistence[1] === "missing") {
      diagnostics.push(diagnostic(unresolved.location, "type", "required_field_never_missing", `Facet '${facet.name}' is required and cannot be missing.`));
      return null;
    }
    return { kind: facetExistence[1] === "exists" ? "exists" : "missing", field: `facet:${facet.id}`, facetId: facet.id, valueType: facet.valueType.kind, optional: facet.optional };
  }
  const existence = /^(exists|missing)\s+([a-z][a-z0-9_.]*)$/.exec(source);
  if (existence) {
    const field = fields[existence[2]!];
    if (!field) {
      diagnostics.push(diagnostic(unresolved.location, "resolve", "unknown_field", `Field '${existence[2]}' is not available for Orca v1 Events.`));
      return null;
    }
    if (!field.optional && existence[1] === "missing") {
      diagnostics.push(diagnostic(unresolved.location, "type", "required_field_never_missing", `Field '${existence[2]}' is required and cannot be missing.`));
      return null;
    }
    return { kind: existence[1] === "exists" ? "exists" : "missing", field: existence[2]!, valueType: field.type, optional: field.optional };
  }
  const facetComparison = /^facet\s+("(?:[^"\\]|\\.)*")\s+(equals|contains|greater_than|less_than)\s+(.+)$/.exec(source);
  const comparison = /^([a-z][a-z0-9_.]*)\s+(equals|contains|greater_than|less_than)\s+(.+)$/.exec(source);
  let fieldName: string;
  let fieldType: { type: ScalarKind; optional: boolean } | undefined;
  let facetId: string | undefined;
  let literalSource: string;
  let operator: "equals" | "contains" | "greater_than" | "less_than";
  let facetValueType: WorkspaceValueType | undefined;
  if (facetComparison) {
    const name = quoted(facetComparison[1]!);
    const facet = name === null ? undefined : resolveNamed(workspace.facets, name);
    if (!facet || facet === "ambiguous") {
      diagnostics.push(diagnostic(unresolved.location, "resolve", facet === "ambiguous" ? "ambiguous_resource" : "unknown_resource", `Facet ${facet === "ambiguous" ? "name is ambiguous" : `'${name ?? ""}' does not exist`} in Workspace revision ${workspace.revision}.`));
      return null;
    }
    fieldName = `facet:${facet.id}`; facetId = facet.id; fieldType = { type: facet.valueType.kind, optional: facet.optional };
    literalSource = facetComparison[3]!;
    const parsedOperator = parseComparisonOperator(facetComparison[2]!);
    if (parsedOperator === null) return null;
    operator = parsedOperator;
    facetValueType = facet.valueType;
  } else if (comparison) {
    fieldName = comparison[1]!; fieldType = fields[fieldName]; literalSource = comparison[3]!;
    const parsedOperator = parseComparisonOperator(comparison[2]!);
    if (parsedOperator === null) return null;
    operator = parsedOperator;
    if (!fieldType) {
      diagnostics.push(diagnostic(unresolved.location, "resolve", "unknown_field", `Field '${fieldName}' is not available for Orca v1 Events.`));
      return null;
    }
  } else {
    diagnostics.push(diagnostic(unresolved.location, "parse", "invalid_predicate", "Expected a named predicate, Boolean group, existence check, or typed comparison."));
    return null;
  }
  if (operator === "contains" && !["text", "email", "domain"].includes(fieldType.type)) {
    diagnostics.push(diagnostic(unresolved.location, "type", "operator_type_mismatch", `'contains' requires Text, Email, or Domain, but '${fieldName}' is ${fieldType.type}.`));
    return null;
  }
  if ((operator === "greater_than" || operator === "less_than") && !["number", "datetime", "duration"].includes(fieldType.type)) {
    diagnostics.push(diagnostic(unresolved.location, "type", "operator_type_mismatch", `'${operator}' cannot compare ${fieldType.type}.`));
    return null;
  }
  const literal = parseLiteral(literalSource);
  const authoritativeType = facetValueType ?? builtinValueType(fieldType.type);
  const value = literal === undefined || authoritativeType === undefined
    ? undefined
    : canonicalFacetLiteral(authoritativeType, literal);
  if (value === undefined) {
    diagnostics.push(diagnostic(unresolved.location, "type", "literal_type_mismatch", `Value '${literalSource}' is not a valid ${fieldType.type} literal.`));
    return null;
  }
  return { kind: "compare", field: fieldName, operator, value, valueType: fieldType.type, optional: fieldType.optional, missingBehavior: "false", ...(facetId ? { facetId } : {}) };
}

function compileAction(line: LocatedLine, workspace: OrcaWorkspaceSnapshot, diagnostics: OrcaDiagnostic[]): OrcaCompiledAction | null {
  const source = line.trimmed.slice("action ".length);
  const namedResource = (match: RegExpExecArray, items: { id: string; name: string }[]) => {
    const name = quoted(match[1]!);
    const resource = name === null ? undefined : resolveNamed(items, name);
    if (!resource || resource === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", resource === "ambiguous" ? "ambiguous_resource" : "unknown_resource", `${name ?? "Resource"} does not resolve uniquely in Workspace revision ${workspace.revision}.`));
      return null;
    }
    return resource;
  };
  const laneMatch = /^route lane ("(?:[^"\\]|\\.)*")$/.exec(source);
  if (laneMatch) {
    const resource = namedResource(laneMatch, workspace.lanes);
    return resource === null ? null : { kind: "route_lane", laneId: resource.id };
  }
  const workflowMatch = /^set workflow ("(?:[^"\\]|\\.)*")$/.exec(source);
  if (workflowMatch) {
    const resource = namedResource(workflowMatch, workspace.workflowStates);
    return resource === null ? null : { kind: "set_workflow_state", stateId: resource.id };
  }
  for (const [pattern, kind] of [
    [/^add collection ("(?:[^"\\]|\\.)*")$/, "add_collection"],
    [/^remove collection ("(?:[^"\\]|\\.)*")$/, "remove_collection"],
  ] as const) {
    const match = pattern.exec(source);
    if (!match) continue;
    const name = quoted(match[1]!);
    const resource = name === null ? undefined : resolveNamed(workspace.collections, name);
    if (!resource || resource === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", resource === "ambiguous" ? "ambiguous_resource" : "unknown_resource", `${name ?? "Resource"} does not resolve uniquely in Workspace revision ${workspace.revision}.`));
      return null;
    }
    return { kind, accountId: resource.accountId, collectionId: resource.id };
  }
  const facetSet = /^set facet ("(?:[^"\\]|\\.)*")\s*=\s*(.+)$/.exec(source);
  if (facetSet) {
    const name = quoted(facetSet[1]!);
    const facet = name === null ? undefined : resolveNamed(workspace.facets, name);
    if (!facet || facet === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", facet === "ambiguous" ? "ambiguous_resource" : "unknown_resource", `Facet '${name ?? ""}' does not resolve uniquely in Workspace revision ${workspace.revision}.`));
      return null;
    }
    if (facet.cardinality !== "single") {
      diagnostics.push(diagnostic(line, "type", "facet_cardinality_mismatch", `Facet '${facet.name}' is multi-value; Orca v1 set supports single-value Facets only.`));
      return null;
    }
    const literal = parseLiteral(facetSet[2]!);
    const value = literal === undefined ? undefined : canonicalFacetLiteral(facet.valueType, literal);
    if (value === undefined) {
      diagnostics.push(diagnostic(line, "type", "literal_type_mismatch", `Facet '${facet.name}' requires a ${facet.valueType.kind} value.`));
      return null;
    }
    return { kind: "set_facet", facetId: facet.id, value };
  }
  const facetUnset = /^unset facet ("(?:[^"\\]|\\.)*")$/.exec(source);
  if (facetUnset) {
    const name = quoted(facetUnset[1]!);
    const facet = name === null ? undefined : resolveNamed(workspace.facets, name);
    if (!facet || facet === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", "unknown_resource", `Facet '${name ?? ""}' does not resolve uniquely in Workspace revision ${workspace.revision}.`));
      return null;
    }
    if (!facet.optional) {
      diagnostics.push(diagnostic(line, "type", "required_facet_cannot_be_unset", `Facet '${facet.name}' is required and cannot be unset.`));
      return null;
    }
    return { kind: "unset_facet", facetId: facet.id };
  }
  const context = /^(link|unlink) context ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(source);
  if (context) {
    const typeName = quoted(context[2]!); const contextName = quoted(context[3]!);
    const type = typeName === null ? undefined : resolveNamed(workspace.contextTypes, typeName);
    if (!type || type === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", "unknown_resource", `Context Type '${typeName ?? ""}' does not resolve uniquely.`)); return null;
    }
    const value = contextName === null ? undefined : resolveNamed(workspace.contexts.filter((item) => item.contextTypeId === type.id), contextName);
    if (!value || value === "ambiguous") {
      diagnostics.push(diagnostic(line, "resolve", "unknown_resource", `Context '${contextName ?? ""}' does not resolve uniquely inside '${type.name}'.`)); return null;
    }
    return { kind: context[1] === "link" ? "link_context" : "unlink_context", contextTypeId: type.id, contextId: value.id };
  }
  const notify = /^notify (immediate|digest)$/.exec(source);
  if (notify) return { kind: "notify", urgency: notify[1] === "immediate" ? "immediate" : "digest" };
  if (source === "suppress interruption") return { kind: "suppress_interruption" };
  if (source === "propose provider deletion") return { kind: "propose_provider_deletion" };
  const schedule = /^schedule review ("(?:[^"\\]|\\.)*")$/.exec(source);
  if (schedule) {
    const duration = quoted(schedule[1]!);
    if (duration === null || canonicalFacetLiteral({ kind: "duration" }, duration) === undefined) {
      diagnostics.push(diagnostic(line, "type", "invalid_duration", "Review duration must be an ISO 8601 duration such as \"P1D\".")); return null;
    }
    return { kind: "schedule_review", duration };
  }
  const retention = /^propose retention (keep|review_after(?:\s+\d+)?)$/.exec(source);
  if (retention) {
    if (retention[1] === "keep") return { kind: "propose_retention", mode: "keep", days: null };
    const days = Number(retention[1]!.split(/\s+/)[1]);
    if (!Number.isInteger(days) || days < 1 || days > 3_650) {
      diagnostics.push(diagnostic(line, "type", "invalid_retention", "Retention review must be between 1 and 3650 days.")); return null;
    }
    return { kind: "propose_retention", mode: "review_after", days };
  }
  diagnostics.push(diagnostic(line, "parse", "invalid_action", "Unknown action. Orca v1 actions are declarative organization, attention, and retention proposals only."));
  return null;
}

export function compileOrcaRule(input: OrcaCompileInput): OrcaCompileResult {
  const { source, workspace } = input;
  const lines = locatedLines(source);
  const diagnostics: OrcaDiagnostic[] = [];
  const byteLength = new TextEncoder().encode(source).length;
  if (byteLength > orcaCompilerLimits.maximumSourceBytes) diagnostics.push(diagnostic(lines[0]!, "limits", "source_too_large", `Source exceeds ${orcaCompilerLimits.maximumSourceBytes} bytes.`));
  if (lines.length > orcaCompilerLimits.maximumLines) diagnostics.push(diagnostic(lines[orcaCompilerLimits.maximumLines] ?? lines[0]!, "limits", "too_many_lines", `Source exceeds ${orcaCompilerLimits.maximumLines} lines.`));
  const longLine = lines.find((line) => new TextEncoder().encode(line.text).length > orcaCompilerLimits.maximumLineBytes);
  if (longLine) diagnostics.push(diagnostic(longLine, "limits", "line_too_large", `A source line exceeds ${orcaCompilerLimits.maximumLineBytes} bytes.`));
  const tokenCount = source.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.]*|\S/g)?.length ?? 0;
  if (tokenCount > orcaCompilerLimits.maximumTokens) diagnostics.push(diagnostic(lines[0]!, "limits", "too_many_tokens", `Source exceeds ${orcaCompilerLimits.maximumTokens} tokens.`));
  if (diagnostics.length) return { ok: false, diagnostics };

  let version: number | null = null;
  let name: string | null = null;
  const events: { kind: OrcaCompiledRuleRevision["event"]["kind"]; line: LocatedLine }[] = [];
  const definitions = new Map<string, UnresolvedPredicate>();
  const predicates: UnresolvedPredicate[] = [];
  const actionLines: LocatedLine[] = [];
  let because: string | null = null;

  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith("#")) continue;
    const language = /^orca\s+(\d+)$/.exec(line.trimmed);
    if (language) { if (version !== null) diagnostics.push(diagnostic(line, "parse", "duplicate_version", "Declare the Orca language version once.")); else version = Number(language[1]); continue; }
    const rule = /^rule\s+(.+)$/.exec(line.trimmed);
    if (rule) { const value = quoted(rule[1]!); if (value === null) diagnostics.push(diagnostic(line, "parse", "invalid_rule_name", "Rule names must be JSON-style quoted text.")); else if (name !== null) diagnostics.push(diagnostic(line, "parse", "duplicate_rule", "Declare one Rule name.")); else name = value; continue; }
    const event = /^event\s+([a-z.]+)$/.exec(line.trimmed);
    if (event) {
      const parsedEvent = orcaEventKindSchema.safeParse(event[1]);
      if (!parsedEvent.success) diagnostics.push(diagnostic(line, "type", "unsupported_event", `Event '${event[1]}' is not authorable in Orca v1.`));
      else events.push({ kind: parsedEvent.data, line });
      continue;
    }
    const predicate = /^predicate\s+([a-z][a-z0-9_]*)\s*=\s*(.+)$/.exec(line.trimmed);
    if (predicate) {
      const value = { name: predicate[1]!, expression: predicate[2]!.trim(), location: line };
      if (definitions.has(value.name)) diagnostics.push(diagnostic(line, "parse", "duplicate_predicate", `Predicate '${value.name}' is already defined.`));
      else { definitions.set(value.name, value); predicates.push(value); }
      continue;
    }
    const when = /^when\s+(.+)$/.exec(line.trimmed);
    if (when) { predicates.push({ name: null, expression: when[1]!.trim(), location: line }); continue; }
    if (line.trimmed.startsWith("action ")) { actionLines.push(line); continue; }
    const reason = /^because\s+(.+)$/.exec(line.trimmed);
    if (reason) { const value = quoted(reason[1]!); if (value === null) diagnostics.push(diagnostic(line, "parse", "invalid_reason", "Because must be JSON-style quoted text.")); else if (because !== null) diagnostics.push(diagnostic(line, "parse", "duplicate_reason", "Declare one Because reason.")); else because = value; continue; }
    diagnostics.push(diagnostic(line, "parse", "unknown_directive", `Unknown Orca v1 directive '${line.trimmed.split(/\s+/)[0]}'.`, "Use orca, rule, event, predicate, when, action, or because."));
  }
  if (version !== 1) diagnostics.push(diagnostic(lines[0]!, "parse", "language_version_required", "Source must begin with the accepted `orca 1` language version."));
  if (!name) diagnostics.push(diagnostic(lines[0]!, "parse", "rule_name_required", "A quoted Rule name is required."));
  if (events.length !== 1) diagnostics.push(diagnostic(events[1]?.line ?? lines[0]!, "parse", "event_count", `A Rule Revision requires exactly one Event pattern; found ${events.length}.`));
  if (!predicates.length) diagnostics.push(diagnostic(lines[0]!, "parse", "predicate_required", "At least one Predicate is required."));
  if (!actionLines.length) diagnostics.push(diagnostic(lines[0]!, "parse", "action_required", "At least one Action is required."));
  if (!because) diagnostics.push(diagnostic(lines.at(-1) ?? lines[0]!, "parse", "because_required", "A human-readable Because reason is required."));
  if (predicates.length > orcaCompilerLimits.maximumPredicates) diagnostics.push(diagnostic(predicates[orcaCompilerLimits.maximumPredicates]!.location, "limits", "too_many_predicates", `A revision may contain at most ${orcaCompilerLimits.maximumPredicates} Predicates.`));
  if (actionLines.length > orcaCompilerLimits.maximumActions) diagnostics.push(diagnostic(actionLines[orcaCompilerLimits.maximumActions]!, "limits", "too_many_actions", `A revision may contain at most ${orcaCompilerLimits.maximumActions} Actions.`));
  const astNodeCount = actionLines.length + predicates.reduce((count, predicate) => count + expressionNodeCount(predicate.expression), 0);
  if (astNodeCount > orcaCompilerLimits.maximumAstNodes) diagnostics.push(diagnostic(lines[0]!, "limits", "too_many_ast_nodes", `A revision may contain at most ${orcaCompilerLimits.maximumAstNodes} AST nodes.`));
  const predicateDepths = expressionDepths(definitions);
  for (const [predicateName, definition] of definitions) {
    const depth = predicateDepths.get(predicateName) ?? 1;
    if (!Number.isFinite(depth)) diagnostics.push(diagnostic(definition.location, "type", "predicate_cycle", `Predicate '${predicateName}' is recursive. Named predicates must be pure, parameterless, and nonrecursive.`));
    else if (depth > orcaCompilerLimits.maximumExpressionDepth) diagnostics.push(diagnostic(definition.location, "limits", "expression_too_deep", `Predicate depth exceeds ${orcaCompilerLimits.maximumExpressionDepth}.`));
  }
  const compiledPredicates = predicates.map((predicate) => ({ name: predicate.name, expression: compileExpression(predicate, workspace, definitions, diagnostics) }));
  const actions = actionLines.map((line) => compileAction(line, workspace, diagnostics));
  if (diagnostics.length || compiledPredicates.some((item) => !item.expression) || actions.some((action) => !action)) return { ok: false, diagnostics };
  const finalPredicates = compiledPredicates.filter((item): item is OrcaCompiledRuleRevision["predicates"][number] => item.expression !== null);
  const finalActions = actions.filter((action): action is OrcaCompiledAction => action !== null);
  const requiredCapabilities = new Set<OrcaCompiledRuleRevision["requiredCapabilities"][number]>();
  if (finalActions.some((action) => action.kind !== "propose_provider_deletion")) requiredCapabilities.add("organization_thread");
  if (finalActions.some((action) => ["notify", "suppress_interruption", "schedule_review"].includes(action.kind))) requiredCapabilities.add("organization_attention");
  if (finalActions.some((action) => action.kind === "propose_provider_deletion")) requiredCapabilities.add("provider_delete");
  const risk = finalActions.some((action) => action.kind === "propose_provider_deletion") ? "destructive"
    : finalActions.some((action) => action.kind === "propose_retention") ? "high"
    : finalActions.some((action) => ["notify", "suppress_interruption", "schedule_review"].includes(action.kind)) ? "medium" : "low";
  const revision = orcaCompiledRuleRevisionSchema.parse({
    languageVersion: 1,
    workspaceId: workspace.workspaceId,
    workspaceSchemaRevision: workspace.revision,
    name: name!,
    event: { kind: events[0]!.kind },
    predicates: finalPredicates,
    actions: finalActions,
    because: because!,
    requiredCapabilities: [...requiredCapabilities].sort(),
    risk,
  } satisfies OrcaCompiledRuleRevision);
  return { ok: true, diagnostics: [], revision };
}
