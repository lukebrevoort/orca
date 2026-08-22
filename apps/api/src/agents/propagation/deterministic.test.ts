import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  conservativeAgentPropagationPolicy,
  type HumanClassificationAssessment,
  type HumanClassificationResult,
  type NormalizedMessage,
} from "@orca/shared";

import { classifyHumanSignal } from "../../classification/human-signal.ts";
import { normalizeGmailMessage } from "../../providers/gmail/normalizer.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { normalizeOutlookMessage } from "../../providers/outlook/normalizer.ts";
import type { GraphMessage } from "../../providers/outlook/types.ts";
import {
  buildAgentEventDeduplicationKey,
  evaluateDeterministicPropagation,
} from "./deterministic.ts";
import { deterministicPropagationFixtures } from "./fixtures.ts";

describe("deterministic agent propagation", () => {
  for (const fixture of deterministicPropagationFixtures) {
    test(`${fixture.name} produces ${fixture.expectedDestination}`, () => {
      const message = fixture.provider === "gmail"
        ? normalizeGmailMessage(fixture.message as GmailMessage, {
            accountId: "account_1",
            accountEmail: "luke@example.com",
          })
        : normalizeOutlookMessage(fixture.message as GraphMessage, {
            accountId: "account_1",
            accountEmail: "luke@example.com",
          });
      const humanClassification = automaticResult(classifyHumanSignal(message.classificationEvidence));
      const assessment = evaluateDeterministicPropagation({
        ownerUserId: "user_1",
        message,
        humanClassification,
        trigger: "sync",
        policy: conservativeAgentPropagationPolicy,
        sourceUrl: `http://localhost:5173/?accountId=account_1&thread=${encodeURIComponent(message.threadId)}`,
      }, new Date("2026-08-19T16:00:01.000Z"));

      assert.equal(assessment.source.provider, fixture.provider);
      assert.equal(assessment.source.accountId, "account_1");
      assert.equal(assessment.eventKind, fixture.expectedEventKind);
      assert.equal(assessment.destination, fixture.expectedDestination);
      assert.equal(assessment.provenance.executionMode, "deterministic");
      assert.equal("attentionBehavior" in assessment, false);
      assert.equal("providerAction" in assessment, false);
    });
  }

  test("uses the canonical account-scoped SHA-256 idempotency tuple", () => {
    const first = buildAgentEventDeduplicationKey({
      ownerUserId: "user_1",
      accountId: "account_1",
      provider: "gmail",
      providerMessageId: "message_1",
      eventKind: "release_available",
    });
    const retry = buildAgentEventDeduplicationKey({
      ownerUserId: "user_1",
      accountId: "account_1",
      provider: "gmail",
      providerMessageId: "message_1",
      eventKind: "release_available",
    });
    const otherAccount = buildAgentEventDeduplicationKey({
      ownerUserId: "user_1",
      accountId: "account_2",
      provider: "gmail",
      providerMessageId: "message_1",
      eventKind: "release_available",
    });

    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.equal(retry, first);
    assert.notEqual(otherAccount, first);
  });

  test("applies a local category policy without changing Human Signal", () => {
    const fixture = deterministicPropagationFixtures.find((item) => item.expectedEventKind === "security_or_account_alert");
    assert.ok(fixture && fixture.provider === "gmail");
    const message = normalizeGmailMessage(fixture.message as GmailMessage, {
      accountId: "account_1",
      accountEmail: "luke@example.com",
    });
    const humanClassification = automaticResult(classifyHumanSignal(message.classificationEvidence));
    const assessment = evaluateDeterministicPropagation({
      ownerUserId: "user_1",
      message,
      humanClassification,
      trigger: "push",
      policy: { ...conservativeAgentPropagationPolicy, securityOrAccountAlert: false },
      sourceUrl: "http://localhost:5173/?thread=gmail-security-thread",
    }, new Date("2026-08-19T16:00:01.000Z"));

    assert.equal(assessment.destination, "none");
    assert.deepEqual(assessment.reasonCodes, ["user_policy_disabled"]);
    assert.equal(
      assessment.humanClassification?.classification,
      humanClassification.effective.classification,
    );
    assert.equal(assessment.humanClassification?.score, humanClassification.effective.score);
  });

  test("derives bounded event copy without copying the message body", () => {
    const message = normalizeGmailMessage(
      deterministicPropagationFixtures[0]?.message as GmailMessage,
      { accountId: "account_1", accountEmail: "luke@example.com" },
    ) as NormalizedMessage;
    message.bodyText = `private-body-marker ${"x".repeat(2_000)}`;
    const humanClassification = automaticResult(classifyHumanSignal(message.classificationEvidence));
    const assessment = evaluateDeterministicPropagation({
      ownerUserId: "user_1",
      message,
      humanClassification,
      trigger: "sync",
      policy: conservativeAgentPropagationPolicy,
      sourceUrl: "http://localhost:5173/?thread=gmail-testflight-thread",
    });

    assert.ok(assessment.title.length <= 160);
    assert.ok(assessment.summary.length <= 500);
    assert.equal(JSON.stringify(assessment).includes("private-body-marker"), false);
  });
});

function automaticResult(assessment: HumanClassificationAssessment): HumanClassificationResult {
  return {
    automatic: assessment,
    effective: { ...assessment, source: "automatic_heuristic", userOverride: null },
    userOverride: null,
  };
}
