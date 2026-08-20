import { createHash } from "node:crypto";

import {
  agentPropagationAssessmentSchema,
  type AgentEventKind,
  type AgentImportance,
  type AgentPropagationAssessment,
  type AgentPropagationPolicy,
} from "@orca/shared";

import type { AgentEvaluationInput, AgentPropagationEvaluator } from "../interfaces.ts";

export const deterministicPropagationPolicyVersion = "m6-v0";
export const deterministicPropagationAgentId = "orca-deterministic-propagator";
export const deterministicPropagationAgentVersion = "0.1.0";

type MatchedRule = {
  eventKind: AgentEventKind;
  importance: AgentImportance;
  reasonCode:
    | "release_became_available"
    | "workflow_failed"
    | "security_change_detected"
    | "payment_or_renewal_detected"
    | "itinerary_changed";
  whyThisMatters: string;
  suggestedNextStep: string;
};

const automationSenderPattern = /(?:^|[._+\-])(no[._+\-]?reply|do[._+\-]?not[._+\-]?reply|notifications?|alerts?|builds?|ci)(?:[._+\-]|@|$)/i;
const automationDomainPattern = /(?:github|gitlab|circleci|buildkite|vercel|netlify|testflight|apple|google|microsoft|okta|stripe|paypal|airbnb|booking|expedia|united|delta|southwest|american|alaska)\./i;
const routineBulkPattern = /\b(newsletter|weekly digest|daily digest|product updates?|special offer|sale|promotion|unsubscribe)\b/i;

/**
 * Deterministic v0 propagation. The evaluator only reads the normalized mail
 * contract and the caller's local policy; it has no provider or model client.
 */
export class DeterministicPropagationEvaluator implements AgentPropagationEvaluator {
  readonly id = deterministicPropagationAgentId;
  readonly version = deterministicPropagationAgentVersion;
  readonly executionMode = "deterministic" as const;

  async evaluate(input: AgentEvaluationInput): Promise<AgentPropagationAssessment> {
    return evaluateDeterministicPropagation(input);
  }
}

export function evaluateDeterministicPropagation(
  input: AgentEvaluationInput,
  evaluatedAt = new Date(),
): AgentPropagationAssessment {
  const message = input.message;
  const searchable = normalizeSearchableText([
    message.subject,
    message.snippet,
    message.bodyText ?? "",
  ].join("\n"));
  const senderAddress = message.from.email.trim().toLowerCase();
  const senderDomain = senderAddress.split("@").at(-1) ?? "";
  const machineEvidence = hasMachineEvidence(input);
  const matched = matchConservativeRule({
    searchable,
    senderAddress,
    senderDomain,
    machineEvidence,
  });

  if (matched) {
    const enabled = isCategoryEnabled(input.policy, matched.eventKind);
    return buildAssessment(input, {
      eventKind: matched.eventKind,
      importance: enabled ? matched.importance : "low",
      relevance: enabled ? "matched" : "not_matched",
      destination: enabled ? "timeline" : "none",
      reasonCode: enabled ? matched.reasonCode : "user_policy_disabled",
      whyThisMatters: enabled
        ? matched.whyThisMatters
        : "This category is disabled by the account's local propagation policy.",
      suggestedNextStep: enabled ? matched.suggestedNextStep : null,
      evaluatedAt,
    });
  }

  if (isRoutineBulk(input, searchable)) {
    return buildAssessment(input, {
      eventKind: "marketing_or_newsletter",
      importance: "low",
      relevance: "not_matched",
      destination: "none",
      reasonCode: "routine_bulk_content",
      whyThisMatters: "Orca found routine bulk content without a concrete consequence.",
      suggestedNextStep: null,
      evaluatedAt,
    });
  }

  const likelyHuman = input.humanClassification?.effective.classification === "likely_human";
  return buildAssessment(input, {
    eventKind: "other",
    importance: "unknown",
    relevance: "not_matched",
    destination: "none",
    reasonCode: likelyHuman ? "human_correspondence" : "insufficient_evidence",
    whyThisMatters: likelyHuman
      ? "Human correspondence remains governed by Human Signal and attention settings."
      : "The deterministic rules found no concrete high-consequence event.",
    suggestedNextStep: null,
    evaluatedAt,
  });
}

