import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { normalizeGmailMessage } from "../providers/gmail/normalizer.ts";
import type { GmailMessage } from "../providers/gmail/types.ts";
import { runDeterministicPropagation } from "./propagation/runtime.ts";

const targetMs = 2_000;
const tempDirs: string[] = [];
const migrationsFolder = resolve(import.meta.dir, "../../drizzle");
const quietLogger = { info() {}, warn() {}, error() {} };

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("BRE-269 sync-to-propagation latency", () => {
  test("records push and fallback-sync commit latency without provider or model calls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-m6-latency-"));
    tempDirs.push(directory);
    const { db, sqlite } = createDatabaseClient(join(directory, "latency.sqlite"));
    migrate(db, { migrationsFolder });

    try {
      db.insert(users).values({ id: "latency-user", email: "latency@orca.test" }).run();
      db.insert(oauthAccounts).values({
        id: "latency-account",
        userId: "latency-user",
        provider: "gmail",
        providerEmail: "latency@orca.test",
        providerId: "latency-provider-account",
      }).run();

      const pushMessage = normalizedRelease("push-latency-message", "push-latency-thread");
      const fallbackMessage = normalizedRelease("fallback-latency-message", "fallback-latency-thread");
      insertSource(db, pushMessage);
      insertSource(db, fallbackMessage);

      const pushStarted = performance.now();
      const push = await runDeterministicPropagation(db, {
        accountId: "latency-account",
        messages: [pushMessage],
        trigger: "push",
        options: { enabled: true, webOrigin: "http://localhost:5173", logger: quietLogger },
      });
      const pushMs = performance.now() - pushStarted;

      const fallbackStarted = performance.now();
      const fallback = await runDeterministicPropagation(db, {
        accountId: "latency-account",
        messages: [fallbackMessage],
        trigger: "sync",
        options: { enabled: true, webOrigin: "http://localhost:5173", logger: quietLogger },
      });
      const fallbackMs = performance.now() - fallbackStarted;

      assert.equal(push.propagated, 1);
      assert.equal(fallback.propagated, 1);
      assert.equal(
        (sqlite.query("select count(*) as count from agent_events").get() as { count: number }).count,
        2,
      );
      assert.ok(pushMs < targetMs, `push propagation took ${pushMs.toFixed(2)}ms`);
      assert.ok(fallbackMs < targetMs, `fallback propagation took ${fallbackMs.toFixed(2)}ms`);
      console.info("BRE-269 latency observation", {
        targetMs,
        pushMs: Number(pushMs.toFixed(2)),
        fallbackMs: Number(fallbackMs.toFixed(2)),
      });
    } finally {
      sqlite.close();
    }
  });
});

function normalizedRelease(id: string, threadId: string) {
  return normalizeGmailMessage(releaseMessage(id, threadId), {
    accountId: "latency-account",
    accountEmail: "latency@orca.test",
  });
}

function releaseMessage(id: string, threadId: string): GmailMessage {
  const body = "A new beta build is available to test.";
  return {
    id,
    threadId,
    labelIds: ["INBOX", "CATEGORY_UPDATES"],
    snippet: body,
    internalDate: "1787155200000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "TestFlight <no_reply@email.apple.com>" },
        { name: "To", value: "Latency <latency@orca.test>" },
        { name: "Subject", value: "Orca 2.1 (42) is ready to test" },
        { name: "Auto-Submitted", value: "auto-generated" },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}

function insertSource(
  db: ReturnType<typeof createDatabaseClient>["db"],
  message: ReturnType<typeof normalizedRelease>,
) {
  db.insert(threads).values({
    id: message.threadId,
    accountId: message.accountId,
    providerThreadId: message.raw.threadId,
    subject: message.subject,
  }).run();
  db.insert(emails).values({
    id: message.id,
    accountId: message.accountId,
    threadId: message.threadId,
    providerMessageId: message.providerMessageId,
    subject: message.subject,
    snippet: message.snippet,
    fromAddress: message.from.email,
    receivedAt: new Date(message.receivedAt),
  }).run();
}
