import {
  agentPropagationAssessmentSchema,
  type AgentPropagationAssessment,
  type AgentPropagationPolicy,
  type AgentPropagationReasonCode,
  type AgentPropagationTrigger,
  type HumanClassificationResult,
  type NormalizedMessage,
  type PropagatedAgentEvent,
} from "@orca/shared";

import type { AgentEventStore, AgentPropagationEvaluator } from "../interfaces.ts";

export type PropagationWriteOutcome = "created" | "updated" | "duplicate" | "persisted";

export type PropagationWriteResult = {
  event: PropagatedAgentEvent;
  outcome: PropagationWriteOutcome;
};

export interface DiagnosticAgentEventStore extends Pick<AgentEventStore, "upsert"> {
  upsertWithResult?(assessment: AgentPropagationAssessment): Promise<PropagationWriteResult>;
}

export type PropagationMuteDecision = {
  reasonCode: Extract<AgentPropagationReasonCode, "sender_muted" | "category_muted">;
} | null;

export type PropagationTelemetry = Pick<Console, "info" | "warn" | "error">;

export type PropagationBatchResult = {
  enabled: boolean;
  evaluated: number;
  propagated: number;
  suppressed: number;
  failed: number;
  writes: Record<PropagationWriteOutcome, number>;
};

export type PropagateNormalizedMessagesInput = {
  ownerUserId: string;
  messages: readonly NormalizedMessage[];
  humanClassificationFor: (message: NormalizedMessage) => HumanClassificationResult | null;
  trigger: AgentPropagationTrigger;
  policy: AgentPropagationPolicy;
  evaluator: AgentPropagationEvaluator;
  store: DiagnosticAgentEventStore;
  sourceUrlFor: (message: NormalizedMessage) => string;
  muteFor?: (assessment: AgentPropagationAssessment) => PropagationMuteDecision;
  logger?: PropagationTelemetry;
};

/**
 * Isolated post-normalization boundary. Each message is evaluated and written
 * independently; failures are reported but never escape into provider sync.
 */
export async function propagateNormalizedMessagesSafely(
  input: PropagateNormalizedMessagesInput,
): Promise<PropagationBatchResult> {
  const logger = input.logger ?? console;
  const result: PropagationBatchResult = {
    enabled: true,
    evaluated: 0,
    propagated: 0,
    suppressed: 0,
    failed: 0,
    writes: { created: 0, updated: 0, duplicate: 0, persisted: 0 },
  };

  for (const message of input.messages) {
    try {
      const evaluated = await input.evaluator.evaluate({
        ownerUserId: input.ownerUserId,
        message,
        humanClassification: input.humanClassificationFor(message),
        trigger: input.trigger,
        policy: input.policy,
        sourceUrl: input.sourceUrlFor(message),
      });
      result.evaluated += 1;
      const mute = input.muteFor?.(evaluated) ?? null;
      const assessment = mute ? suppressMutedAssessment(evaluated, mute.reasonCode) : evaluated;

      if (assessment.destination === "none") {
        result.suppressed += 1;
        logger.info("Agent propagation suppressed", safeTelemetry(assessment, "suppressed"));
        continue;
      }

      const write = input.store.upsertWithResult
        ? await input.store.upsertWithResult(assessment)
        : { event: await input.store.upsert(assessment), outcome: "persisted" as const };
      result.propagated += 1;
      result.writes[write.outcome] += 1;
      logger.info("Agent propagation persisted", safeTelemetry(assessment, write.outcome));
    } catch (error) {
      result.failed += 1;
      logger.error("Agent propagation failed; normalized mail remains stored", {
        accountId: message.accountId,
        provider: message.provider,
        providerMessageId: message.providerMessageId,
        trigger: input.trigger,
        error: safeErrorCode(error),
      });
    }
  }

  return result;
}

function suppressMutedAssessment(
  assessment: AgentPropagationAssessment,
  reasonCode: "sender_muted" | "category_muted",
): AgentPropagationAssessment {
  return agentPropagationAssessmentSchema.parse({
    ...assessment,
    importance: "low",
    relevance: "not_matched",
    destination: "none",
    reasonCodes: [reasonCode],
    whyThisMatters: "A reversible local propagation mute applies to this event.",
    suggestedNextStep: null,
  });
}

function safeTelemetry(
  assessment: AgentPropagationAssessment,
  outcome: "suppressed" | PropagationWriteOutcome,
) {
  return {
    accountId: assessment.source.accountId,
    provider: assessment.source.provider,
    messageId: assessment.source.messageId,
    threadId: assessment.source.threadId,
    policyVersion: assessment.provenance.policyVersion,
    agentId: assessment.provenance.agentId,
    agentVersion: assessment.provenance.agentVersion,
    executionMode: assessment.provenance.executionMode,
    eventKind: assessment.eventKind,
    reasonCodes: assessment.reasonCodes,
    destination: assessment.destination,
    outcome,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "PropagationError";
}
