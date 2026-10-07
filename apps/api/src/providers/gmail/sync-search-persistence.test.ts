import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { readRankedSearch, type RankedSearchInput } from "../../search/read.ts";
import { prepareSyntheticSearchIndex } from "../../search/test-support.ts";
import { persistGmailMessages } from "./sync.ts";
import type { GmailMessage } from "./types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function message(id = "one"): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(Date.UTC(2026, 8, 2)),
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Appointment details",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "To", value: "User <user@example.test>" },
        { name: "Subject", value: "Appointment" },
      ],
      body: { data: Buffer.from("Original itinerary").toString("base64") },
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-gmail-search-persistence-"));
  directories.push(directory);
  const path = join(directory, "canonical.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  db.insert(users).values({ id: "user", email: "user@example.test" }).run();
  db.insert(oauthAccounts).values({
    id: "account", userId: "user", provider: "gmail", providerEmail: "user@example.test", providerId: "provider-user",
  }).run();
  const persist = (gmailMessages: GmailMessage[]) => persistGmailMessages(db, {
    accountId: "account", accountEmail: "user@example.test", gmailMessages,
    labelList: [
      { id: "INBOX", name: "Inbox" }, { id: "UNREAD", name: "Unread" },
      { id: "STARRED", name: "Starred" }, { id: "CATEGORY_PROMOTIONS", name: "Promotions" },
    ],
    now: new Date("2026-09-02T12:00:00Z"), propagationTrigger: "sync", propagationOptions: { enabled: false },
  });
  const input = (extra: Partial<RankedSearchInput> = {}): RankedSearchInput => ({
    databasePath: path, authorization: { userId: "user", accountIds: ["account"] },
    query: { query: "appointment", limit: 10, view: "all", classification: "all" },
    mode: "full", cursorKey: "synthetic-provider-search-secret", ...extra,
  });
  const jobs = () => sqlite.query<{ message_id: string; mode: string; version: number }, []>(
    "SELECT message_id,mode,version FROM mail_search_outbox ORDER BY message_id,mode",
  ).all();
  const revisions = () => sqlite.query<{ mode: string; revision: number }, []>(
    "SELECT mode,revision FROM mail_search_accounts WHERE account_id='account' ORDER BY mode",
  ).all();
  const mailboxRevision = () => sqlite.query<{ revision: number }, []>(
    "SELECT revision FROM mailbox_revisions WHERE account_id='account'",
  ).get()!.revision;
  const build = () => prepareSyntheticSearchIndex(sqlite);
  return { db, sqlite, persist, input, jobs, revisions, mailboxRevision, build };
}

