/**
 * Deterministic work comparison; never uses a live mailbox or elapsed-time gates.
 * Materialize the published base's read.ts beside the current reader, then set
 * MAILBOX_BASELINE_MODULE to its absolute path. See docs/verification/empty-attention-pages.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../src/db/client.ts";
import { createMailboxReader, type MailboxReadQuery } from "../src/mailbox/read.ts";

const baselinePath = Bun.env.MAILBOX_BASELINE_MODULE;
if (!baselinePath) throw new Error("Set MAILBOX_BASELINE_MODULE to the published base's read.ts copy");
const baselineModule = await import(pathToFileURL(resolve(baselinePath)).href) as { createMailboxReader: typeof createMailboxReader };
const baseTime = Date.parse("2026-09-02T12:00:00.000Z");
const authorization = { userId: "benchmark-user", accountIds: ["account-a", "account-b"] };
const results: Array<{ messages: number; scenario: string; pagesCompared: number; firstPageQueries: { baseline: number; optimized: number }; baselinePageQueries: number; optimizedPageQueries: number }> = [];

for (const messageCount of [5_000, 20_000]) {
  const directory = mkdtempSync(join(tmpdir(), "orca-empty-attention-benchmark-"));
  const client = createDatabaseClient(join(directory, "fixture.sqlite"));
  try {
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    client.sqlite.run("insert into users (id, email) values ('benchmark-user', 'benchmark@example.com')");
    const account = client.sqlite.prepare(`insert into oauth_accounts
      (id, user_id, provider, provider_id, provider_email, last_synced_at, created_at)
      values (?, 'benchmark-user', 'gmail', ?, ?, ?, ?)`);
    const thread = client.sqlite.prepare(`insert into threads
      (id, account_id, provider_thread_id, subject, latest_received_at, message_count)
      values (?, ?, ?, ?, ?, 1)`);
    const email = client.sqlite.prepare(`insert into emails
      (id, account_id, thread_id, provider_message_id, from_address, from_name, subject, snippet,
       received_at, human_classification, human_signal, human_classification_reasons, human_classifier_version)
      values (?, ?, ?, ?, ?, 'Synthetic Sender', ?, 'Synthetic mailbox benchmark', ?, ?, ?, ?, 'fixture-v1')`);
    client.sqlite.transaction(() => {
      for (const [index, id] of authorization.accountIds.entries()) account.run(id, id, `${id}@example.com`, baseTime, baseTime + index);
      for (let index = 0; index < messageCount; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        const accountId = authorization.accountIds[index % 2]!;
        // Repeated timestamps exercise stable account/ID tie-breaking.
        const timestamp = baseTime - Math.floor(index / 4) * 1_000;
        const classification = index % 3 === 0 ? "automated_or_bulk" : "likely_human";
        thread.run(`thread-${suffix}`, accountId, `provider-thread-${suffix}`, `Subject ${suffix}`, timestamp);
        email.run(`message-${suffix}`, accountId, `thread-${suffix}`, `provider-message-${suffix}`,
          `sender-${suffix}@group-${index % 5}.example`, `Subject ${suffix}`, timestamp,
          classification, classification === "likely_human" ? 8 : 2,
          JSON.stringify([classification === "likely_human" ? "direct_recipient" : "list_id_header"]));
      }
    })();
    const baseline = baselineModule.createMailboxReader(client.sqlite);
    const optimized = createMailboxReader(client.sqlite);
    function compare(scenario: string, query: MailboxReadQuery, expectedFirstPageQueries?: [number, number]) {
      let cursor: string | undefined;
      let baselinePageQueries = 0;
      let optimizedPageQueries = 0;
      let pagesCompared = 0;
      let firstPageQueries = { baseline: 0, optimized: 0 };
      do {
        const input = { authorization, query: { ...query, cursor } };
        const before = baseline.read(input);
        const after = optimized.read(input);
        // Includes accounts, all counts, message enrichment, freshness and exact cursor bytes.
        assert.deepEqual(after.response, before.response, scenario);
        assert.ok(after.metric.accountPageQueries <= before.metric.accountPageQueries, scenario);
        assert.equal(after.metric.pageRowsProjected, before.metric.pageRowsProjected, scenario);
        if (pagesCompared === 0) firstPageQueries = { baseline: before.metric.accountPageQueries, optimized: after.metric.accountPageQueries };
        if (pagesCompared === 0 && expectedFirstPageQueries) {
          assert.equal(before.metric.accountPageQueries, expectedFirstPageQueries[0], `${scenario}: baseline`);
          assert.equal(after.metric.accountPageQueries, expectedFirstPageQueries[1], `${scenario}: optimized`);
        }
        baselinePageQueries += before.metric.accountPageQueries;
        optimizedPageQueries += after.metric.accountPageQueries;
        pagesCompared += 1;
        cursor = after.response.nextCursor ?? undefined;
      } while (cursor && pagesCompared < 3);
      results.push({ messages: messageCount, scenario, pagesCompared, firstPageQueries, baselinePageQueries, optimizedPageQueries });
    }
    compare("normal-only default", { limit: 100 }, [6, 2]);
    compare("empty Focus", { view: "focus", limit: 100 }, [4, 0]);
    compare("empty search", { view: "all", query: "no fixture matches this", limit: 100 }, [10, 0]);
    compare("empty sender", { view: "all", sender: "absent@example.com", limit: 100 }, [10, 0]);
    compare("empty date range", { view: "all", receivedAfter: new Date(baseTime + 1).toISOString(), limit: 100 }, [10, 0]);
    compare("normal-only All Mail", { view: "all", limit: 100 }, [6, 2]);
    compare("human classification", { view: "all", classification: "human", limit: 100 }, [6, 2]);
    compare("empty classification", { view: "all", classification: "uncertain", limit: 100 }, [10, 2]);
    compare("sender and date filters", { view: "all", sender: "group-2.example", receivedBefore: new Date(baseTime - 10_000).toISOString(), limit: 100 });

    const rule = client.sqlite.prepare(`insert into sender_attention_rules
      (id, account_id, scope, value, behavior, source) values (?, ?, 'domain', ?, ?, 'user_choice')`);
    for (const id of authorization.accountIds) {
      for (const [index, behavior] of ["notify", "focus", "normal", "quiet", "hidden"].entries()) {
        rule.run(`${id}-${behavior}`, id, `group-${index}.example`, behavior);
      }
    }
    for (const view of ["focus", "normal", "quiet", "hidden", "all"] as const) {
      compare(`mixed attention ${view}`, { view, limit: 100 });
    }
    for (const behavior of ["notify", "focus", "normal", "quiet", "hidden"] as const) {
      client.sqlite.run("update sender_attention_rules set behavior = ?", [behavior]);
      compare(`only ${behavior}`, { view: "all", limit: 100 });
    }
  } finally {
    client.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ fixture: "two-account synthetic, repeated timestamps", results }, null, 2));
