import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  m5FixtureExpectedClassifications,
  m5FixtureReasonCodeCases,
  m5NormalizedFixtureMessages,
} from "@orca/shared";
import type { HumanClassificationEvidence } from "@orca/shared";

import { gmailMessageFixture } from "../providers/gmail/fixtures/message.fixture.ts";
import { normalizeGmailMessage } from "../providers/gmail/normalizer.ts";
import { outlookMessageFixture } from "../providers/outlook/fixtures/message.fixture.ts";
import { normalizeOutlookMessage } from "../providers/outlook/normalizer.ts";
import { classifyHumanSignal, humanClassifierVersion } from "./human-signal.ts";

function evidence(overrides: Partial<HumanClassificationEvidence> = {}): HumanClassificationEvidence {
  return {
    sender: { name: "Maya", email: "maya@example.com" },
    recipients: [{ name: "Luke", email: "luke@example.com" }],
    recipientRelationship: "direct",
    reply: { hasInReplyTo: false, referenceCount: 0 },
    headerSignals: [],
    providerSignals: [],
    ...overrides,
  };
}

describe("Human Signal classifier", () => {
  test("classifies direct correspondence and replies as a likely-human estimate", () => {
    assert.deepEqual(
      classifyHumanSignal(evidence({ reply: { hasInReplyTo: true, referenceCount: 1 } })),
      {
        classification: "likely_human",
        score: 9,
        reasonCodes: ["direct_recipient", "reply_context"],
        classifierVersion: humanClassifierVersion,
      },
    );
  });

  test("classifies no-reply transactional and list mail without reading message content", () => {
    const automated = classifyHumanSignal(evidence({
      sender: { name: "Billing", email: "no-reply@billing.example" },
      recipientRelationship: "not_direct",
      providerSignals: ["transactional_category"],
    }));
    assert.equal(automated.classification, "automated_or_bulk");
    assert.equal(automated.score, 0);
    assert.deepEqual(automated.reasonCodes, ["sender_no_reply_pattern", "provider_transactional_signal"]);

    const directTransactional = classifyHumanSignal(evidence({
      sender: { name: "Billing", email: "no-reply@billing.example" },
      providerSignals: ["transactional_category"],
    }));
    assert.equal(directTransactional.classification, "automated_or_bulk");
    assert.equal(directTransactional.score, 0);

    const newsletter = classifyHumanSignal(evidence({
      recipientRelationship: "not_direct",
      headerSignals: ["list_id", "list_unsubscribe"],
    }));
    assert.equal(newsletter.classification, "automated_or_bulk");
    assert.equal(newsletter.score, 0);
    assert.deepEqual(newsletter.reasonCodes, ["list_id_header", "list_unsubscribe_header"]);
  });

  test("returns uncertain for conflicting evidence and unclassified for missing or unknown input", () => {
    const conflicting = classifyHumanSignal(evidence({
      reply: { hasInReplyTo: true, referenceCount: 1 },
      headerSignals: ["list_id"],
    }));
    assert.equal(conflicting.classification, "uncertain");
    assert.equal(conflicting.score, 6);
    assert.deepEqual(conflicting.reasonCodes, ["direct_recipient", "reply_context", "list_id_header", "conflicting_evidence"]);

    assert.deepEqual(classifyHumanSignal(null), {
      classification: "unclassified",
      score: null,
      reasonCodes: ["insufficient_evidence"],
      classifierVersion: humanClassifierVersion,
    });

    assert.deepEqual(classifyHumanSignal(evidence({
      recipients: [],
      recipientRelationship: "unknown",
    })), {
      classification: "unclassified",
      score: null,
      reasonCodes: ["insufficient_evidence"],
      classifierVersion: humanClassifierVersion,
    });
  });

  test("is deterministic for the same provider-neutral evidence", () => {
    const normalized = evidence({
      recipientRelationship: "not_direct",
      headerSignals: ["auto_submitted"],
      providerSignals: ["automated_category"],
    });
    assert.deepEqual(classifyHumanSignal(normalized), classifyHumanSignal(structuredClone(normalized)));
  });

  test("runs Gmail and Outlook normalized fixtures through the same deterministic rules", () => {
    const gmail = normalizeGmailMessage({
      ...gmailMessageFixture,
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      payload: {
        ...gmailMessageFixture.payload,
        headers: [
          { name: "From", value: "No Reply <no-reply@example.com>" },
          { name: "To", value: "Luke <luke@example.com>" },
          { name: "List-Id", value: "<digest.example>" },
        ],
      },
    }, { accountId: "gmail-account", accountEmail: "luke@example.com" });
    const outlook = normalizeOutlookMessage({
      ...outlookMessageFixture,
      from: { emailAddress: { name: "No Reply", address: "no-reply@example.com" } },
      toRecipients: [{ emailAddress: { name: "Luke", address: "luke@example.com" } }],
      ccRecipients: [],
      internetMessageHeaders: [{ name: "List-Id", value: "<digest.example>" }],
      categories: ["Promotions"],
    }, { accountId: "outlook-account", accountEmail: "luke@example.com" });

    assert.deepEqual(
      classifyHumanSignal(gmail.classificationEvidence),
      classifyHumanSignal(outlook.classificationEvidence),
    );
  });

  test("covers every M5 state, provider, account, and mixed thread", () => {
    for (const message of m5NormalizedFixtureMessages) {
      const expected = m5FixtureExpectedClassifications[message.id];
      assert.ok(expected, `Missing expected M5 classification for ${message.id}`);
      assert.deepEqual(classifyHumanSignal(message.classificationEvidence), expected, message.id);
      assert.equal(message.provider, message.raw.provider);
      assert.equal(message.accountId, message.raw.accountId);
    }

    const mixedThread = m5NormalizedFixtureMessages.filter((message) => message.threadId.endsWith("mixed-thread"));
    assert.equal(mixedThread.length, 2);
    assert.deepEqual(
      mixedThread.map((message) => m5FixtureExpectedClassifications[message.id]?.classification),
      ["automated_or_bulk", "likely_human"],
    );
    assert.deepEqual(
      [...new Set(m5NormalizedFixtureMessages.map((message) => message.provider))],
      ["gmail", "outlook"],
    );
  });

  test("covers every M5 precedence and auto-response header reason branch", () => {
    const signalNames = new Set<string>();
    const reasonCodes = new Set<string>();

    for (const fixture of m5FixtureReasonCodeCases) {
      assert.deepEqual(classifyHumanSignal(fixture.evidence), fixture.expected, fixture.id);
      for (const signal of fixture.evidence.headerSignals) signalNames.add(signal);
      for (const reasonCode of fixture.expected.reasonCodes) reasonCodes.add(reasonCode);
    }

    assert.deepEqual([...signalNames].sort(), ["auto_submitted", "precedence_bulk", "precedence_list", "x_auto_response_suppress"]);
    assert.deepEqual([...reasonCodes].sort(), ["auto_submitted_header", "bulk_precedence_header", "insufficient_evidence"]);
  });
});
