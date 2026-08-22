import {
  agentPropagationAssessmentSchema,
  propagatedAgentEventSchema,
} from "./agent-contract.ts";

const testFlightAssessment = {
  source: {
    ownerUserId: "user_1",
    accountId: "account_work",
    provider: "gmail" as const,
    messageId: "message_testflight_42",
    providerMessageId: "provider-testflight-42",
    threadId: "thread_testflight",
    sender: { name: "TestFlight", email: "no_reply@email.apple.com" },
    subject: "Orca 2.1 is ready to test",
    receivedAt: "2026-08-19T16:00:00.000Z",
    sourceUrl: "https://orca.example/mail/accounts/account_work/messages/message_testflight_42",
  },
  provenance: {
    trigger: "push" as const,
    policyVersion: "m6-policy-v1",
    agentId: "orca-deterministic-propagator",
    agentVersion: "1.0.0",
    executionMode: "deterministic" as const,
  },
  eventKind: "release_available" as const,
  importance: "high" as const,
  relevance: "matched" as const,
  destination: "timeline" as const,
  reasonCodes: ["release_became_available" as const],
  title: "A new Orca beta is ready",
  summary: "TestFlight says Orca 2.1 is available to install.",
  whyThisMatters: "This build is ready for the planned review.",
  suggestedNextStep: "Open the original message when you are ready to install it.",
  humanClassification: {
    classification: "automated_or_bulk" as const,
    score: 2,
    reasonCodes: ["auto_submitted_header" as const],
    classifierVersion: "m5-v1",
    source: "automatic_heuristic" as const,
  },
  deduplicationKey: "sha256:2e5831b1b2e99b86b869e224cb7c9ea52d8186a7dbced3a004f6277f5415dec9",
  evaluatedAt: "2026-08-19T16:00:01.000Z",
};

export const agentContractPropagatedAssessmentFixture = agentPropagationAssessmentSchema.parse(
  testFlightAssessment,
);

export const agentContractBulkSuppressedFixture = agentPropagationAssessmentSchema.parse({
  ...testFlightAssessment,
  source: {
    ...testFlightAssessment.source,
    messageId: "message_newsletter_7",
    providerMessageId: "provider-newsletter-7",
    threadId: "thread_newsletter",
    sender: { name: "Product Weekly", email: "news@example.com" },
    subject: "This week in productivity",
    sourceUrl: "https://orca.example/mail/accounts/account_work/messages/message_newsletter_7",
  },
  eventKind: "marketing_or_newsletter",
  importance: "low",
  relevance: "not_matched",
  destination: "none",
  reasonCodes: ["routine_bulk_content"],
  title: "Routine product newsletter",
  summary: "This message remains available in Tideline.",
  whyThisMatters: "No concrete consequence matched the account policy.",
  suggestedNextStep: null,
  deduplicationKey: "sha256:9b58341ed42e20cc964ecc6d8570ca12be97da302952ec8863e3f601ade93182",
});

export const agentContractDuplicateDeliveryFixture = agentPropagationAssessmentSchema.parse({
  ...testFlightAssessment,
  provenance: { ...testFlightAssessment.provenance, trigger: "sync" },
  evaluatedAt: "2026-08-19T16:01:00.000Z",
});

export const agentContractFalsePositiveFixture = propagatedAgentEventSchema.parse({
  ...testFlightAssessment,
  id: "agent_event_testflight",
  lifecycle: {
    state: "false_positive",
    lastTransition: "false_positive",
    revision: 2,
    createdAt: "2026-08-19T16:00:01.000Z",
    updatedAt: "2026-08-19T16:05:00.000Z",
    lastTransitionAt: "2026-08-19T16:05:00.000Z",
    seenAt: null,
    snoozedUntil: null,
  },
});

const bookingAssessment = {
  ...testFlightAssessment,
  source: {
    ownerUserId: "user_1",
    accountId: "account_travel",
    provider: "outlook" as const,
    messageId: "message_booking_9",
    providerMessageId: "provider-booking-9",
    threadId: "thread_booking",
    sender: { name: "Example Air", email: "updates@example-air.com" },
    subject: "Your departure time changed",
    receivedAt: "2026-08-19T17:00:00.000Z",
    sourceUrl: "https://orca.example/mail/accounts/account_travel/messages/message_booking_9",
  },
  provenance: { ...testFlightAssessment.provenance, trigger: "sync" as const },
  eventKind: "travel_or_booking_change" as const,
  importance: "high" as const,
  relevance: "matched" as const,
  reasonCodes: ["itinerary_changed" as const],
  title: "Your departure moved to 18:40",
  summary: "Example Air moved the booked departure by 40 minutes.",
  whyThisMatters: "The new departure changes the planned airport arrival time.",
  suggestedNextStep: "Review the updated itinerary in the original message.",
  deduplicationKey: "sha256:1f1d8defb1b9e658a3db78d858948eb3989138e0ce4085c05bd80f396e1733fe",
  evaluatedAt: "2026-08-19T17:00:01.000Z",
};

export const agentContractUpdatedFixture = propagatedAgentEventSchema.parse({
  ...bookingAssessment,
  id: "agent_event_booking",
  lifecycle: {
    state: "new",
    lastTransition: "updated",
    revision: 2,
    createdAt: "2026-08-19T17:00:01.000Z",
    updatedAt: "2026-08-19T17:02:00.000Z",
    lastTransitionAt: "2026-08-19T17:02:00.000Z",
    seenAt: null,
    snoozedUntil: null,
  },
});

export const agentContractRetractedFixture = propagatedAgentEventSchema.parse({
  ...bookingAssessment,
  id: "agent_event_booking",
  lifecycle: {
    state: "retracted",
    lastTransition: "retracted",
    revision: 3,
    createdAt: "2026-08-19T17:00:01.000Z",
    updatedAt: "2026-08-19T17:04:00.000Z",
    lastTransitionAt: "2026-08-19T17:04:00.000Z",
    seenAt: null,
    snoozedUntil: null,
  },
});

export const agentContractFixtureSet = Object.freeze({
  propagated: agentContractPropagatedAssessmentFixture,
  suppressedBulk: agentContractBulkSuppressedFixture,
  duplicateDelivery: agentContractDuplicateDeliveryFixture,
  falsePositive: agentContractFalsePositiveFixture,
  updated: agentContractUpdatedFixture,
  retracted: agentContractRetractedFixture,
});