export function buildAgentEventDeduplicationKey(input: {
  ownerUserId: string;
  accountId: string;
  provider: string;
  providerMessageId: string;
  eventKind: AgentEventKind;
  policyVersion?: string;
}): string {
  const canonicalTuple = [
    "agent-event-dedupe-v1",
    input.ownerUserId,
    input.accountId,
    input.provider,
    input.providerMessageId,
    input.eventKind,
    input.policyVersion ?? deterministicPropagationPolicyVersion,
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalTuple)).digest("hex")}`;
}

function matchConservativeRule(input: {
  searchable: string;
  senderAddress: string;
  senderDomain: string;
  machineEvidence: boolean;
}): MatchedRule | null {
  const automatedSender = input.machineEvidence
    || automationSenderPattern.test(input.senderAddress)
    || automationDomainPattern.test(input.senderDomain);

  const testFlightSource = /testflight/i.test(input.senderAddress)
    || /(?:^|\.)apple\.com$/i.test(input.senderDomain)
    || /\btestflight\b/i.test(input.searchable);
  if (
    testFlightSource
    && /\b(?:is |now )?(?:ready|available) to test\b|\bnew (?:beta )?build\b|\bbuild [\w.-]+ (?:is )?available\b/i.test(input.searchable)
  ) {
    return {
      eventKind: "release_available",
      importance: "high",
      reasonCode: "release_became_available",
      whyThisMatters: "A release or beta build is ready for review.",
      suggestedNextStep: "Open the original message when you are ready to review the build.",
    };
  }

  if (
    automatedSender
    && /\b(?:workflow|pipeline|build|deploy(?:ment)?|check run)\b[^\n.!?]{0,60}\b(?:failed|failure|errored|cancelled|canceled)\b|\b(?:failed|failure)\b[^\n.!?]{0,40}\b(?:workflow|pipeline|build|deploy(?:ment)?)\b/i.test(input.searchable)
  ) {
    return {
      eventKind: "ci_or_deploy_failure",
      importance: "high",
      reasonCode: "workflow_failed",
      whyThisMatters: "An automated build or deployment reported a failure.",
      suggestedNextStep: "Open the original message to inspect the failed run.",
    };
  }

  if (
    automatedSender
    && /\bsecurity alert\b|\bunusual (?:sign[ -]?in|activity)\b|\bnew sign[ -]?in\b|\bpassword (?:was )?changed\b|\btwo[ -]?factor (?:authentication )?(?:was )?disabled\b|\baccount (?:was )?(?:locked|suspended)\b/i.test(input.searchable)
  ) {
    return {
      eventKind: "security_or_account_alert",
      importance: "high",
      reasonCode: "security_change_detected",
      whyThisMatters: "An account or security setting may have changed.",
      suggestedNextStep: "Review the original message and verify the activity directly with the service.",
    };
  }

  if (
    automatedSender
    && /\b(?:payment )?receipt\b|\binvoice (?:is )?(?:ready|available|due)\b|\bsubscription (?:has )?(?:renewed|renewal)\b|\brenewal (?:notice|confirmation|upcoming)\b|\bpayment (?:was )?(?:successful|received)\b/i.test(input.searchable)
  ) {
    return {
      eventKind: "receipt_or_renewal",
      importance: "medium",
      reasonCode: "payment_or_renewal_detected",
      whyThisMatters: "A payment, receipt, invoice, or renewal may affect the account.",
      suggestedNextStep: "Open the original message to confirm the amount and timing.",
    };
  }

  if (
    automatedSender
    && /\b(?:flight|train|reservation|booking|itinerary|trip)\b[^\n.!?]{0,70}\b(?:changed|updated|cancelled|canceled|delayed|rebooked)\b|\b(?:changed|updated|cancelled|canceled|delayed|rebooked)\b[^\n.!?]{0,50}\b(?:flight|train|reservation|booking|itinerary|trip)\b/i.test(input.searchable)
  ) {
    return {
      eventKind: "travel_or_booking_change",
      importance: "high",
      reasonCode: "itinerary_changed",
      whyThisMatters: "A travel or booking plan changed.",
      suggestedNextStep: "Open the original message to review the updated itinerary.",
    };
  }

  return null;
}

function buildAssessment(
  input: AgentEvaluationInput,
  decision: {
    eventKind: AgentEventKind;
    importance: AgentImportance;
    relevance: "matched" | "not_matched";
    destination: "timeline" | "none";
    reasonCode: AgentPropagationAssessment["reasonCodes"][number];
    whyThisMatters: string;
    suggestedNextStep: string | null;
    evaluatedAt: Date;
  },
): AgentPropagationAssessment {
  const message = input.message;
  const senderLabel = message.from.name?.trim() || message.from.email.trim() || "An automated sender";
  const subject = boundedText(message.subject || "(No subject)", 160);
  const summary = boundedText(`${senderLabel} sent “${subject}”.`, 500);
  const effectiveClassification = input.humanClassification?.effective ?? null;
  const assessment = {
    source: {
      ownerUserId: input.ownerUserId,
      accountId: message.accountId,
      provider: message.provider,
      messageId: message.id,
      providerMessageId: message.providerMessageId,
      threadId: message.threadId,
      sender: message.from,
      subject: boundedText(message.subject, 998),
      receivedAt: message.receivedAt,
      sourceUrl: input.sourceUrl,
    },
    provenance: {
      trigger: input.trigger,
      policyVersion: deterministicPropagationPolicyVersion,
      agentId: deterministicPropagationAgentId,
      agentVersion: deterministicPropagationAgentVersion,
      executionMode: "deterministic" as const,
    },
    eventKind: decision.eventKind,
    importance: decision.importance,
    relevance: decision.relevance,
    destination: decision.destination,
    reasonCodes: [decision.reasonCode],
    title: subject,
    summary,
    whyThisMatters: decision.whyThisMatters,
    suggestedNextStep: decision.suggestedNextStep,
    humanClassification: effectiveClassification
      ? {
          classification: effectiveClassification.classification,
          score: effectiveClassification.score,
          reasonCodes: effectiveClassification.reasonCodes,
          classifierVersion: effectiveClassification.classifierVersion,
          source: effectiveClassification.source,
        }
      : null,
    deduplicationKey: buildAgentEventDeduplicationKey({
      ownerUserId: input.ownerUserId,
      accountId: message.accountId,
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      eventKind: decision.eventKind,
    }),
    evaluatedAt: decision.evaluatedAt.toISOString(),
  };

  return agentPropagationAssessmentSchema.parse(assessment);
}

function hasMachineEvidence(input: AgentEvaluationInput): boolean {
  if (input.humanClassification?.effective.classification === "automated_or_bulk") return true;
  const evidence = input.message.classificationEvidence;
  return Boolean(evidence && (evidence.headerSignals.length > 0 || evidence.providerSignals.length > 0));
}

function isRoutineBulk(input: AgentEvaluationInput, searchable: string): boolean {
  const evidence = input.message.classificationEvidence;
  return routineBulkPattern.test(searchable)
    || evidence?.providerSignals.some((signal) => signal === "bulk_or_marketing_label" || signal === "promotions_label") === true
    || evidence?.headerSignals.some((signal) => signal === "list_id" || signal === "list_unsubscribe" || signal === "precedence_bulk" || signal === "precedence_list") === true;
}

function isCategoryEnabled(policy: AgentPropagationPolicy, eventKind: AgentEventKind): boolean {
  switch (eventKind) {
    case "release_available": return policy.releaseAvailable;
    case "ci_or_deploy_failure": return policy.ciOrDeployFailure;
    case "security_or_account_alert": return policy.securityOrAccountAlert;
    case "receipt_or_renewal": return policy.receiptOrRenewal;
    case "travel_or_booking_change": return policy.travelOrBookingChange;
    case "marketing_or_newsletter": return policy.marketingOrNewsletter;
    case "other": return policy.other;
  }
}

function normalizeSearchableText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() || "(No subject)";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
