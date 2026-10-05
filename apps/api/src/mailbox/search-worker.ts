import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { inboxClassificationResponseSchema, inboxQuerySchema, mailProviderSchema } from "@orca/shared/schemas";

import { createMailboxReader, MailboxCursorError, MailboxScopeError } from "./read.ts";
import { MailSearchAdmissionError, MailSearchUnavailableError } from "./search-index.ts";

/** Private, versioned stdin/stdout protocol. This is not a client request schema.
 * The authenticated API/MCP caller supplies authority and body permission. The
 * reader still intersects every supplied account ID with the user's ownership. */
export const mailSearchProcessLimits = Object.freeze({
  // One fresh process per API instance until deployment memory headroom is
  // verified. This is a conservative shipped limit, not an environment knob.
  maxActive: 1,
  maxActivePerUser: 1,
  maxQueued: 8,
  maxQueuedPerUser: 1,
  deadlineMs: 2_000,
  queueWaitMs: 1_000,
  maxRequestBytes: 64 * 1024,
  maxStdoutBytes: 2 * 1024 * 1024,
  maxStderrBytes: 8 * 1024,
  busyTimeoutMs: 100,
});

const identifier = z.string().min(1).max(1_024).refine(value => !value.includes("\0"));
export const mailSearchWorkerRequestSchema = z.object({
  version: z.literal(1),
  databasePath: z.string().max(4_096).refine(value => isAbsolute(value) && !value.includes("\0")),
  authorization: z.object({
    userId: identifier,
    accountIds: z.array(identifier).max(1_000).optional(),
  }).strict(),
  searchBodyText: z.boolean(),
  query: inboxQuerySchema.omit({ accountId: true }).extend({
    query: inboxQuerySchema.shape.query.unwrap(),
    cursor: z.string().min(1).max(32_768).optional(),
    limit: z.number().int().min(1).max(100),
    receivedAfter: z.iso.datetime({ offset: true }).optional(),
    receivedBefore: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
}).strict();
export type MailSearchWorkerRequest = z.infer<typeof mailSearchWorkerRequestSchema>;

const nonnegativeNumber = z.number().finite().nonnegative();
const nonnegativeInteger = nonnegativeNumber.int();
const metricSchema = z.object({
  durationMs: nonnegativeNumber,
  countDurationMs: nonnegativeNumber,
  pageDurationMs: nonnegativeNumber,
  enrichmentDurationMs: nonnegativeNumber,
  accountCount: nonnegativeInteger,
  limit: nonnegativeInteger,
  returnedMessages: nonnegativeInteger,
  aggregateRowsReturned: nonnegativeInteger,
  pageRowsProjected: nonnegativeInteger,
  lookaheadRowsProjected: nonnegativeInteger,
  labelAssociationRowsLoaded: nonnegativeInteger,
  effectiveOverridesProjected: nonnegativeInteger,
  accountPageQueries: nonnegativeInteger,
  maxPageRowsBound: nonnegativeInteger,
  revision: z.string(),
}).strict();

export const mailSearchWorkerErrorCodeSchema = z.enum([
  "search_query_too_broad", "search_index_not_ready", "invalid_cursor", "no_accounts",
  "search_invalid_request", "search_database_unavailable", "search_failed",
]);

export const mailSearchWorkerReplySchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      response: inboxClassificationResponseSchema.extend({ freshness: inboxClassificationResponseSchema.shape.freshness.unwrap() }),
      metric: metricSchema,
    }).strict(),
    capabilityAccounts: z.array(z.object({ id: identifier, provider: mailProviderSchema, scope: z.string().nullable() }).strict()),
    peakRssBytes: nonnegativeInteger.nullable(),
  }).strict(),
  z.object({ ok: z.literal(false), code: mailSearchWorkerErrorCodeSchema }).strict(),
]);
export type MailSearchWorkerReply = z.infer<typeof mailSearchWorkerReplySchema>;

/** Never imports database config, creates a file, migrates, enables search,
 * decrypts credentials, or changes journal mode. Both SQLite open flags and
 * query_only prohibit writes (including temporary tables). */
export function openMailSearchDatabase(databasePath: string): Database {
  const sqlite = new Database(databasePath, { readonly: true, create: false, strict: true });
  try {
    sqlite.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${mailSearchProcessLimits.busyTimeoutMs}; PRAGMA cache_size=-8192`);
    return sqlite;
  } catch (error) { sqlite.close(); throw error; }
}

export function runMailSearchSnapshot(request: MailSearchWorkerRequest): MailSearchWorkerReply {
  let sqlite: Database;
  try { sqlite = openMailSearchDatabase(request.databasePath); }
  catch { return { ok: false, code: "search_database_unavailable" }; }
  try {
    // The nested reader transaction is a savepoint. Metadata used by an
    // injectable parent provider registry belongs to the same outer snapshot.
    const snapshot = sqlite.transaction(() => {
      const result = createMailboxReader(sqlite, { searchBodyText: request.searchBodyText }).read(request);
      const capabilityAccounts = sqlite.query(`select id, provider, scope from oauth_accounts
        where user_id=? and id in (select value from json_each(?)) order by id`).all(
        request.authorization.userId, JSON.stringify(result.response.accounts.map(account => account.id)),
      ) as Array<{ id: string; provider: "gmail" | "outlook"; scope: string | null }>;
      return { result, capabilityAccounts };
    })();
    return { ok: true, ...snapshot, peakRssBytes: processPeakRssBytes() };
  } catch (error) {
    if (error instanceof MailSearchAdmissionError) return { ok: false, code: "search_query_too_broad" };
    if (error instanceof MailSearchUnavailableError) return { ok: false, code: "search_index_not_ready" };
    if (error instanceof MailboxCursorError) return { ok: false, code: "invalid_cursor" };
    if (error instanceof MailboxScopeError) return { ok: false, code: "no_accounts" };
    // Do not serialize SQLite errors, SQL, query strings, mail, or stack traces.
    return { ok: false, code: "search_failed" };
  } finally { sqlite.close(); }
}

function processPeakRssBytes(): number | null {
  // Bun-spawned getrusage.maxRSS can retain the parent's pre-exec high-water.
  // Linux VmHWM belongs to this executable's address space. Do not mislabel
  // current RSS or an inherited maximum as a portable child peak measurement.
  if (process.platform !== "linux") return null;
  try {
    const kilobytes = /^VmHWM:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
    return kilobytes ? Number(kilobytes) * 1024 : null;
  } catch { return null; }
}

async function main(): Promise<void> {
  let reply: MailSearchWorkerReply;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = Bun.stdin.stream().getReader();
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > mailSearchProcessLimits.maxRequestBytes) throw new Error("request limit");
      chunks.push(chunk);
    }
    const request = mailSearchWorkerRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    reply = request.success ? runMailSearchSnapshot(request.data) : { ok: false, code: "search_invalid_request" };
  } catch { reply = { ok: false, code: "search_invalid_request" }; }
  // Parent independently enforces the byte cap while streaming, then validates
  // the full schema only after successful exit. No body columns are serialized.
  const output = JSON.stringify(reply);
  await Bun.write(Bun.stdout, Buffer.byteLength(output) > mailSearchProcessLimits.maxStdoutBytes
    ? JSON.stringify({ ok: false, code: "search_query_too_broad" }) : output);
}

if (import.meta.main) await main();
