import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttentionBehavior, ResolvedSenderAttention } from "@orca/shared";

import { applySenderAttentionBatch, SenderAttentionChangeError } from "./batch.ts";

function resolution(behavior: AttentionBehavior): ResolvedSenderAttention {
  return { behavior, rule: null };
}

describe("sender attention batch", () => {
  test("returns canonical success for every sender", async () => {
    const canonical = new Map<string, ResolvedSenderAttention>();
    const result = await applySenderAttentionBatch(
      { addresses: ["maya@example.com", "jordan@example.com"], behavior: "quiet" },
      {
        write: (address, behavior) => { canonical.set(address, resolution(behavior)); },
        resolve: (address) => canonical.get(address) ?? resolution("normal"),
      },
    );

    assert.deepEqual(result.outcomes.map((outcome) => [outcome.address, outcome.status]), [
      ["maya@example.com", "succeeded"],
      ["jordan@example.com", "succeeded"],
    ]);
  });

  test("keeps mixed failures explicit and retries only the requested sender", async () => {
    let jordanAttempts = 0;
    const canonical = new Map<string, ResolvedSenderAttention>();
    const adapter = {
      write(address: string, behavior: AttentionBehavior) {
        if (address === "jordan@example.com" && jordanAttempts++ === 0) throw new Error("database busy");
        canonical.set(address, resolution(behavior));
      },
      resolve: (address: string) => canonical.get(address) ?? resolution("normal"),
    };
    const first = await applySenderAttentionBatch(
      { addresses: ["maya@example.com", "jordan@example.com"], behavior: "quiet" },
      adapter,
    );

    assert.equal(first.outcomes[0]?.status, "succeeded");
    assert.deepEqual(first.outcomes[1], {
      status: "failed",
      address: "jordan@example.com",
      retryable: true,
      error: { code: "temporarily_unavailable", message: "This sender could not be updated right now" },
      resolution: { behavior: "normal", rule: null },
    });

    const retry = await applySenderAttentionBatch(
      { addresses: ["jordan@example.com"], behavior: "quiet" },
      adapter,
    );
    assert.deepEqual(retry.outcomes, [{
      status: "succeeded",
      address: "jordan@example.com",
      resolution: { behavior: "quiet", rule: null },
    }]);
  });

  test("marks permanent failures as non-retryable without losing canonical state", async () => {
    const result = await applySenderAttentionBatch(
      { addresses: ["maya@example.com"], behavior: "hidden" },
      {
        write() { throw new SenderAttentionChangeError("conflict", "This sender rule conflicts", false); },
        resolve: () => resolution("focus"),
      },
    );

    assert.deepEqual(result.outcomes[0], {
      status: "failed",
      address: "maya@example.com",
      retryable: false,
      error: { code: "conflict", message: "This sender rule conflicts" },
      resolution: { behavior: "focus", rule: null },
    });
  });

  test("reports success when fallback resolution proves the requested state persisted", async () => {
    let canonical = resolution("normal");
    let resolutionAttempts = 0;
    const result = await applySenderAttentionBatch(
      { addresses: ["maya@example.com"], behavior: "quiet" },
      {
        write(_address, behavior) {
          canonical = resolution(behavior);
        },
        resolve() {
          if (resolutionAttempts++ === 0) throw new Error("initial canonical read failed");
          return canonical;
        },
      },
    );

    assert.deepEqual(result.outcomes, [{
      status: "succeeded",
      address: "maya@example.com",
      resolution: { behavior: "quiet", rule: null },
    }]);
  });
});
