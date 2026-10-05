import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, test } from "bun:test";
import { mailSearchTerms } from "@orca/shared";
import {
  backfillMailSearchBatch, MailSearchBackfillBudgetError, readMailSearchIndexStatus,
  setMailSearchEnabled, verifyMailSearchIndex,
} from "../db/mail-search-index.ts";
import {
  compileMailSearchMatch, mailSearchAnchors, MailSearchAdmissionError, MailSearchUnavailableError, prepareMailSearch,
} from "./search-index.ts";

const migration = readFileSync(new URL("../../drizzle/0051_indexed_mail_search.sql", import.meta.url), "utf8");
function database(migrateNow = true, path = ":memory:") {
  const sqlite = new Database(path);
  sqlite.exec(`PRAGMA foreign_keys=ON;
    create table oauth_accounts(id text primary key, user_id text not null);
    create table emails(id text primary key, account_id text not null references oauth_accounts(id) on delete cascade,
      from_name text, from_address text, subject text, snippet text, body_text text, is_read integer default 0);
    insert into oauth_accounts values('account-a','owner-a'),('account-b','owner-a'),('account-c','owner-c');`);
  if (migrateNow) sqlite.exec(migration);
  return sqlite;
}
function insert(sqlite: Database, id: string, fields: Partial<{
  account: string; name: string | null; address: string | null; subject: string | null; snippet: string | null; body: string | null;
}> = {}) {
  sqlite.query(`insert into emails(id,account_id,from_name,from_address,subject,snippet,body_text)
    values(?,?,?,?,?,?,?)`).run(id, fields.account ?? "account-a", fields.name ?? null, fields.address ?? null,
      fields.subject ?? null, fields.snippet ?? null, fields.body ?? null);
}
function search(sqlite: Database, query: string, body = true, owner = "owner-a", accounts?: string[]) {
  return sqlite.transaction(() => {
    const relation = prepareMailSearch(sqlite, {
      query, authorization: { userId: owner, ...(accounts ? { accountIds: accounts } : {}) }, searchBodyText: body,
    });
    const rows = sqlite.query(`${relation.sql}`).all(...relation.params) as Array<{ email_id: string }>;
    return rows.map(row => row.email_id).sort();
  })();
}
function activate(sqlite: Database) { setMailSearchEnabled(sqlite, true); }
function documentId(sqlite: Database, id: string) {
  return (sqlite.query("select document_id from mail_search_documents where email_id=?").get(id) as { document_id: number }).document_id;
}

