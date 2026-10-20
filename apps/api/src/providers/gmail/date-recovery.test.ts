import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { storeProviderTokens } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emailAttachments, emailLabels, emails, oauthAccounts, organizationFacets, organizationThreadFacetValues, threads, users } from "../../db/schema.ts";
import { GmailApiError, type GmailClient } from "./client.ts";
import { persistGmailMessages, recoverGmailMessageDates, syncGmailAccountPage } from "./sync.ts";
import { backfillGmailAccount, syncGmailAccountHistory } from "./push.ts";
import type { GmailMessage } from "./types.ts";
import { createDefaultGmailSyncCoordinator } from "./sync-runtime.ts";

const now = new Date("2026-10-16T12:00:00Z");
const corrected = "1782671400000";
function message(id: string, internalDate = "invalid"): GmailMessage {
  return { id, threadId: `thread-${id}`, internalDate, labelIds: ["INBOX", "STARRED"], payload: {
    headers: [{ name: "Subject", value: "Preserve synthetic mail" }], mimeType: "text/plain",
    body: { data: Buffer.from("Preserve body").toString("base64") },
  } };
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { f.cleanup(); }
}
async function setup() {
  const priorKey = process.env.TOKEN_ENCRYPTION_KEY;
  const priorSecret = process.env.SESSION_SECRET;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  process.env.SESSION_SECRET = "synthetic-session-secret-long-enough";
  const directory = mkdtempSync(join(tmpdir(), "orca-date-recovery-"));
  const { db, sqlite } = createDatabaseClient(join(directory, "synthetic.sqlite"));
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  db.insert(users).values({ id: "user", email: "owner@example.com" }).run();
  for (const id of ["a", "b"]) {
    db.insert(oauthAccounts).values({ id, userId: "user", provider: "gmail", providerEmail: `${id}@example.com`, providerId: id, syncHistoryId: "100", lastSyncedAt: now }).run();
    await storeProviderTokens(db, { oauthAccountId: id, accessToken: `token-${id}`, refreshToken: null, tokenExpiry: null });
  }
  const seed = (accountId: string, gmailMessages: GmailMessage[]) => persistGmailMessages(db, {
    accountId, accountEmail: `${accountId}@example.com`, gmailMessages, labelList: [], now,
    propagationTrigger: "sync", propagationOptions: { enabled: false },
  });
  const calls: string[] = [];
  let response = (id: string): GmailMessage => message(id, corrected);
  const client: GmailClient = {
    async listLabels() { return []; },
    async listInboxMessagePage() { return { messageIds: [], nextCursor: null }; },
    async listHistory() { return { messageIds: [], deletedMessageIds: [], nextCursor: null, historyId: "101" }; },
    async getMessage(token, id) { calls.push(`${token}:${id}`); return response(id); },
    async getMessageMetadata(token, id) { calls.push(`${token}:${id}`); return response(id); },
  };
  const row = (id: string, account = "a") => db.select().from(emails).where(eq(emails.id, `gmail:${account}:${id}`)).get()!;
  const page = () => syncGmailAccountPage(db, { accountId: "a", gmailClient: client, now });
  const history = (historyId = "101") => syncGmailAccountHistory(db, { accountId: "a", gmailClient: client, now, historyId });
  return { db, dbFactory: () => createDatabaseClient(join(directory, "synthetic.sqlite")), seed, row, page, history, calls, client, respond(fn: typeof response) { response = fn; }, cleanup() {
    sqlite.close(); rmSync(directory, { recursive: true, force: true });
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
    if (priorSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = priorSecret;
  } };
}

test("empty incremental page revisits unknown dates without changing mail or another account", () => fixture(async f => {
  await f.seed("a", [message("shared")]); await f.seed("b", [message("shared")]);
  const before = f.row("shared"), other = f.row("shared", "b");
  assert.equal(before.internalDate, null);
  f.respond(id => ({ ...message(id, corrected), payload: { body: { data: "d3Jvbmc=" } }, labelIds: [] }));
  await f.page();
  assert.deepEqual(f.calls, ["token-a:shared"]);
  const after = f.row("shared");
  assert.equal(after.receivedAt?.getTime(), Number(corrected));
  assert.equal(after.internalDate?.getTime(), Number(corrected));
  for (const key of ["bodyText", "bodyHtml", "subject", "isRead", "isStarred", "threadId"] as const) assert.equal(after[key], before[key]);
  assert.deepEqual(f.row("shared", "b"), other);
  assert.equal(f.db.select().from(threads).where(eq(threads.id, after.threadId)).get()?.latestReceivedAt?.getTime(), Number(corrected));
}));

for (const historyId of ["101", "100"]) test(`history ${historyId} revisits unknown dates without delta IDs`, () => fixture(async f => {
  await f.seed("a", [message("history")]);
  await f.history(historyId);
  assert.deepEqual(f.calls, ["token-a:history"]);
  assert.equal(f.row("history").receivedAt?.getTime(), Number(corrected));
}));

test("genuine epoch is excluded; legacy epoch revalidated once; repaired epoch stays confirmed", () => fixture(async f => {
  await f.seed("a", [message("genuine", "0"), message("legacy", "0"), message("unknown")]);
  f.db.update(emails).set({ providerSnapshotDigest: "legacy-hash" }).where(eq(emails.id, "gmail:a:legacy")).run();
  f.respond(id => message(id, "0"));
  await f.page(); await f.page();
  assert.deepEqual(f.calls.sort(), ["token-a:legacy", "token-a:unknown"]);
  assert.equal(f.row("unknown").internalDate?.getTime(), 0);
  assert.equal(f.row("legacy").internalDate?.getTime(), 0);
  const repairedDigest = f.row("unknown").providerSnapshotDigest;
  await f.seed("a", [message("unknown", "0")]);
  assert.notEqual(f.row("unknown").providerSnapshotDigest, repairedDigest, "next full sync must replace repair sentinel");
}));

test("bounded retries rotate past invalid and unavailable messages even with an unchanged clock", () => fixture(async f => {
  await f.seed("a", Array.from({ length: 23 }, (_, i) => message(`id-${String(i).padStart(2, "0")}`)));
  f.respond(id => {
    if (id === "id-00") throw new GmailApiError("synthetic missing", 404);
    if (id === "id-01") throw new Error("synthetic unavailable");
    return message(id);
  });
  const preserved = f.row("id-00").bodyText;
  await f.page(); assert.equal(f.calls.length, 20);
  await f.page(); assert.equal(f.calls.length, 40);
  assert.equal(new Set(f.calls).size, 23);
  assert.equal(f.row("id-00").bodyText, preserved);
  assert.equal(f.db.select().from(emails).all().length, 23);
}));

test("recovery rejects provider identity mismatch and supports clients without metadata", () => fixture(async f => {
  await f.seed("a", [message("mismatch")]);
  delete f.client.getMessageMetadata;
  f.respond(() => message("other", corrected));
  await f.page();
  assert.equal(f.row("mismatch").internalDate, null);
  assert.equal(f.db.select().from(emails).all().length, 1);
  f.respond(id => ({ ...message(id, corrected), threadId: "wrong-thread" })); await f.page();
  assert.equal(f.row("mismatch").internalDate, null);
  f.respond(id => message(id, corrected)); await f.page();
  assert.equal(f.row("mismatch").internalDate?.getTime(), Number(corrected));
}));


test("date-only repair preserves attachments, labels, thread flags and Organization values", () => fixture(async f => {
  const mail = message("preserve");
  mail.payload!.parts = [{ filename: "synthetic.txt", mimeType: "text/plain", body: { attachmentId: "synthetic-attachment", size: 1 } }];
  await f.seed("a", [mail]);
  const threadId = f.row("preserve").threadId;
  f.db.update(threads).set({ isRead: false, messageCount: 77 }).where(eq(threads.id, threadId)).run();
  f.db.insert(organizationFacets).values({ id: "required", workspaceId: "user", name: "Required", position: 0,
    valueType: JSON.stringify({ kind: "text", maxLength: 20 }), cardinality: JSON.stringify({ kind: "single" }),
    isOptional: false, defaultValue: JSON.stringify("default") }).run();
  f.db.insert(organizationFacets).values({ id: "custom", workspaceId: "user", name: "Custom", position: 1,
    valueType: JSON.stringify({ kind: "text", maxLength: 20 }), cardinality: JSON.stringify({ kind: "single" }), isOptional: true }).run();
  f.db.insert(organizationThreadFacetValues).values({ workspaceId: "user", facetId: "custom", accountId: "a", threadId, value: JSON.stringify("user choice"), updatedAt: now }).run();
  const facets = f.db.select().from(organizationThreadFacetValues).all();
  const beforeThread = f.db.select().from(threads).where(eq(threads.id, threadId)).get()!;
  const attachments = f.db.select().from(emailAttachments).all();
  const labels = f.db.select().from(emailLabels).all();
  await f.page();
  const afterThread = f.db.select().from(threads).where(eq(threads.id, threadId)).get()!;
  assert.equal(afterThread.isRead, beforeThread.isRead);
  assert.equal(afterThread.messageCount, beforeThread.messageCount);
  assert.equal(afterThread.subject, "Preserve synthetic mail");
  assert.equal(afterThread.latestReceivedAt?.getTime(), Number(corrected));
  assert.ok(attachments.length); assert.ok(labels.length);
  assert.deepEqual(f.db.select().from(emailAttachments).all(), attachments);
  assert.deepEqual(f.db.select().from(emailLabels).all(), labels);
  assert.deepEqual(f.db.select().from(organizationThreadFacetValues).all(), facets);
  const { subject: _bs, latestReceivedAt: _bd, updatedAt: _bu, ...beforeStable } = beforeThread;
  const { subject: _as, latestReceivedAt: _ad, updatedAt: _au, ...afterStable } = afterThread;
  assert.deepEqual(afterStable, beforeStable);
}));

test("recovery rejects another account's lease and never writes after lease loss", () => fixture(async f => {
  await f.seed("a", [message("lease")]);
  const before = f.row("lease");
  const lease = { accountId: "b", owner: "synthetic", version: 1, assert() {}, renew() { return true; } };
  const run = () => recoverGmailMessageDates(f.db, { accountId: "a", accessToken: "token-a", gmailClient: f.client, now, leaseGuard: lease });
  await assert.rejects(run, /lease account mismatch/);
  assert.equal(f.calls.length, 0);
  lease.accountId = "a";
  f.respond(id => { lease.assert = () => { throw new Error("synthetic lease lost"); }; return message(id, corrected); });
  await assert.rejects(run, /synthetic lease lost/);
  assert.deepEqual(f.row("lease"), before);
}));

test("an in-flight recovery cannot overwrite a concurrent successful normalization", () => fixture(async f => {
  await f.seed("a", [message("race")]);
  const winningTime = "1782671500000";
  f.client.getMessageMetadata = async (_token, id) => {
    await f.seed("a", [message(id, winningTime)]);
    return message(id, corrected);
  };
  await f.page();
  assert.equal(f.row("race").receivedAt?.getTime(), Number(winningTime));
}));


test("failed legacy revalidation never certifies an ambiguous epoch", () => fixture(async f => {
  await f.seed("a", [message("legacy-failure", "0")]);
  f.db.update(emails).set({ providerSnapshotDigest: null }).where(eq(emails.id, "gmail:a:legacy-failure")).run();
  f.respond(() => { throw new GmailApiError("synthetic unavailable", 404); });
  await f.page();
  assert.equal(f.row("legacy-failure").providerSnapshotDigest, null);
  f.respond(id => message(id, "0"));
  await f.page(); await f.page();
  assert.equal(f.calls.length, 2);
}));


test("multi-page backfill shares one twenty-message recovery budget", () => fixture(async f => {
  await f.seed("a", Array.from({ length: 23 }, (_, i) => message(`backfill-${i}`)));
  f.respond(id => message(id));
  let pages = 0;
  f.client.listInboxMessagePage = async () => ({ messageIds: [], nextCursor: ++pages < 3 ? `page-${pages}` : null });
  await backfillGmailAccount(f.db, { accountId: "a", gmailClient: f.client, now, maxPages: 3 });
  assert.equal(pages, 3);
  assert.equal(f.calls.length, 20);
}));

test("legacy null internal date with a real received date is not treated as fallback mail", () => fixture(async f => {
  await f.seed("a", [message("real-date", corrected)]);
  f.db.update(emails).set({ internalDate: null, providerSnapshotDigest: null }).where(eq(emails.id, "gmail:a:real-date")).run();
  await f.page();
  assert.equal(f.calls.length, 0);
  assert.equal(f.row("real-date").receivedAt?.getTime(), Number(corrected));
}));


test("coordinator incremental pagination shares one recovery budget", () => fixture(async f => {
  await f.seed("a", Array.from({ length: 23 }, (_, i) => message(`incremental-${i}`)));
  f.respond(id => message(id));
  let pages = 0;
  f.client.listInboxMessagePage = async () => ({ messageIds: [], nextCursor: ++pages < 3 ? `page-${pages}` : null });
  const coordinator = createDefaultGmailSyncCoordinator({ dbFactory: f.dbFactory, gmailClient: f.client, now: () => now,
    config: { topicName: null, verificationToken: null, syncIntervalMs: 60000, watchRenewalWindowMs: 60000, backfillPageSize: 25, backfillMaxPages: 3 } });
  coordinator.enqueue({ accountId: "a", source: "manual" });
  const result = await coordinator.drainAccount("a");
  assert.equal(result.completed, true);
  assert.equal(pages, 3);
  assert.equal(f.calls.length, 20);
}));

for (const push of [false, true]) test(`watch renewal and fallback share the primary recovery budget (push=${push})`, () => fixture(async f => {
  await f.seed("a", Array.from({ length: 23 }, (_, i) => message(`watch-${i}`)));
  f.respond(id => message(id));
  let histories = 0;
  f.client.listHistory = async () => ({ messageIds: [], deletedMessageIds: [], nextCursor: null, historyId: String(101 + histories++) });
  f.client.watch = async () => ({ historyId: "102", expiration: String(now.getTime() + 86400000) });
  const coordinator = createDefaultGmailSyncCoordinator({ dbFactory: f.dbFactory, gmailClient: f.client, now: () => now,
    config: { topicName: "projects/synthetic/topics/gmail", verificationToken: "synthetic", syncIntervalMs: 60000, watchRenewalWindowMs: 60000, backfillPageSize: 25, backfillMaxPages: 3 } });
  if (push) coordinator.enqueue({ accountId: "a", source: "push", historyId: "101" });
  coordinator.enqueue({ accountId: "a", source: "fallback" });
  const result = await coordinator.drainAccount("a");
  assert.equal(result.completed, true);
  assert.equal(f.calls.length, 20);
  assert.equal(histories, push ? 2 : 1);
}));
