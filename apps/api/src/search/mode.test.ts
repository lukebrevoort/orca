import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { createMailboxReader } from "../mailbox/read.ts";
import { readSearchMode, readStagedMetadata } from "./mode.ts";
import { disableSearch, enableSearch } from "./indexing/admin.ts";
import { getSearchIndexPath, readSearchControl } from "./indexing/schema.ts";
import { prepareSyntheticSearchIndex } from "./test-support.ts";
import { readRankedSearch } from "./read.ts";
import { createRankedSearchExecutor } from "./executor.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-staged-mode-")); directories.push(directory);
  const path = join(directory, "mail.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values({ id: "owner", email: "owner@example.test" }).run();
  client.db.insert(oauthAccounts).values({ id: "account", userId: "owner", provider: "gmail", providerId: "account", providerEmail: "owner@example.test" }).run();
  for (let i = 0; i < 3; i++) {
    const id = `message-${i}`;
    client.db.insert(threads).values({ id, accountId: "account", providerThreadId: id }).run();
    client.db.insert(emails).values({ id, threadId: id, accountId: "account", providerMessageId: id,
      fromAddress: "sender@example.test", subject: i < 2 ? 'AI 50% code_a "open' : "Elsewhere", snippet: "A note", bodyText: "bodyonly", receivedAt: new Date(i + 1) }).run();
  }
  const input = { authorization: { userId: "owner" }, query: { query: "AI", view: "all" as const, classification: "all" as const, limit: 1 }, cursorKey: "synthetic-staged-cursor-key" };
  return { ...client, path, input };
}

test("fresh capture-only migration preserves short literal metadata counts, order, cursors and raw initial cursors", () => {
  const f = fixture();
  try {
    expect(readSearchControl(f.sqlite).activation_epoch).toBe(0);
    expect(existsSync(getSearchIndexPath(f.path))).toBe(false);
    for (const query of ["A", "AI", "50%", "code_a", '"open', "bodyonly"]) {
      const input = { ...f.input, query: { ...f.input.query, query } };
      const original = createMailboxReader(f.sqlite).read(input).response;
      const staged = readStagedMetadata(f.sqlite, input);
      expect(staged.snapshot.capabilities).toMatchObject({ version: 1, mode: "legacy-metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1", ownerId: "owner" });
      expect(staged.legacy!.response.messages).toEqual(original.messages);
      expect(staged.legacy!.response.counts).toEqual(original.counts);
      if (original.nextCursor) {
        expect(staged.legacy!.response.nextCursor).not.toBe(original.nextCursor);
        const nextInput = { ...input, query: { ...input.query, cursor: staged.legacy!.response.nextCursor! } };
        expect(readStagedMetadata(f.sqlite, nextInput).legacy!.response.messages).toEqual(createMailboxReader(f.sqlite).read({ ...input, query: { ...input.query, cursor: original.nextCursor } }).response.messages);
        expect(readStagedMetadata(f.sqlite, { ...input, query: { ...input.query, cursor: original.nextCursor } }).legacy!.response.messages).toEqual(readStagedMetadata(f.sqlite, nextInput).legacy!.response.messages);
      }
    }
    expect(existsSync(getSearchIndexPath(f.path))).toBe(false);
    expect(() => readRankedSearch({ ...f.input, databasePath: f.path, mode: "full", query: { ...f.input.query, query: '"' } })).toThrow("has not been activated");
  } finally { f.sqlite.close(); }
});

test("operator transitions audit epochs and refuse cross-mode and off-on cursor replays", () => {
  const f = fixture(); let index: Database | undefined;
  try {
    const before = readStagedMetadata(f.sqlite, f.input);
    const raw = createMailboxReader(f.sqlite).read(f.input).response.nextCursor!;
    prepareSyntheticSearchIndex(f.sqlite);
    index = new Database(getSearchIndexPath(f.path));
    const active = readSearchMode(f.sqlite, "owner");
    expect(active.capabilities.mode).toBe("indexed");
    expect(active.capabilities.epoch).not.toBe(before.snapshot.capabilities.epoch);
    const rankedInput = { ...f.input, databasePath: f.path, mode: "metadata" as const, exactCounts: true, query: { ...f.input.query, query: "code_a" } };
    const indexedCursor = readRankedSearch(rankedInput).page.nextCursor!;
    expect(() => readRankedSearch({ ...rankedInput, query: { ...rankedInput.query, cursor: before.legacy!.response.nextCursor! } })).toThrow("continuation is invalid");
    enableSearch(f.sqlite, index, "already active");
    expect(readSearchMode(f.sqlite, "owner").capabilities.epoch).toBe(active.capabilities.epoch);
    disableSearch(f.sqlite, "Operator tests metadata rollback");
    const disabled = readSearchMode(f.sqlite, "owner");
    disableSearch(f.sqlite, "already disabled");
    expect(readSearchMode(f.sqlite, "owner").capabilities.epoch).toBe(disabled.capabilities.epoch);
    for (const cursor of [raw, before.legacy!.response.nextCursor!, indexedCursor]) {
      expect(() => readStagedMetadata(f.sqlite, { ...f.input, query: { ...f.input.query, cursor } })).toThrow();
    }
    const rollbackCursor = readStagedMetadata(f.sqlite, f.input).legacy!.response.nextCursor!;
    enableSearch(f.sqlite, index, "Operator tests reactivation");
    const reactivated = readSearchMode(f.sqlite, "owner");
    expect(reactivated.capabilities.epoch).not.toBe(active.capabilities.epoch);
    expect(() => readRankedSearch({ ...rankedInput, expectedEpoch: active.capabilities.epoch })).toThrow("mode changed");
    expect(() => readRankedSearch({ ...rankedInput, query: { ...rankedInput.query, cursor: indexedCursor } })).toThrow("Stored mail changed");
    disableSearch(f.sqlite);
    expect(() => readStagedMetadata(f.sqlite, { ...f.input, query: { ...f.input.query, cursor: rollbackCursor } })).toThrow("Stored mail changed");
    expect(f.sqlite.query("SELECT activation_epoch,command,reason FROM mail_search_activation_audit ORDER BY id").all()).toMatchObject([
      { activation_epoch: 1, command: "init" }, { activation_epoch: 2, command: "enable" },
      { activation_epoch: 3, command: "disable", reason: "Operator tests metadata rollback" },
      { activation_epoch: 4, command: "enable", reason: "Operator tests reactivation" }, { activation_epoch: 5, command: "disable" },
    ]);
  } finally { index?.close(); f.sqlite.close(); }
});

