import { Database } from "bun:sqlite";
import { canonicalizePath, openCanonicalReadOnly } from "./schema.ts";
import { applyIndexJob, publishAccountReady, type WorkerIdentity } from "./worker-core.ts";
import { DEFAULT_INDEX_LIMITS, type IndexJob, type IndexLimits } from "./queue.ts";
import type { SearchMode } from "./schema.ts";

export type IndexWorkerRequest = {
  protocol: 1; canonicalPath: string; indexPath: string; identity: WorkerIdentity;
  limits?: IndexLimits;
} & ({ action: "apply"; job: IndexJob } | { action: "seal"; accountId: string; incarnation: string; mode: SearchMode });

if (import.meta.main) {
  let canonical: Database | undefined;
  let index: Database | undefined;
  try {
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16_384) throw new Error("search_request_too_large");
    const request = JSON.parse(input) as IndexWorkerRequest;
    if (request.protocol !== 1 || !["apply", "seal"].includes(request.action)) throw new Error("search_worker_protocol");
    const canonicalPath = canonicalizePath(request.canonicalPath);
    const indexPath = canonicalizePath(request.indexPath);
    if (canonicalPath === indexPath) throw new Error("search_index_must_be_separate");
    canonical = openCanonicalReadOnly(canonicalPath);
    index = new Database(indexPath, { strict: true, readwrite: true, create: false });
    index.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048");
    const result = request.action === "apply"
      ? applyIndexJob(canonical, index, request.job, request.identity, request.limits ?? DEFAULT_INDEX_LIMITS)
      : { protocol: 1, sealed: publishAccountReady(canonical, index, request.accountId, request.incarnation, request.mode, request.identity) };
    process.stdout.write(JSON.stringify(result));
  } catch {
    // Do not put mail, SQLite arguments, or file paths into protocol/error logs.
    process.exitCode = 1;
  } finally { index?.close(); canonical?.close(); }
}
