import {
  senderAttentionBatchResultSchema,
  type AttentionBehavior,
  type BatchSenderAttentionChange,
  type ResolvedSenderAttention,
  type SenderAttentionBatchResult,
} from "@orca/shared";

export type SenderAttentionBatchAdapter = {
  write(address: string, behavior: AttentionBehavior): void | Promise<void>;
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
    let writeError: SenderAttentionChangeError | null = null;
    try {
      await adapter.write(address, input.behavior);
    } catch (error) {
      writeError = error instanceof SenderAttentionChangeError
        ? error
        : new SenderAttentionChangeError(
          "temporarily_unavailable",
          "This sender could not be updated right now",
          true,
        );
    }

    let resolution: ResolvedSenderAttention | null = null;
    let resolutionFailed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        resolution = await adapter.resolve(address);
        resolutionFailed = false;
        break;
      } catch {
        resolutionFailed = true;
      }
    }

    // A canonical read is the source of truth even if the write threw after
    // persistence or the first read failed. Desired canonical state is success.
    if (resolution?.behavior === input.behavior) {
      outcomes.push({ status: "succeeded", address, resolution });
      continue;
    }

    if (writeError) {
      outcomes.push({
        status: "failed",
        address,
        retryable: writeError.retryable,
        error: { code: writeError.code, message: writeError.message },
        resolution,
      });
      continue;
    }

    const unresolved = resolutionFailed || !resolution;
    outcomes.push({
      status: "failed",
      address,
      retryable: unresolved,
      error: unresolved
        ? { code: "temporarily_unavailable", message: "The saved sender state could not be verified right now" }
        : { code: "conflict", message: "The saved sender state did not match the requested behavior" },
      resolution,
    });
  }

  return senderAttentionBatchResultSchema.parse({ behavior: input.behavior, outcomes });
}
