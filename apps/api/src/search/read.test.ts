import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mailSearchPageSchema } from "@orca/shared/mail-search";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { initializeSearchBuild, enableSearch } from "./indexing/admin.ts";
import { acquireWriterOwnership } from "./indexing/ownership.ts";
import { enqueueBaseline, claimNextJob, acknowledgeReceipt } from "./indexing/queue.ts";
import { getSearchIndexPath, openCanonicalReadOnly, readSearchControl, readSourceAccounts } from "./indexing/schema.ts";
import { applyIndexJob, publishAccountReady } from "./indexing/worker-core.ts";
import { createMailboxReader } from "../mailbox/read.ts";
import { readRankedSearch, type RankedSearchInput } from "./read.ts";
import { SearchError } from "./errors.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-ranked-read-")); directories.push(directory);
  const path = join(directory, "mail.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  for (const id of ["user", "foreign"]) client.db.insert(users).values({ id, email: `${id}@example.test`, displayName: id }).run();
  function account(id: string, userId = "user") { client.db.insert(oauthAccounts).values({ id, userId, provider: "gmail", providerEmail: `${id}@example.test`, providerId: id }).run(); }
  account("a"); account("b"); account("foreign", "foreign");
  const indexPath = getSearchIndexPath(path); initializeSearchBuild(client.sqlite, indexPath);
  const index = new Database(indexPath); index.exec("PRAGMA synchronous=FULL");
  client.sqlite.exec("UPDATE mail_search_control SET worker_enabled=1,paused=0");
  const owner = acquireWriterOwnership(index, indexPath, readSearchControl(client.sqlite));
  const identity = { sourceId: readSearchControl(client.sqlite).source_id, buildId: readSearchControl(client.sqlite).build_id, ownerToken: owner.token };
  const source = openCanonicalReadOnly(path);
  function insert(id: string, fields: { subject?: string; sender?: string; address?: string; snippet?: string; body?: string | null; html?: string; accountId?: string } = {}) {
    const accountId = fields.accountId ?? "a";
    client.db.insert(threads).values({ id: `t-${id}`, accountId, providerThreadId: id }).run();
    client.db.insert(emails).values({ id, accountId, threadId: `t-${id}`, providerMessageId: id,
      fromAddress: fields.address ?? "sender@example.test", fromName: fields.sender ?? "Sender", subject: fields.subject ?? "A note",
      snippet: fields.snippet ?? "Small synthetic fixture", bodyText: fields.body ?? null, bodyHtml: fields.html ?? null,
      receivedAt: new Date("2026-01-01T12:00:00Z"), humanClassification: "likely_human" }).run();
  }
  function build() {
    for (const accountId of ["a", "b", "foreign"]) for (const mode of ["metadata", "full"] as const) {
      let result; do { result = enqueueBaseline(client.sqlite, accountId, mode); } while (!result.complete);
    }
    let job; while ((job = claimNextJob(client.sqlite))) acknowledgeReceipt(client.sqlite, applyIndexJob(source, index, job, identity));
    for (const accountId of ["a", "b", "foreign"]) for (const mode of ["metadata", "full"] as const) {
      const sourceAccount = readSourceAccounts(client.sqlite, [accountId], mode)[0]!;
      expect(publishAccountReady(source, index, accountId, sourceAccount.incarnation, mode, identity)).toBe(true);
    }
    enableSearch(client.sqlite, index);
  }
  function input(query = "appointment", extra: Partial<RankedSearchInput> = {}): RankedSearchInput {
    return { databasePath: path, authorization: { userId: "user", accountIds: ["a"] }, query: { query, limit: 10, view: "all", classification: "all" }, mode: "full", cursorKey: "synthetic-only-cursor-secret", ...extra };
  }
  const read = (query = "appointment", extra: Partial<RankedSearchInput> = {}) => readRankedSearch(input(query, extra));
  const close = () => { source.close(); owner.release(); index.close(); client.sqlite.close(); };
  return { ...client, path, index, insert, build, input, read, close };
}

