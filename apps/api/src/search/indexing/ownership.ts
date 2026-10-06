import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { assertMatchingBuild, canonicalizePath, readIndexControl, type SearchControl } from "./schema.ts";

export interface WriterOwnership { token: string; directory: string; recordWorker: (pid: number | null) => void; release: () => void }
/** No lease, stale-PID heuristic, or automatic takeover. A crash requires explicit operator recovery. */
export function acquireWriterOwnership(index: Database, indexPath: string, canonical: SearchControl): WriterOwnership {
  const directory = `${canonicalizePath(indexPath)}.writer-lock`;
  try { mkdirSync(directory, { mode: 0o700 }); } catch { throw new Error("search_writer_owned_or_recovery_required"); }
  const token = randomUUID();
  let workerPid: number | null = null;
  const save = () => writeFileSync(join(directory, "owner.json"), JSON.stringify({ token, hostname: hostname(), supervisorPid: process.pid, workerPid }), { mode: 0o600 });
  try {
    save();
    index.transaction(() => {
      assertMatchingBuild(canonical, readIndexControl(index));
      if (index.query("UPDATE index_control SET owner_token=? WHERE singleton=1 AND owner_token IS NULL").run(token).changes !== 1) throw new Error("search_writer_recovery_required");
    }).immediate();
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    token, directory,
    recordWorker(pid) { workerPid = pid; save(); },
    release() {
      if (workerPid !== null) throw new Error("search_worker_not_reaped");
      const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as { token: string };
      if (owner.token !== token) throw new Error("search_writer_fenced");
      if (index.query("UPDATE index_control SET owner_token=NULL WHERE singleton=1 AND owner_token=?").run(token).changes !== 1) throw new Error("search_writer_fenced");
      rmSync(directory, { recursive: true });
    },
  };
}
