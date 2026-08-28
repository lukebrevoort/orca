import { orcaEvaluationTraceSchema, type OrcaEvaluationTrace } from "@orca/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export const orcaPersistedTraceDecoderVersions = Object.freeze({
  current: "current",
  bre315: "bre-315-v1",
} as const);

function normalizeBre315TraceV1(value: unknown): Record<string, unknown> | null {
  const root = record(value);
  if (!root) return null;
  const normalized = structuredClone(root);
  let recognized = false;

  const budget = record(normalized.budget);
  if (budget && !Object.hasOwn(budget, "status")) {
    if (typeof budget.exhausted !== "boolean") return null;
    budget.status = budget.exhausted ? "exhausted" : "complete";
    recognized = true;
  }

  const event = record(normalized.event);
  if (event?.kind === "thread.updated" && Object.hasOwn(event, "messageId")) {
    const legacyMessageId = event.messageId;
    if (typeof legacyMessageId !== "string" || legacyMessageId.trim() !== legacyMessageId || legacyMessageId.length < 1 || legacyMessageId.length > 200) return null;
    // BRE-315 stored the provider Message that prompted reevaluation on a
    // Thread Event. It was transport linkage, not the Event subject. The
    // stable Event ID, kind, cause, time, Account, and Thread retain the
    // semantic history under the current strict Event model.
    delete event.messageId;
    recognized = true;
  }

  return recognized ? normalized : null;
}

/**
 * Decodes the persisted BRE-315 v1 Trace wire shape at storage read boundaries.
 * Current writes remain strict: this compatibility path is never used before
 * persistence and the fully normalized value must pass the current schema.
 */
export function decodePersistedOrcaEvaluationTrace(value: unknown): OrcaEvaluationTrace {
  const current = orcaEvaluationTraceSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = normalizeBre315TraceV1(value);
  return orcaEvaluationTraceSchema.parse(legacy ?? value);
}
