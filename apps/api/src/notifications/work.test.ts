import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { notificationFixture } from "./fixture.ts";
import { setMobilePushTestEnv, clearMobilePushTestEnv } from "../mobile-push/test-helpers.ts";
import { claimBrowser } from "./browser.ts";
import { randomUUID } from "node:crypto";
import { persistGmailMessages } from "../providers/gmail/sync.ts";

test("BRE-455 200-arrival account scan examines at most twenty per browser claim with metadata-only indexed SQL", async () => {
  setMobilePushTestEnv(); const f = await notificationFixture();
  try {
    await f.adopt(); await f.fresh("initial");
    // Disjoint conversations with real sender inheritance; no synthesized projection rows.
    const { previewImportance, mutateImportance } = await import("../importance/store.ts");
    const preview = previewImportance(f.sqlite, { userId: "u", accountId: "a" }, { accountId: "a", address: "receipt@example.net", choice: "important" }, f.state.now);
    mutateImportance(f.sqlite, { userId: "u", accountId: "a" }, { accountId: "a", target: { kind: "sender", address: "receipt@example.net" }, choice: "important", expectedRevision: 0, operationId: randomUUID(), confirmation: preview.confirmation }, f.state.now);
    f.state.now += 1000;
    await persistGmailMessages(f.db, { accountId: "a", accountEmail: "u@example.com", gmailMessages: Array.from({ length: 200 }, (_, i) => f.message(`work-${i}`)), labelList: [], now: new Date(f.state.now), propagationTrigger: "push", propagationOptions: { enabled: false } });
    const reads: string[] = [], rowCounts: number[] = [];
    const statements: { sql: string; method: string; args: unknown[]; returned: number }[] = [];
    const before = f.sqlite.serialize();
    const query = f.sqlite.query.bind(f.sqlite);
    f.sqlite.query = ((sql: string) => {
      const statement = query(sql);
      return new Proxy(statement, { get(target, key) {
        if (key === "all" || key === "get" || key === "run") return (...args: unknown[]) => {
          const result = (target[key] as (...v: unknown[]) => unknown).apply(target, args);
          const returned = Array.isArray(result) ? result.length : result ? 1 : 0;
          statements.push({ sql, method: String(key), args, returned });
          if (key !== "run") { reads.push(sql); rowCounts.push(returned); }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof f.sqlite.query;
    const result = claimBrowser(f.sqlite, { userId: "u", installationId: "browser", channel: "open_app" }, f.session.sessionId, { channel: "open_app", expectedRevision: 1, operationId: randomUUID(), permission: "granted" }, f.state.now);
    f.sqlite.query = query;
    expect(result.notifications.length).toBeLessThanOrEqual(20);
    expect(reads.some(sql => /body_text|body_html|snippet|attachments/i.test(sql))).toBe(false);
    const scan = reads.find(sql => sql.includes("FROM important_notification_arrivals a JOIN emails") && sql.includes("ORDER BY a.sequence LIMIT"))!;
    expect(scan).toBeDefined();
    const scanRows = rowCounts[reads.indexOf(scan)]!; expect(scanRows).toBe(20);
    const plan = f.sqlite.query(`EXPLAIN QUERY PLAN ${scan}`).all("a", 0, 20) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("important_notification_arrivals_account_idx"))).toBe(true);
    // Captured work is the actual observed statements/returned rows, not a timing speedup.
    const output = process.env.BRE455_SQL_WORK_PATH;
    if (output) {
      if (!output.startsWith("/tmp/bre455-work-")) throw Error("Synthetic work export must use a fresh /tmp/bre455-work- path");
      mkdirSync(output);
      writeFileSync(join(output, "before.sqlite"), before);
      writeFileSync(join(output, "statements.json"), JSON.stringify({ statements, scanRows, envelopes: result.notifications.length, reads: reads.length, returnedRows: rowCounts.reduce((a, b) => a + b, 0), plan }, null, 2));
    }
    console.log("BRE455_SQL_WORK", JSON.stringify({ arrivals: 202, scanRows, envelopes: result.notifications.length, reads: reads.length, returnedRows: rowCounts.reduce((a, b) => a + b, 0), plan }));
  } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
});
