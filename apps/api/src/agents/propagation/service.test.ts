import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  conservativeAgentPropagationPolicy,
  propagatedAgentEventSchema,
  type AgentPropagationAssessment,
  type HumanClassificationResult,
  type NormalizedMessage,
  type PropagatedAgentEvent,
} from "@orca/shared";

import type { AgentPropagationEvaluator } from "../interfaces.ts";
import { DeterministicPropagationEvaluator } from "./deterministic.ts";
import { deterministicPropagationFixtures } from "./fixtures.ts";
import { normalizeGmailMessage } from "../../providers/gmail/normalizer.ts";
import type { GmailMessage } from "../../providers/gmail/types.ts";
import { classifyHumanSignal } from "../../classification/human-signal.ts";
import { propagateNormalizedMessagesSafely, type DiagnosticAgentEventStore } from "./service.ts";

describe("post-normalization propagation service", () => {
  test("isolates evaluator and storage failures and logs only safe metadata", async () => {
    const messages = [messageAt(0), messageAt(2)];
    messages[0]!.bodyText = "BODY_SECRET_VALUE";
    const logs: unknown[][] = [];
    const evaluator = new DeterministicPropagationEvaluator();
    let writes = 0;
    const store: DiagnosticAgentEventStore = {
      async upsert(assessment) {
        writes += 1;
        if (writes === 1) throw new Error("STORAGE_SECRET_VALUE");
        return eventFrom(assessment);
      },
    };

    const result = await propagateNormalizedMessagesSafely({
      ownerUserId: "user_1",
      messages,
      humanClassificationFor: automaticClassification,
      trigger: "push",
      policy: conservativeAgentPropagationPolicy,
      evaluator,
      store,
      sourceUrlFor: (message) => `http://localhost:5173/?thread=${encodeURIComponent(message.threadId)}`,
      logger: {
        info(...args) { logs.push(args); },
        warn(...args) { logs.push(args); },
        error(...args) { logs.push(args); },
      },
    });

    assert.deepEqual(result, {
      enabled: true,
      evaluated: 2,
      propagated: 1,
      suppressed: 0,
      failed: 1,
      writes: { created: 0, updated: 0, duplicate: 0, persisted: 1 },
    });
    const serializedLogs = JSON.stringify(logs);
    assert.equal(serializedLogs.includes("BODY_SECRET_VALUE"), false);
    assert.equal(serializedLogs.includes("STORAGE_SECRET_VALUE"), false);
    assert.equal(serializedLogs.includes("providerMessageId"), true);
  });

  test("suppresses matching sender/category mutes before persistence", async () => {
    const message = messageAt(0);
    let persisted = false;
    const result = await propagateNormalizedMessagesSafely({
      ownerUserId: "user_1",
      messages: [message],
      humanClassificationFor: automaticClassification,
      trigger: "sync",
      policy: conservativeAgentPropagationPolicy,
      evaluator: new DeterministicPropagationEvaluator(),
      store: {
        async upsert(assessment) {
          persisted = true;
          return eventFrom(assessment);
        },
      },
      sourceUrlFor: () => "http://localhost:5173/?thread=testflight",
      muteFor: () => ({ reasonCode: "sender_muted" }),
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(persisted, false);
    assert.equal(result.suppressed, 1);
    assert.equal(result.failed, 0);
  });

  test("reports created, updated, and duplicate outcomes for diagnostics", async () => {
    const message = messageAt(0);
    const outcomes = ["created", "updated", "duplicate"] as const;
    let call = 0;
    const store: DiagnosticAgentEventStore = {
      async upsert(assessment) { return eventFrom(assessment); },
      async upsertWithResult(assessment) {
        return { event: eventFrom(assessment), outcome: outcomes[call++]! };
      },
    };
    const totals = { created: 0, updated: 0, duplicate: 0 };

    for (let index = 0; index < 3; index += 1) {
      const result = await propagateNormalizedMessagesSafely({
        ownerUserId: "user_1",
        messages: [message],
        humanClassificationFor: automaticClassification,
        trigger: "push",
        policy: conservativeAgentPropagationPolicy,
        evaluator: new DeterministicPropagationEvaluator(),
        store,
        sourceUrlFor: () => "http://localhost:5173/?thread=testflight",
        logger: { info() {}, warn() {}, error() {} },
      });
      totals.created += result.writes.created;
      totals.updated += result.writes.updated;
      totals.duplicate += result.writes.duplicate;
    }

    assert.deepEqual(totals, { created: 1, updated: 1, duplicate: 1 });
  });

  test("isolates evaluator failures from subsequent messages", async () => {
    const base = new DeterministicPropagationEvaluator();
    let calls = 0;
    const evaluator: AgentPropagationEvaluator = {
      ...base,
      id: base.id,
      version: base.version,
      executionMode: base.executionMode,
      async evaluate(input) {
        calls += 1;
        if (calls === 1) throw new Error("bad evaluation");
        return base.evaluate(input);
      },
    };
    let persisted = 0;
    const result = await propagateNormalizedMessagesSafely({
      ownerUserId: "user_1",
      messages: [messageAt(0), messageAt(2)],
      humanClassificationFor: automaticClassification,
      trigger: "sync",
      policy: conservativeAgentPropagationPolicy,
      evaluator,
      store: {
        async upsert(assessment) {
          persisted += 1;
          return eventFrom(assessment);
        },
      },
      sourceUrlFor: () => "http://localhost:5173/?thread=event",
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.failed, 1);
    assert.equal(persisted, 1);
  });
});

function messageAt(index: number): NormalizedMessage {
  const fixture = deterministicPropagationFixtures[index];
  assert.ok(fixture?.provider === "gmail");
  return normalizeGmailMessage(fixture.message as GmailMessage, {
    accountId: "account_1",
    accountEmail: "luke@example.com",
  });
}

function automaticClassification(message: NormalizedMessage): HumanClassificationResult {
  const automatic = classifyHumanSignal(message.classificationEvidence);
  return {
    automatic,
    effective: { ...automatic, source: "automatic_heuristic", userOverride: null },
    userOverride: null,
  };
}

function eventFrom(assessment: AgentPropagationAssessment): PropagatedAgentEvent {
  const timestamp = assessment.evaluatedAt;
  return propagatedAgentEventSchema.parse({
    ...assessment,
    id: `event:${assessment.deduplicationKey}`,
    lifecycle: {
      state: "new",
      lastTransition: "created",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastTransitionAt: timestamp,
      seenAt: null,
      snoozedUntil: null,
    },
  });
}
