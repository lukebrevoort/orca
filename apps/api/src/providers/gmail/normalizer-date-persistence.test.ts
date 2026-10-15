import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../../db/schema.ts";
import { persistGmailMessages } from "./sync.ts";
import type { GmailMessage } from "./types.ts";

test("malformed dates do not abort a batch or overwrite another account's matching provider IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-gmail-date-"));
  const { db, sqlite } = createDatabaseClient(join(directory, "synthetic.sqlite"));
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(users).values({ id: "synthetic-user", email: "owner@example.com" }).run();
    for (const accountId of ["account-a", "account-b"]) {
      db.insert(oauthAccounts).values({
        id: accountId,
        userId: "synthetic-user",
        provider: "gmail",
        providerEmail: `${accountId}@example.com`,
        providerId: accountId,
      }).run();
    }
    const batch = (internalDate: string, subject: string): GmailMessage[] => [
      {
        id: "shared-provider-message",
        threadId: "shared-provider-thread",
        internalDate,
        labelIds: ["INBOX"],
        payload: { headers: [{ name: "Subject", value: subject }] },
      },
      {
        id: "valid-provider-message",
        threadId: "shared-provider-thread",
        internalDate: "1782671400000",
        labelIds: ["INBOX"],
        payload: { headers: [{ name: "Subject", value: "Valid synthetic message" }] },
      },
    ];
    const persist = (accountId: string, gmailMessages: GmailMessage[]) => persistGmailMessages(db, {
      accountId,
      accountEmail: `${accountId}@example.com`,
      gmailMessages,
      labelList: [{ id: "INBOX", name: "Inbox" }],
      now: new Date("2026-10-15T00:00:00.000Z"),
      propagationTrigger: "sync",
      propagationOptions: { enabled: false },
    });

    await persist("account-b", batch("1782671400000", "Account B private subject"));
    const before = db.select().from(emails).all().filter(row => row.accountId === "account-b");
    const result = await persist("account-a", batch("invalid", "Account A private subject"));
    assert.equal(result.changedEmailCount, 2);
    const rows = db.select().from(emails).all();
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.filter(row => row.accountId === "account-b"), before);
    const fallback = rows.find(row => row.id === "gmail:account-a:shared-provider-message")!;
    assert.equal(fallback.subject, "Account A private subject");
    assert.equal(fallback.receivedAt.toISOString(), "1970-01-01T00:00:00.000Z");
    const accountThreads = db.select().from(threads).all();
    assert.equal(accountThreads.length, 2);
    for (const thread of accountThreads) {
      assert.equal(thread.id, `gmail:${thread.accountId}:shared-provider-thread`);
      assert.equal(thread.messageCount, 2);
      assert.equal(thread.latestReceivedAt.toISOString(), "2026-06-28T18:30:00.000Z");
    }
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
