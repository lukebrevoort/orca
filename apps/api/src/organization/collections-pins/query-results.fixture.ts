/** BRE-457 test-only data. No production evaluator or historical-parity oracle. */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { detectGmailCapabilities } from "../../auth/gmail/capabilities.ts";
import type { AuthVariables } from "../../auth/middleware.ts";
import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads, collections, emails, labels, oauthAccounts,
  organizationSavedQueries, pins, threadAttentionOverrides, threads, users,
} from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { ProviderRegistry } from "../../providers/registry.ts";

export const queryResultsBase = "a6a8567e81dab98d7ee50b6ec263d94266ac3009";
export const ownerAccount = "bre457-account-a";
export const secondAccount = "bre457-account-b";
export const foreignAccount = "bre457-account-foreign";
export const ownedCollection = "bre457-collection-a";
export const resultsPrefix = "/v1/organization/collections-pins/queries";
const epoch = Date.parse("2026-11-01T12:00:00.000Z");

export function receipt(value: Record<string, unknown>) {
  const record = { stage: process.env.BRE457_QUERY_STAGE ?? "candidate", ...value };
  console.info(`BRE457 ${JSON.stringify(record)}`);
  if (process.env.BRE457_RECEIPTS) appendFileSync(process.env.BRE457_RECEIPTS, `${JSON.stringify(record)}\n`);
}

export type QueryFilters = {
  mailbox?: "inbox" | "focus" | "quiet" | "hidden" | "all";
  attention?: "all" | "notify" | "focus" | "normal";
  classification?: "human" | "tideline" | "uncertain" | "all";
  sender?: string;
  text?: string;
  accountId?: string;
  collectionId?: string;
  dataSource?: "stored_mail";
};