describe("Gmail persistence search capture", () => {
  test("label and unread changes keep search ready while refreshing canonical filters, projection and cursors", async () => {
    const f = fixture();
    try {
      const changed = message();
      const other = message("two");
      await f.persist([changed, other]);
      f.build();
      const revisions = f.revisions();
      const mailboxRevision = f.mailboxRevision();
      const pageQuery = { ...f.input().query, limit: 1 };
      const first = readRankedSearch(f.input({ query: pageQuery }));
      assert.ok(first.page.nextCursor);

      changed.labelIds = ["INBOX", "STARRED", "CATEGORY_PROMOTIONS"];
      assert.equal((await f.persist([changed])).changedEmailCount, 1);
      assert.deepEqual(f.jobs(), []);
      assert.deepEqual(f.revisions(), revisions);
      assert.ok(f.mailboxRevision() > mailboxRevision);
      assert.throws(() => readRankedSearch(f.input({ query: { ...pageQuery, cursor: first.page.nextCursor! } })), /changed/);

      for (const mode of ["metadata", "full"] as const) {
        const all = readRankedSearch(f.input({ mode })).page.messages;
        const row = all.find((entry) => entry.id === "gmail:account:one")!;
        assert.equal(row.unread, false);
        assert.ok(row.labels.includes("Starred"));
        assert.ok(row.labels.includes("Promotions"));
        assert.ok(!row.labels.includes("Unread"));
        const filtered = readRankedSearch(f.input({ mode, query: { ...f.input().query, classification: "uncertain" } }));
        assert.deepEqual(filtered.page.messages.map((entry) => entry.id), ["gmail:account:one"]);
      }
      assert.deepEqual(f.sqlite.query("SELECT is_read,is_starred FROM emails WHERE provider_message_id='one'").get(), { is_read: 1, is_starred: 1 });
      assert.equal((await f.persist([changed])).unchangedEmailCount, 1);
      assert.deepEqual(f.jobs(), []);
      assert.deepEqual(f.revisions(), revisions);

      // A later provider UNREAD snapshot must not undo Orca's existing local-read protection.
      changed.labelIds = ["INBOX", "UNREAD"];
      await f.persist([changed]);
      assert.deepEqual(f.jobs(), []);
      assert.deepEqual(f.revisions(), revisions);
      assert.deepEqual(f.sqlite.query("SELECT is_read,is_starred FROM emails WHERE provider_message_id='one'").get(), { is_read: 1, is_starred: 0 });
      assert.deepEqual(readRankedSearch(f.input({ query: { ...f.input().query, classification: "uncertain" } })).page.messages, []);
    } finally { f.sqlite.close(); }
  });

  test("a body-only provider edit queues full mode once and leaves metadata ready", async () => {
    const f = fixture();
    try {
      const changed = message();
      await f.persist([changed]);
      f.build();
      const before = f.revisions();
      changed.payload!.body = { data: Buffer.from("Replacement itinerary").toString("base64") };
      await f.persist([changed]);
      assert.deepEqual(f.jobs(), [{ message_id: "gmail:account:one", mode: "full", version: before[0]!.revision + 1 }]);
      assert.deepEqual(f.revisions(), [{ mode: "full", revision: before[0]!.revision + 1 }, before[1]!]);
      assert.equal(readRankedSearch(f.input({ mode: "metadata" })).page.messages.length, 1);
      assert.throws(() => readRankedSearch(f.input()), /catching up/);
      f.build();
      assert.equal(readRankedSearch(f.input({ query: { ...f.input().query, query: "replacement" } })).page.messages.length, 1);
      assert.deepEqual(readRankedSearch(f.input({ query: { ...f.input().query, query: "original" } })).page.messages, []);

      changed.payload!.body = {};
      await f.persist([changed]);
      assert.deepEqual(f.jobs().map((job) => job.mode), ["full"]);
      f.build();
      assert.deepEqual(readRankedSearch(f.input({ query: { ...f.input().query, query: "replacement" } })).page.messages, []);
    } finally { f.sqlite.close(); }
  });

  test("mixed provider batches capture only changed search modes and preserve new-message capture", async () => {
    const f = fixture();
    try {
      const metadata = message("metadata");
      const body = message("body");
      const flags = message("flags");
      const combined = message("combined");
      await f.persist([metadata, body, flags, combined]);
      f.build();
      const before = f.revisions();
      metadata.payload!.headers!.find((header) => header.name === "Subject")!.value = "Rescheduled appointment";
      body.payload!.body = { data: Buffer.from("Replacement itinerary").toString("base64") };
      flags.labelIds = ["STARRED"];
      combined.snippet = "Updated appointment details";
      combined.payload!.body = { data: Buffer.from("Updated itinerary").toString("base64") };
      await f.persist([metadata, body, flags, combined, message("new")]);
      assert.deepEqual(f.jobs().map(({ message_id, mode }) => [message_id, mode]), [
        ["gmail:account:body", "full"],
        ["gmail:account:combined", "full"], ["gmail:account:combined", "metadata"],
        ["gmail:account:metadata", "full"], ["gmail:account:metadata", "metadata"],
        ["gmail:account:new", "full"], ["gmail:account:new", "metadata"],
      ]);
      assert.deepEqual(f.revisions(), [
        { mode: "full", revision: before[0]!.revision + 5 },
        { mode: "metadata", revision: before[1]!.revision + 3 },
      ]);
      f.build();
      assert.deepEqual(readRankedSearch(f.input({ query: { ...f.input().query, query: "rescheduled" } })).page.messages.map((row) => row.id), ["gmail:account:metadata"]);
      assert.equal(readRankedSearch(f.input()).page.messages.length, 5);
    } finally { f.sqlite.close(); }
  });
});
