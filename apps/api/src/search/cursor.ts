import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { inboxClassificationResponseSchema, type InboxClassificationResponse } from "@orca/shared/schemas";
import { SearchError } from "./errors.ts";

export type SearchPosition = { tier: number; after: string };
export type SearchContinuation = SearchPosition & { counts?: InboxClassificationResponse["counts"] };
type Cursor = SearchContinuation & { version: 3; binding: string };
const maxRowId = 9_223_372_036_854_775_807n;
export const searchDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function signature(payload: string, key: string): Buffer { return createHmac("sha256", key).update(`orca-ranked-search-v3:${payload}`).digest(); }
export function encodeSearchCursor(position: SearchContinuation, binding: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 3, binding, ...position } satisfies Cursor)).toString("base64url");
  return `${payload}.${signature(payload, key).toString("base64url")}`;
}
export function decodeSearchCursor(value: string | undefined, binding: string, key: string): SearchContinuation {
  if (!value) return { tier: 0, after: "0" };
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new SearchError("search_invalid_cursor");
  const [payload, mac] = value.split(".") as [string, string];
  const supplied = Buffer.from(mac, "base64url");
  const expected = signature(payload, key);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new SearchError("search_invalid_cursor");
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new SearchError("search_invalid_cursor"); }
  if (!cursor || !["after,binding,tier,version", "after,binding,counts,tier,version"].includes(Object.keys(cursor).sort().join()) || cursor.version !== 3
    || !Number.isInteger(cursor.tier) || cursor.tier < 0 || cursor.tier > 3
    || typeof cursor.after !== "string" || !/^\d{1,19}$/.test(cursor.after) || BigInt(cursor.after) > maxRowId
    || typeof cursor.binding !== "string") throw new SearchError("search_invalid_cursor");
  if (cursor.binding !== binding) throw new SearchError("search_cursor_stale");
  if ("counts" in cursor) {
    // Counts are trusted only after signature and full snapshot binding checks.
    // Keep accepting old position-only cursors; those are recounted once.
    const parsed = inboxClassificationResponseSchema.shape.counts.safeParse(cursor.counts);
    if (!parsed.success) throw new SearchError("search_invalid_cursor");
    const counts = parsed.data;
    for (const group of [counts.attention, counts.classification]) {
      if (!Object.values(group).every(Number.isSafeInteger)
        || Object.entries(group).filter(([key]) => key !== "all").reduce((sum, [, value]) => sum + BigInt(value), 0n) !== BigInt(group.all)) {
        throw new SearchError("search_invalid_cursor");
      }
    }
    if (counts.attention.all !== counts.classification.all) throw new SearchError("search_invalid_cursor");
    return { tier: cursor.tier, after: cursor.after, counts };
  }
  return { tier: cursor.tier, after: cursor.after };
}
