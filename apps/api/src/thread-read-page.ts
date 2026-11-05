import { createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { threadReadPageSchema, type ThreadReadPage } from "@orca/shared";
import { getAuthConfig } from "./auth/config.ts";
import { sanitizeInboundHtml } from "./mail/provider-html.ts";

// Ordering matches emails_thread_latest_destination_idx: newest received date,
// newest creation time, then ID ascending. SQLite sorts NULL dates last.
const pageSize = 20;
const maxBody = 2 * 1024 * 1024;
const maxRawBodies = 8 * 1024 * 1024;
const maxMetadata = 2 * 1024 * 1024;
// Sixfold expansion covers JSON escaping; the actual serialized response is
// checked too. A candidate that cannot fit alone becomes unavailable.
const maxEncoded = 16 * 1024 * 1024;
const maxIdBytes = 1024;
type Key = { received: number | null; created: number; row: number };
type Cursor = Key & { version: 1; scope: string; direction: "earlier" | "newer" };
type Probe = Key & { id: string | null; textBytes: number; htmlBytes: number; metadataBytes: number };

export class ThreadPageError extends Error {
  constructor(readonly code: "not_found" | "invalid_cursor" | "payload_limit", message: string) { super(message); }
}

function cursorMac(value: string) {
  return createHmac("sha256", getAuthConfig().sessionSecret).update("orca-thread-page-v1\0").update(value).digest();
}
function scopeFingerprint(scope: { user: string; account: string; thread: string }) {
  return createHmac("sha256", getAuthConfig().sessionSecret).update("orca-thread-page-scope-v1\0").update(JSON.stringify(scope)).digest("base64url");
}
function makeCursor(key: Key, scope: { user: string; account: string; thread: string }, direction: Cursor["direction"]) {
  const value = Buffer.from(JSON.stringify({ version: 1, scope: scopeFingerprint(scope), received: key.received, created: key.created, row: key.row, direction })).toString("base64url");
  return `${value}.${cursorMac(value).toString("base64url")}`;
}
function readCursor(value: string, scope: { user: string; account: string; thread: string }): Cursor {
  try {
    if (value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const [payload, signature] = value.split(".") as [string, string];
    const expected = cursorMac(payload);
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || actual.toString("base64url") !== signature || !timingSafeEqual(expected, actual)) throw Error();
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cursor;
    if (data.version !== 1 || data.scope !== scopeFingerprint(scope) ||
        !(data.direction === "earlier" || data.direction === "newer") ||
        !(data.received === null || Number.isSafeInteger(data.received)) || !Number.isSafeInteger(data.created) ||
        !Number.isSafeInteger(data.row) || data.row <= 0) throw Error();
    return data;
  } catch { throw new ThreadPageError("invalid_cursor", "Invalid conversation page cursor"); }
}

export function readThreadPage(sqlite: Database, scope: { user: string; account: string; thread: string }, cursorValue?: string): ThreadReadPage {
  if (Buffer.byteLength(JSON.stringify(scope)) > 2048) throw new ThreadPageError("payload_limit", "This conversation has an unsupported identifier.");
  const cursor = cursorValue ? readCursor(cursorValue, scope) : null;
  const execute = sqlite.transaction(() => {
    const exists = sqlite.query("select 1 from threads where id = ? and account_id = ?").get(scope.thread, scope.account);
    if (!exists) throw new ThreadPageError("not_found", "Thread not found");
    const reverse = cursor?.direction === "newer";
    const order = `emails.received_at ${reverse ? "asc" : "desc"}, emails.created_at ${reverse ? "asc" : "desc"}, emails.id ${reverse ? "desc" : "asc"}`;
    const projection = `select
      case when octet_length(id) <= ${maxIdBytes} then id else null end as id,
      rowid as row, received_at as received, created_at as created,
      coalesce(octet_length(body_text), 0) as textBytes,
      coalesce(octet_length(body_html), 0) as htmlBytes,
      coalesce(octet_length(from_address), 0) + coalesce(octet_length(from_name), 0) + coalesce(octet_length(subject), 0) as metadataBytes
      from emails where account_id = ? and thread_id = ?`;
    const candidates: Probe[] = [];
    function add(condition: string, bindings: Array<string | number | null>) {
      const remaining = pageSize + 1 - candidates.length;
      if (!remaining) return;
      const rows = sqlite.query(`${projection} ${condition} order by ${order} limit ${remaining}`)
        .all(scope.account, scope.thread, ...bindings) as Probe[];
      candidates.push(...rows);
    }
    if (!cursor) {
      add("", []);
    } else {
      // Disjoint, ordered ranges allow the composite index to seek at each
      // boundary instead of rescanning the preceding conversation.
      const earlier = cursor.direction === "earlier";
      // Resolve the signed row anchor inside SQLite. The ID itself may be
      // oversized and must never be copied into a cursor or JavaScript.
      const anchor = sqlite.query("select 1 from emails where rowid = ? and account_id = ? and thread_id = ? and received_at is ? and created_at = ?")
        .get(cursor.row, scope.account, scope.thread, cursor.received, cursor.created);
      if (!anchor) throw new ThreadPageError("invalid_cursor", "Conversation changed. Restart pages to continue.");
      add(`and received_at is ? and created_at = ? and id ${earlier ? ">" : "<"} (select id from emails where rowid = ?)`, [cursor.received, cursor.created, cursor.row]);
      add(`and received_at is ? and created_at ${earlier ? "<" : ">"} ?`, [cursor.received, cursor.created]);
      if (cursor.received === null) {
        if (!earlier) add("and received_at is not null", []);
      } else if (earlier) {
        add("and received_at < ?", [cursor.received]);
        add("and received_at is null", []);
      } else {
        add("and received_at > ?", [cursor.received]);
      }
    }
    if (candidates.some(row => !Number.isSafeInteger(row.row) || row.row <= 0 || !Number.isSafeInteger(row.created) || !(row.received === null || Number.isSafeInteger(row.received)))) {
      throw new ThreadPageError("payload_limit", "This conversation contains an unsupported message identifier.");
    }
    const selected: Probe[] = [];
    let raw = 0, metadata = 0, conservative = 0;
    for (const row of candidates.slice(0, pageSize)) {
      const size = row.textBytes + row.htmlBytes;
      const alone = row.id === null || row.textBytes > maxBody || row.htmlBytes > maxBody || row.metadataBytes > maxMetadata || 6 * (size + row.metadataBytes) > maxEncoded - 65536;
      const estimate = alone ? 8192 : 6 * (size + row.metadataBytes + Buffer.byteLength(row.id ?? "")) + 2048;
      if (selected.length && ((!alone && (raw + size > maxRawBodies || metadata + row.metadataBytes > maxMetadata)) || conservative + estimate > maxEncoded - 65536)) break;
      selected.push(row);
      if (!alone) { raw += size; metadata += row.metadataBytes; }
      conservative += estimate;
    }
    let encodedEntries = 0;
    const entries: ThreadReadPage["entries"] = selected.map(row => {
      const size = row.textBytes + row.htmlBytes;
      const unavailableId = row.id ?? `row:${row.row}`;
      if (row.id === null || row.textBytes > maxBody || row.htmlBytes > maxBody || row.metadataBytes > maxMetadata || 6 * (size + row.metadataBytes) > maxEncoded - 65536) { encodedEntries += 8192; return { kind: "unavailable", id: unavailableId }; }
      const message = sqlite.query("select from_address as address, from_name as name, subject, body_text as text, body_html as html from emails where account_id = ? and thread_id = ? and rowid = ?").get(scope.account, scope.thread, row.row) as { address: string | null; name: string | null; subject: string | null; text: string | null; html: string | null };
      const date = row.received === null ? null : new Date(row.received);
      const entry = { kind: "message" as const, id: row.id, from: message.name || message.address || "Unknown sender", subject: message.subject || "", receivedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null, bodyText: message.text, bodyHtml: sanitizeInboundHtml(message.html), htmlPresent: row.htmlBytes > 0 };
      const encoded = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (encodedEntries + encoded > maxEncoded - 65536) { encodedEntries += 8192; return { kind: "unavailable", id: row.id }; }
      encodedEntries += encoded;
      return entry;
    });
    // Newer queries scan in reverse and are returned in the same newest-first order.
    if (reverse) { entries.reverse(); selected.reverse(); }
    const first = selected[0], last = selected.at(-1);
    const moreInDirection = candidates.length > selected.length;
    const page = threadReadPageSchema.parse({ entries,
      earlier: last && (reverse || moreInDirection) ? makeCursor(last, scope, "earlier") : null,
      newer: first && (!reverse && cursor || reverse && moreInDirection) ? makeCursor(first, scope, "newer") : null,
    });
    if (Buffer.byteLength(JSON.stringify(page)) > maxEncoded) throw new ThreadPageError("payload_limit", "Conversation page is too large.");
    return page;
  });
  return execute.deferred();
}