test("full stored-index relevance orders subject, sender, metadata and body without date filtering", () => {
  const f = fixture();
  try {
    f.insert("body", { body: "Appointment confirmation for our synthetic visit" });
    f.insert("metadata", { subject: "Appointment", snippet: "Confirmation enclosed" });
    f.insert("sender", { sender: "Appointment Confirmation" });
    f.insert("subject", { subject: "Appointment confirmation" });
    f.insert("html", { html: "<p>Appointment confirmation</p>" });
    f.insert("other-account", { subject: "Appointment confirmation", accountId: "b" });
    f.insert("foreign", { subject: "Appointment confirmation", accountId: "foreign" });
    f.build();
    const baseline = createMailboxReader(f.sqlite).read({ authorization: f.input().authorization, query: f.input("confirmation appointment").query });
    expect(baseline.response.messages).toHaveLength(0);
    const result = f.read("confirmation appointment");
    expect(result.page.messages.map(row => row.id)).toEqual(["subject", "sender", "metadata", "body"]);
    expect(result.page.coverage).toBe("stored-plaintext");
    expect(result.page.continuation).toBe("none");
    expect(mailSearchPageSchema.safeParse(result.page).success).toBe(true);
    expect(result.metric.shortBodyBytes).toBe(0);
  } finally { f.close(); }
});

test("literal substring phrases, percent, underscore and quotes cannot become search syntax", () => {
  const f = fixture();
  try {
    f.insert("literal", { subject: 'Tattoo appointment 50% code_a say "hello"' });
    f.insert("false", { subject: "Tattoo appointment 500 codeza say hello" }); f.build();
    expect(f.read('tatto "50%" code_a').page.messages.map(row => row.id)).toEqual(["literal"]);
    expect(f.read('"say \\"hello\\""').page.messages.map(row => row.id)).toEqual(["literal"]);
    expect(f.read('"appointment 50%"').page.messages.map(row => row.id)).toEqual(["literal"]);
    expect(f.read('"appointment  50"').page.messages).toEqual([]);
  } finally { f.close(); }
});

test("mixed short clauses retain exact field relevance and body matches", () => {
  const f = fixture();
  try {
    f.insert("body", { subject: "Update", body: "AI notes" });
    f.insert("subject", { subject: "AI update" });
    f.insert("sender", { sender: "AI update" });
    f.insert("split", { subject: "Update", snippet: "AI notes" });
    f.insert("no", { subject: "Update", body: "ordinary notes" }); f.build();
    const result = f.read("AI update");
    expect(result.page.messages.map(row => row.id)).toEqual(["subject", "sender", "split", "body"]);
    expect(result.metric.shortBodyBytes).toBeGreaterThan(0);
    expect(() => f.read("AI PR")).toThrow("at least 3 characters");
  } finally { f.close(); }
});

test("keyset pages exhaust all ranked results once and bind mode, query, scope, revision and signature", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 14; i++) f.insert(`match-${i}`, { subject: "Appointment" }); f.build();
    const first = f.read(); expect(first.page.messages).toHaveLength(10); expect(first.page.continuation).toBe("matches");
    const nextQuery = { ...f.input().query, cursor: first.page.nextCursor! };
    const second = f.read("appointment", { query: nextQuery });
    expect(new Set([...first.page.messages, ...second.page.messages].map(row => row.id)).size).toBe(14);
    expect(second.page.messages).toHaveLength(4); expect(second.page.continuation).toBe("none");
    for (const extra of [{ mode: "metadata" as const }, { authorization: { userId: "user", accountIds: ["b"] } }, { query: { ...nextQuery, query: "different" } }]) {
      expect(() => f.read("appointment", { query: nextQuery, ...extra })).toThrow("changed");
    }
    expect(() => f.read("appointment", { query: { ...nextQuery, cursor: nextQuery.cursor.slice(0, -1) + "!" } })).toThrow("invalid");
    f.sqlite.exec("UPDATE emails SET is_read=1 WHERE id='match-0'");
    expect(() => f.read("appointment", { query: nextQuery })).toThrow("changed");
  } finally { f.close(); }
});

