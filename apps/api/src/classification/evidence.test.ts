import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildHumanClassificationEvidence } from "./evidence.ts";
import { classifyHumanSignal, humanClassifierVersion } from "./human-signal.ts";

function build(headers: ReadonlyMap<string, string>) {
  return buildHumanClassificationEvidence({
    sender: { name: "Maya", email: "maya@example.com" },
    recipients: [{ name: "Luke", email: "luke@example.com" }],
    accountEmail: "luke@example.com",
    headers,
    providerSignals: [],
  });
}

describe("Human Signal evidence", () => {
  test("does not mistake Auto-Submitted: no or X-Auto-Response-Suppress for sender automation", () => {
    const evidence = build(new Map([
      ["auto-submitted", "no"],
      ["x-auto-response-suppress", "All"],
    ]));

    assert.deepEqual(evidence.headerSignals, []);
    assert.deepEqual(classifyHumanSignal(evidence), {
      classification: "likely_human",
      score: 7,
      reasonCodes: ["direct_recipient"],
      classifierVersion: humanClassifierVersion,
    });
    assert.deepEqual(classifyHumanSignal({ ...evidence, headerSignals: ["x_auto_response_suppress"] }), {
      classification: "likely_human",
      score: 7,
      reasonCodes: ["direct_recipient"],
      classifierVersion: humanClassifierVersion,
    });
  });

  test("keeps actual automatic-submission declarations as explainable evidence", () => {
    assert.deepEqual(build(new Map([["auto-submitted", "auto-generated"]])).headerSignals, ["auto_submitted"]);
  });
});
