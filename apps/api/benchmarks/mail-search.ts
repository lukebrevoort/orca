/** Synthetic indexed-search benchmark. No provider/network calls or real mail.
 * bun apps/api/benchmarks/mail-search.ts [path-to-baseline-reader.ts]
 * Optional baseline must expose createMailboxReader; counts may differ by design.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../src/db/client.ts";
import { setMailSearchEnabled } from "../src/db/mail-search-index.ts";
import { oauthAccounts, users } from "../src/db/schema.ts";
import { createMailboxReader } from "../src/mailbox/read.ts";
import { MailSearchAdmissionError } from "../src/mailbox/search-index.ts";

const baseline = process.argv[2] ? (await import(pathToFileURL(resolve(process.argv[2])).href)).createMailboxReader as typeof createMailboxReader : null;
const samples = Number(Bun.env.SEARCH_BENCH_SAMPLES ?? 10), warmups = 2;
const sizes = (Bun.env.SEARCH_BENCH_SIZES ?? "1000,5000,20000").split(",").map(Number);
const largeBodyEvery = Number(Bun.env.SEARCH_BENCH_LARGE_EVERY ?? 0);
assert(Number.isInteger(samples) && samples > 0 && sizes.every(size => Number.isInteger(size) && size > 0));
assert(Number.isInteger(largeBodyEvery) && largeBodyEvery >= 0);
const body = "Routine synthetic preparation details. ".repeat(220); // ~8 KiB/message.
const maxTerms = "albatross bluebird cardinal dunlin egret finch gannet heron ibis jaybird kingfisher linnet magpie nuthatch osprey pelican";
const scenarios = [
  { name: "unfiltered", query: undefined },
  { name: "sender-subject", query: "harbor reference" },
  { name: "body-only", query: "appointment" },
  { name: "sender-and-body", query: "harbor confirmed" },
  { name: "no-match", query: "absent-token" },
  { name: "four-terms-at-end", query: maxTerms.split(" ").slice(0, 4).join(" ") },
  { name: "eight-terms-at-end", query: maxTerms.split(" ").slice(0, 8).join(" ") },
  { name: "maximum-terms", query: maxTerms },
];
const datasets = [];
for (const size of sizes) {
  const directory = mkdtempSync(join(tmpdir(), "orca-search-benchmark-"));
  const { db, sqlite } = createDatabaseClient(join(directory, "mail.sqlite"));
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    setMailSearchEnabled(sqlite, true);
    db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
    db.insert(oauthAccounts).values(["a", "b"].map(id => ({ id, userId: "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
    const thread = sqlite.prepare("INSERT INTO threads (id,account_id,provider_thread_id) VALUES (?,?,?)");
    const mail = sqlite.prepare("INSERT INTO emails (id,account_id,thread_id,provider_message_id,from_name,from_address,subject,snippet,body_text,received_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const seedStarted = performance.now();
    sqlite.transaction(() => {
      for (let i = 0; i < size; i++) {
        const id = `message-${String(i).padStart(5, "0")}`, account = i % 2 ? "a" : "b";
        const match = i % 100 === 99;
        thread.run(id, account, id);
        const messageBody = largeBodyEvery > 0 && i % largeBodyEvery === 0 ? body.repeat(Math.ceil(300 * 1024 / body.length)).slice(0, 300 * 1024) : body;
        mail.run(id, account, id, id, match ? "Blue Harbor Studio" : "Routine Sender", "booking@example.com", "Your reference images", "Thanks for your ideas.", `${messageBody}\n${maxTerms}\n${match ? "Your appointment is confirmed." : "No booking yet."}`, size - i);
      }
    })();
    const seedMs = performance.now() - seedStarted;
    const pageSize = (sqlite.query("pragma page_size").get() as { page_size: number }).page_size;
    const pageCount = (sqlite.query("pragma page_count").get() as { page_count: number }).page_count;
    const storage = {
      totalDatabaseBytes: pageSize * pageCount,
      indexedSourceOctets: (sqlite.query("select sum(metadata_octets + body_octets) as bytes from mail_search_documents").get() as { bytes: number }).bytes,
      // Logical posting blocks, not complete on-disk FTS size (page/tree overhead excluded).
      metadataPostingBlockBytes: (sqlite.query("select coalesce(sum(octet_length(block)),0) as bytes from mail_search_metadata_v1_data").get() as { bytes: number }).bytes,
      fullPostingBlockBytes: (sqlite.query("select coalesce(sum(octet_length(block)),0) as bytes from mail_search_full_v1_data").get() as { bytes: number }).bytes,
    };
    const readers = { ...(baseline ? { before: baseline(sqlite, { searchBodyText: true }) } : {}), after: createMailboxReader(sqlite, { searchBodyText: true }) };
    const results = [];
    for (const scenario of scenarios) for (const [version, reader] of Object.entries(readers)) {
      const durations = []; let count: number | null = 0, projected = 0, bound = 0, maximumTimerDelayMs = 0, admissionCode: string | null = null;
      for (let sample = -warmups; sample < samples; sample++) {
        const started = performance.now();
        const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0));
        let page;
        try { page = reader.read({ authorization: { userId: "owner" }, query: { view: "all", limit: 25, query: scenario.query } }); }
        catch (error) {
          if (!(error instanceof MailSearchAdmissionError)) throw error;
          admissionCode = error.code; count = null;
        }
        const duration = performance.now() - started;
        const timerDelay = await timer;
        if (sample >= 0) maximumTimerDelayMs = Math.max(maximumTimerDelayMs, timerDelay);
        if (sample >= 0) durations.push(duration);
        if (page) {
          count = page.response.counts.attention.all;
          projected = Math.max(projected, page.metric.pageRowsProjected); bound = page.metric.maxPageRowsBound;
          assert(page.metric.pageRowsProjected <= bound);
          assert(page.response.messages.every(message => !("bodyText" in message)));
        }
      }
      durations.sort((a,b) => a-b);
      results.push({ scenario: scenario.name, version, count, admissionCode, p50Ms: +durations[Math.floor(samples / 2)]!.toFixed(2), p95Ms: +durations[Math.ceil(samples * .95) - 1]!.toFixed(2), maximumTimerDelayMs: +maximumTimerDelayMs.toFixed(2), maxRowsProjected: projected, maxRowsBound: bound });
    }
    const coldConnection = createDatabaseClient(join(directory, "mail.sqlite"));
    let freshConnectionMs;
    try {
      const started = performance.now();
      try { createMailboxReader(coldConnection.sqlite, { searchBodyText: true }).read({ authorization: { userId: "owner" }, query: { view: "all", limit: 25, query: maxTerms } }); }
      catch (error) { if (!(error instanceof MailSearchAdmissionError)) throw error; }
      freshConnectionMs = performance.now() - started;
    } finally { coldConnection.sqlite.close(); }
    datasets.push({ messages: size, bodyBytes: Buffer.byteLength(body), largeBodyEvery, largeBodyBytes: largeBodyEvery ? 300 * 1024 : 0, seedWithIndexMs: +seedMs.toFixed(2), storage, freshSQLiteConnectionMaximumTermsMs: +freshConnectionMs.toFixed(2), samples, warmups, results });
  } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ syntheticOnly: true, note: "Local warm-cache timings, not a production SLA. Fresh SQLite connection retains the OS page cache. Seed timing includes canonical mail and transactional index maintenance.", datasets }, null, 2));
