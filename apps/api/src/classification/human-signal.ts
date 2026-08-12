import type {
  HumanClassificationAssessment,
  HumanClassificationEvidence,
  HumanClassificationReasonCode,
} from "@orca/shared";

/** Increment whenever deterministic classification rules intentionally change. */
export const humanClassifierVersion = "m5-v2";

const noReplyAddressPattern = /(?:^|[._+\-])(no[._+\-]?reply|do[._+\-]?not[._+\-]?reply|mailer[._+\-]?daemon|postmaster)(?:[._+\-]|@|$)/i;

/**
 * Produce a provider-neutral, explainable estimate from normalized metadata.
 * This deliberately never reads message content or calls a network service.
 */
export function classifyHumanSignal(
  evidence: HumanClassificationEvidence | null | undefined,
): HumanClassificationAssessment {
  if (!evidence || !evidence.sender.email.trim()) {
    return unclassifiedAssessment();
  }

  const reasons = new Set<HumanClassificationReasonCode>();
  let score = 5;
  let hasHumanEvidence = false;
  let hasMachineEvidence = false;
  let hasReplyEvidence = false;
  let hasStrongMachineEvidence = false;

  if (evidence.recipientRelationship === "direct") {
    score += 2;
    hasHumanEvidence = true;
    reasons.add("direct_recipient");
  }

  if (evidence.reply.hasInReplyTo || evidence.reply.referenceCount > 0) {
    score += 2;
    hasHumanEvidence = true;
    hasReplyEvidence = true;
    reasons.add("reply_context");
  }

  if (noReplyAddressPattern.test(evidence.sender.email.trim().toLowerCase())) {
    score -= 4;
    hasMachineEvidence = true;
    hasStrongMachineEvidence = true;
    reasons.add("sender_no_reply_pattern");
  }

  for (const signal of evidence.headerSignals) {
    // Kept in the wire contract to parse historical evidence, but this header
    // controls automatic replies by recipients rather than sender authorship.
    if (signal === "x_auto_response_suppress") continue;

    switch (signal) {
      case "list_id":
        score -= 3;
        reasons.add("list_id_header");
        break;
      case "list_unsubscribe":
        score -= 2;
        reasons.add("list_unsubscribe_header");
        break;
      case "precedence_bulk":
      case "precedence_list":
        score -= 3;
        reasons.add("bulk_precedence_header");
        break;
      case "auto_submitted":
        score -= 3;
        reasons.add("auto_submitted_header");
        break;
    }
    hasMachineEvidence = true;
    hasStrongMachineEvidence = true;
  }

  for (const signal of evidence.providerSignals) {
    switch (signal) {
      case "bulk_or_marketing_label":
        score -= 3;
        reasons.add("provider_bulk_signal");
        break;
      case "automated_category":
        score -= 3;
        reasons.add("provider_bulk_signal");
        hasStrongMachineEvidence = true;
        break;
      case "promotions_label":
        score -= 2;
        reasons.add("provider_promotions_signal");
        break;
      case "transactional_category":
        score -= 3;
        reasons.add("provider_transactional_signal");
        hasStrongMachineEvidence = true;
        break;
    }
    hasMachineEvidence = true;
  }

  if (!hasHumanEvidence && !hasMachineEvidence) {
    return unclassifiedAssessment();
  }

  const boundedScore = Math.max(0, Math.min(10, score));
  if (hasReplyEvidence && hasStrongMachineEvidence) {
    reasons.add("conflicting_evidence");
    return assessment("uncertain", boundedScore, reasons);
  }

  if (hasMachineEvidence && boundedScore <= 3) {
    return assessment("automated_or_bulk", boundedScore, reasons);
  }

  if (hasHumanEvidence && boundedScore >= 7) {
    return assessment("likely_human", boundedScore, reasons);
  }

  reasons.add("insufficient_evidence");
  return assessment("uncertain", boundedScore, reasons);
}

export function automaticClassificationColumns(
  classification: HumanClassificationAssessment,
) {
  return {
    humanSignal: classification.score,
    humanClassification: classification.classification,
    humanClassificationReasons: JSON.stringify(classification.reasonCodes),
    humanClassifierVersion: classification.classifierVersion,
  };
}

function unclassifiedAssessment(): HumanClassificationAssessment {
  return assessment("unclassified", null, new Set(["insufficient_evidence"]));
}

function assessment(
  classification: HumanClassificationAssessment["classification"],
  score: number | null,
  reasons: Set<HumanClassificationReasonCode>,
): HumanClassificationAssessment {
  return {
    classification,
    score,
    reasonCodes: [...reasons],
    classifierVersion: humanClassifierVersion,
  };
}
