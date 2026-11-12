/** PREPARED, NOT EXECUTED. Real Hono callbacks/SQLite; no server or method patches. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { organizationSavedQueryDefinitionSchema, organizationSavedQueryResultResponseSchema } from "@orca/shared";
import { createDatabaseClient } from "../../../apps/api/src/db/client.ts";
import { emails, importanceChoices, organizationSavedQueries, threads } from "../../../apps/api/src/db/schema.ts";
import { createQueryImportanceBaselineFixture, importanceReceipt } from "../../../apps/api/src/organization/collections-pins/query-importance-baseline.fixture.ts";
import { readSavedQueryResults } from "../../../apps/api/src/organization/collections-pins/query-results-reader.ts";
import type { MailboxReadMetric } from "../../../apps/api/src/mailbox/read.ts";

const output = process.argv[2];
if (!output) throw new Error("Allocated candidate demo requires an external output path");
const f = await createQueryImportanceBaselineFixture();
const observations: unknown[] = [];
try {
  await f.preconditions();
  for (let i = 0; i < 120; i += 1) {
    const id = `importance-work-${String(i).padStart(3, "0")}`;
    const at = new Date(Date.parse("2026-11-02T12:00:00Z") - i * 1000);
    f.client.db.insert(threads).values({ id, accountId: f.queryU.accountId, providerThreadId: id, messageCount: 1, latestReceivedAt: at }).run();
    f.client.db.insert(emails).values({ id, accountId: f.queryU.accountId, threadId: id, providerMessageId: id,
      fromAddress: "same@synthetic.example", fromName: i % 25 === 0 ? "MAYA" : "Other",
      subject: "finite paired metadata work", snippet: "no private body", receivedAt: at, createdAt: at, humanClassification: "likely_human" }).run();
  }
  // Many real exact participants in one conversation exercise window work beyond output20.
  for (let i = 0; i < 40; i += 1) {
    const address = `work${i}@synthetic.example`;
    f.client.db.insert(emails).values({ id: `metadata-participant-${i}`, accountId: f.queryU.accountId,
      threadId: "importance-work-000", providerMessageId: `metadata-participant-${i}`, fromAddress: address,
      receivedAt: new Date("2026-10-01T00:00:00Z"), humanClassification: "likely_human" }).run();
    f.client.db.insert(importanceChoices).values({ accountId: f.queryU.accountId, kind: "sender", target: address,
      choice: "important", revision: 1, updatedAt: Date.now() }).run();
  }
  const queries = ["dense", "sparse"].map(name => {
    const id = `metadata-${name}-query`;
    f.client.db.insert(organizationSavedQueries).values({ id, accountId: f.queryU.accountId, name: id, revision: 2,
      definitionJson: JSON.stringify(organizationSavedQueryDefinitionSchema.parse({ revision: 1,
        filters: { mailbox: "all", attention: "all", classification: "all", ...(name === "sparse" ? { sender: "MAYA" } : {}) } })) }).run();
    return { name, id, accountId: f.queryU.accountId, revision: 2 };
  });
  for (let round = 0; round < 3; round += 1) {
    for (const query of queries) {
      let basicIds: string[] | undefined;
      for (const includeImportance of [false, true]) {
        const begin = performance.now(), rssBefore = process.memoryUsage().rss;
        const actual = await f.request(`HTTP-callback ${query.name} ${includeImportance} round${round}`,
          f.resultUrl(query).replace("limit=30", "limit=3"), { ...f.headersU, ...(includeImportance ? { "x-orca-importance-version": "1" } : {}) });
        assert.equal(actual.response.status, 200);
        const body = organizationSavedQueryResultResponseSchema.parse(actual.value);
        assert.equal(body.messages.length, 3);
        assert.ok(body.messages.every(row => includeImportance ? Boolean(row.importance) : row.importance === undefined));
        const ids = body.messages.map(row => row.id);
        if (!includeImportance) basicIds = ids; else assert.deepEqual(ids, basicIds);
        const http = { round, profile: query.name, includeImportance, rows: ids,
          callbackMs: performance.now() - begin, rssBefore, rssAfter: process.memoryUsage().rss, openedConnections: actual.openedConnections };
        let metric: MailboxReadMetric | undefined;
        const { sqlite } = createDatabaseClient(f.databasePath);
        try {
          const read = readSavedQueryResults(sqlite, { auth: f.sessionU, authSource: "cookie", queryId: query.id,
            query: { accountId: query.accountId, limit: 3 }, includeImportance, cursorSecret: process.env.SESSION_SECRET!,
            observe(value) { metric = value; assert.equal(sqlite.inTransaction, true); assert.deepEqual(sqlite.query("PRAGMA query_only").get(), { query_only: 1 }); } });
          assert.deepEqual(read.messages.map(row => row.id), ids);
          assert.deepEqual(sqlite.query("SELECT total_changes() changes").get(), { changes: 0 });
        } finally { sqlite.close(); }
        assert.ok(metric);
        observations.push({ ...http, metric, metricScope: "separate actual reader invocation on same fixture; not HTTP SQL instrumentation" });
        if (round === 0 && includeImportance) {
          const source = readFileSync(resolve("apps/api/src/importance/store.ts"), "utf8");
          const statements = [...source.matchAll(/sqlite\.query\(`(WITH wanted[\s\S]*?)`\)\.all\(\.\.\.params\)/g)].map(match => match[1]!.replace("${values}", body.messages.map(() => "(?,?)").join(",")));
          assert.equal(statements.length, 2, "Metadata replay must use exactly the current production batch statements");
          const spec = { statements, params: body.messages.flatMap(row => [row.accountId, row.threadId]), targetCount: body.messages.length,
            productionSourceSha256: createHash("sha256").update(source).digest("hex") };
          const input = join(resolve(output, ".."), `${query.name}-metadata-input.json`);
          const measured = join(resolve(output, ".."), `${query.name}-metadata-work.json`);
          writeFileSync(input, JSON.stringify(spec, null, 2) + "\n");
          const child = Bun.spawnSync([process.env.BRE457_METADATA_PYTHON ?? "python3", "docs/verification/bre-457-query-importance/metadata-work.py", f.databasePath, input, measured], { stdout: "pipe", stderr: "pipe" });
          assert.equal(child.exitCode, 0, child.stderr.toString());
          observations.push({ scope: "separate Python SQLite metadata-only replay", profile: query.name, measured: JSON.parse(readFileSync(measured, "utf8")) });
        }
      }
    }
  }
  writeFileSync(output, JSON.stringify({ kind: "real Hono HTTP callbacks and migrated SQLite finite fixture; no loopback server/browser/device",
    sourceWorkRows: 120, contributingParticipantsAdded: 40, limit: 3, rounds: 3, observations,
    limits: "O(candidates) query stream plus contributing-preference work; two batch SELECTs source prediction and separate Python SQL replay, never a Bun whole-request VM/SQL bound or speedup" }, null, 2) + "\n");
  importanceReceipt({ name: "candidate-demo-complete", output, callbacks: 12, actualReaderInvocations: 12, pythonMetadataReplays: 2 });
} finally { f.close(); }
