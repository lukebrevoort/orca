import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

import { humanClassificationEvidenceSchema } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { emails } from "../db/schema.ts";
import {
  automaticClassificationColumns,
  classifyHumanSignal,
  humanClassifierVersion,
} from "./human-signal.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export type HumanClassificationBackfillResult = {
  accountId: string;
  processed: number;
  hasMore: boolean;
};

/**
 * Reclassify a bounded, account-scoped batch from stored normalized evidence.
 * It intentionally performs no provider or network access, so a partially
 * synced account can be processed safely and repeated after a rule-version
 * change.
 */
export function backfillHumanClassifications(
  db: Database,
  input: { accountId: string; limit?: number; now?: Date },
): HumanClassificationBackfillResult {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = db
    .select({
      id: emails.id,
      humanClassificationEvidence: emails.humanClassificationEvidence,
    })
    .from(emails)
    .where(and(
      eq(emails.accountId, input.accountId),
      or(isNull(emails.humanClassifierVersion), ne(emails.humanClassifierVersion, humanClassifierVersion)),
    ))
    .orderBy(asc(emails.receivedAt), asc(emails.id))
    .limit(limit + 1)
    .all();

  const batch = rows.slice(0, limit);
  const updatedAt = input.now ?? new Date();
  for (const row of batch) {
    const classification = classifyHumanSignal(parseStoredEvidence(row.humanClassificationEvidence));
    db
      .update(emails)
      .set({
        ...automaticClassificationColumns(classification),
        updatedAt,
      })
      .where(and(eq(emails.id, row.id), eq(emails.accountId, input.accountId)))
      .run();
  }

  return {
    accountId: input.accountId,
    processed: batch.length,
    hasMore: rows.length > limit,
  };
}

function parseStoredEvidence(value: string | null) {
  if (!value) return undefined;
  try {
    const result = humanClassificationEvidenceSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
