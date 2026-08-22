import {
  type AgentPropagationAssessment,
  type AgentPropagationMuteRule,
  type AgentPropagationTrigger,
  type HumanClassificationAssessment,
  type HumanClassificationOverride,
  type HumanClassificationResult,
  type NormalizedMessage,
} from "@orca/shared";
import { eq } from "drizzle-orm";

import { classifyHumanSignal } from "../../classification/human-signal.ts";
import { getServerConfig } from "../../config/server.ts";
import type { createDatabaseClient } from "../../db/client.ts";
import {
  humanClassificationOverrides,
  oauthAccounts,
} from "../../db/schema.ts";
import { getAgentFeatureFlags } from "../config.ts";
import type { AgentPropagationEvaluator } from "../interfaces.ts";
import { DeterministicPropagationEvaluator } from "./deterministic.ts";
import {
  propagateNormalizedMessagesSafely,
  type DiagnosticAgentEventStore,
  type PropagationBatchResult,
  type PropagationMuteDecision,
  type PropagationTelemetry,
} from "./service.ts";
import {
  listAgentPropagationMutes,
  resolveAgentPropagationPolicy,
  SqliteAgentEventStore,
} from "./store.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export type DeterministicPropagationRuntimeOptions = {
  enabled?: boolean;
  webOrigin?: string;
  evaluator?: AgentPropagationEvaluator;
  store?: DiagnosticAgentEventStore;
  logger?: PropagationTelemetry;
};

export async function runDeterministicPropagation(
  db: DatabaseClient,
  input: {
    accountId: string;
    messages: readonly NormalizedMessage[];
    trigger: AgentPropagationTrigger;
    options?: DeterministicPropagationRuntimeOptions;
  },
): Promise<PropagationBatchResult> {
  const enabled = input.options?.enabled ?? getAgentFeatureFlags().propagationEnabled;
  if (!enabled || input.messages.length === 0) return emptyResult(enabled);
  const logger = input.options?.logger ?? console;

  try {
    const account = db.select({
      id: oauthAccounts.id,
      ownerUserId: oauthAccounts.userId,
    }).from(oauthAccounts).where(eq(oauthAccounts.id, input.accountId)).get();
    if (!account) throw new Error("PropagationAccountNotFound");
    if (input.messages.some((message) => message.accountId !== account.id)) {
      throw new Error("PropagationAccountScopeError");
    }

    const overrides = db.select().from(humanClassificationOverrides)
      .where(eq(humanClassificationOverrides.accountId, account.id)).all();
    const policy = resolveAgentPropagationPolicy(db, account.id);
    const mutes = listAgentPropagationMutes(db, account.id);
    const webOrigin = new URL(input.options?.webOrigin ?? getServerConfig().webOrigin).origin;

    return propagateNormalizedMessagesSafely({
      ownerUserId: account.ownerUserId,
      messages: input.messages,
      humanClassificationFor: (message) => resolveHumanClassification(message, overrides),
      trigger: input.trigger,
      policy,
      evaluator: input.options?.evaluator ?? new DeterministicPropagationEvaluator(),
      store: input.options?.store ?? new SqliteAgentEventStore(db),
      sourceUrlFor(message) {
        const url = new URL("/", webOrigin);
        url.searchParams.set("thread", message.threadId);
        url.searchParams.set("accountId", message.accountId);
        return url.toString();
      },
      muteFor: (assessment) => resolveMute(assessment, mutes),
      logger,
    });
  } catch (error) {
    logger.error("Agent propagation setup failed; normalized mail remains stored", {
      accountId: input.accountId,
      trigger: input.trigger,
      messageCount: input.messages.length,
      error: error instanceof Error ? error.name : "PropagationSetupError",
    });
    return {
      ...emptyResult(true),
      failed: input.messages.length,
    };
  }
}

function resolveHumanClassification(
  message: NormalizedMessage,
  overrides: Array<typeof humanClassificationOverrides.$inferSelect>,
): HumanClassificationResult {
  const automatic = classifyHumanSignal(message.classificationEvidence);
  const address = message.from.email.trim().toLowerCase();
  const domain = address.split("@").at(-1) ?? "";
  const row = overrides.find((override) => override.targetType === "message" && override.targetValue === message.id)
    ?? overrides.find((override) => override.targetType === "sender_address" && override.targetValue === address)
    ?? overrides.find((override) => override.targetType === "sender_domain" && override.targetValue === domain);
  if (!row) return automaticResult(automatic);

  const userOverride: HumanClassificationOverride = {
    id: row.id,
    accountId: row.accountId,
    target: row.targetType === "message"
      ? { scope: "message", messageId: row.targetValue }
      : row.targetType === "sender_address"
      ? { scope: "sender_address", address: row.targetValue }
      : { scope: "sender_domain", domain: row.targetValue },
    classification: row.classification as HumanClassificationOverride["classification"],
    source: "user_choice",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const effective = {
    classification: userOverride.classification,
    score: automatic.score,
    reasonCodes: automatic.reasonCodes,
    classifierVersion: automatic.classifierVersion,
    source: "user_override" as const,
    userOverride,
  };
  return { automatic, effective, userOverride };
}

function automaticResult(automatic: HumanClassificationAssessment): HumanClassificationResult {
  return {
    automatic,
    effective: { ...automatic, source: "automatic_heuristic", userOverride: null },
    userOverride: null,
  };
}

function resolveMute(
  assessment: AgentPropagationAssessment,
  mutes: readonly AgentPropagationMuteRule[],
): PropagationMuteDecision {
  const address = assessment.source.sender.email.trim().toLowerCase();
  const domain = address.split("@").at(-1) ?? "";
  for (const mute of mutes) {
    if (mute.target.scope === "sender_address" && mute.target.value === address) {
      return { reasonCode: "sender_muted" };
    }
    if (mute.target.scope === "sender_domain" && mute.target.value === domain) {
      return { reasonCode: "sender_muted" };
    }
    if (mute.target.scope === "event_kind" && mute.target.value === assessment.eventKind) {
      return { reasonCode: "category_muted" };
    }
  }
  return null;
}

function emptyResult(enabled: boolean): PropagationBatchResult {
  return {
    enabled,
    evaluated: 0,
    propagated: 0,
    suppressed: 0,
    failed: 0,
    writes: { created: 0, updated: 0, duplicate: 0, persisted: 0 },
  };
}
