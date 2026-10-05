import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { setMailSearchEnabled } from "../db/mail-search-index.ts";
import { emails, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createMailboxReader, MailboxCursorError, MailboxScopeError, type MailboxReadQuery } from "./read.ts";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

// Invented mail only. No customer mail, addresses, dates, or content.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-mail-search-"));
  const client = createDatabaseClient(join(directory, "mail.sqlite"));
  cleanups.push(() => { client.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  setMailSearchEnabled(client.sqlite, true);
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "foreign"].map(id => ({ id, userId: id === "foreign" ? "foreign" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
  function mail(id: string, values: Partial<typeof emails.$inferInsert> = {}) {
    const accountId = values.accountId ?? "a";
    const threadId = values.threadId ?? id;
    const receivedAt = new Date("2026-01-01T12:00:00Z");
    client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, subject: "Your reference images", latestReceivedAt: receivedAt, messageCount: 1 }).onConflictDoNothing().run();
    client.db.insert(emails).values({ id, accountId, threadId, providerMessageId: id, fromName: "Blue Harbor Studio", fromAddress: "booking@harbor.example", subject: "Your reference images", snippet: "Thanks for sending your ideas.", bodyText: "Hello!\n" + "Preparation details. ".repeat(100) + "\nYour appointment is confirmed with Morgan. Booking code: BK_42. Deposit: 25%. Folder: C:\\art.", receivedAt, ...values }).run();
  }
  const reader = createMailboxReader(client.sqlite, { searchBodyText: true });
  const authorization = { userId: "owner", accountIds: ["a", "b"] };
  function search(query: string, extra: Partial<MailboxReadQuery> = {}, accountIds = authorization.accountIds) {
    return reader.read({ authorization: { ...authorization, accountIds }, query: { view: "all", limit: 100, query, ...extra } });
  }
  return { ...client, mail, search, reader, authorization };
}

describe("stored mail search", () => {
  for (const query of ["Harbor", "BOOKING@HARBOR", "reference", "sending your", "appointment", "CONFIRMED", "Harbor confirmed", "confirmed harbor", "  HARBOR\tconfir  ", '"appointment is confirmed"', 'harbor "appointment is confirmed"']) {
    test(`finds the confirmation with ${JSON.stringify(query)}`, () => {
      const f = fixture(); f.mail("confirmation");
      const result = f.search(query);
      expect(result.response.messages.map(row => row.id)).toEqual(["confirmation"]);
      expect(result.response.counts.attention.all).toBe(1);
      expect(result.metric.pageRowsProjected).toBeLessThanOrEqual(result.metric.maxPageRowsBound);
      expect(result.response.messages[0]).not.toHaveProperty("bodyText");
    });
  }

  test("requires every term on one message and preserves contiguous quoted phrases", () => {
    const f = fixture(); f.mail("confirmation");
    f.mail("other", { fromName: "North Shop", fromAddress: "north@example.com", subject: "Appointment", snippet: "", bodyText: "Confirmed, pending review", threadId: "confirmation" });
    expect(f.search("harbor impossible").response.messages).toEqual([]);
    expect(f.search("harbor pending").response.messages).toEqual([]);
    expect(f.search('"confirmed appointment"').response.messages).toEqual([]);
    expect(f.search("appoitnment").response.messages).toEqual([]); // No implicit fuzzy expansion.
  });

  test("treats SQL wildcards, backslashes, apostrophes, and unmatched quotes as literal text", () => {
    const f = fixture(); f.mail("confirmation");
    f.mail("decoy", { bodyText: "Booking code: BKx42. Deposit: 250. Folder: C:art.", fromName: null, subject: null, snippet: null });
    for (const query of ["BK_42", "25%", "C:\\art"]) expect(f.search(query).response.messages.map(row => row.id)).toEqual(["confirmation"]);
    for (const query of ["' OR 1=1 --", '"', '""', 'confirmed"']) expect(f.search(query).response.messages).toEqual([]);
  });

  test("keeps account ownership, explicit scope, sender, dates, and attention filters", () => {
    const f = fixture(); f.mail("a"); f.mail("b", { accountId: "b" }); f.mail("private", { accountId: "foreign" });
    f.db.insert(senderAttentionRules).values({ id: "quiet", accountId: "a", scope: "address", value: "booking@harbor.example", behavior: "quiet", source: "user_choice" }).run();
    expect(f.search("appointment").response.messages.map(row => row.id)).toEqual(["b", "a"]);
    expect(f.search("appointment", {}, ["a", "foreign"]).response.messages.map(row => row.id)).toEqual(["a"]);
    expect(f.search("appointment", { view: "normal" }).response.messages.map(row => row.id)).toEqual(["b"]);
    expect(f.search("appointment", { sender: "absent" }).response.messages).toEqual([]);
    expect(f.search("appointment", { receivedAfter: "2026-01-02T00:00:00Z" }).response.messages).toEqual([]);
    expect(() => f.search("appointment", {}, ["foreign"])).toThrow(MailboxScopeError);
  });

  test("paginates tied cross-account matches exactly once and rejects reused query cursors", () => {
    const f = fixture();
    for (const accountId of ["a", "b"]) for (let i = 0; i < 4; i++) f.mail(`${accountId}-${i}`, { accountId });
    const ids: string[] = []; let cursor: string | undefined; let firstCursor: string | undefined;
    do {
      const page = f.search("harbor confirmed", { limit: 3, cursor });
      expect(page.response.counts.attention.all).toBe(8);
      expect(page.metric.pageRowsProjected).toBeLessThanOrEqual(page.metric.maxPageRowsBound);
      ids.push(...page.response.messages.map(row => row.id));
      cursor = page.response.nextCursor ?? undefined; firstCursor ??= cursor;
    } while (cursor);
    expect(ids).toEqual(["a-0", "a-1", "a-2", "a-3", "b-0", "b-1", "b-2", "b-3"]);
    expect(() => f.search("harbor", { limit: 3, cursor: firstCursor })).toThrow(MailboxCursorError);
    expect(() => f.search("harbor confirmed", { limit: 3, cursor: firstCursor }, ["a"])).toThrow(MailboxCursorError);
  });

  test("does not scan raw HTML markup or claim attachment/HTML-only/fuzzy search", () => {
    const f = fixture(); f.mail("html", { bodyText: null, bodyHtml: '<p>quartz</p><img src="https://example.com/hidden-tracker">' });
    expect(f.search("quartz").response.messages).toEqual([]);
    expect(f.search("hidden-tracker").response.messages).toEqual([]);
    expect(f.search("harbor").response.messages.map(row => row.id)).toEqual(["html"]);
  });

  test("metadata-only readers cannot infer body text and cannot reuse body-search cursors", () => {
    const f = fixture(); f.mail("one"); f.mail("two");
    const metadata = createMailboxReader(f.sqlite);
    for (const query of ["appointment", "harbor confirmed"]) {
      const page = metadata.read({ authorization: f.authorization, query: { view: "all", limit: 1, query } });
      expect(page.response.messages).toEqual([]);
      expect(page.response.counts.attention.all).toBe(0);
      expect(page.response.nextCursor).toBeNull();
    }
    const body = f.search("harbor", { limit: 1 });
    expect(body.response.nextCursor).not.toBeNull();
    expect(() => metadata.read({ authorization: f.authorization, query: { view: "all", limit: 1, query: "harbor", cursor: body.response.nextCursor! } })).toThrow(MailboxCursorError);
    const metadataPage = metadata.read({ authorization: f.authorization, query: { view: "all", limit: 1, query: "harbor" } });
    expect(() => f.search("harbor", { limit: 1, cursor: metadataPage.response.nextCursor! })).toThrow(MailboxCursorError);
    f.sqlite.query("UPDATE emails SET body_text='Changed body' WHERE id='two'").run();
    expect(() => f.search("harbor", { limit: 1, cursor: body.response.nextCursor! })).toThrow(MailboxCursorError);
  });
});
