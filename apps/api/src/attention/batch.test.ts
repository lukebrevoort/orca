import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttentionBehavior, ResolvedSenderAttention, SenderAttentionTarget } from "@orca/shared";

import { applySenderAttentionBatch, SenderAttentionChangeError } from "./batch.ts";

function resolution(behavior: AttentionBehavior): ResolvedSenderAttention {
  return { behavior, rule: null };
}

const mayaA = { accountId: "account-a", address: "maya@example.com" };
const mayaB = { accountId: "account-b", address: "maya@example.com" };
const jordanB = { accountId: "account-b", address: "jordan@example.com" };
const targetKey = (target: SenderAttentionTarget) => JSON.stringify([target.accountId, target.address]);

describe("sender attention batch", () => {
  test("returns canonical success for every sender", async () => {
    const canonical = new Map<string, ResolvedSenderAttention>();
    const result = await applySenderAttentionBatch(
      { targets: [mayaA, mayaB], behavior: "quiet" },
      {
        write: (targets, behavior) => targets.forEach((target) => canonical.set(targetKey(target), resolution(behavior))),
        resolve: (target) => canonical.get(targetKey(target)) ?? resolution("normal"),
      },
    );

    assert.deepEqual(result.outcomes.map((outcome) => [outcome.target.accountId, outcome.target.address, outcome.status]), [
      ["account-a", "maya@example.com", "succeeded"],
      ["account-b", "maya@example.com", "succeeded"],
    ]);
  });

  test("keeps canonical successes explicit and retries only the unresolved exact target", async () => {
    let writeAttempts = 0;
    const canonical = new Map<string, ResolvedSenderAttention>([[targetKey(mayaA), resolution("quiet")]]);
    const adapter = {
      write(targets: readonly SenderAttentionTarget[], behavior: AttentionBehavior) {
        if (writeAttempts++ === 0) throw new Error("database busy");
        targets.forEach((target) => canonical.set(targetKey(target), resolution(behavior)));
      },
      resolve: (target: SenderAttentionTarget) => canonical.get(targetKey(target)) ?? resolution("normal"),
    };
    const first = await applySenderAttentionBatch(
      { targets: [mayaA, jordanB], behavior: "quiet" },
      adapter,
    );

    assert.equal(first.outcomes[0]?.status, "succeeded");
    assert.deepEqual(first.outcomes[1], {
      status: "failed",
      target: jordanB,
      retryable: true,
      error: { code: "temporarily_unavailable", message: "These senders could not be updated right now" },
      resolution: { behavior: "normal", rule: null },
    });

    const retry = await applySenderAttentionBatch(
      { targets: [jordanB], behavior: "quiet" },
      adapter,
    );
    assert.deepEqual(retry.outcomes, [{
      status: "succeeded",
      target: jordanB,
      resolution: { behavior: "quiet", rule: null },
    }]);
  });

  test("marks permanent failures as non-retryable without losing canonical state", async () => {
    const result = await applySenderAttentionBatch(
      { targets: [mayaA], behavior: "hidden" },
      {
        write() { throw new SenderAttentionChangeError("conflict", "This sender rule conflicts", false); },
        resolve: () => resolution("focus"),
      },
    );

    assert.deepEqual(result.outcomes[0], {
      status: "failed",
      target: mayaA,
      retryable: false,
      error: { code: "conflict", message: "This sender rule conflicts" },
      resolution: { behavior: "focus", rule: null },
    });
  });

  test("reports success when fallback resolution proves the requested state persisted", async () => {
    let canonical = resolution("normal");
    let resolutionAttempts = 0;
    const result = await applySenderAttentionBatch(
      { targets: [mayaA], behavior: "quiet" },
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
      target: mayaA,
      resolution: { behavior: "quiet", rule: null },
    }]);
  });
});