export async function createQueryResultsFixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-bre457-query-"));
  const databasePath = join(directory, "synthetic.sqlite");
  const priorSecret = process.env.SESSION_SECRET;
  const priorEncryption = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "bre457-synthetic-only-session-secret-not-a-live-credential";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 57).toString("base64");
  const client = createDatabaseClient(databasePath);
  const networkFetch = globalThis.fetch;
  const calls = { network: 0, sync: 0, transport: 0 };
  const connectionChanges: number[] = [];
  let querySequence = 0;
  const close = () => {
    globalThis.fetch = networkFetch;
    client.sqlite.close();
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
    if (priorEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorEncryption;
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    client.db.insert(users).values([
      { id: "bre457-owner", email: "owner@synthetic.example" },
      { id: "bre457-foreign", email: "foreign@synthetic.example" },
    ]).run();
    client.db.insert(oauthAccounts).values([
      { id: ownerAccount, userId: "bre457-owner", provider: "gmail", providerEmail: "a@synthetic.example", providerId: "synthetic-a" },
      { id: secondAccount, userId: "bre457-owner", provider: "gmail", providerEmail: "b@synthetic.example", providerId: "synthetic-b" },
      { id: foreignAccount, userId: "bre457-foreign", provider: "gmail", providerEmail: "foreign@synthetic.example", providerId: "synthetic-foreign" },
    ]).run();

    function message(id: string, input: {
      thread?: string; accountId?: string; behavior?: "notify" | "focus" | "normal" | "quiet" | "hidden";
      classification?: "likely_human" | "automated_or_bulk" | "uncertain" | "unclassified";
      subject?: string; snippet?: string; name?: string; address?: string; at?: number;
    } = {}) {
      const accountId = input.accountId ?? ownerAccount;
      const threadId = input.thread ?? `thread-${id}`;
      client.db.insert(threads).values({
        id: threadId, accountId, providerThreadId: input.accountId ? "shared-provider-thread" : threadId,
        latestReceivedAt: new Date(input.at ?? epoch), messageCount: 1,
      }).onConflictDoNothing().run();
      client.db.insert(emails).values({
        id, accountId, threadId, providerMessageId: id,
        fromName: input.name ?? "Human", fromAddress: input.address ?? "human@synthetic.example",
        subject: input.subject ?? "attention-marker", snippet: input.snippet ?? "latest",
        receivedAt: new Date(input.at ?? epoch), createdAt: new Date(input.at ?? epoch),
        humanClassification: input.classification ?? "likely_human", isRead: false,
      }).run();
      client.db.insert(threadAttentionOverrides).values({
        accountId, threadId, behavior: input.behavior ?? "normal",
      }).onConflictDoNothing().run();
    }

    message("notify", { behavior: "notify" });
    message("focus", { behavior: "focus" });
    message("normal");
    message("bulk-focus", { behavior: "focus", classification: "automated_or_bulk" });
    message("quiet-old", { thread: "quiet-history", behavior: "quiet", classification: "automated_or_bulk", subject: "quiet-marker", snippet: "Maya", at: epoch - 1000 });
    message("quiet-new", { thread: "quiet-history", behavior: "quiet", subject: "quiet-marker", snippet: "other" });
    message("hidden-old", { thread: "hidden-history", behavior: "hidden", subject: "hidden-marker", snippet: "Maya", at: epoch - 1000 });
    message("hidden-new", { thread: "hidden-history", behavior: "hidden", subject: "hidden-marker", snippet: "other" });
    message("history-old", { thread: "history", subject: "history-marker", snippet: "needle", at: epoch - 1000 });
    message("history-new", { thread: "history", subject: "history-marker", snippet: "other" });
    message("person", { name: "ÉLODIE", address: "other@synthetic.example", subject: "Launch", snippet: "MAYA outcome" });
    message("unicode", { name: "İSTANBUL", subject: "unicode-marker" });
    message("sigma", { name: "ΟΣ", subject: "sigma-marker" });
    message("boundary", { subject: "right", snippet: "left" });
    message("tie-z", { thread: "tie", subject: "tie-marker", snippet: "Maya" });
    message("tie-a", { thread: "tie", subject: "tie-marker", snippet: "other" });
    message("archived", { behavior: "notify", subject: "archive-marker" });
    message("moved", { subject: "moved-marker" });
    message("second-account", { accountId: secondAccount });
    message("foreign-account", { accountId: foreignAccount });
    // Effective destinations come from production migrations/views, not a fixture classifier.
    client.sqlite.query("UPDATE organization_thread_lane_states SET manual_override_lane_id=':orca-compat:quiet' WHERE account_id=? AND thread_id='thread-moved'").run(ownerAccount);
    client.db.insert(labels).values({ id: "inbox-a", accountId: ownerAccount, providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
    client.sqlite.query("INSERT INTO email_labels(id,email_id,label_id) SELECT 'inbox-'||id,id,'inbox-a' FROM emails WHERE account_id=? AND id <> 'archived'").run(ownerAccount);
    client.db.insert(collections).values([
      { id: ownedCollection, accountId: ownerAccount, name: "Selected", color: "#70867d", position: 0 },
      { id: "bre457-collection-b", accountId: secondAccount, name: "Other account", color: "#70867d", position: 0 },
      { id: "bre457-collection-foreign", accountId: foreignAccount, name: "Foreign", color: "#70867d", position: 0 },
    ]).run();
    client.db.insert(collectionThreads).values({ id: "membership-notify", collectionId: ownedCollection, threadId: "thread-notify" }).run();

    function rawQuery(raw: string, accountId = ownerAccount, revision = 7) {
      const id = `bre457-query-${++querySequence}`;
      client.db.insert(organizationSavedQueries).values({ id, accountId, name: id, definitionJson: raw, revision }).run();
      return id;
    }
    function query(filters: QueryFilters, accountId = ownerAccount) {
      return rawQuery(JSON.stringify({ revision: 1, filters }), accountId);
    }
    const catalogQueryId = query({ mailbox: "inbox", attention: "notify", classification: "all" });
    client.db.insert(pins).values({
      id: "bre457-pin", accountId: ownerAccount, kind: "filter", targetId: "test-only-query-target",
      targetType: "query", savedQueryId: catalogQueryId, label: "Notify only", position: 0,
    }).run();
    const session = await createSession(client.db, "bre457-owner");
    const otherSession = await createSession(client.db, "bre457-owner");
    const foreignSession = await createSession(client.db, "bre457-foreign");
    const headers = { cookie: `orca_session=${session.token}` };
    const dbFactory = () => {
      const connection = createDatabaseClient(databasePath);
      const originalClose = connection.sqlite.close.bind(connection.sqlite);
      connection.sqlite.close = (...args: Parameters<typeof connection.sqlite.close>) => {
        const row = connection.sqlite.query("SELECT total_changes() AS changes").get() as { changes: number };
        connectionChanges.push(row.changes);
        return originalClose(...args);
      };
      return connection;
    };
    globalThis.fetch = Object.assign(async () => {
      calls.network += 1;
      throw new Error("BRE-457 synthetic fixture forbids network access");
    }, { preconnect: networkFetch.preconnect }) as typeof fetch;
    const app = createApp({
      dbFactory,
      providerRegistry: new ProviderRegistry([{
        provider: "gmail", createOAuthApp: () => new Hono<{ Variables: AuthVariables }>(), detectCapabilities: detectGmailCapabilities,
        async syncPage() { calls.sync += 1; throw new Error("Forbidden synthetic provider sync"); },
        createTransport() { calls.transport += 1; throw new Error("Forbidden synthetic provider transport"); },
      }]),
      feedbackTicketDelivery: null,
    });
    function url(queryId: string, params: Record<string, string> = {}) {
      return `${resultsPrefix}/${encodeURIComponent(queryId)}/results?${new URLSearchParams({ accountId: ownerAccount, limit: "30", ...params })}`;
    }
    async function request(path: string, requestHeaders: Record<string, string> = headers) {
      const start = connectionChanges.length;
      try {
        return await app.request(path, { headers: requestHeaders });
      } finally {
        const changes = connectionChanges.slice(start);
        assert.deepEqual(changes.filter(value => value !== 0), [], "Fresh-session reads must perform zero SQLite DML, including trigger/rolled-back changes");
        assert.deepEqual(calls, { network: 0, sync: 0, transport: 0 });
      }
    }
    async function preconditions() {
      const unauthenticated = await request("/v1/organization/collections-pins/query", {});
      assert.equal(unauthenticated.status, 401);
      const catalogResponse = await request(`/v1/organization/collections-pins/query?accountId=${ownerAccount}`);
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json() as { workspaceId: string; accountIds: string[]; queries: Array<{ id: string; revision: number; definition: unknown }>; pins: Array<{ target: { queryId: string } }> };
      assert.equal(catalog.workspaceId, "bre457-owner");
      assert.deepEqual(catalog.accountIds, [ownerAccount]);
      assert.equal(catalog.queries.find(item => item.id === catalogQueryId)?.revision, 7);
      assert.equal(catalog.pins[0]?.target.queryId, catalogQueryId);
      assert.equal((await request(`/v1/inbox?accountId=${ownerAccount}&classification=all&limit=30`)).status, 200);
      receipt({ name: "real-auth-catalog-query-mailbox-preconditions", unauthenticatedStatus: 401, catalogStatus: 200, inboxStatus: 200, queryId: catalogQueryId, objectRevision: 7, schemaRevision: 1, connectionChanges, providerCalls: calls });
    }
    return { ...client, app, directory, session, otherSession, foreignSession, headers, query, rawQuery, url, request, preconditions, catalogQueryId, calls, connectionChanges, close };
  } catch (error) {
    close();
    throw error;
  }
}

export type QueryResultsFixture = Awaited<ReturnType<typeof createQueryResultsFixture>>;
