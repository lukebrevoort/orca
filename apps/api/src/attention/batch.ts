import {
  senderAttentionBatchResultSchema,
  type AttentionBehavior,
  type BatchSenderAttentionChange,
  type ResolvedSenderAttention,
  type SenderAttentionBatchResult,
  type SenderAttentionTarget,
} from "@orca/shared";

export type SenderAttentionBatchAdapter = {
  /** Persist every target as one atomic operation. */
  write(targets: readonly SenderAttentionTarget[], behavior: AttentionBehavior): void | Promise<void>;
  resolve(target: SenderAttentionTarget): ResolvedSenderAttention | null | Promise<ResolvedSenderAttention | null>;
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
 * Writes the complete batch atomically, then returns the canonical resolution
 * for every exact account/address target. A canonical desired state is treated
 * as success even when the write reported an error, making retries idempotent.
 */
export async function applySenderAttentionBatch(
  input: BatchSenderAttentionChange,
  adapter: SenderAttentionBatchAdapter,
): Promise<SenderAttentionBatchResult> {
  const outcomes: SenderAttentionBatchResult["outcomes"] = [];
  let writeError: SenderAttentionChangeError | null = null;

  try {
    await adapter.write(input.targets, input.behavior);
  } catch (error) {
    writeError = error instanceof SenderAttentionChangeError
      ? error
      : new SenderAttentionChangeError(
        "temporarily_unavailable",
        "These senders could not be updated right now",
        true,
      );
  }

  for (const target of input.targets) {
    let resolution: ResolvedSenderAttention | null = null;
    let resolutionFailed = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        resolution = await adapter.resolve(target);
        resolutionFailed = false;
        break;
      } catch {
        resolutionFailed = true;
      }
    }

    // A canonical read is the source of truth even if the write threw after
    // persistence or the first read failed. Desired canonical state is success.
    if (resolution?.behavior === input.behavior) {
      outcomes.push({ status: "succeeded", target, resolution });
      continue;
    }

    if (writeError) {
      outcomes.push({
        status: "failed",
        target,
        retryable: writeError.retryable,
        error: { code: writeError.code, message: writeError.message },
        resolution,
      });
      continue;
    }

    const unresolved = resolutionFailed || !resolution;
    outcomes.push({
      status: "failed",
      target,
      retryable: unresolved,
      error: unresolved
        ? { code: "temporarily_unavailable", message: "The saved sender state could not be verified right now" }
        : { code: "conflict", message: "The saved sender state did not match the requested behavior" },
      resolution,
    });
  }

  return senderAttentionBatchResultSchema.parse({ behavior: input.behavior, outcomes });
}
