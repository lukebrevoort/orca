import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { agentEvents, emails, oauthAccounts, threadReminders, threads, users } from "../db/schema.ts";
import { buildSummary } from "./rules.ts";
import { querySummary } from "./query.ts";
const clients: ReturnType<typeof createDatabaseClient>[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.sqlite.close(); });
const now = new Date("2026-11-03T17:00:00Z");
const day = 86400000;
function setup() {
  const c = createDatabaseClient(":memory:"); clients.push(c);
  migrate(c.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  c.db.insert(users).values([{ id: "u", email: "user@example.test" }, { id: "other", email: "other@example.test" }]).run();
  c.db.insert(oauthAccounts).values(["a", "b", "private"].map(id => ({ id, userId: id === "private" ? "other" : "u", provider: "gmail", providerId: id, providerEmail: `${id}@example.test` }))).run();
  function messageRows(id: string, accountId = "a", patch: Partial<typeof emails.$inferInsert> = {}) {
    return { thread: { id, accountId, providerThreadId: id }, email: { id, accountId, threadId: id, providerMessageId: id, fromAddress: "sender@example.test", toRecipients: JSON.stringify([{ email: `${accountId}@example.test` }]), receivedAt: now, humanClassification: "likely_human", humanSignal: 8, humanClassificationReasons: "[]", ...patch } };
  }
  function eventRow(id: string, lifecycleState: string, accountId = "a") {
    return { id: `event-${id}`, ownerUserId: accountId === "private" ? "other" : "u", accountId, messageId: id, threadId: id, providerMessageId: id, provider: "gmail", senderAddress: "sender@example.test", sourceSubject: "subject", sourceReceivedAt: now, sourceUrl: "https://example.test", trigger: "sync", policyVersion: "v1", agentId: "agent", agentVersion: "v1", executionMode: "deterministic", eventKind: "request", importance: "normal", relevance: "direct", destination: "inbox", reasonCodes: "[]", title: "<script>event</script>", summary: "summary", whyThisMatters: "why", deduplicationKey: id, assessmentFingerprint: id, evaluatedAt: now, lifecycleState } satisfies typeof agentEvents.$inferInsert;
  }
  function message(id: string, accountId = "a", patch: Partial<typeof emails.$inferInsert> = {}) {
    const rows = messageRows(id, accountId, patch);
    c.db.insert(threads).values(rows.thread).run();
    c.db.insert(emails).values(rows.email).run();
  }
  function event(id: string, lifecycleState: string, accountId = "a") {
    c.db.insert(agentEvents).values(eventRow(id, lifecycleState, accountId)).run();
  }
  return { ...c, message, event, messageRows, eventRow };
}
test("owned account only: same-user second account and other user never leak", () => {
  const f = setup();
  for (const a of ["a", "b", "private"]) { f.message(a, a); f.event(a, "new", a); }
  const a = querySummary(f.db, "u", "a", now);
  expect(a.messages.map(m => m.id)).toEqual(["a"]);
  expect(a.events.map(e => e.messageId)).toEqual(["a"]);
  expect(buildSummary(a, now).needsYou.map(i => i.source.messageId)).toEqual(["a"]);
  expect(querySummary(f.db, "u", "b", now).messages.map(m => m.id)).toEqual(["b"]);
  expect(() => querySummary(f.db, "u", "private", now)).toThrow("Mail account was not found");
  expect(() => querySummary(f.db, "other", "a", now)).toThrow();
  expect(() => querySummary(f.db, "u", "missing", now)).toThrow();
});
test("SQL filters inactive event and reminder statuses, preserves plain markup and skips malformed reasons", () => {
  const f = setup();
  for (const state of ["new", "seen", "dismissed", "muted", "retracted", "unexpected"]) {
    f.message(state, "a", { humanClassification: "unclassified", humanSignal: null, subject: "<script>subject</script>", snippet: "<b>snippet</b>" }); f.event(state, state);
  }
  for (const status of ["scheduled", "resurfaced", "cancelled", "completed", "unexpected"]) {
    const id = `rem-${status}`; f.message(id, "a", { humanClassification: "unclassified", humanSignal: null });
    f.db.insert(threadReminders).values({ id, accountId: "a", threadId: id, status, scheduledFor: now, timezone: "America/New_York" }).run();
  }
  f.message("bad", "a", { humanClassificationReasons: "{bad" }); f.event("bad", "new");
  const data = querySummary(f.db, "u", "a", now);
  expect(data.events.map(e => e.lifecycleState).sort()).toEqual(["new", "new", "seen"]);
  expect(data.reminders.map(r => r.status).sort()).toEqual(["resurfaced", "scheduled"]);
  const result = buildSummary(data, now);
  expect(result.needsYou.map(i => i.source.messageId).sort()).toEqual(["new", "rem-resurfaced", "seen"]);
  expect(result.needsYou.find(i => i.source.messageId === "new")).toMatchObject({ title: "<script>event</script>", snippet: "<b>snippet</b>" });
});
test("10k-row account reads at most 500, truncates body before materialization, bounded events/reminders and caps tiles", () => {
  const f = setup();
  f.db.transaction(() => {
    // 500 rows stay below Bun SQLite's 32766-variable limit, including defaults.
    const batchSize = 500;
    for (let start = 0; start < 10000; start += batchSize) {
      const rows = Array.from({ length: Math.min(batchSize, 10000 - start) }, (_, offset) => {
        const i = start + offset;
        return f.messageRows(`m${String(i).padStart(5, "0")}`, "a", { bodyText: i === 9999 ? "x".repeat(30000) : "body" });
      });
      f.db.insert(threads).values(rows.map(row => row.thread)).run();
      f.db.insert(emails).values(rows.map(row => row.email)).run();
    }
    for (let start = 9400; start < 10000; start += batchSize) {
      const ids = Array.from({ length: Math.min(batchSize, 10000 - start) }, (_, offset) => `m${String(start + offset).padStart(5, "0")}`);
      f.db.insert(agentEvents).values(ids.map(id => f.eventRow(id, "new"))).run();
      f.db.insert(threadReminders).values(ids.map(id => ({ id, accountId: "a", threadId: id, status: "resurfaced", scheduledFor: now, timezone: "UTC" }))).run();
    }
  });
  const data = querySummary(f.db, "u", "a", now);
  expect(data.messages).toHaveLength(500);
  expect(data.messages[0]?.id).toBe("m09999");
  expect(data.messages[0]?.bodyText?.length).toBe(20000);
  expect(data.events).toHaveLength(500); expect(data.reminders).toHaveLength(500);
  expect(buildSummary(data, now).needsYou).toHaveLength(20);
}, 30000);
test("window and invalid-time boundaries", () => {
  const f = setup();
  f.message("edge", "a", { receivedAt: new Date(now.getTime() - 14 * day) });
  f.message("old", "a", { receivedAt: new Date(now.getTime() - 14 * day - 1) });
  f.message("future", "a", { receivedAt: new Date(now.getTime() + 1) });
  f.message("null", "a", { receivedAt: null });
  expect(querySummary(f.db, "u", "a", now).messages.map(m => m.id)).toEqual(["edge"]);
  expect(() => querySummary(f.db, "u", "a", new Date(NaN))).toThrow();
});
test("active events and resurfaced reminders retain source references outside the mail window", () => {
  const f = setup();
  for (const id of ["old-event", "old-reminder"]) f.message(id, "a", { receivedAt: new Date(now.getTime() - 30 * day) });
  f.event("old-event", "seen");
  f.db.insert(threadReminders).values({ id: "rem", accountId: "a", threadId: "old-reminder", status: "resurfaced", scheduledFor: now, timezone: "UTC" }).run();
  const data = querySummary(f.db, "u", "a", now);
  expect(data.messages).toEqual([]);
  expect(buildSummary(data, now).needsYou.map(i => i.source.messageId)).toEqual(["old-event", "old-reminder"]);
});
test("reminders stay isolated between accounts of the same and different owners", () => {
  const f = setup();
  for (const accountId of ["a", "b", "private"]) {
    f.message(`message-${accountId}`, accountId);
    f.db.insert(threadReminders).values({ id: `reminder-${accountId}`, accountId, threadId: `message-${accountId}`, status: "resurfaced", scheduledFor: now, timezone: "UTC" }).run();
  }
  for (const accountId of ["b", "private"]) {
    f.db.insert(threadReminders).values({ id: `hostile-reminder-${accountId}`, accountId, threadId: "message-a", status: "resurfaced", scheduledFor: now, timezone: "UTC" }).run();
  }
  for (const accountId of ["a", "b", "private"]) {
    const data = querySummary(f.db, accountId === "private" ? "other" : "u", accountId, now);
    expect(data.reminders.map(r => [r.accountId, r.threadId, r.sourceMessage?.id])).toEqual([[accountId, `message-${accountId}`, `message-${accountId}`]]);
  }
});
test("SQL bounds million-character subjects and snippets in all source projections", () => {
  const f = setup();
  f.message("huge", "a", { subject: "s".repeat(1000000), snippet: "x".repeat(1000000) });
  f.event("huge", "new");
  f.db.insert(threadReminders).values({ id: "huge-reminder", accountId: "a", threadId: "huge", status: "resurfaced", scheduledFor: now, timezone: "UTC" }).run();
  const data = querySummary(f.db, "u", "a", now);
  for (const m of [data.messages[0], data.events[0]?.sourceMessage, data.reminders[0]?.sourceMessage]) {
    expect(m?.subject).toBe("s".repeat(300));
    expect(m?.snippet).toBe("x".repeat(500));
  }
});
