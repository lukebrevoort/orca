import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { createApp } from "../index.ts";

// This same suite runs on the immutable parent before any implementation exists.
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { f.sqlite.close(); rmSync(f.dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(f.priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
async function setup() {
  const priorEnv = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "bre454-synthetic-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-bre454-")), path = join(dir, "fixture.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  db.insert(schema.users).values([{ id: "u1", email: "one@example.com" }, { id: "u2", email: "two@example.com" }]).run();
  db.insert(schema.oauthAccounts).values([
    { id: "a1", userId: "u1", provider: "gmail", providerId: "a1", providerEmail: "one@example.com" },
    { id: "a2", userId: "u1", provider: "gmail", providerId: "a2", providerEmail: "alias@example.com" },
    { id: "a3", userId: "u2", provider: "gmail", providerId: "a3", providerEmail: "two@example.com" },
  ]).run();
  function thread(id: string, accountId = "a1") {
    db.insert(schema.threads).values({ id, accountId, providerThreadId: ["t1", "t2", "t3"].includes(id) ? "shared-provider-ref" : id, subject: id, messageCount: 1 }).run();
  }
  function message(id: string, threadId: string, fromAddress = "robot@example.com", accountId = "a1", isDraft = false) {
    db.insert(schema.emails).values({ id, accountId, threadId, providerMessageId: id, fromAddress, subject: id,
      receivedAt: new Date(1000), bodyText: "private body", humanSignal: 0, humanClassification: "automated_or_bulk", isDraft }).run();
  }
  thread("t1"); message("m1", "t1"); thread("t2", "a2"); message("m2", "t2", "robot@example.com", "a2");
  thread("t3", "a3"); message("m3", "t3", "robot@example.com", "a3");
  const s1 = await createSession(db, "u1"), s2 = await createSession(db, "u2");
  let providerCalls = 0;
  const clock = { now: Date.now() };
  const app = createApp({ now: () => new Date(clock.now), dbFactory: () => createDatabaseClient(path), gmailClient: new Proxy({}, { get() { return () => { providerCalls++; throw Error("No provider calls allowed"); }; } }) as never });
  async function req(url: string, body?: unknown, user = 1, method = body === undefined ? "GET" : "POST") {
    const response = await app.request(url, { method, headers: { cookie: `orca_session=${user === 1 ? s1.token : s2.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json().catch(() => null) as any };
  }
  const target = (threadId = "t1") => ({ kind: "conversation", threadId });
  const read = (threadId = "t1", accountId = "a1") => req(`/v1/importance/conversations/${threadId}?accountId=${accountId}`);
  const write = (choice: string | null, expectedRevision = 0, threadId = "t1", accountId = "a1", operationId = randomUUID()) =>
    req("/v1/importance/choices", { accountId, target: target(threadId), choice, expectedRevision, operationId });
  const preview = (choice: string | null, address = "robot@example.com", accountId = "a1") => req("/v1/importance/preview", { accountId, address, choice });
  async function sender(choice: string | null, revision = 0, address = "robot@example.com", accountId = "a1") {
    const p = await preview(choice, address, accountId); expect(p.status).toBe(200);
    return req("/v1/importance/choices", { accountId, target: { kind: "sender", address }, choice, expectedRevision: revision, operationId: randomUUID(), confirmation: p.value.confirmation });
  }
  return { headers: { cookie: `orca_session=${s1.token}` }, clock, priorEnv, dir, path, db, sqlite, app, req, read, write, preview, sender, thread, message, providerCalls: () => providerCalls };
  } catch (error) {
    sqlite.close(); rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    throw error;
  }
}

test("BRE-454 durable conversation choices, independent DB/read projections and no mail side effects", () => fixture(async f => {
  const before = f.sqlite.query("select * from emails order by id").all();
  const placement = f.sqlite.query("select * from organization_effective_destinations order by thread_id").all();
  expect((await f.read()).status).toBe(200);
  const saved = await f.write("important"); expect(saved.status).toBe(200);
  expect(f.sqlite.query("select choice,revision from importance_choices where account_id='a1' and kind='conversation' and target='t1'").get()).toEqual({ choice: "important", revision: 1 });
  expect((await f.read()).value.importance.effective).toBe("important");
  const detail = await f.req("/v1/threads/t1?accountId=a1"); expect(detail.status).toBe(200); expect(detail.value.thread.importance.effective).toBe("important");
  const mailbox = await f.req("/v1/inbox?accountId=a1&view=all"); expect(mailbox.status).toBe(200); expect(mailbox.value.messages[0].importance.effective).toBe("important");
  const page = await f.req("/v1/threads/t1/messages?accountId=a1"); expect(page.value.importance.effective).toBe("important");
  f.message("later", "t1", "human@example.com");
  expect((await f.read()).value.importance.effective).toBe("important");
  f.sqlite.exec("update emails set human_signal=100,human_classification='likely_human' where id='later'");
  expect((await f.write("not_important", 1)).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("not_important");
  expect(f.sqlite.query("select * from emails where id in ('m1','m2','m3') order by id").all()).toEqual(before);
  expect(f.sqlite.query("select * from organization_effective_destinations order by thread_id").all()).toEqual(placement);
  for (const table of ["sender_attention_rules", "thread_attention_overrides", "organization_rules", "human_classification_overrides"]) expect((f.sqlite.query(`select count(*) n from ${table}`).get() as { n: number }).n).toBe(0);
  expect(f.providerCalls()).toBe(0);
}));

test("BRE-454 exact sender inheritance, distinct inbound aggregation, future mail and reset", () => fixture(async f => {
  expect((await f.sender("important")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("important");
  f.message("new-person", "t1", "human@example.com"); f.message("duplicate", "t1");
  const mixed = (await f.read()).value.importance;
  expect(mixed.effective).toBe("important"); expect(mixed.participantCounts).toEqual({ important: 1, notImportant: 0, unreviewed: 1, total: 2 });
  expect(mixed.preferences[0]).toMatchObject({ address: "robot@example.com", choice: "important", revision: 1 });
  expect((await f.sender("not_important", 1)).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("unreviewed");
  expect((await f.sender("not_important", 0, "human@example.com")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("not_important");
  expect((await f.write("important")).status).toBe(200);
  expect((await f.sender("important", 2)).status).toBe(200);
  expect((await f.write(null, 1)).status).toBe(200);
  expect((await f.read()).value.importance).toMatchObject({ effective: "important", conversation: { choice: null, revision: 2 }, source: "participants" });
  // Same exact sender in a new conversation inherits, without creating a thread override.
  f.sqlite.query("update threads set provider_thread_id='old' where id='t1'").run();
  f.thread("future"); f.message("future-mail", "future");
  expect((await f.read("future")).value.importance.effective).toBe("important");
  expect((await f.read("t2", "a2")).value.importance.effective).toBe("unreviewed");
  f.message("alias", "future", "robot+alias@example.com");
  expect((await f.read("future")).value.importance.participantCounts.unreviewed).toBe(1);
  f.sqlite.query("update threads set provider_thread_id='future-old' where id='future'").run();
  f.thread("empty"); f.message("outgoing", "empty", "one@example.com"); f.message("draft", "empty", "robot@example.com", "a1", true);
  expect((await f.read("empty")).value.importance).toMatchObject({ effective: "unreviewed", participantCounts: { total: 0 } });
}));

test("BRE-454 sender preview is read only, explains overrides/other participants, and requires current confirmation", () => fixture(async f => {
  expect((await f.write("important")).status).toBe(200);
  const before = f.sqlite.query("select * from importance_choices").all();
  const p = await f.preview("not_important"); expect(p.status).toBe(200);
  expect(p.value).toMatchObject({ existing: { matching: 1, overridden: 1, changed: 0 }, future: { accountId: "a1", address: "robot@example.com", preservesConversationOverrides: true, otherImportantParticipantsMayKeepImportant: true } });
  expect(f.sqlite.query("select * from importance_choices").all()).toEqual(before);
  const body = { accountId: "a1", target: { kind: "sender", address: "robot@example.com" }, choice: "not_important", expectedRevision: 0, operationId: randomUUID() };
  expect((await f.req("/v1/importance/choices", body)).status).toBe(409);
  f.message("additional", "t1", "second@example.com");
  expect((await f.req("/v1/importance/choices", { ...body, confirmation: p.value.confirmation })).status).toBe(409);
  expect((await f.sender("important", 0, "second@example.com")).status).toBe(200);
  expect((await f.write(null, 1)).status).toBe(200);
  const mixed = await f.preview("not_important"); expect(mixed.value.existing.keptImportantByOtherParticipants).toBe(1);
  expect((await f.sender("not_important")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("important");
}));

test("BRE-454 guarded Undo, ABA tombstones, retries and ambiguous-response reconciliation cannot overwrite newer choices", () => fixture(async f => {
  const op = randomUUID();
  const first = await f.write("important", 0, "t1", "a1", op); expect(first.status).toBe(200);
  expect((await f.write("important", 0, "t1", "a1", op)).status).toBe(200);
  expect((await f.read()).value.importance.conversation.revision).toBe(1);
  expect((await f.write("not_important", 0, "t1", "a1", op)).status).toBe(409);
  const reconcile = await f.req(`/v1/importance/operations/${op}?accountId=a1`); expect(reconcile.value.status).toBe("current");
  const undo = await f.req(`/v1/importance/operations/${op}/undo`, { accountId: "a1", operationId: randomUUID(), expectedRevision: 1 }); expect(undo.status).toBe(200);
  expect((await f.read()).value.importance.conversation).toMatchObject({ choice: null, revision: 2 });
  expect((await f.write("important", 0)).status).toBe(409);
  expect((await f.write("not_important", 2)).status).toBe(200);
  const superseded = await f.req(`/v1/importance/operations/${op}?accountId=a1`); expect(superseded.value.status).toBe("superseded"); expect(superseded.value.current.choice).toBe("not_important");
  expect((await f.req(`/v1/importance/operations/${op}/undo`, { accountId: "a1", operationId: randomUUID(), expectedRevision: 3 })).status).toBe(409);
  expect((await f.write("important", 0, "t1", "a1", op)).value.status).toBe("superseded");
  expect((await f.read()).value.importance.conversation.revision).toBe(3);
  const missing = await f.req(`/v1/importance/operations/${randomUUID()}?accountId=a1`); expect(missing.status).toBe(404);
}));

test("BRE-454 authorization, unknown/malformed targets, exact address and account isolation", () => fixture(async f => {
  expect((await f.write("important")).status).toBe(200);
  expect((await f.read("t2", "a1")).status).toBe(404);
  expect((await f.write("important", 0, "t3", "a3")).status).toBe(404);
  expect((await f.req("/v1/importance/conversations/t1?accountId=a1", undefined, 2)).status).toBe(404);
  expect((await f.write("important", 0, "missing")).status).toBe(404);
  expect((await f.read("t3", "a3")).status).toBe(404);
  expect((await f.req("/v1/importance/conversations/t3?accountId=a3", undefined, 2)).value.importance.effective).toBe("unreviewed");
  expect((await f.preview("important", "nobody@example.com")).status).toBe(404);
  for (const address of ["example.com", "*@example.com", "A <a@example.com>"]) expect((await f.preview("important", address)).status).toBe(400);
  expect((await f.req("/v1/importance/choices", { accountId: "a1", target: { kind: "conversation", threadId: "t1" }, choice: "unreviewed", expectedRevision: 1, operationId: randomUUID() })).status).toBe(400);
  expect((await f.app.request("/v1/importance/conversations/t1?accountId=a1")).status).toBe(401);
}));

test("BRE-454 Important retained-mail pages ignore provider placement, have scoped stale-safe cursors and load no bodies", () => fixture(async f => {
  expect((await f.write("important")).status).toBe(200);
  f.sqlite.query("update threads set provider_thread_id='original' where id='t1'").run();
  for (let i = 0; i < 4; i++) { f.thread(`list-${i}`); f.message(`lm-${i}`, `list-${i}`); expect((await f.write("important", 0, `list-${i}`)).status).toBe(200); }
  f.db.insert(schema.labels).values({ id: "inbox", accountId: "a1", providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
  // No thread has the INBOX label; all remain retained. Legacy quiet routing is irrelevant.
  f.db.insert(schema.senderAttentionRules).values({ id: "quiet", accountId: "a1", scope: "address", value: "robot@example.com", behavior: "quiet", source: "user" }).run();
  f.sqlite.query("update emails set body_text=? where account_id='a1'").run("x".repeat(1024 * 1024));
  const first = await f.req("/v1/important?accountId=a1&limit=2"); expect(first.status).toBe(200); expect(first.value.items.length).toBe(2); expect(first.value.nextCursor).toBeString();
  expect(JSON.stringify(first.value)).not.toContain("bodyText");
  const second = await f.req(`/v1/important?accountId=a1&limit=2&cursor=${encodeURIComponent(first.value.nextCursor)}`); expect(second.status).toBe(200);
  expect(new Set([...first.value.items, ...second.value.items].map((x: any) => x.threadId)).size).toBe(4);
  expect((await f.req(`/v1/important?accountId=a2&cursor=${encodeURIComponent(first.value.nextCursor)}`)).status).toBe(400);
  expect((await f.req("/v1/important?accountId=a3", undefined, 2)).value.items).toEqual([]);
  f.message("new-mail", "t1", "new@example.com");
  expect((await f.req(`/v1/important?accountId=a1&cursor=${encodeURIComponent(first.value.nextCursor)}`)).status).toBe(400);
  expect((await f.req("/v1/important?accountId=a1&limit=101")).status).toBe(400);
  expect(f.providerCalls()).toBe(0);
}));

test("BRE-454 revisions remain monotonic through reset/recreate and stale Undo, with current reset inheritance", () => fixture(async f => {
  const first = await f.write("important"); expect(first.status).toBe(200);
  expect((await f.write(null, 1)).status).toBe(200);
  expect((await f.write("not_important", 2)).status).toBe(200);
  expect((await f.req(`/v1/importance/operations/${first.value.receipt.operationId}/undo`, { accountId: "a1", operationId: randomUUID(), expectedRevision: 1 })).status).toBe(409);
  expect((await f.write("important", 1)).status).toBe(409);
  const last = await f.write(null, 3); expect(last.status).toBe(200);
  expect((await f.sender("important")).status).toBe(200);
  expect((await f.read()).value.importance).toMatchObject({ effective: "important", conversation: { choice: null, revision: 4 } });
  expect((await f.write("not_important", 0)).status).toBe(409);
  expect((await f.write("important", 4)).status).toBe(200);
  expect(f.sqlite.query("select revision from importance_choices where kind='conversation'").get()).toEqual({ revision: 5 });
}));

test("BRE-454 failed transaction rolls back; dropped response reconciles after restart without replaying over a newer write", () => fixture(async f => {
  f.sqlite.exec("CREATE TRIGGER synthetic_importance_failure BEFORE INSERT ON importance_operations BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  // A real SQLite error after the choice write must abort both the choice and derived state.
  const failed = await f.write("important"); expect(failed.status).toBe(500);
  expect((await f.read()).value.importance.conversation.revision).toBe(0);
  expect((f.sqlite.query("select count(*) n from importance_operations").get() as { n: number }).n).toBe(0);
  f.sqlite.exec("DROP TRIGGER synthetic_importance_failure");
  const operationId = randomUUID();
  await f.write("important", 0, "t1", "a1", operationId); // Deliberately discard response as a disconnected client would.
  const reopened = createDatabaseClient(f.path);
  try { expect(reopened.sqlite.query("select choice,revision from importance_choices where kind='conversation'").get()).toEqual({ choice: "important", revision: 1 }); } finally { reopened.sqlite.close(); }
  expect((await f.write("not_important", 1)).status).toBe(200);
  const reconcile = await f.req(`/v1/importance/operations/${operationId}?accountId=a1`);
  expect(reconcile.value).toMatchObject({ status: "superseded", current: { choice: "not_important", revision: 2 } });
  expect((await f.write("important", 0, "t1", "a1", operationId)).value.status).toBe("superseded");
  expect((await f.read()).value.importance.effective).toBe("not_important");
}));

test("BRE-454 provider SENT/draft transitions, sender updates/deletion, account address changes and cascades update participants", () => fixture(async f => {
  expect((await f.sender("important")).status).toBe(200);
  f.db.insert(schema.labels).values({ id: "sent", accountId: "a1", providerLabelId: "SENT", name: "Sent", type: "system" }).run();
  f.db.insert(schema.emailLabels).values({ id: "m1-sent", emailId: "m1", labelId: "sent" }).run();
  expect((await f.read()).value.importance).toMatchObject({ effective: "unreviewed", participantCounts: { total: 0 } });
  f.sqlite.exec("delete from email_labels where email_id='m1'");
  expect((await f.read()).value.importance.effective).toBe("important");
  f.sqlite.exec("update emails set from_address='new@example.com' where id='m1'");
  expect((await f.read()).value.importance.effective).toBe("unreviewed");
  expect((await f.sender("not_important", 0, "new@example.com")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("not_important");
  f.sqlite.exec("update oauth_accounts set provider_email='new@example.com' where id='a1'");
  expect((await f.read()).value.importance.participantCounts.total).toBe(0);
  f.sqlite.exec("delete from emails where id='m1'");
  expect((await f.read()).value.importance.effective).toBe("unreviewed");
  f.sqlite.exec("delete from oauth_accounts where id='a1'");
  expect((f.sqlite.query("select count(*) n from importance_choices where account_id='a1'").get() as { n: number }).n).toBe(0);
  expect((await f.read()).status).toBe(404);
}));

test("BRE-454 invalid JSON, content type, oversized body, operation ownership and cursor tampering are rejected", () => fixture(async f => {
  const saved = await f.write("important"); expect(saved.status).toBe(200);
  const op = saved.value.receipt.operationId;
  expect((await f.req(`/v1/importance/operations/${op}?accountId=a1`, undefined, 2)).status).toBe(404);
  expect((await f.req(`/v1/importance/operations/${op}/undo`, { accountId: "a2", operationId: randomUUID(), expectedRevision: 1 })).status).toBe(404);
  expect((await f.req("/v1/importance/choices", { accountId: "a1", target: { kind: "sender", address: "example.com" }, choice: "important", expectedRevision: 0, operationId: randomUUID() })).status).toBe(400);
  const headers = (await f.req("/v1/important?accountId=a1")).value;
  expect(headers.items.length).toBe(1);
  expect((await f.req("/v1/important?accountId=a1&cursor=abc.def.ghi")).status).toBe(400);
  const unauthenticated = await f.app.request("/v1/importance/choices", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  expect(unauthenticated.status).toBe(401);
  const malformed = await f.app.request("/v1/importance/choices", { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: "{" });
  expect(malformed.status).toBe(400);
  const wrongType = await f.app.request("/v1/importance/choices", { method: "POST", headers: { ...f.headers, "content-type": "text/plain" }, body: "{}" });
  expect(wrongType.status).toBe(400);
  expect((await f.req("/v1/importance/choices", { junk: "x".repeat(17 * 1024) })).status).toBe(413);
}));

test("BRE-454 preview and immediate Undo expire, concurrent initial writes serialize, and replay remains reconciliation", () => fixture(async f => {
  const command = { accountId: "a1", target: { kind: "sender", address: "robot@example.com" }, choice: "important", expectedRevision: 0, operationId: randomUUID() };
  const p = await f.preview("important"); expect(p.status).toBe(200);
  f.clock.now += 300_001;
  expect((await f.req("/v1/importance/choices", { ...command, confirmation: p.value.confirmation })).status).toBe(409);
  const races = await Promise.all([f.write("important"), f.write("not_important")]);
  expect(races.map(r => r.status).sort()).toEqual([200, 409]);
  const applied = races.find(r => r.status === 200)!;
  f.clock.now += 300_001;
  expect((await f.req(`/v1/importance/operations/${applied.value.receipt.operationId}/undo`, { accountId: "a1", operationId: randomUUID(), expectedRevision: 1 })).status).toBe(409);
  expect((await f.req(`/v1/importance/operations/${applied.value.receipt.operationId}?accountId=a1`)).value.status).toBe("current");
}));

test("BRE-454 existing routing/rule/read/provider state survives automated Important and human Not important choices", () => fixture(async f => {
  f.db.insert(schema.senderAttentionRules).values({ id: "legacy", accountId: "a1", scope: "address", value: "robot@example.com", behavior: "quiet", source: "user" }).run();
  f.sqlite.exec("update emails set human_signal=100,human_classification='likely_human',is_read=1 where id='m1'");
  const mail = f.sqlite.query("select * from emails").all();
  const rules = f.sqlite.query("select * from sender_attention_rules").all();
  const destinations = f.sqlite.query("select * from organization_effective_destinations").all();
  const beforeState = await f.req("/v1/inbox?accountId=a1&view=all");
  expect((await f.write("not_important")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("not_important");
  expect((await f.sender("important")).status).toBe(200);
  expect((await f.read()).value.importance.effective).toBe("not_important");
  expect(f.sqlite.query("select * from emails").all()).toEqual(mail);
  expect(f.sqlite.query("select * from sender_attention_rules").all()).toEqual(rules);
  expect(f.sqlite.query("select * from organization_effective_destinations").all()).toEqual(destinations);
  const afterState = await f.req("/v1/inbox?accountId=a1&view=all");
  expect(afterState.value.messages.map(({ importance, ...rest }: any) => rest)).toEqual(beforeState.value.messages.map(({ importance, ...rest }: any) => rest));
  expect(f.providerCalls()).toBe(0);
}));

test("BRE-454 provenance is bounded and truthful while aggregate counts include every distinct exact participant", () => fixture(async f => {
  for (let i = 0; i < 25; i++) {
    const address = `person${String(i).padStart(2, "0")}@example.com`;
    f.message(`participant-${i}`, "t1", address);
    f.sqlite.query("insert into importance_choices values('a1','sender',?,'important',1,1000)").run(address);
  }
  const importance = (await f.read()).value.importance;
  expect(importance.effective).toBe("important");
  expect(importance.participantCounts).toEqual({ important: 25, notImportant: 0, unreviewed: 1, total: 26 });
  expect(importance.preferences.length).toBe(20); expect(importance.preferencesTruncated).toBe(true);
  expect(importance.preferences[0].address).toBe("person00@example.com");
  expect(importance.preferences[19].address).toBe("person19@example.com");
}));
