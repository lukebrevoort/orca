import type { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MailSearchCapabilities } from "@orca/shared/mail-search";
import { createMailboxReader, type MailboxReadAuthorization, type MailboxReadQuery } from "../mailbox/read.ts";
import { readSearchControl, type SearchControl } from "./indexing/schema.ts";
import { searchDigest } from "./cursor.ts";
import { SearchError } from "./errors.ts";

export type SearchExpectation = { mode?: string; epoch?: string };
export type SearchModeSnapshot = { capabilities: MailSearchCapabilities; allowUnwrappedCursor: boolean };
export function searchActivationEpoch(control: SearchControl, ownerId: string): string {
  return searchDigest(["orca-search-activation-v1", control.source_id, control.build_id, control.activation_epoch, ownerId]);
}
/** Read only the canonical control row. Readiness belongs to indexed execution. */
export function readSearchMode(canonical: Database, ownerId: string, expected: SearchExpectation = {}): SearchModeSnapshot {
  let control: SearchControl;
  try { control = readSearchControl(canonical); }
  catch { throw new SearchError("search_index_unavailable"); }
  const common = { version: 1 as const, epoch: searchActivationEpoch(control, ownerId), ownerId };
  const capabilities: MailSearchCapabilities = control.enabled
    ? { ...common, mode: "indexed", coverage: "stored-plaintext", semantics: "literal-index-v3" }
    : { ...common, mode: "legacy-metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1" };
  if ((expected.mode !== undefined || expected.epoch !== undefined)
    && (expected.mode !== capabilities.mode || expected.epoch !== capabilities.epoch)) throw new SearchError("search_mode_changed");
  return { capabilities, allowUnwrappedCursor: control.activation_epoch === 0 };
}
export function requireIndexedSearch(snapshot: SearchModeSnapshot): void {
  if (snapshot.capabilities.mode !== "indexed") throw new SearchError("search_not_activated");
}
function legacySignature(payload: string, key: string, ownerId: string): Buffer {
  return createHmac("sha256", key).update(JSON.stringify(["orca-legacy-search-v2", ownerId, payload])).digest();
}
function unwrapLegacyCursor(value: string | undefined, snapshot: SearchModeSnapshot, key: string): string | undefined {
  if (!value) return value;
  if (!value.includes(".")) {
    if (snapshot.allowUnwrappedCursor) return value;
    throw new SearchError("search_cursor_stale");
  }
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new SearchError("search_invalid_cursor");
  const [payload, mac] = value.split(".") as [string, string];
  const actual = Buffer.from(mac, "base64url");
  const expected = legacySignature(payload, key, snapshot.capabilities.ownerId);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new SearchError("search_invalid_cursor");
  let decoded: { version: number; epoch: string; cursor: Record<string, unknown> };
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new SearchError("search_invalid_cursor"); }
  if (!decoded || Object.keys(decoded).sort().join() !== "cursor,epoch,version" || decoded.version !== 2
    || !decoded.cursor || typeof decoded.cursor !== "object" || Array.isArray(decoded.cursor) || typeof decoded.epoch !== "string") throw new SearchError("search_invalid_cursor");
  if (decoded.epoch !== snapshot.capabilities.epoch) throw new SearchError("search_cursor_stale");
  // The unchanged mailbox reader validates its original cursor fields/scope.
  return Buffer.from(JSON.stringify(decoded.cursor)).toString("base64url");
}
function wrapLegacyCursor(cursor: string | null, snapshot: SearchModeSnapshot, key: string): string | null {
  if (cursor === null) return null;
  // Embed the original JSON once: nested base64 would exceed the wire limit
  // for ordinary maximum-length query/sender filters. Owner is MAC-bound.
  const original = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const payload = Buffer.from(JSON.stringify({ version: 2, epoch: snapshot.capabilities.epoch, cursor: original })).toString("base64url");
  const value = `${payload}.${legacySignature(payload, key, snapshot.capabilities.ownerId).toString("base64url")}`;
  // Account lists and Unicode can still grow the original cursor. Fail clearly
  // rather than returning an unusable continuation or claiming exhaustion.
  if (value.length > 2_048) throw new SearchError("search_budget_exceeded");
  return value;
}
/** Mode capture and the original synchronous reader share a canonical snapshot.
 * No parser, sidecar, readiness scan, or replacement metadata query is involved. */
export function readStagedMetadata(canonical: Database, input: {
  authorization: MailboxReadAuthorization; query: MailboxReadQuery; cursorKey: string; expected?: SearchExpectation;
}, options: Parameters<typeof createMailboxReader>[1] = {}) {
  return canonical.transaction(() => {
    const snapshot = readSearchMode(canonical, input.authorization.userId, input.expected);
    if (snapshot.capabilities.mode === "indexed" && input.query.query?.trim()) return { snapshot, legacy: undefined };
    const textSearch = Boolean(input.query.query?.trim());
    const legacy = createMailboxReader(canonical, options).read({
      authorization: input.authorization,
      query: { ...input.query, cursor: textSearch ? unwrapLegacyCursor(input.query.cursor, snapshot, input.cursorKey) : input.query.cursor },
    });
    if (textSearch) legacy.response.nextCursor = wrapLegacyCursor(legacy.response.nextCursor, snapshot, input.cursorKey);
    return { snapshot, legacy };
  })();
}