describe("indexed mail search migration and lifecycle", () => {
  test("is additive, defaults disabled, and never silently serves a partial index", () => {
    const sqlite = database(false);
    try {
      insert(sqlite, "legacy", { body: "before migration" });
      assert.throws(() => search(sqlite, "migration"), MailSearchUnavailableError);
      sqlite.exec(migration);
      assert.equal(readMailSearchIndexStatus(sqlite).indexedMessages, 0);
      assert.equal(readMailSearchIndexStatus(sqlite).canonicalMessages, 1);
      assert.throws(() => search(sqlite, "migration"), MailSearchUnavailableError);
      assert.throws(() => activate(sqlite), /coverage is incomplete/);
      assert.equal(backfillMailSearchBatch(sqlite).complete, true);
      assert.throws(() => search(sqlite, "migration"), MailSearchUnavailableError);
      verifyMailSearchIndex(sqlite);
      assert.equal(readMailSearchIndexStatus(sqlite).phase, "ready");
      assert.throws(() => search(sqlite, "migration"), MailSearchUnavailableError);
      activate(sqlite);
      assert.deepEqual(search(sqlite, "migration"), ["legacy"]);
      setMailSearchEnabled(sqlite, false);
      assert.throws(() => search(sqlite, "migration"), MailSearchUnavailableError);
      assert.equal(readMailSearchIndexStatus(sqlite).canonicalMessages, 1);
    } finally { sqlite.close(); }
  });

  test("resumes committed cursor batches after closing the database, including concurrent old writers", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-search-resume-"));
    const path = join(directory, "search.sqlite");
    let sqlite = database(false, path);
    try {
      for (const id of ["b", "d", "f", "h"]) insert(sqlite, id, { body: `message ${id}` });
      sqlite.exec(migration);
      assert.deepEqual(backfillMailSearchBatch(sqlite, { batchRows: 2 }), { processed: 2, sourceOctets: 24, complete: false, lastEmailId: "d" });
      sqlite.close();
      sqlite = new Database(path); sqlite.exec("PRAGMA foreign_keys=ON");
      // A pre-cursor insert and an unbackfilled update are both maintained by triggers.
      insert(sqlite, "a", { body: "new message" });
      sqlite.query("update emails set body_text='updated message' where id='h'").run();
      sqlite.query("delete from emails where id='f'").run();
      assert.equal(backfillMailSearchBatch(sqlite, { batchRows: 2 }).complete, true);
      activate(sqlite);
      assert.deepEqual(search(sqlite, "message"), ["a", "b", "d", "h"]);
      assert.equal(readMailSearchIndexStatus(sqlite).indexedMessages, 4);
    } finally { sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("bounds backfill by octets, rejects oversized documents without advancing, and resumes safely", () => {
    const sqlite = database(false);
    try {
      insert(sqlite, "a", { body: "a".repeat(100) });
      insert(sqlite, "b", { body: "b".repeat(500) });
      sqlite.exec(migration);
      const batch = backfillMailSearchBatch(sqlite, { batchRows: 10, batchOctets: 200 });
      assert.equal(batch.processed, 1); assert.equal(batch.sourceOctets, 103); assert.equal(batch.complete, false);
      assert.throws(() => backfillMailSearchBatch(sqlite, { batchOctets: 200 }), MailSearchBackfillBudgetError);
      assert.equal(readMailSearchIndexStatus(sqlite).lastEmailId, "a");
      assert.equal(backfillMailSearchBatch(sqlite, { batchOctets: 600 }).complete, true);
      activate(sqlite);
      assert.deepEqual(search(sqlite, "bbbb"), ["b"]);
    } finally { sqlite.close(); }
  });

  test("keeps stable surrogate IDs through updates and VACUUM; updates/delete/disconnect are atomic", () => {
    const sqlite = database();
    try {
      activate(sqlite);
      insert(sqlite, "keep", { body: "old-token" });
      insert(sqlite, "remove", { body: "old-token" });
      const id = documentId(sqlite, "keep");
      sqlite.query("update emails set body_text='new-token', subject='changed-subject' where id='keep'").run();
      assert.equal(documentId(sqlite, "keep"), id);
      assert.deepEqual(search(sqlite, "old-token"), ["remove"]);
      assert.deepEqual(search(sqlite, "new-token changed-subject"), ["keep"]);
      sqlite.exec("delete from emails where id='remove'; VACUUM");
      assert.equal(documentId(sqlite, "keep"), id);
      assert.deepEqual(search(sqlite, "old-token"), []);
      assert.throws(() => sqlite.transaction(() => {
        sqlite.exec("update emails set body_text='rollback-token' where id='keep'");
        throw new Error("rollback");
      })());
      assert.deepEqual(search(sqlite, "rollback-token"), []);
      assert.deepEqual(search(sqlite, "new-token"), ["keep"]);
      sqlite.exec("delete from oauth_accounts where id='account-a'");
      assert.equal(readMailSearchIndexStatus(sqlite).indexedMessages, 0);
      assert.deepEqual(search(sqlite, "new-token"), []);
      verifyMailSearchIndex(sqlite);
    } finally { sqlite.close(); }
  });

  test("supports replacements and canonical ID/account changes without stale owner postings", () => {
    const sqlite = database();
    try {
      insert(sqlite, "mail", { body: "original-token" }); activate(sqlite);
      sqlite.exec("insert or replace into emails(id,account_id,body_text) values('mail','account-a','replacement-token')");
      assert.deepEqual(search(sqlite, "original-token"), []);
      assert.deepEqual(search(sqlite, "replacement-token"), ["mail"]);
      const id = documentId(sqlite, "mail");
      sqlite.exec("update emails set id='renamed', account_id='account-c' where id='mail'");
      assert.equal(documentId(sqlite, "renamed"), id);
      assert.deepEqual(search(sqlite, "replacement-token"), []);
      assert.deepEqual(search(sqlite, "replacement-token", true, "owner-c"), ["renamed"]);
      verifyMailSearchIndex(sqlite);
    } finally { sqlite.close(); }
  });

  test("refuses corrupt row coverage even if an operator marks the build ready", () => {
    const sqlite = database();
    try {
      insert(sqlite, "mail", { body: "matchable" });
      sqlite.exec("delete from mail_search_full_v1");
      assert.throws(() => activate(sqlite), /row coverage is inconsistent/);
      assert.equal(readMailSearchIndexStatus(sqlite).enabled, false);
    } finally { sqlite.close(); }
  });
});

describe("indexed literal matching and authority", () => {
  test("ANDs terms across metadata/body on the same message; phrases are contiguous", () => {
    const sqlite = database();
    try {
      insert(sqlite, "complete", { name: "Alice Example", subject: "Project orca", body: "weekly design review" });
      insert(sqlite, "partial", { name: "Alice Example", body: "weekly interrupted design review" });
      insert(sqlite, "other-message", { subject: "Project orca" }); activate(sqlite);
      assert.deepEqual(search(sqlite, 'alice orca "weekly design"'), ["complete"]);
      assert.deepEqual(search(sqlite, 'alice "weekly design"'), ["complete"]);
      assert.deepEqual(search(sqlite, 'alice "weekly design"', false), []);
    } finally { sqlite.close(); }
  });

  test("treats FTS operators, quotes, percent, underscore, backslash and phrases literally", () => {
    const sqlite = database();
    try {
      insert(sqlite, "literal", { body: 'red OR blue contains a%b_c and \\path and x"y and "" and https://example.test/a' });
      insert(sqlite, "nearby", { body: "red blue contains axbyc and path and xyz" }); activate(sqlite);
      for (const query of ['"red OR blue"', 'a%b_c', '\\path', 'x"y', '""', 'https://example.test/a', '%', '_']) {
        assert.deepEqual(search(sqlite, query), ["literal"], query);
      }
      assert.deepEqual(search(sqlite, 'NOT missing'), []);
      assert.throws(() => compileMailSearchMatch(['a"b', 'OR']), MailSearchAdmissionError);
    } finally { sqlite.close(); }
  });

  test("never lets explicit account IDs override owner scope", () => {
    const sqlite = database();
    try {
      insert(sqlite, "a", { body: "shared token" });
      insert(sqlite, "b", { account: "account-b", body: "shared token" });
      insert(sqlite, "c", { account: "account-c", body: "shared token" }); activate(sqlite);
      assert.deepEqual(search(sqlite, "shared", true, "owner-a"), ["a", "b"]);
      assert.deepEqual(search(sqlite, "shared", true, "owner-a", ["account-a", "account-c"]), ["a"]);
      assert.deepEqual(search(sqlite, "sh", true, "owner-a", ["account-c"]), []);
      assert.deepEqual(search(sqlite, "shared", true, "owner-a", []), []);
    } finally { sqlite.close(); }
  });

  test("matches existing SQLite literal semantics for Unicode, field separators, and embedded NUL", () => {
    const sqlite = database();
    try {
      insert(sqlite, "nul", { body: "a\0bc after" });
      insert(sqlite, "unicode", { name: "ÉLAN", subject: "résumé 漢字文 emoji🦊🦊🦊", body: "CASE FOLD" });
      insert(sqlite, "line", { name: "one", address: "two", body: "one\ntwo" }); activate(sqlite);
      assert.deepEqual(search(sqlite, "abc"), []);
      assert.deepEqual(search(sqlite, "after"), []);
      assert.deepEqual(search(sqlite, '"one\ntwo"'), ["line"]);
      assert.deepEqual(search(sqlite, 'résumé 漢字文 🦊🦊🦊'), ["unicode"]);
      assert.deepEqual(search(sqlite, 'CASE FOLD'), ["unicode"]);
      // Existing SQLite LIKE folds ASCII, not accented uppercase.
      assert.deepEqual(search(sqlite, "élan"), []);
      assert.throws(() => search(sqlite, "a\0b"), MailSearchAdmissionError);
    } finally { sqlite.close(); }
  });

  test("metadata-only search works with the body index absent and huge bodies outside its byte budget", () => {
    const sqlite = database();
    try {
      insert(sqlite, "huge", { subject: "metadata result", body: "body-only-secret ".repeat(700_000) }); activate(sqlite);
      sqlite.exec("drop table mail_search_full_v1");
      assert.deepEqual(search(sqlite, "metadata", false), ["huge"]);
      assert.deepEqual(search(sqlite, "me", false), ["huge"]);
      assert.deepEqual(search(sqlite, "body-only-secret", false), []);
    } finally { sqlite.close(); }
  });

  test("short terms narrow via longer terms and reuse only bounded matched IDs", () => {
    const sqlite = database();
    try {
      for (let n = 0; n < 505; n++) insert(sqlite, `${n}`, { body: n === 1 ? "unique-anchor xy" : "common xy" });
      activate(sqlite);
      assert.throws(() => search(sqlite, "xy"), MailSearchAdmissionError);
      assert.throws(() => search(sqlite, "common xy"), MailSearchAdmissionError);
      assert.deepEqual(search(sqlite, "unique-anchor xy"), ["1"]);
      assert.deepEqual(search(sqlite, "unique-anchor zz"), []);
      sqlite.transaction(() => {
        const relation = prepareMailSearch(sqlite, { query: "unique-anchor xy", authorization: { userId: "owner-a" }, searchBodyText: true });
        assert.equal(relation.strategy, "bounded-residual");
        assert.equal(relation.sql, "select value as email_id from json_each(?)");
        assert.deepEqual(relation.params, ['["1"]']);
      })();
    } finally { sqlite.close(); }
  });

  test("rejects short-term byte work before scanning large bodies even below row cap", () => {
    const sqlite = database();
    try {
      insert(sqlite, "large", { body: "anchor xy zz ".repeat(300_000) }); activate(sqlite);
      assert.deepEqual(search(sqlite, "anchor xy"), ["large"]);
      assert.throws(() => search(sqlite, "anchor xy zz"), MailSearchAdmissionError);
      assert.deepEqual(search(sqlite, "anchor"), ["large"]);
    } finally { sqlite.close(); }
  });

  test("rejects a 200-character repeated phrase before expensive body matching", () => {
    const sqlite = database();
    try {
      for (let n = 0; n < 100; n++) insert(sqlite, `${n}`, { body: "a".repeat(8 * 1024) });
      activate(sqlite);
      const query = "a".repeat(200);
      assert.deepEqual(mailSearchAnchors([query]), ["aaa"]);
      assert.equal(compileMailSearchMatch(mailSearchAnchors([query])), '\"aaa\"');
      assert.throws(() => search(sqlite, query), MailSearchAdmissionError);
      assert.deepEqual(search(sqlite, "aaaa"), Array.from({ length: 100 }, (_, n) => `${n}`).sort());
    } finally { sqlite.close(); }
  });

  test("verifies anchor false positives and rejects broad candidates instead of partial results", () => {
    const sqlite = database();
    try {
      insert(sqlite, "false-positive", { body: "abc one def two ghi" });
      activate(sqlite);
      assert.deepEqual(search(sqlite, "abcdefghi"), []);
      for (let n = 0; n < 500; n++) insert(sqlite, `${n}`, { body: "abc one def two ghi" });
      assert.throws(() => search(sqlite, "abcdefghi"), MailSearchAdmissionError);
    } finally { sqlite.close(); }
  });

  test("requires one read snapshot and enforces parser bounds", () => {
    const sqlite = database();
    try {
      activate(sqlite);
      assert.throws(() => prepareMailSearch(sqlite, { query: "hello", authorization: { userId: "owner-a" }, searchBodyText: true }), /shared read transaction/);
      assert.throws(() => search(sqlite, "a".repeat(201)), RangeError);
      assert.throws(() => search(sqlite, Array.from({ length: 17 }, (_, n) => `term${n}`).join(" ")), RangeError);
    } finally { sqlite.close(); }
  });

  test("agrees with escaped LIKE on a deterministic punctuation/Unicode corpus", () => {
    const sqlite = database();
    try {
      const alphabet = ['alpha', 'BETA', 'a%b', 'c_d', 'path\\abc', 'abc"def', 'écho', '漢字文', '🦊🦊🦊', 'foo\nbar', 'éÉé', 'abc\0def'];
      for (let n = 0; n < 80; n++) insert(sqlite, `mail-${n}`, {
        name: alphabet[n % alphabet.length], subject: alphabet[(n * 3 + 1) % alphabet.length],
        snippet: alphabet[(n * 7 + 2) % alphabet.length], body: alphabet[(n * 5 + 3) % alphabet.length],
      });
      activate(sqlite);
      for (const query of ['alpha', 'BETA', 'a%b', 'c_d', 'path\\abc', 'abc"def', 'écho', '漢字文', '🦊🦊🦊', '"foo\nbar"', 'éÉé', 'abc', 'def', 'alpha BETA', 'écho a%b', 'al', '%']) {
        for (const body of [false, true]) {
          const values: string[] = [];
          const predicates = mailSearchTerms(query).map(term => {
            const pattern = `%${term.replace(/[\\%_]/gu, c => `\\${c}`)}%`;
            values.push(pattern); if (body) values.push(pattern);
            return `(lower(coalesce(from_name,'') || char(10) || coalesce(from_address,'') || char(10) || coalesce(subject,'') || char(10) || coalesce(snippet,'')) like ? escape '\\'
              ${body ? "or coalesce(body_text,'') like ? escape '\\'" : ""})`;
          });
          const expected = (sqlite.query(`select id from emails where ${predicates.join(" and ")}`).all(...values) as Array<{ id: string }>).map(row => row.id).sort();
          assert.deepEqual(search(sqlite, query, body), expected, `${query}; body=${body}`);
        }
      }
    } finally { sqlite.close(); }
  });
});
