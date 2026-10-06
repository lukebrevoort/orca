import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SearchError } from "./errors.ts";

export type SearchPosition = { tier: number; after: string };
type Cursor = SearchPosition & { version: 3; binding: string };
const maxRowId = 9_223_372_036_854_775_807n;
export const searchDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function signature(payload: string, key: string): Buffer { return createHmac("sha256", key).update(`orca-ranked-search-v3:${payload}`).digest(); }
export function encodeSearchCursor(position: SearchPosition, binding: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({ version: 3, binding, ...position } satisfies Cursor)).toString("base64url");
  return `${payload}.${signature(payload, key).toString("base64url")}`;
}
export function decodeSearchCursor(value: string | undefined, binding: string, key: string): SearchPosition {
  if (!value) return { tier: 0, after: "0" };
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new SearchError("search_invalid_cursor");
  const [payload, mac] = value.split(".") as [string, string];
  const supplied = Buffer.from(mac, "base64url");
  const expected = signature(payload, key);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new SearchError("search_invalid_cursor");
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new SearchError("search_invalid_cursor"); }
  if (!cursor || Object.keys(cursor).sort().join() !== "after,binding,tier,version" || cursor.version !== 3
    || !Number.isInteger(cursor.tier) || cursor.tier < 0 || cursor.tier > 3
    || typeof cursor.after !== "string" || !/^\d{1,19}$/.test(cursor.after) || BigInt(cursor.after) > maxRowId
    || typeof cursor.binding !== "string") throw new SearchError("search_invalid_cursor");
  if (cursor.binding !== binding) throw new SearchError("search_cursor_stale");
  return { tier: cursor.tier, after: cursor.after };
}
