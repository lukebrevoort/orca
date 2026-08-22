import {
  conservativeAgentPropagationPolicy,
  type AgentPropagationAssessment,
  type HumanClassificationAssessment,
  type HumanClassificationResult,
} from "@orca/shared";

import { classifyHumanSignal } from "../../classification/human-signal.ts";
import { normalizeGmailMessage } from "../../providers/gmail/normalizer.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { normalizeOutlookMessage } from "../../providers/outlook/normalizer.ts";
import type { GraphMessage } from "../../providers/outlook/types.ts";
import { evaluateDeterministicPropagation } from "./deterministic.ts";
import { deterministicPropagationFixtures } from "./fixtures.ts";

/** Repeatable, provider-free demo path. No credentials or network are used. */
export function runDeterministicPropagationDemo(): AgentPropagationAssessment[] {
  return deterministicPropagationFixtures.map((fixture, index) => {
    const message = fixture.provider === "gmail"
      ? normalizeGmailMessage(fixture.message as GmailMessage, {
          accountId: "demo-account",
          accountEmail: "demo@orca.test",
        })
      : normalizeOutlookMessage(fixture.message as GraphMessage, {
          accountId: "demo-account",
          accountEmail: "demo@orca.test",
        });
    const automatic = classifyHumanSignal(message.classificationEvidence);
    return evaluateDeterministicPropagation({
      ownerUserId: "demo-user",
      message,
      humanClassification: automaticResult(automatic),
      trigger: "manual_request",
      policy: conservativeAgentPropagationPolicy,
      sourceUrl: `http://localhost:5173/?accountId=demo-account&thread=${encodeURIComponent(message.threadId)}`,
    }, new Date(1_787_155_200_000 + index * 1_000));
  });
}

if (import.meta.main) {
  console.log(JSON.stringify(
    runDeterministicPropagationDemo().map((assessment) => ({
      provider: assessment.source.provider,
      providerMessageId: assessment.source.providerMessageId,
      eventKind: assessment.eventKind,
      destination: assessment.destination,
      reasonCodes: assessment.reasonCodes,
      executionMode: assessment.provenance.executionMode,
      deduplicationKey: assessment.deduplicationKey,
    })),
    null,
    2,
  ));
}

function automaticResult(automatic: HumanClassificationAssessment): HumanClassificationResult {
  return {
    automatic,
    effective: { ...automatic, source: "automatic_heuristic", userOverride: null },
    userOverride: null,
  };
}
