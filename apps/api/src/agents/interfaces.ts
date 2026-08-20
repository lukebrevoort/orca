import type {
  AgentEventLifecycle,
  AgentEventListPage,
  AgentPropagationAssessment,
  AgentPropagationPolicy,
  AgentPropagationTrigger,
  HumanClassificationResult,
  NormalizedMessage,
  PropagatedAgentEvent,
  UpdateAgentEventLifecycle,
} from "@orca/shared";

export type AgentEvaluationInput = {
  ownerUserId: string;
  message: NormalizedMessage;
  humanClassification: HumanClassificationResult | null;
  trigger: AgentPropagationTrigger;
  policy: AgentPropagationPolicy;
  sourceUrl: string;
};

/**
 * Implement this seam for deterministic M6 rules. A future model-assisted
 * implementation must return the same assessment and may not mutate mail.
 */
export interface AgentPropagationEvaluator {
  readonly id: string;
  readonly version: string;
  readonly executionMode: "deterministic" | "model_assisted";
  evaluate(input: AgentEvaluationInput): Promise<AgentPropagationAssessment>;
}

export type AgentEventListQuery = {
  ownerUserId: string;
  accountIds: readonly string[];
  states?: readonly AgentEventLifecycle["state"][];
  limit: number;
  cursor?: string;
};

/** Persistence remains account-scoped and retry-safe through deduplicationKey. */
export interface AgentEventStore {
  upsert(assessment: AgentPropagationAssessment): Promise<PropagatedAgentEvent>;
  list(query: AgentEventListQuery): Promise<AgentEventListPage>;
  updateLifecycle(input: {
    ownerUserId: string;
    accountId: string;
    eventId: string;
    update: UpdateAgentEventLifecycle;
  }): Promise<PropagatedAgentEvent>;
}
