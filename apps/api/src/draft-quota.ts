import type { Database } from "bun:sqlite";

export const maxDraftsPerAccount = 200;
export const maxDraftBytesPerAccount = 200 * 1024 * 1024;

const contentColumns = {
  toRecipients: "to_recipients",
  ccRecipients: "cc_recipients",
  bccRecipients: "bcc_recipients",
  subject: "subject",
  bodyText: "body_text",
  bodyHtml: "body_html",
  context: "context",
  attachments: "attachments",
} as const;

type DraftStorage = { [K in keyof typeof contentColumns]: string | null };

/** Measures the serialized, sanitized content that will actually be stored. */
export function draftStorageBytes(storage: DraftStorage): number {
  return (Object.keys(contentColumns) as (keyof DraftStorage)[])
    .reduce((bytes, key) => bytes + Buffer.byteLength(storage[key] ?? "", "utf8"), 0);
}

export type DraftQuotaError = {
  status: 413;
  code: "draft_quota_exceeded";
  message: string;
};

const byteExpression = Object.values(contentColumns)
  .map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`)
  .join(" + ");

/**
 * Read-only admission check; call inside the write transaction to avoid races.
 * Only editable drafts count. Sent and other delivery states retain their data.
 * Invalid or unsafe byte counts fail closed rather than bypassing the limit.
 */
export function checkDraftQuota(
  sqlite: Database,
  input: { accountId: string; newBytes: number; replacingDraftId?: string },
): DraftQuotaError | null {
  const exceeded = (): DraftQuotaError => ({
    status: 413,
    code: "draft_quota_exceeded",
    message: "Draft storage quota exceeded.",
  });
  if (!Number.isSafeInteger(input.newBytes) || input.newBytes < 0) return exceeded();

  const replacing = input.replacingDraftId !== undefined;
  const totals = sqlite.query<{ count: number; bytes: number }, [string, string | null]>(`
    SELECT COUNT(*) AS count, COALESCE(SUM(${byteExpression}), 0) AS bytes
    FROM message_drafts
    WHERE account_id = ? AND delivery_status = 'draft'
      AND (?2 IS NULL OR id != ?2)
  `).get(input.accountId, input.replacingDraftId ?? null)!;

  if ((!replacing && totals.count >= maxDraftsPerAccount)
    || totals.bytes + input.newBytes > maxDraftBytesPerAccount) return exceeded();
  return null;
}

/** Shared wire body for the draft routes' 413 response. */
export function draftQuotaResponse(error: DraftQuotaError) {
  return { error: { code: error.code, message: error.message, retryable: false as const } };
}
