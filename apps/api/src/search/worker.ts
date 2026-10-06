import { readFileSync } from "node:fs";
import { MailSearchQueryError } from "@orca/shared/mail-search";
import { MailboxScopeError } from "../mailbox/read.ts";
import { SearchError } from "./errors.ts";
import { readRankedSearch } from "./read.ts";
import {
  rankedSearchProcessLimits, rankedSearchProtocolVersion, rankedSearchWorkerErrorCodeSchema,
  rankedSearchWorkerReplySchema, rankedSearchWorkerRequestSchema,
  type RankedSearchWorkerErrorCode, type RankedSearchWorkerReply, type RankedSearchWorkerRequest,
} from "./protocol.ts";

function errorCode(error: unknown): RankedSearchWorkerErrorCode {
  if (error instanceof SearchError || error instanceof MailSearchQueryError || error instanceof MailboxScopeError) {
    const parsed = rankedSearchWorkerErrorCodeSchema.safeParse(error.code);
    if (parsed.success) return parsed.data;
  }
  // Never expose SQLite errors, SQL, query text, account metadata or stack traces.
  return "search_failed";
}

function processPeakRssBytes(): number | null {
  // Unlike inherited getrusage maxima, Linux VmHWM describes this executable.
  if (process.platform !== "linux") return null;
  try {
    const value = /^VmHWM:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
    const bytes = value ? Number(value) * 1024 : NaN;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch { return null; }
}

function failure(code: RankedSearchWorkerErrorCode): RankedSearchWorkerReply {
  return { version: rankedSearchProtocolVersion, ok: false, code, peakRssBytes: processPeakRssBytes() };
}

/** Opens canonical and sidecar databases read-only inside readRankedSearch. No
 * config import, migration, indexing, write fallback or credential decryption. */
export function runRankedSearchSnapshot(request: RankedSearchWorkerRequest): RankedSearchWorkerReply {
  try {
    const result = readRankedSearch(request);
    return { version: rankedSearchProtocolVersion, ok: true, result, peakRssBytes: processPeakRssBytes() };
  } catch (error) { return failure(errorCode(error)); }
}

async function main(): Promise<void> {
  let reply: RankedSearchWorkerReply;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = Bun.stdin.stream().getReader();
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        bytes += chunk.byteLength;
        if (bytes > rankedSearchProcessLimits.maxRequestBytes) throw new Error("request limit");
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const request = rankedSearchWorkerRequestSchema.safeParse(JSON.parse(decoded));
    reply = request.success ? runRankedSearchSnapshot(request.data) : failure("search_failed");
  } catch { reply = failure("search_failed"); }
  // Validate before emitting; the parent also validates after the child closes.
  const parsed = rankedSearchWorkerReplySchema.safeParse(reply);
  let output = JSON.stringify(parsed.success ? parsed.data : failure("search_failed"));
  if (Buffer.byteLength(output) > rankedSearchProcessLimits.maxStdoutBytes) {
    output = JSON.stringify(failure("search_budget_exceeded"));
  }
  await Bun.write(Bun.stdout, output);
}

if (import.meta.main) await main();
