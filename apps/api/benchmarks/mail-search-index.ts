/** Synthetic migration rehearsal. No real mail, network, or production connection.
 * bun apps/api/benchmarks/mail-search-index.ts
 * SEARCH_INDEX_BENCH_SIZE=20000 SEARCH_INDEX_BENCH_LARGE_EVERY=100 ...
 * Retains only aggregate evidence; the temporary database is deleted afterwards.
 */
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillMailSearchBatch, readMailSearchIndexStatus, setMailSearchEnabled } from "../src/db/mail-search-index.ts";

const size = Number(Bun.env.SEARCH_INDEX_BENCH_SIZE ?? 20_000);
const largeEvery = Number(Bun.env.SEARCH_INDEX_BENCH_LARGE_EVERY ?? 100);
if (!Number.isInteger(size) || size < 1 || !Number.isInteger(largeEvery) || largeEvery < 0) throw new Error("Invalid synthetic benchmark options");
const directory = mkdtempSync(join(tmpdir(), "orca-index-build-bench-"));
const path = join(directory, "mail.sqlite");
const sqlite = new Database(path);
try {
  sqlite.exec(`pragma journal_mode=WAL; pragma foreign_keys=ON;
    create table oauth_accounts(id text primary key, user_id text not null);
    create table emails(id text primary key, account_id text not null references oauth_accounts(id) on delete cascade,
      from_name text, from_address text, subject text, snippet text, body_text text, is_read integer default 0);
    insert into oauth_accounts values('account','owner');`);
  const insert = sqlite.query("insert into emails(id,account_id,from_name,from_address,subject,snippet,body_text) values(?,'account','Synthetic Sender','sender@example.invalid',?, 'Synthetic snippet',?)");
  let random = 0x12345678;
  const rand = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  const words = Array.from({ length: 512 }, (_, index) => `message${index.toString(36)} topic${(index * 31).toString(36)}`);
  function body(index: number, length = 8 * 1024) {
    let result = `Synthetic record ${index}: `;
    while (result.length < length) result += `${words[rand() % words.length]} `;
    return result.slice(0, length);
  }
  const seedStarted = performance.now();
  sqlite.transaction(() => {
    for (let index = 0; index < size; index++) insert.run(`mail-${String(index).padStart(8, "0")}`, `Subject ${index}`, body(index, largeEvery && index % largeEvery === 0 ? 300 * 1024 : 8 * 1024));
  })();
  sqlite.exec("pragma wal_checkpoint(TRUNCATE)");
  const canonicalSeedMs = performance.now() - seedStarted;
  const canonicalFileBytes = statSync(path).size;
  const migrationStarted = performance.now();
  sqlite.exec(readFileSync(new URL("../drizzle/0051_indexed_mail_search.sql", import.meta.url), "utf8"));
  const additiveMigrationMs = performance.now() - migrationStarted;
  const durations: number[] = [];
  let maxWalBytes = 0;
  const buildStarted = performance.now();
  for (;;) {
    const start = performance.now();
    const batch = backfillMailSearchBatch(sqlite);
    durations.push(performance.now() - start);
    if (existsSync(`${path}-wal`)) maxWalBytes = Math.max(maxWalBytes, statSync(`${path}-wal`).size);
    if (batch.complete) break;
  }
  const backfillMs = performance.now() - buildStarted;
  const verifyStarted = performance.now();
  setMailSearchEnabled(sqlite, true);
  const verifyAndEnableMs = performance.now() - verifyStarted;
  const indexedStatus = readMailSearchIndexStatus(sqlite);
  sqlite.exec("pragma wal_checkpoint(TRUNCATE)");
  const builtFileBytes = statSync(path).size;
  const postingBytes = (index: string) => (sqlite.query(`select coalesce(sum(octet_length(block)),0) as bytes from ${index}_data`).get() as { bytes: number }).bytes;
  const maintenance: Record<string, number> = {};
  for (const [kind, query] of [
    ["readFlag100", "update emails set is_read=1 where id=?"],
    ["bodyUpdate100", "update emails set body_text=body_text || ' updated' where id=?"],
    ["delete100", "delete from emails where id=?"],
  ] as const) {
    const statement = sqlite.query(query);
    const start = performance.now();
    sqlite.transaction(() => {
      for (let index = 0; index < Math.min(size, 100); index++) statement.run(`mail-${String(index).padStart(8, "0")}`);
    })();
    maintenance[`${kind}Ms`] = +(performance.now() - start).toFixed(2);
  }
  durations.sort((a, b) => a - b);
  console.log(JSON.stringify({
    syntheticOnly: true,
    note: "Minimal canonical schema isolates index migration/storage cost; real app includes other triggers. Body text is deterministic synthetic vocabulary, not a production storage/SLA estimate. No pauses between batches; admin defaults yield 100ms between batches. Verify explicitly holds a writer lock. Physical derived delta includes map/index page allocation; posting-block bytes exclude tree overhead and are observed after the maintenance samples.",
    runtime: { bun: Bun.version, sqlite: (sqlite.query("select sqlite_version() as version").get() as { version: string }).version },
    messages: size, normalBodyBytes: 8 * 1024, largeBodyEvery: largeEvery, largeBodyBytes: largeEvery ? 300 * 1024 : 0,
    canonicalSeedMs: +canonicalSeedMs.toFixed(2), additiveMigrationMs: +additiveMigrationMs.toFixed(2),
    backfillMs: +backfillMs.toFixed(2), batches: durations.length,
    batchP50Ms: +durations[Math.floor(durations.length * 0.5)]!.toFixed(2),
    batchP95Ms: +durations[Math.ceil(durations.length * 0.95) - 1]!.toFixed(2),
    maximumBatchMs: +durations.at(-1)!.toFixed(2), verifyAndEnableMs: +verifyAndEnableMs.toFixed(2),
    indexedSourceOctets: indexedStatus.indexedSourceOctets,
    canonicalFileBytes, builtFileBytes, derivedFileGrowthBytes: builtFileBytes - canonicalFileBytes,
    fullPostingBlockBytesAfterMaintenance: postingBytes("mail_search_full_v1"), metadataPostingBlockBytesAfterMaintenance: postingBytes("mail_search_metadata_v1"),
    peakObservedWalBytes: maxWalBytes, maintenance,
  }, null, 2));
} finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
