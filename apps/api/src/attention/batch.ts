import {
  senderAttentionBatchResultSchema,
  type AttentionBehavior,
  type BatchSenderAttentionChange,
  type ResolvedSenderAttention,
  type SenderAttentionBatchResult,
} from "@orca/shared";

export type SenderAttentionBatchAdapter = {
  apply(address: string, behavior: AttentionBehavior): ResolvedSenderAttention | Promise<ResolvedSenderAttention>;
  resolve(address: string): ResolvedSenderAttention | null | Promise<ResolvedSenderAttention | null>;
};

export class SenderAttentionChangeError extends Error {
  constructor(
    readonly code: "conflict" | "temporarily_unavailable" | "validation_error",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Applies each sender independently and always returns the canonical resolution
 * for successes and, when readable, failures. This is intentionally a per-item
 * contract: one unavailable sender cannot make already-saved rules look stale.
 */
export async function applySenderAttentionBatch(
  input: BatchSenderAttentionChange,
  adapter: SenderAttentionBatchAdapter,
): Promise<SenderAttentionBatchResult> {
  const outcomes: SenderAttentionBatchResult["outcomes"] = [];

  for (const address of input.addresses) {
    try {
      outcomes.push({
        status: "succeeded",
        address,
        resolution: await adapter.apply(address, input.behavior),
      });
    } catch (error) {
      const expected = error instanceof SenderAttentionChangeError
        ? error
        : new SenderAttentionChangeError(
          "temporarily_unavailable",
          "This sender could not be updated right now",
          true,
        );
      let resolution: ResolvedSenderAttention | null = null;
      try {
        resolution = await adapter.resolve(address);
      } catch {
        // A missing canonical read is explicit in the wire result rather than
        // being guessed by the client.
      }
      outcomes.push({
        status: "failed",
        address,
        retryable: expected.retryable,
        error: { code: expected.code, message: expected.message },
        resolution,
      });
    }
  }

  return senderAttentionBatchResultSchema.parse({ behavior: input.behavior, outcomes });
}
