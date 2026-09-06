import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { prepareMailSearchView, type MailSearchViewSource } from "@orca/shared";
import { createDatabaseClient } from "../../db/client";
import { emails, threads, users, oauthAccounts, humanClassificationOverrides } from "../../db/schema";
import { createMailboxReader } from "../../mailbox/read";
import { createOrganizationViews } from "./module";
import { createSqliteOrganizationViewsRepository } from "./sqlite-repository";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const all: MailSearchViewSource = { query: "", mailbox: "all", evidence: "all", accountId: null, collectionId: null };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-search-equivalence-"));
  const client = createDatabaseClient(join(directory, "mail.sqlite"));
  cleanups.push(() => { client.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "foreign"].map((id) => ({ id, userId: id === "foreign" ? "foreign" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
  const scope = { workspaceId: "owner", accountIds: ["a", "b"], actor: { id: "owner", type: "human" as const } };
  const views = createOrganizationViews(createSqliteOrganizationViewsRepository(client.sqlite));
  const reader = createMailboxReader(client.sqlite);
  function mail(id: string, accountId = "a", fromAddress = "maya@example.com", classification: "likely_human" | "automated_or_bulk" | "uncertain" | "unclassified" | null = null, threadId = id) {
    const receivedAt = new Date("2026-09-01T12:00:00Z");
    client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, subject: `Subject ${threadId}`, latestReceivedAt: receivedAt, messageCount: 1 }).onConflictDoNothing().run();
    client.db.insert(emails).values({ id, accountId, threadId, providerMessageId: id, fromAddress, subject: `Subject ${id}`, receivedAt, humanClassification: classification }).run();
  }
  function override(id: string, targetType: "message" | "sender_address" | "sender_domain", targetValue: string, classification: "likely_human" | "automated_or_bulk" | "uncertain", accountId = "a") {
    client.db.insert(humanClassificationOverrides).values({ id, accountId, targetType, targetValue, classification, source: "user_choice" }).run();
  }
  function keys(items: Array<{ accountId: string; threadId: string }>) { return [...new Set(items.map((item) => `${item.accountId}/${item.threadId}`))].sort(); }
  function searchKeys(search: MailSearchViewSource) {
    const items: Array<{ accountId: string; threadId: string }> = []; let cursor: string | undefined;
    do {
      const page = reader.read({ authorization: { userId: "owner", accountIds: search.accountId ? [search.accountId] : scope.accountIds }, query: { view: "all", classification: search.evidence, limit: 1, cursor } });
      items.push(...page.response.messages); cursor = page.response.nextCursor ?? undefined;
    } while (cursor);
    return keys(items);
  }
  function compare(search: MailSearchViewSource, expected: string[]) {
    const snapshot = () => ["organization_views", "organization_change_sets", "threads", "emails", "organization_thread_lane_states", "organization_lane_policies"].map((table) => client.sqlite.query(`SELECT * FROM ${table}`).all());
    const beforePreview = snapshot();
    const preparation = prepareMailSearchView(search, "/?search=mail");
    const prepared = views.prepare({ scope, input: preparation });
    const { definitionDigest: _digest, definitionKind: _kind, effectiveAccountIds: _accounts, summary: _summary, saveEligibility: _eligibility, preparationNotices: _notices, ...draft } = prepared.draft;
    let cursor: string | undefined; const previewItems: Array<{ accountId: string; threadId: string }> = [];
    do { const page = views.preview({ scope, request: { draft, page: { limit: 1, cursor } } }); previewItems.push(...page.results.items); cursor = page.results.nextCursor ?? undefined; } while (cursor);
    expect(snapshot()).toEqual(beforePreview);
    expect(searchKeys(search)).toEqual(expected);
    expect(keys(previewItems)).toEqual(expected);
    const commit = views.commit({ scope, request: { draft: prepared.draft, expectedRevisions: { workspace: prepared.workspaceRevision, view: null }, retryKey: `search-${crypto.randomUUID()}`, confirmedZeroMatchDigest: expected.length ? null : prepared.draft.definitionDigest } });
    const savedItems: Array<{ accountId: string; threadId: string }> = [];
    do { const page = views.results({ scope, viewId: commit.view.id, query: { limit: 1, cursor } }); savedItems.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(keys(savedItems)).toEqual(expected);
    expect(commit.view.definition).toEqual(preparation.definition);
    return { commit, draft, keys };
  }
  return { ...client, scope, views, mail, override, compare, searchKeys };
}

describe("BRE-384 production mailbox / live View equivalence", () => {
  test("uses the mailbox's exact override normalization, including non-space whitespace", () => {
    const f = fixture();
    f.mail("plain", "a", " Maya@Example.com ");
    f.mail("tab", "a", "\tMaya@Example.com\t");
    f.mail("nbsp", "a", "\u00a0Maya@Example.com\u00a0");
    f.override("address", "sender_address", "maya@example.com", "likely_human");
    f.compare({ ...all, evidence: "human" }, ["a/plain"]);
    f.compare({ ...all, evidence: "uncertain" }, ["a/nbsp", "a/tab"]);
  });
  test("preserves override precedence, same-account isolation, cross-page conversation grouping and future matches", () => {
    const f = fixture();
    f.mail("domain-human"); f.mail("address-bulk", "a", "bulk@example.com"); f.mail("message-human", "a", "bulk@example.com");
    f.mail("other-account", "b", "bulk@example.com", "likely_human"); f.mail("private", "foreign", "bulk@example.com", "likely_human");
    f.mail("older-human", "a", "different@elsewhere.example", "likely_human", "conversation");
    f.mail("latest-bulk", "a", "bulk@example.com", "automated_or_bulk", "conversation");
    const later = Date.parse("2026-09-02T12:00:00Z");
    f.sqlite.query("UPDATE emails SET received_at=? WHERE id=?").run(later, "latest-bulk");
    f.sqlite.query("UPDATE threads SET latest_received_at=? WHERE id=? AND account_id=?").run(later, "conversation", "a");
    f.mail("unknown", "a", "malformed"); f.mail("uncertain", "b", "someone@elsewhere.example", "uncertain");
    f.override("domain", "sender_domain", "example.com", "likely_human");
    f.override("address", "sender_address", "bulk@example.com", "automated_or_bulk");
    f.override("message", "message", "message-human", "likely_human");
    const search = { ...all, evidence: "human" as const };
    const { commit } = f.compare(search, ["a/conversation", "a/domain-human", "a/message-human", "b/other-account"]);
    f.compare({ ...search, accountId: "a" }, ["a/conversation", "a/domain-human", "a/message-human"]);
    f.compare({ ...all, evidence: "tideline" }, ["a/address-bulk", "a/conversation"]);
    f.compare({ ...all, evidence: "uncertain" }, ["a/unknown", "b/uncertain"]);
    f.mail("future", "b", "new@elsewhere.example", "likely_human");
    const reopened = createOrganizationViews(createSqliteOrganizationViewsRepository(f.sqlite));
    expect(reopened.results({ scope: f.scope, viewId: commit.view.id, query: { limit: 100 } }).items.map((item) => `${item.accountId}/${item.threadId}`).sort()).toEqual(["a/conversation", "a/domain-human", "a/message-human", "b/future", "b/other-account"]);
    expect(reopened.list({ scope: f.scope }).items.find((item) => item.id === commit.view.id)?.definition).toEqual({ revision: 1, humanSignal: { classifications: ["likely_human"] } });
    f.sqlite.query("DELETE FROM human_classification_overrides WHERE id='message'").run();
    f.compare(search, ["a/conversation", "a/domain-human", "b/future", "b/other-account"]);
  });
  test("unsupported and blank drafts cannot commit; zero and foreign scopes remain explicit", () => {
    const f = fixture(); f.mail("one", "a", "maya@example.com", "likely_human");
    const before = f.sqlite.query("SELECT count(*) AS count FROM organization_views").get();
    for (const source of [all, { ...all, query: "one", accountId: "a", mailbox: "inbox" as const, collectionId: "collection" }]) {
      const reviewed = f.views.prepare({ scope: f.scope, input: prepareMailSearchView(source, "/") });
      expect(reviewed.draft.saveEligibility.allowed).toBe(false);
      expect(() => f.views.commit({ scope: f.scope, request: { draft: reviewed.draft, expectedRevisions: { workspace: reviewed.workspaceRevision, view: null }, retryKey: "blocked", confirmedZeroMatchDigest: reviewed.draft.definitionDigest } })).toThrow();
    }
    expect(f.sqlite.query("SELECT count(*) AS count FROM organization_views").get()).toEqual(before);
    expect(() => f.views.prepare({ scope: f.scope, input: prepareMailSearchView({ ...all, accountId: "foreign" }, "/") })).toThrow();
    f.compare({ ...all, evidence: "uncertain", accountId: "a" }, []);
  });

  test("omitted account scope includes accounts connected later while explicit scope stays fixed", () => {
    const f = fixture(); f.mail("first", "a", "maya@example.com", "likely_human");
    const dynamic = f.compare({ ...all, evidence: "human" }, ["a/first"]).commit;
    const fixed = f.compare({ ...all, evidence: "human", accountId: "a" }, ["a/first"]).commit;
    f.db.insert(oauthAccounts).values({ id: "new", userId: "owner", provider: "gmail", providerId: "new", providerEmail: "new@example.com" }).run();
    f.scope.accountIds.push("new"); f.mail("new-mail", "new", "maya@example.com", "likely_human");
    expect(f.views.results({ scope: f.scope, viewId: dynamic.view.id, query: {} }).items.map((item) => item.threadId).sort()).toEqual(["first", "new-mail"]);
    expect(f.views.results({ scope: f.scope, viewId: fixed.view.id, query: {} }).items.map((item) => item.threadId)).toEqual(["first"]);
    expect(() => f.views.results({ scope: { ...f.scope, accountIds: ["b"] }, viewId: fixed.view.id, query: {} })).toThrow();
  });

});