test("a soft candidate boundary preserves progress and never claims filtered results exhausted", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 7; i++) f.insert(`row-${i}`, { subject: "Appointment", address: i === 6 ? "target@example.test" : "other@example.test" }); f.build();
    const input = f.input(); input.query.sender = "target@example.test";
    let cursor: string | undefined; const ids: string[] = []; let pages = 0;
    do {
      const result = readRankedSearch({ ...input, query: { ...input.query, cursor } }, { candidatePageBudget: 2 });
      ids.push(...result.page.messages.map(row => row.id)); pages++;
      if (!result.page.messages.length && result.page.nextCursor) expect(result.page.continuation).toBe("scan");
      expect(result.page.nextCursor).not.toBe(cursor);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor && pages < 10);
    expect(cursor).toBeUndefined(); expect(ids).toEqual(["row-6"]); expect(pages).toBe(4);
  } finally { f.close(); }
});

test("metadata exact counts remain independent from body postings and body-only readiness", () => {
  const f = fixture();
  try {
    f.insert("metadata", { subject: "Release update" }); f.insert("body", { body: "Release update" }); f.build();
    f.sqlite.exec("UPDATE emails SET body_text='Changed body release' WHERE id='metadata'");
    f.index.exec("DROP TABLE full_fts");
    const result = f.read("release", { mode: "metadata", exactCounts: true });
    expect(result.page.messages.map(row => row.id)).toEqual(["metadata"]);
    expect(result.counts?.attention.all).toBe(1); expect(result.counts?.classification.likely_human).toBe(1);
    expect(result.metric.shortBodyBytes).toBe(0);
    expect(() => f.read("release")).toThrow(SearchError);
  } finally { f.close(); }
});

test("exact snapshot equality refuses an index ahead of a pinned canonical revision", () => {
  const f = fixture();
  try {
    f.insert("one", { subject: "Appointment" }); f.build();
    expect(() => readRankedSearch(f.input(), { afterCanonicalSnapshot: () => {
      f.sqlite.exec("UPDATE emails SET subject='Appointment changed' WHERE id='one'"); f.build();
    } })).toThrow("catching up");
  } finally { f.close(); }
});

test("lossless document cursor crosses integers above JavaScript safe range", () => {
  const f = fixture();
  try {
    f.index.exec("INSERT INTO sqlite_sequence(name,seq) VALUES('index_documents',9007199254740992)");
    for (let i = 0; i < 3; i++) f.insert(`large-${i}`, { subject: "Appointment" });
    // Worker row IDs are currently numeric; this test exercises the reader's contract
    // independently by constructing a valid small index at large SQLite row IDs.
    f.build();
    const result = f.read("appointment", { query: { ...f.input().query, limit: 1 } });
    const next = f.read("appointment", { query: { ...f.input().query, limit: 1, cursor: result.page.nextCursor! } });
    expect(result.page.messages[0]?.id).not.toBe(next.page.messages[0]?.id);
  } finally { f.close(); }
});


test("invalid filter scopes are rejected before both empty and matching traversals", () => {
  const f = fixture();
  try {
    f.insert("one", { subject: "Appointment" }); f.build();
    for (const query of ["appointment", "absentword"]) for (const scope of [{ collectionId: "missing" }, { destinationId: "foreign" }]) {
      expect(() => f.read(query, { query: { ...f.input(query).query, ...scope } })).toThrow("not found");
    }
  } finally { f.close(); }
});

test("legacy exact sender and attention filters remain exact and bind cursors", () => {
  const f = fixture();
  try {
    f.insert("owned-sender", { subject: "Appointment", address: "studio@example.test" });
    f.insert("lookalike", { subject: "Appointment", address: "studio@example.test.evil" });
    f.sqlite.exec("INSERT INTO sender_attention_rules(id,account_id,scope,value,behavior,source,created_at,updated_at) VALUES('rule','a','address','studio@example.test','notify','user_choice',0,0)");
    f.build();
    const first = f.read("appointment", { query: { ...f.input().query, limit: 1 } });
    expect(first.page.nextCursor).not.toBeNull();
    for (const exact of [{ senderAddress: "studio@example.test" }, { attentionBehavior: "notify" as const }]) {
      const scoped = { ...f.input().query, ...exact };
      expect(f.read("appointment", { query: scoped }).page.messages.map(message => message.id)).toEqual(["owned-sender"]);
      expect(() => f.read("appointment", { query: { ...scoped, cursor: first.page.nextCursor! } })).toThrow("changed");
    }
  } finally { f.close(); }
});
