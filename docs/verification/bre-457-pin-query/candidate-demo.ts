/** Owned loopback HTTP/SQLite demo + finite sparse/dense work receipts. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseClient } from "../../../apps/api/src/db/client.ts";
import { createQueryResultsFixture, foreignAccount, ownerAccount } from "../../../apps/api/src/organization/collections-pins/query-results.fixture.ts";
import { readSavedQueryResults } from "../../../apps/api/src/organization/collections-pins/query-results-reader.ts";
import type { MailboxReadMetric } from "../../../apps/api/src/mailbox/read.ts";
import { organizationSavedQueryResultResponseSchema } from "../../../packages/shared/src/organization-saved-query-results.ts";

const output = Bun.argv[2];
if (!output) throw new Error("Expected a new evidence JSON path");
const httpFetch = globalThis.fetch;
const fixture = await createQueryResultsFixture();
let server: ReturnType<typeof Bun.serve> | undefined;
const http: unknown[] = [];
const work: unknown[] = [];
try {
  await fixture.preconditions();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => fixture.app.fetch(request) });
  for (const scenario of [
    { name: "notify-only", queryId: fixture.query({ mailbox: "inbox", attention: "notify", classification: "all", text: "attention-marker" }), ids: ["notify"] },
    { name: "Unicode-cross-field-person", queryId: fixture.query({ mailbox: "all", attention: "all", sender: "élodie other@", text: "maya" }), ids: ["person"] },
  ]) {
    const response = await httpFetch(new URL(fixture.url(scenario.queryId), server.url), { headers: fixture.headers });
    assert.equal(response.status, 200);
    const body = organizationSavedQueryResultResponseSchema.parse(await response.json());
    assert.deepEqual(body.messages.map(message => message.id), scenario.ids);
    http.push({ name: scenario.name, status: response.status, cacheControl: response.headers.get("cache-control"), body });
  }
  const foreign = await httpFetch(new URL(fixture.url(fixture.catalogQueryId, { accountId: foreignAccount }), server.url), { headers: fixture.headers });
  assert.equal(foreign.status, 404);
  http.push({ name: "foreign-account", status: foreign.status, body: await foreign.json() });

  // Same finite mailbox, same selected account/order/page limit. Sparse differs
  // only in its extra person predicate. These timings are descriptive, not a speedup.
  for (let index = 0; index < 330; index += 1) {
    fixture.seedMessage(`work-${String(index).padStart(3, "0")}`, {
      name: index % 33 === 0 ? "İSTANBUL" : "Other", subject: "work-fixture-marker",
      at: Date.parse("2026-11-01T12:02:00.000Z"),
    });
  }
  const dense = fixture.query({ mailbox: "all", attention: "all", text: "work-fixture-marker" });
  const sparse = fixture.query({ mailbox: "all", attention: "all", text: "work-fixture-marker", sender: "i\u0307stanbul" });
  for (const round of [0, 1, 2]) {
    for (const [name, queryId] of (round % 2 ? [["sparse", sparse], ["dense", dense]] : [["dense", dense], ["sparse", sparse]])) {
      const { sqlite } = createDatabaseClient(join(fixture.directory, "synthetic.sqlite"));
      let metric: MailboxReadMetric | undefined;
      let selectPreparations = 0;
      const query = sqlite.query.bind(sqlite);
      sqlite.query = ((sql: string, ...args: unknown[]) => {
        if (/^\s*(select|with)\b/i.test(sql)) selectPreparations += 1;
        return query(sql, ...args as []);
      }) as typeof sqlite.query;
      const beforeRss = process.memoryUsage().rss;
      const started = performance.now();
      try {
        const response = readSavedQueryResults(sqlite, {
          auth: fixture.session, authSource: "cookie", queryId: queryId!,
          query: { accountId: ownerAccount, limit: 3 }, cursorSecret: process.env.SESSION_SECRET!,
          observe(value) { metric = value; },
        });
        const milliseconds = performance.now() - started;
        assert.equal(response.messages.length, 3);
        assert.ok(metric?.savedQuery);
        assert.ok(metric.savedQuery.maxRetainedRows <= 5);
        if (name === "sparse") assert.ok(metric.savedQuery.candidateRowsScanned > 4, "Sparse work must scan beyond a first page");
        assert.deepEqual(sqlite.query("SELECT total_changes() AS changes").get(), { changes: 0 });
        work.push({ name, round, limit: 3, fixtureWorkRows: 330, milliseconds, rssBefore: beforeRss, rssAfter: process.memoryUsage().rss, selectPreparations, metric });
      } finally { sqlite.close(); }
    }
  }
  assert.deepEqual(fixture.calls, { network: 0, sync: 0, transport: 0 });
  writeFileSync(output, `${JSON.stringify({ http, work, localHttpRequests: 3, runtimeSqlFunctionRegistration: typeof Reflect.get(fixture.sqlite, "function") === "function", providerCalls: fixture.calls, requestConnectionChanges: fixture.connectionChanges, limitations: ["Synthetic loopback HTTP, not live mail/native acceptance", "Worst-case streaming work is O(candidates); no database-work bound follows from the page limit", "SELECT preparation count is not VM-step count; timings/RSS are noisy finite-run observations"] }, null, 2)}\n`);
} finally {
  if (server) await server.stop(true);
  fixture.close();
}
