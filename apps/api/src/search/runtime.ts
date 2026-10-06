import { createHmac } from "node:crypto";
import { getAuthConfig } from "../auth/config.ts";
import { SearchIndexSupervisor } from "./indexing/supervisor.ts";
import { canonicalizePath, openCanonicalReadOnly, readSearchControl } from "./indexing/schema.ts";

/** Domain-separated server key. Never stored in a cursor, log or URL. */
export function searchCursorKey(): string {
  return createHmac("sha256", getAuthConfig().sessionSecret).update("orca-stored-mail-search-cursor-v3").digest("hex");
}

/** Reuses the existing API deployment. Only explicit persisted worker activation
 * permits a bounded drain; startup never creates, backfills or enables an index. */
export function createSearchIndexScheduler(options: { databasePath: string; intervalMs?: number; onBlocked?: (code: string) => void }) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let supervisor: SearchIndexSupervisor | undefined;
  let lastFailure: string | undefined;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const path = canonicalizePath(options.databasePath);
        const db = openCanonicalReadOnly(path);
        let active = false;
        try { const control = readSearchControl(db); active = Boolean(control.worker_enabled && !control.paused); }
        finally { db.close(); }
        if (stopped || !active) return;
        supervisor ??= new SearchIndexSupervisor({ canonicalPath: path });
        await supervisor.kick();
        lastFailure = undefined;
      } catch {
        // Mailbox ingestion and ordinary reads remain available. Do not expose
        // paths, contents, SQLite messages or a PID-based recovery suggestion.
        const code = "search_index_maintenance_blocked";
        if (lastFailure !== code) options.onBlocked?.(code);
        lastFailure = code;
      }
    })().finally(() => {
      running = undefined;
      if (!stopped) { timer = setTimeout(() => { void tick(); }, options.intervalMs ?? 5_000); timer.unref(); }
    });
    return running;
  };
  return {
    start: tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await supervisor?.shutdown();
      await running;
    },
  };
}
