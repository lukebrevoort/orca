import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  agentPropagationAssessmentSchema,
  conservativeAgentPropagationPolicy,
  inboxResponseSchema,
  orcaMcpAuthorizationContextSchema,
  orcaMcpMaximumAccessTokenLifetimeSeconds,
  orcaMcpReadOnlyTools,
  propagatedAgentEventSchema,
  updateAgentEventLifecycleSchema,
} from "./index.ts";
import { accountFixture, inboxFixture } from "./fixtures.ts";

const propagatedAssessment = {
  source: {
    ownerUserId: "user_1",
    accountId: "account_1",
    provider: "gmail" as const,
    messageId: "message_testflight",
    threadId: "thread_testflight",
    sender: { name: "TestFlight", email: "no_reply@email.apple.com" },
    subject: "Orca 2.1 is ready to test",
    receivedAt: "2026-08-19T16:00:00.000Z",
    sourceUrl: "http://localhost:5173/thread/thread_testflight?accountId=account_1",
  },
  provenance: {
    trigger: "push" as const,
    policyVersion: "m6-v0",
    agentId: "orca-deterministic-propagator",
    agentVersion: "0.1.0",
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
  deduplicationKey: "account_1:message_testflight:release_available:m6-v0",
  evaluatedAt: "2026-08-19T16:00:01.000Z",
};

describe("M6 agent contract", () => {
  test("keeps propagation separate from Human Signal, attention, and provider state", () => {
    const parsed = agentPropagationAssessmentSchema.parse(propagatedAssessment);

    assert.equal(parsed.destination, "timeline");
    assert.equal(parsed.humanClassification?.classification, "automated_or_bulk");
    assert.equal("attentionBehavior" in parsed, false);
    assert.equal("providerLabel" in parsed, false);
    assert.equal("providerAction" in parsed, false);
  });

  test("represents conservative suppression without inventing a timeline event", () => {
    const suppressed = agentPropagationAssessmentSchema.parse({
      ...propagatedAssessment,
      eventKind: "marketing_or_newsletter",
      importance: "low",
      relevance: "not_matched",
      destination: "none",
      reasonCodes: ["routine_bulk_content"],
      title: "Routine product newsletter",
      summary: "This message remains available in Tideline.",
      whyThisMatters: "Orca found no consequence that should interrupt the base timeline.",
      suggestedNextStep: null,
      deduplicationKey: "account_1:message_newsletter:marketing_or_newsletter:m6-v0",
    });

    assert.equal(suppressed.destination, "none");
    assert.equal(conservativeAgentPropagationPolicy.marketingOrNewsletter, false);
    assert.equal(conservativeAgentPropagationPolicy.releaseAvailable, true);
  });

  test("validates reversible lifecycle states and snooze requirements", () => {
    const event = propagatedAgentEventSchema.parse({
      ...propagatedAssessment,
      id: "agent_event_1",
      lifecycle: {
        state: "false_positive",
        revision: 2,
        createdAt: "2026-08-19T16:00:01.000Z",
        updatedAt: "2026-08-19T16:05:00.000Z",
        seenAt: "2026-08-19T16:04:00.000Z",
        snoozedUntil: null,
      },
    });

    assert.equal(event.lifecycle.state, "false_positive");
    assert.deepEqual(updateAgentEventLifecycleSchema.parse({ action: "restore" }), { action: "restore" });
    assert.equal(propagatedAgentEventSchema.safeParse({
      ...event,
      lifecycle: { ...event.lifecycle, state: "snoozed", snoozedUntil: null },
    }).success, false);
  });

  test("uses stable account-scoped deduplication across retries", () => {
    const first = agentPropagationAssessmentSchema.parse(propagatedAssessment);
    const retry = agentPropagationAssessmentSchema.parse({
      ...propagatedAssessment,
      provenance: { ...propagatedAssessment.provenance, trigger: "sync" },
      evaluatedAt: "2026-08-19T16:01:00.000Z",
    });

    assert.equal(first.source.accountId, retry.source.accountId);
    assert.equal(first.deduplicationKey, retry.deduplicationKey);
  });

  test("binds read-only MCP access to issuer, resource, accounts, scopes, and a short lifetime", () => {
    const context = orcaMcpAuthorizationContextSchema.parse({
      userId: "user_1",
      accountIds: ["account_1"],
      issuer: "https://auth.orca.example",
      resource: "https://app.orca.example/mcp",
      scopes: ["orca:mail.metadata:read", "orca:agent-events:read"],
      issuedAt: "2026-08-19T16:00:00.000Z",
      expiresAt: "2026-08-19T16:10:00.000Z",
    });

    assert.equal(context.accountIds.length, 1);
    assert.equal(orcaMcpMaximumAccessTokenLifetimeSeconds, 600);
    assert.equal(orcaMcpAuthorizationContextSchema.safeParse({
      ...context,
      expiresAt: "2026-08-19T16:10:01.000Z",
    }).success, false);
    assert.equal(orcaMcpReadOnlyTools.every((tool) =>
      tool.annotations.readOnlyHint && !tool.annotations.destructiveHint && !tool.annotations.openWorldHint
    ), true);
    assert.equal(orcaMcpReadOnlyTools.some((tool) => /send|draft|archive|delete|label/.test(tool.name)), false);
  });

  test("preserves the pre-M6 inbox response contract", () => {
    const legacy = {
      accounts: [accountFixture],
      messages: inboxFixture,
      counts: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 },
      nextCursor: null,
    };

    assert.deepEqual(inboxResponseSchema.parse(legacy), legacy);
  });
});
