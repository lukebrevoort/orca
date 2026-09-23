import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createDatabaseClient } from "../db/client.ts";
import { humanClassifierVersion } from "../classification/human-signal.ts";
import type { MobilePushConfig } from "./config.ts";

export const testConfig: MobilePushConfig = {
  configured: true,
  disabledReason: null,
  teamId: "ABCDEFGHIJ",
  keyId: "KLMNOPQRST",
  privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  bundleId: "com.orca.test",
  intervalMs: 60_000,
  batchSize: 100,
  staleDeviceMs: 90 * 86_400_000,
  maxAttempts: 4,
};

export const tempDirs: string[] = [];

export function setMobilePushTestEnv() {
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
}

export function clearMobilePushTestEnv() {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

export function createMobilePushTestDb() {
  const directory = mkdtempSync(join(tmpdir(), "orca-mobile-push-"));
  tempDirs.push(directory);
  const path = join(directory, "push.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  return { ...client, path };
}

export function seedAccount(sqlite: ReturnType<typeof createMobilePushTestDb>["sqlite"], userId: string, accountId: string) {
  sqlite.query("INSERT INTO users (id,email,created_at) VALUES (?,?,?)").run(userId, `${userId}@example.com`, 1);
  sqlite.query("INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(`session-${userId}`, userId, 9_999_999_999_999, 1);
  sqlite.query("INSERT INTO oauth_accounts (id,user_id,provider,provider_email,provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(accountId, userId, "gmail", `${userId}@example.com`, `provider-${accountId}`, 1, 1);
  sqlite.query("INSERT INTO labels (id,account_id,provider_label_id,name,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`inbox-${accountId}`, accountId, "INBOX", "Inbox", "system", 1, 1);
  sqlite.query("INSERT INTO labels (id,account_id,provider_label_id,name,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(`sent-${accountId}`, accountId, "SENT", "Sent", "system", 1, 1);
}

export function seedMessage(sqlite: ReturnType<typeof createMobilePushTestDb>["sqlite"], input: {
  id: string;
  accountId: string;
  createdAt: number;
  receivedAt?: number;
  classification?: "likely_human" | "automated_or_bulk" | "uncertain" | "unclassified";
  read?: boolean;
  draft?: boolean;
  inbox?: boolean;
  sent?: boolean;
}) {
  const threadId = `thread-${input.id}`;
  sqlite.query("INSERT INTO threads (id,account_id,provider_thread_id,message_count,is_read,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(threadId, input.accountId, threadId, 1, input.read ? 1 : 0, input.createdAt, input.createdAt);
  sqlite.query(`INSERT INTO emails (id,account_id,thread_id,provider_message_id,from_address,received_at,is_read,is_draft,
    human_signal,human_classification,human_classification_reasons,human_classifier_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id, input.accountId, threadId, input.id, "person@example.com", input.receivedAt ?? input.createdAt, input.read ? 1 : 0,
      input.draft ? 1 : 0, input.classification === "likely_human" ? 9 : 2, input.classification ?? "likely_human", "[]",
      humanClassifierVersion, input.createdAt, input.createdAt);
  if (input.inbox !== false) {
    sqlite.query("INSERT INTO email_labels (id,email_id,label_id,created_at) VALUES (?,?,?,?)")
      .run(`inbox-link-${input.id}`, input.id, `inbox-${input.accountId}`, input.createdAt);
  }
  if (input.sent) {
    sqlite.query("INSERT INTO email_labels (id,email_id,label_id,created_at) VALUES (?,?,?,?)")
      .run(`sent-link-${input.id}`, input.id, `sent-${input.accountId}`, input.createdAt);
  }
}
