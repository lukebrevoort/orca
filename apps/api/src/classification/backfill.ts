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

export type HumanClassificationBackfillCandidate = {
  id: string;
  humanClassificationEvidence: string | null;
  humanClassifierVersion: string | null;
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
      humanClassifierVersion: emails.humanClassifierVersion,
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
  let processed = 0;
  let skippedChangedRow = false;
  for (const row of batch) {
    if (applyBackfillClassification(db, { accountId: input.accountId, row, updatedAt })) {
      processed += 1;
    } else {
      skippedChangedRow = true;
    }
  }

  return {
    accountId: input.accountId,
    processed,
    hasMore: rows.length > limit || skippedChangedRow,
  };
}

/**
 * Persist an automatic result only if the evidence and rule version selected
 * for this batch are still current. A sync may update either in another
 * process between selecting the batch and this write.
 */
export function applyBackfillClassification(
  db: Database,
  input: { accountId: string; row: HumanClassificationBackfillCandidate; updatedAt: Date },
) {
  const classification = classifyHumanSignal(parseStoredEvidence(input.row.humanClassificationEvidence));
  const unchangedEvidence = input.row.humanClassificationEvidence === null
    ? isNull(emails.humanClassificationEvidence)
    : eq(emails.humanClassificationEvidence, input.row.humanClassificationEvidence);
  const unchangedVersion = input.row.humanClassifierVersion === null
    ? isNull(emails.humanClassifierVersion)
    : eq(emails.humanClassifierVersion, input.row.humanClassifierVersion);
  const updated = db
    .update(emails)
    .set({
      ...automaticClassificationColumns(classification),
      updatedAt: input.updatedAt,
    })
    .where(and(
      eq(emails.id, input.row.id),
      eq(emails.accountId, input.accountId),
      unchangedEvidence,
      unchangedVersion,
    ))
    .returning({ id: emails.id })
    .all();

  return updated.length === 1;
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
