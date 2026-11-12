/** Test-only real Hono/SQLite fixture; no production reader or global-method patches. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  authSessionSchema, expectedUserIdHeaderName, inboxResponseSchema,
  organizationCollectionPinQueryResponseSchema, organizationSavedQueryResultResponseSchema,
  organizationSavedQueryDefinitionSchema,
} from "@orca/shared";
import { createSession } from "../../auth/session-store.ts";
import { createMobileSession } from "../../auth/mobile/store.ts";
import { shouldRenewSession } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { emails, importanceChoices, labels, oauthAccounts, organizationSavedQueries, threads, users } from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import { gmailProvider } from "../../providers/gmail/provider.ts";
import type { GmailClient } from "../../providers/gmail/client.ts";
import { ProviderRegistry } from "../../providers/registry.ts";
import { readSavedQueryResults } from "./query-results-reader.ts";

export const baselineBase = "7c97193688599e5996bb657c34227a63927c384c";
const originalUser = "bre457-importance-user-U";
const currentUser = "bre457-importance-user-B";
type AuthKind = "cookie" | "mobile";
type RetainedQuery = { id: string; accountId: string; revision: number };
type StateRow = {
  thread_id: string; effective: string; choice: string | null;
  choice_revision: number | null; account_revision: number;
};

export function importanceReceipt(value: Record<string, unknown>) {
  const entry = { stage: process.env.BRE457_IMPORTANCE_STAGE ?? "extension", ...value };
  console.info(`BRE457_IMPORTANCE ${JSON.stringify(entry)}`);
  if (process.env.BRE457_IMPORTANCE_RECEIPTS) {
    appendFileSync(process.env.BRE457_IMPORTANCE_RECEIPTS, `${JSON.stringify(entry)}\n`);
  }
}

export async function createQueryImportanceBaselineFixture() {
  const parent = process.env.BRE457_IMPORTANCE_SCRATCH ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "orca-query-importance-"));
  const databasePath = join(directory, "synthetic.sqlite");
  const previous = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "bre457-query-importance-synthetic-session-secret-only";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString("base64");
  const client = createDatabaseClient(databasePath);
  const providerCalls = { client: 0, body: 0, sync: 0, transport: 0 };
  let connectionsOpened = 0;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    client.sqlite.close();
    rmSync(directory, { recursive: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    importanceReceipt({ name: "owned-fixture-cleanup", removed: true });
  }
  try {
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    const accountU = "bre457-importance-account-U", accountB = "bre457-importance-account-B";
    client.db.insert(users).values([
      { id: originalUser, email: "importance-u@synthetic.example" },
      { id: currentUser, email: "importance-b@synthetic.example" },
    ]).run();
    client.db.insert(oauthAccounts).values([
      { id: accountU, userId: originalUser, provider: "gmail", providerId: "importance-u", providerEmail: "u@synthetic.example" },
      { id: accountB, userId: currentUser, provider: "gmail", providerId: "importance-b", providerEmail: "b@synthetic.example" },
    ]).run();
    const at = new Date("2026-11-01T12:00:00.000Z");
    for (const [accountId, suffixes] of [[accountU, ["important", "not-important", "unreviewed"]], [accountB, ["current-owner"]]] as const) {
      const labelId = `inbox-${accountId}`;
      client.db.insert(labels).values({ id: labelId, accountId, providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
      for (const suffix of suffixes) {
        const threadId = `importance-thread-${suffix}`, messageId = `importance-message-${suffix}`;
        client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, messageCount: 1, latestReceivedAt: at }).run();
        client.db.insert(emails).values({
          id: messageId, accountId, threadId, providerMessageId: messageId,
          fromAddress: `${suffix}@synthetic.example`, fromName: suffix,
          subject: "retained importance witness", snippet: suffix,
          humanClassification: "likely_human", isRead: false, receivedAt: at, createdAt: at,
        }).run();
        client.sqlite.query("INSERT INTO email_labels(id,email_id,label_id) VALUES(?,?,?)").run(`inbox-${messageId}`, messageId, labelId);
      }
      // The URL/expected object revision will come from the real catalog, not this seed name.
      client.db.insert(organizationSavedQueries).values({
        id: `importance-query-${accountId}`, accountId, name: "Canonical importance baseline", revision: 7,
        definitionJson: JSON.stringify(organizationSavedQueryDefinitionSchema.parse({
          revision: 1, filters: { dataSource: "stored_mail", mailbox: "inbox", attention: "all", classification: "all", accountId },
        })),
      }).run();
    }
    client.db.insert(importanceChoices).values([
      { accountId: accountU, kind: "conversation", target: "importance-thread-important", choice: "important", revision: 2, updatedAt: at.getTime() },
      { accountId: accountU, kind: "conversation", target: "importance-thread-not-important", choice: "not_important", revision: 3, updatedAt: at.getTime() },
    ]).run();
    const sessionU = await createSession(client.db, originalUser);
    const sessionB = await createSession(client.db, currentUser);
    const mobileB = createMobileSession(client.db, currentUser);
    assert.equal(shouldRenewSession(sessionU.expiresAt), false);
    assert.equal(shouldRenewSession(sessionB.expiresAt), false);

    function forbidden(kind: keyof typeof providerCalls): never {
      providerCalls[kind] += 1;
      throw new Error(`Synthetic query-importance GET reached forbidden provider ${kind}`);
    }
    // Supported provider dependency seams only. Real auth/catalog/query/mailbox handlers stay intact.
    // These counters are not a process-wide fetch/network monitor.
    const gmailClient: GmailClient = {
      async getProfile() { return forbidden("client"); },
      async getMessageMetadata() { return forbidden("client"); },
      async getMessage() { return forbidden("body"); },
      async listInboxMessagePage() { return forbidden("client"); },
      async listLabels() { return forbidden("client"); },
      async listHistory() { return forbidden("client"); },
      async watch() { return forbidden("client"); },
    };
    const app = createApp({
      dbFactory() { connectionsOpened += 1; return createDatabaseClient(databasePath); },
      gmailClient,
      providerRegistry: new ProviderRegistry([{
        ...gmailProvider,
        async syncPage() { return forbidden("sync"); },
        createTransport() { return forbidden("transport"); },
      }]),
      feedbackTicketDelivery: null,
    });
    const credentials = {
      U: { cookie: `orca_session=${sessionU.token}` },
      cookie: { cookie: `orca_session=${sessionB.token}` },
      mobile: { authorization: `Bearer ${mobileB.accessToken}` },
    };
    const watchedTables = [
      "users", "oauth_accounts", "sessions", "mobile_sessions", "emails", "threads", "labels", "email_labels",
      "importance_choices", "importance_thread_state", "importance_participants", "mailbox_revisions",
      "organization_saved_queries", "collections", "pins", "organization_thread_lane_states",
    ];
    function snapshot() {
      return watchedTables.map(table => [table, client.sqlite.query(`SELECT * FROM "${table}"`).all()
        .map(row => JSON.stringify(row)).sort()]);
    }
    function dataVersion() {
      return (client.sqlite.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    }
    async function request(name: string, path: string, headers: Record<string, string>) {
      const beforeVersion = dataVersion(), beforeTables = snapshot(), beforeConnections = connectionsOpened;
      const response = await app.request(path, { headers });
      const value: unknown = await response.json();
      const noCommittedWrites = dataVersion() === beforeVersion;
      const stateUnchanged = JSON.stringify(snapshot()) === JSON.stringify(beforeTables);
      importanceReceipt({ name: "request-control", request: name, status: response.status, noCommittedWrites, stateUnchanged,
        openedConnections: connectionsOpened - beforeConnections, providerCalls: { ...providerCalls }, freshSession: true });
      assert.equal(noCommittedWrites, true, `${name}: observer saw a committed SQLite change`);
      assert.equal(stateUnchanged, true, `${name}: selected persisted tables changed`);
      assert.deepEqual(providerCalls, { client: 0, body: 0, sync: 0, transport: 0 });
      return { response, value, openedConnections: connectionsOpened - beforeConnections };
    }
    function resultUrl(query: RetainedQuery) {
      return `/v1/organization/collections-pins/queries/${encodeURIComponent(query.id)}/results?${new URLSearchParams({ accountId: query.accountId, limit: "30" })}`;
    }
    function sourceStates() {
      return client.sqlite.query(`SELECT s.thread_id,s.effective,c.choice,c.revision choice_revision,r.revision account_revision
        FROM importance_thread_state s LEFT JOIN importance_choices c ON c.account_id=s.account_id AND c.kind='conversation' AND c.target=s.thread_id
        JOIN mailbox_revisions r ON r.account_id=s.account_id WHERE s.account_id=? ORDER BY s.thread_id`).all(accountU) as StateRow[];
    }
    let queryU: RetainedQuery | undefined, queryB: RetainedQuery | undefined;
    async function preconditions() {
      const anonymous = await request("anonymous catalog", "/v1/organization/collections-pins/query", {});
      assert.equal(anonymous.response.status, 401);
      for (const [kind, expectedId] of [["U", originalUser], ["cookie", currentUser], ["mobile", currentUser]] as const) {
        const session = await request(`${kind} real session`, "/v1/auth/session", credentials[kind]);
        assert.equal(session.response.status, 200);
        assert.equal(authSessionSchema.parse(session.value).user?.id, expectedId);
      }
      for (const [kind, accountId, userId] of [["U", accountU, originalUser], ["cookie", accountB, currentUser], ["mobile", accountB, currentUser]] as const) {
        const catalog = await request(`${kind} actual catalog`, `/v1/organization/collections-pins/query?accountId=${encodeURIComponent(accountId)}`, credentials[kind]);
        assert.equal(catalog.response.status, 200);
        const body = organizationCollectionPinQueryResponseSchema.parse(catalog.value);
        assert.equal(body.workspaceId, userId);
        assert.deepEqual(body.accountIds, [accountId]);
        const selected = body.queries.find(query => query.name === "Canonical importance baseline");
        assert.ok(selected);
        const raw = client.sqlite.query("SELECT id,account_id,revision FROM organization_saved_queries WHERE id=?").get(selected.id) as { id: string; account_id: string; revision: number };
        assert.equal(selected.accountId, raw.account_id);
        assert.equal(selected.revision, raw.revision);
        const retained = { id: selected.id, accountId: selected.accountId, revision: selected.revision };
        if (kind === "U") queryU = retained; else queryB = retained;
        const result = await request(`${kind} own default query`, resultUrl(retained), credentials[kind]);
        assert.equal(result.response.status, 200);
        const parsed = organizationSavedQueryResultResponseSchema.parse(result.value);
        assert.equal(parsed.query.id, retained.id);
        assert.equal(parsed.query.revision, retained.revision);
        assert.deepEqual(parsed.accounts.map(account => account.id), [accountId]);
        assert.ok(parsed.messages.length > 0);
        assert.ok(parsed.messages.every(message => message.accountId === accountId && message.importance === undefined));
      }
      assert.ok(queryU && queryB);
      const states = sourceStates();
      assert.deepEqual(states.map(row => row.effective).sort(), ["important", "not_important", "unreviewed"]);
      assert.equal(states.find(row => row.effective === "unreviewed")?.choice_revision, null);
      const inbox = await request("Inbox supported importance header", `/v1/inbox?${new URLSearchParams({ accountId: accountU, classification: "all", limit: "30" })}`,
        { ...credentials.U, "x-orca-importance-version": "1" });
      assert.equal(inbox.response.status, 200);
      const inboxBody = inboxResponseSchema.parse(inbox.value);
      assert.equal(inboxBody.messages.length, states.length);
      for (const state of states) {
        const row = inboxBody.messages.find(message => message.threadId === state.thread_id);
        assert.ok(row?.importance);
        assert.equal(row.importance.effective, state.effective);
        assert.equal(row.importance.conversation.choice, state.choice);
        assert.equal(row.importance.conversation.revision, state.choice_revision ?? 0);
        assert.equal(row.importance.accountRevision, state.account_revision);
      }
      const unknown = await request("query unknown importance version remains basic", resultUrl(queryU), { ...credentials.U, "x-orca-importance-version": "2" });
      assert.equal(unknown.response.status, 200);
      assert.ok(organizationSavedQueryResultResponseSchema.parse(unknown.value).messages.every(row => row.importance === undefined));
      // Exercise the real existing reader callback. No injected response, transaction or SQLite method.
      const proof = createDatabaseClient(databasePath);
      try {
        let observed = false;
        readSavedQueryResults(proof.sqlite, {
          auth: sessionU, authSource: "cookie", queryId: queryU.id,
          query: { accountId: queryU.accountId, limit: 30 }, cursorSecret: process.env.SESSION_SECRET!,
          observe() {
            observed = true;
            assert.equal(proof.sqlite.inTransaction, true);
            assert.deepEqual(proof.sqlite.query("PRAGMA query_only").get(), { query_only: 1 });
            assert.throws(() => proof.sqlite.query("UPDATE emails SET snippet='forbidden' WHERE account_id=?").run(accountU), /readonly|read-only/i);
          },
        });
        assert.equal(observed, true);
        assert.deepEqual(proof.sqlite.query("SELECT total_changes() changes").get(), { changes: 0 });
        importanceReceipt({ name: "actual-query-read-only-control", inTransaction: true, queryOnly: 1, rejectedUpdate: true, connectionTotalChanges: 0 });
      } finally { proof.sqlite.close(); }
      importanceReceipt({ name: "preconditions-complete", complete: true, queryU, queryB, sourceStates: states,
        authenticatedUserIds: [originalUser, currentUser], cookieAndMobileBOwnScopePositive: true,
        providerCalls: { ...providerCalls }, measurement: "fresh-session data_version plus selected source table equality; not attempted-DML auditing on closed request connections" });
    }
    return {
      preconditions, request, resultUrl, sourceStates, close,
      app, client, databasePath, sessionU, sessionB, mobileB,
      get queryU() { assert.ok(queryU); return queryU; },
      get queryB() { assert.ok(queryB); return queryB; },
      headersU: credentials.U,
      headersB(kind: AuthKind, expected = originalUser) { return { ...credentials[kind], [expectedUserIdHeaderName]: expected }; },
      currentUser,
    };
  } catch (error) { close(); throw error; }
}

export type QueryImportanceBaselineFixture = Awaited<ReturnType<typeof createQueryImportanceBaselineFixture>>;