test("legacy mode and synchronous metadata read stay in one canonical snapshot", () => {
  const f = fixture(); let index: Database | undefined;
  try {
    prepareSyntheticSearchIndex(f.sqlite); disableSearch(f.sqlite);
    const before = readSearchMode(f.sqlite, "owner");
    const writer = createDatabaseClient(f.path);
    index = new Database(getSearchIndexPath(f.path));
    let transitioned = false;
    try {
      const result = readStagedMetadata(f.sqlite, f.input, { clock: () => {
        if (!transitioned) { transitioned = true; enableSearch(writer.sqlite, index!); }
        return performance.now();
      } });
      expect(result.snapshot.capabilities).toEqual(before.capabilities);
      expect(result.legacy!.response.counts.attention.all).toBe(2);
      expect(readSearchMode(f.sqlite, "owner").capabilities.mode).toBe("indexed");
    } finally { writer.sqlite.close(); }
  } finally { index?.close(); f.sqlite.close(); }
});

test("read child rejects an activation change after handler dispatch before parsing query", async () => {
  const f = fixture();
  let toggled = false;
  const executor = createRankedSearchExecutor({ onLifecycle: ({ event }) => {
    if (event === "started" && !toggled) { toggled = true; disableSearch(f.sqlite); }
  } });
  try {
    prepareSyntheticSearchIndex(f.sqlite);
    const epoch = readSearchMode(f.sqlite, "owner").capabilities.epoch;
    await expect(executor.read({ ...f.input, databasePath: f.path, mode: "full", expectedEpoch: epoch, query: { ...f.input.query, query: '"' } })).rejects.toMatchObject({ code: "search_mode_changed" });
    await expect(executor.read({ ...f.input, databasePath: f.path, mode: "full" })).rejects.toMatchObject({ code: "search_not_activated" });
  } finally { await executor.shutdown(); f.sqlite.close(); }
});


test("legacy cursor fits maximal ordinary query and sender filters and continues unchanged", () => {
  const f = fixture();
  try {
    const query = "q".repeat(200); const sender = "s".repeat(320);
    f.sqlite.query("UPDATE emails SET subject=?,from_name=? WHERE id IN ('message-0','message-1')").run(query, sender);
    const input = { ...f.input, query: { ...f.input.query, query, sender } };
    const first = readStagedMetadata(f.sqlite, input).legacy!.response;
    expect(first.counts.attention.all).toBe(2); expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor!.length).toBeLessThanOrEqual(2_048);
    const second = readStagedMetadata(f.sqlite, { ...input, query: { ...input.query, cursor: first.nextCursor! } }).legacy!.response;
    expect(second.messages).toHaveLength(1); expect(second.messages[0]!.id).not.toBe(first.messages[0]!.id);
    expect(second.nextCursor).toBeNull();
    const unicodeQuery = "漢".repeat(200); const unicodeSender = "名".repeat(320);
    f.sqlite.query("UPDATE emails SET subject=?,from_name=? WHERE id IN ('message-0','message-1')").run(unicodeQuery, unicodeSender);
    expect(() => readStagedMetadata(f.sqlite, { ...input, query: { ...input.query, query: unicodeQuery, sender: unicodeSender } }))
      .toThrow("execution budget");
  } finally { f.sqlite.close(); }
});

test("capability expectations bind the authenticated owner even on the first page", () => {
  const f = fixture();
  try {
    const owner = readSearchMode(f.sqlite, "owner").capabilities;
    const other = readSearchMode(f.sqlite, "other-owner").capabilities;
    expect(other.mode).toBe(owner.mode); expect(other.epoch).not.toBe(owner.epoch);
    expect(() => readSearchMode(f.sqlite, "other-owner", { mode: owner.mode, epoch: owner.epoch })).toThrow("mode changed");
  } finally { f.sqlite.close(); }
});
