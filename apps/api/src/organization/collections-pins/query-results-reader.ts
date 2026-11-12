import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  normalizeOrganizationSavedQueryDefinition,
  organizationSavedQueryResultResponseSchema,
  type OrganizationSavedQueryDefinition,
  type OrganizationSavedQueryResultQuery,
  type OrganizationSavedQueryResultResponse,
} from "@orca/shared";
import type { AuthContext } from "../../auth/middleware.ts";
import { createMailboxReader, mailboxRevision, type MailboxReadMetric, type MailboxReadQuery } from "../../mailbox/read.ts";
import { canonicalOrganizationJson } from "../authority.ts";
import { decodeQueryResultCursor, encodeQueryResultCursor } from "./query-result-cursor.ts";

export class SavedQueryReadError extends Error {
  constructor(readonly status: 401 | 404 | 422 | 503, readonly code: string, message: string) { super(message); }
}
const notFound = () => new SavedQueryReadError(404, "not_found", "Saved query or Account scope was not found");
const unavailable = () => new SavedQueryReadError(503, "mailbox_unavailable", "Mailbox state is unavailable; retry after synchronization");
const invalid = () => new SavedQueryReadError(422, "invalid_saved_query", "Saved query definition is invalid for this Account");
const digest = (value: unknown) => createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex");

type ReadInput = {
  auth: AuthContext;
  authSource: "cookie" | "mobile_bearer";
  queryId: string;
  query: OrganizationSavedQueryResultQuery;
  cursorSecret: string;
  /** Trusted representation option; deliberately excluded from evaluation/cursor scope. */
  includeImportance?: boolean;
  observe?: (metric: MailboxReadMetric) => void;
};

/** No catalog construction/bootstrap: this connection reads existing owned data only. */
export function readSavedQueryResults(sqlite: Database, input: ReadInput): OrganizationSavedQueryResultResponse {
  // This is a request-owned connection, never the middleware's renewal connection.
  // Enforce read-only SQL in addition to the no-domain-DML regression assertions.
  sqlite.exec("PRAGMA query_only = ON");
  return sqlite.transaction(() => {
    const { userId, sessionId } = input.auth;
    const sessionSql = input.authSource === "mobile_bearer"
      ? "SELECT id FROM mobile_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?"
      : "SELECT id FROM sessions WHERE id=? AND user_id=? AND invalidated_at IS NULL AND expires_at>?";
    if (!sqlite.query(sessionSql).get(sessionId, userId, Date.now())) {
      throw new SavedQueryReadError(401, "unauthorized", "Authentication required");
    }
    const accountId = input.query.accountId;
    const record = sqlite.query(`SELECT q.definition_json, q.revision
      FROM organization_saved_queries q JOIN oauth_accounts account ON account.id=q.account_id
      WHERE q.id=? AND account.id=? AND account.user_id=?`).get(input.queryId, accountId, userId) as { definition_json: string; revision: number } | null;
    if (!record) throw notFound();
    let definition: OrganizationSavedQueryDefinition;
    try {
      // Both normalizers validate strict current/legacy schemas. Do not call
      // mapQuery(), whose legacy catalog fallback broadens invalid records.
      definition = normalizeOrganizationSavedQueryDefinition(JSON.parse(record.definition_json));
      if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw invalid();
    } catch { throw invalid(); }
    const filters = definition.filters;
    if (filters.accountId !== undefined && filters.accountId !== accountId) throw invalid();
    if (filters.collectionId && !sqlite.query("SELECT id FROM collections WHERE id=? AND account_id=?").get(filters.collectionId, accountId)) throw notFound();

    // Missing derived roots are an explicit unavailable state, never a lazy GET
    // repair or fallback to another destination/account/all mail.
    if (!sqlite.query("SELECT account_id FROM mailbox_revisions WHERE account_id=?").get(accountId)
      || !sqlite.query(`SELECT settings.workspace_id FROM organization_workspace_lane_settings settings
        JOIN organization_lanes lane ON lane.workspace_id=settings.workspace_id AND lane.id=settings.fallback_lane_id
        WHERE settings.workspace_id=?`).get(userId)
      || sqlite.query(`SELECT thread.id FROM threads thread LEFT JOIN organization_thread_lane_states state
        ON state.workspace_id=? AND state.account_id=thread.account_id AND state.thread_id=thread.id
        WHERE thread.account_id=? AND state.thread_id IS NULL LIMIT 1`).get(userId, accountId)) throw unavailable();

    const legacy = filters.dataSource !== "stored_mail";
    const profile = legacy ? "legacy-pin-v1" as const : "stored-mail-v1" as const;
    const mailbox = filters.mailbox ?? "inbox";
    const attention = filters.attention ?? "all";
    const classification = filters.classification ?? (legacy && mailbox === "inbox" ? "human" : "all");
    const effective = {
      mailbox, attention, classification, person: filters.sender ?? null, text: filters.text ?? null,
      accountId, collectionId: filters.collectionId ?? null,
      order: "mailbox-v2/latest-received-created-id/v1",
    };
    const definitionDigest = digest(definition);
    const revision = mailboxRevision(sqlite, [accountId]);
    const fingerprint = digest({
      endpoint: "organization-saved-query-results/v1", userId, sessionId, authSource: input.authSource,
      accountId, queryId: input.queryId, objectRevision: record.revision,
      definitionDigest, profile, effective, mailboxRevision: revision, limit: input.query.limit,
    });
    const position = decodeQueryResultCursor(input.query.cursor, input.cursorSecret, fingerprint, revision);
    const query: MailboxReadQuery = {
      limit: input.query.limit, cursor: position, classification,
      ...(mailbox !== "inbox" ? { view: mailbox } : {}),
      ...(filters.collectionId ? { collectionId: filters.collectionId } : {}),
      ...(!legacy && filters.text ? { query: filters.text } : {}),
    };
    // Generated stored_mail queries do not opt into the trusted extension at all.
    const savedQueryProfile = legacy || attention !== "all" || filters.sender
      ? { legacy, attention, ...(filters.sender ? { person: filters.sender } : {}), ...(legacy && filters.text ? { text: filters.text } : {}) }
      : undefined;
    const { response } = createMailboxReader(sqlite, { observe: input.observe, includeImportance: input.includeImportance }).read({
      authorization: { userId, accountIds: [accountId] }, query,
      ...(savedQueryProfile ? { savedQueryProfile } : {}),
    });
    if (response.accounts.length !== 1 || response.accounts[0]?.id !== accountId
      || response.messages.some(message => message.accountId !== accountId)) throw new Error("Saved-query mailbox projection escaped Account scope");
    // The existing batch reader omits targets with missing precomputed state.
    // An opted-in success must be complete, never a fabricated Unreviewed or a
    // partial projection. This check remains inside the same query-only snapshot.
    if (input.includeImportance && response.messages.some(message => message.importance === undefined)) throw unavailable();
    return organizationSavedQueryResultResponseSchema.parse({
      query: { id: input.queryId, accountId, revision: record.revision, definitionDigest, evaluationProfile: profile },
      accounts: response.accounts,
      messages: response.messages,
      nextCursor: response.nextCursor ? encodeQueryResultCursor({
        version: 1, fingerprint, mailboxRevision: revision, position: response.nextCursor,
      }, input.cursorSecret) : null,
      freshness: response.freshness,
    });
  }).deferred();
}
