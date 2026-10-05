import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  backfillMailSearchBatch, readMailSearchIndexStatus, setMailSearchEnabled, verifyMailSearchIndex,
} from "./mail-search-index.ts";

// Deliberately requires an explicit file; never silently targets the production/default DB.
// Usage: bun apps/api/src/db/mail-search-admin.ts --database /absolute/path.sqlite status
// Commands: status | backfill | verify | enable | disable
// Backfill: --batch-rows 100 --batch-bytes 4194304 --max-batches 1 --pause-ms 100
const args = process.argv.slice(2);
const commands = new Set(["status", "backfill", "verify", "enable", "disable"]);
const allowedOptions = new Set(["--database", "--batch-rows", "--batch-bytes", "--max-batches", "--pause-ms"]);
const options = new Map<string, string>();
let command: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (allowedOptions.has(arg)) {
    const value = args[++index];
    if (value === undefined || value.startsWith("--") || options.has(arg)) throw new Error(`Missing or repeated option: ${arg}`);
    options.set(arg, value);
  } else if (commands.has(arg) && command === undefined) command = arg;
  else throw new Error(`Unknown or repeated argument: ${arg}`);
}
function option(name: string): string | undefined { return options.get(name); }
function numericOption(name: string, fallback: number): number {
  const value = option(name);
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
if (command !== "backfill" && [...options.keys()].some(key => key !== "--database")) {
  throw new Error("Batch options are only supported with backfill");
}
const databasePath = option("--database");
if (!command || !databasePath || databasePath.startsWith("--")) {
  throw new Error("Usage: bun apps/api/src/db/mail-search-admin.ts --database PATH status|backfill|verify|enable|disable [--batch-rows N --batch-bytes N --max-batches N --pause-ms N]");
}
if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
  throw new Error("--database must name an existing SQLite file; this tool never creates or migrates a database");
}
const sqlite = new Database(resolve(databasePath), { create: false, readwrite: true });
sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
try {
  if (command === "status") console.log(JSON.stringify(readMailSearchIndexStatus(sqlite), null, 2));
  else if (command === "verify") console.log(JSON.stringify(verifyMailSearchIndex(sqlite), null, 2));
  else if (command === "enable" || command === "disable") console.log(JSON.stringify(setMailSearchEnabled(sqlite, command === "enable"), null, 2));
  else {
    const maxBatches = numericOption("--max-batches", 1);
    const pauseMs = numericOption("--pause-ms", 100);
    if (maxBatches < 1 || maxBatches > 10_000 || pauseMs > 60_000) throw new Error("Use --max-batches 1..10000 and --pause-ms 0..60000");
    for (let batch = 0; batch < maxBatches; batch++) {
      const startedAt = performance.now();
      const result = backfillMailSearchBatch(sqlite, {
        ...(option("--batch-rows") ? { batchRows: numericOption("--batch-rows", 100) } : {}),
        ...(option("--batch-bytes") ? { batchOctets: numericOption("--batch-bytes", 4 * 1024 * 1024) } : {}),
      });
      console.log(JSON.stringify({ ...result, durationMs: Math.round(performance.now() - startedAt) }));
      if (result.complete) break;
      if (batch + 1 < maxBatches) await Bun.sleep(pauseMs);
    }
    console.log(JSON.stringify(readMailSearchIndexStatus(sqlite), null, 2));
  }
} finally {
  sqlite.close();
}
