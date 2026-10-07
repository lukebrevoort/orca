import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import {
  parseMailSearch, mailSearchOrder, mailSearchSemantics, normalizeMailSearchText,
  type MailSearchPage,
} from "@orca/shared/mail-search";
import type { InboxClassificationResponse } from "@orca/shared/schemas";
import {
  readMailboxAccounts, serializeMailboxAccount, readMailboxCandidateRows, serializeMailboxRows,
  mailboxRevision, mailboxFreshAt, mailboxMessageClassification, MailboxScopeError, validateMailboxFilterScope,
  type MailboxReadAuthorization, type MailboxReadQuery, type RawMailboxMessage,
} from "../mailbox/read.ts";
import {
  readSearchControl, readSourceAccounts, readIndexControl, readIndexAccount,
  openCanonicalReadOnly, openIndexReadOnly, getSearchIndexPath, searchScopeKey, canonicalizePath,
  SEARCH_INDEX_FORMAT, type SearchMode, type SourceAccount,
} from "./indexing/schema.ts";
import { SearchError } from "./errors.ts";
import { decodeSearchCursor, encodeSearchCursor, searchDigest, type SearchPosition } from "./cursor.ts";
import { readSearchMode, requireIndexedSearch, searchActivationEpoch } from "./mode.ts";

export const rankedSearchReadLimits = Object.freeze({ candidateBatch: 64, candidatePageBudget: 2_048, shortBodyBytes: 4 * 1024 * 1024 });
export type RankedSearchInput = {
  databasePath: string;
  authorization: MailboxReadAuthorization;
  query: MailboxReadQuery & { query: string };
  mode: SearchMode;
  cursorKey: string;
  expectedEpoch?: string;
  exactCounts?: boolean;
};
export type RankedSearchResult = {
  page: MailSearchPage;
  counts?: InboxClassificationResponse["counts"];
  freshness: NonNullable<InboxClassificationResponse["freshness"]>;
  capabilityAccounts: Array<{ id: string; provider: "gmail" | "outlook"; scope: string | null }>;
  metric: { durationMs: number; candidateRows: number; indexBatches: number; shortBodyBytes: number; projectedMessages: number };
};
type Candidate = { doc_id: string; account_id: string; incarnation: string; message_id: string; source_bytes: number };
type Matched = { position: SearchPosition; row: RawMailboxMessage };
const quoteFts = (literal: string) => `"${literal.replaceAll('"', '""')}"`;

function fieldExpression(fields: string, clauses: readonly string[]) {
  return `{${fields}} : (${clauses.map(quoteFts).join(" AND ")})`;
}
/** Internal scope values cannot become user text fields or ranking features. */
export function compileSearchTier(anchors: readonly string[], tier: number, mode: SearchMode, scopes: readonly string[], excludeHigher: boolean): string {
  const fields = ["subject", "sender", "sender subject snippet", "sender subject snippet body"];
  if (!anchors.length || scopes.length === 0 || tier > (mode === "full" ? 3 : 2)) throw new Error("Invalid internal search tier");
  let expression = fieldExpression(fields[tier]!, anchors);
  if (excludeHigher) {
    for (let higher = 0; higher < tier; higher++) expression = `(${expression}) NOT (${fieldExpression(fields[higher]!, anchors)})`;
  }
  return `(scope_key : (${scopes.map(quoteFts).join(" OR ")})) AND (${expression})`;
}

function assertReady(canonical: Database, index: Database, accountIds: string[], mode: SearchMode) {
  let control;
  let indexControl;
  try { control = readSearchControl(canonical); indexControl = readIndexControl(index); }
  catch { throw new SearchError("search_index_unavailable"); }
  if (!control.enabled) throw new SearchError("search_not_activated");
  if (control.format_version !== SEARCH_INDEX_FORMAT || indexControl.format_version !== SEARCH_INDEX_FORMAT
    || control.source_id !== indexControl.source_id || control.build_id !== indexControl.build_id) throw new SearchError("search_index_unavailable");
  const sources = readSourceAccounts(canonical, accountIds, mode);
  if (sources.length !== accountIds.length) throw new SearchError("search_index_updating");
  for (const source of sources) {
    const published = readIndexAccount(index, source.account_id, source.incarnation, mode);
    if (!source.baseline_complete || !published || published.deleted || !published.ready || published.published_revision !== source.revision) {
      const blocked = canonical.query("select 1 from mail_search_outbox where account_id=? and incarnation=? and mode=? and state='blocked' limit 1").get(source.account_id, source.incarnation, mode);
      throw new SearchError(blocked ? "search_index_blocked" : "search_index_updating");
    }
  }
  return { control, sources };
}

function candidates(index: Database, mode: SearchMode, match: string, after: string, sources: SourceAccount[]): Candidate[] {
  const table = mode === "full" ? "full_fts" : "metadata_fts";
  const scopeSql = sources.map(() => "(d.account_id=? and d.incarnation=?)").join(" or ");
  const rows = index.query(`select cast(d.doc_id as text) doc_id,d.account_id,d.incarnation,d.message_id,
    d.${mode === "full" ? "full_bytes" : "metadata_bytes"} source_bytes
    from ${table} join index_documents d on d.doc_id=${table}.rowid
    where ${table} match ? and ${table}.rowid > cast(? as integer)
      and d.${mode === "full" ? "full_deleted" : "metadata_deleted"}=0 and (${scopeSql})
    order by ${table}.rowid asc limit ?`).all(match, after, ...sources.flatMap(source => [source.account_id, source.incarnation]), rankedSearchReadLimits.candidateBatch) as Candidate[];
  for (const row of rows) {
    if (!/^\d+$/.test(row.doc_id) || !Number.isSafeInteger(row.source_bytes) || row.source_bytes < 0) throw new SearchError("search_index_unavailable");
  }
  return rows;
}

function metadataFields(row: RawMailboxMessage) {
  return [row.subject ?? "", `${row.from_name ?? ""} ${row.from_address ?? ""}`, row.snippet ?? ""].map(normalizeMailSearchText);
}
function metadataTier(row: RawMailboxMessage, clauses: readonly string[]): number {
  const fields = metadataFields(row);
  if (clauses.every(clause => fields[0]!.includes(clause))) return 0;
  if (clauses.every(clause => fields[1]!.includes(clause))) return 1;
  if (clauses.every(clause => fields.some(field => field.includes(clause)))) return 2;
  return 3;
}
function matchCandidate(canonical: Database, row: RawMailboxMessage, clauses: readonly string[], shortClauses: readonly string[], mode: SearchMode, budget: { bodyBytes: number }, expectedTier: number): number | "budget" | null {
  const tier = metadataTier(row, clauses);
  if (tier < 3) return tier;
  if (mode === "metadata" || expectedTier < 3) return null;
  const fields = metadataFields(row);
  const missingShort = shortClauses.filter(clause => !fields.some(field => field.includes(clause)));
  // Positional FTS already proved all longer clauses, including body phrases.
  if (!missingShort.length) return 3;
  const size = canonical.query("select coalesce(octet_length(body_text),0) bytes from emails where id=? and account_id=?").get(row.id, row.account_id) as { bytes: number } | null;
  if (!size || !Number.isSafeInteger(size.bytes) || size.bytes < 0) throw new SearchError("search_index_unavailable");
  if (size.bytes > rankedSearchReadLimits.shortBodyBytes) throw new SearchError("search_budget_exceeded");
  if (budget.bodyBytes + size.bytes > rankedSearchReadLimits.shortBodyBytes) return "budget";
  budget.bodyBytes += size.bytes;
  const body = canonical.query("select lower(coalesce(body_text,'')) text from emails where id=? and account_id=?").get(row.id, row.account_id) as { text: string } | null;
  return body && missingShort.every(clause => body.text.includes(clause)) ? 3 : null;
}

function emptyCounts(): InboxClassificationResponse["counts"] {
  return { attention: { all: 0, focus: 0, normal: 0, quiet: 0, hidden: 0 }, classification: { all: 0, likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 0 } };
}
function addCount(counts: InboxClassificationResponse["counts"], row: RawMailboxMessage) {
  counts.attention.all++; counts.classification.all++;
  const attention = row.attention_behavior === "notify" ? "focus" : row.attention_behavior;
  if (attention === "focus" || attention === "normal" || attention === "quiet" || attention === "hidden") counts.attention[attention]++;
  const classification = mailboxMessageClassification(row);
  if (classification === "likely_human" || classification === "automated_or_bulk" || classification === "uncertain" || classification === "unclassified") counts.classification[classification]++;
}
function follows(position: SearchPosition, cursor: SearchPosition) {
  return position.tier > cursor.tier || position.tier === cursor.tier && BigInt(position.after) > BigInt(cursor.after);
}

/** Runs only in the bounded read child. Both snapshots stay pinned through
 * readiness, candidate traversal, canonical filters, hydration and cursor. */
export function readRankedSearch(input: RankedSearchInput, options: { afterCanonicalSnapshot?: () => void; candidatePageBudget?: number } = {}): RankedSearchResult {
  const start = performance.now();
  if (!Number.isInteger(input.query.limit) || input.query.limit < 1 || input.query.limit > (input.mode === "metadata" && input.exactCounts ? 100 : 50)) throw new Error("Invalid internal search page size");
  if (input.exactCounts && input.mode !== "metadata") throw new Error("Exact search counts are metadata-only");
  const canonicalPath = canonicalizePath(input.databasePath);
  const indexPath = getSearchIndexPath(canonicalPath);
  const canonical = openCanonicalReadOnly(canonicalPath);
  let index: Database | undefined;
  try {
    canonical.exec("BEGIN");
    const snapshot = readSearchMode(canonical, input.authorization.userId,
      input.expectedEpoch === undefined ? {} : { mode: "indexed", epoch: input.expectedEpoch });
    requireIndexedSearch(snapshot);
    const parsed = parseMailSearch(input.query.query);
    const accounts = readMailboxAccounts(canonical, input.authorization);
    if (!accounts.length) throw new MailboxScopeError();
    const accountIds = accounts.map(account => account.id);
    validateMailboxFilterScope(canonical, input.authorization.userId, accountIds, input.query);
    if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) throw new SearchError("search_index_updating");
    const revision = mailboxRevision(canonical, accountIds);
    // Establish canonical clock/ownership snapshot before opening the sidecar.
    readSearchControl(canonical);
    options.afterCanonicalSnapshot?.();
    index = openIndexReadOnly(indexPath);
    index.exec("BEGIN");
    const { control, sources } = assertReady(canonical, index, accountIds, input.mode);
    const binding = searchDigest({ version: 3, parser: mailSearchSemantics, order: mailSearchOrder,
      owner: input.authorization.userId, mode: input.mode, source: control.source_id, build: control.build_id,
      activationEpoch: searchActivationEpoch(control, input.authorization.userId),
      accounts: sources.map(source => [source.account_id, source.incarnation, source.revision]).sort(), revision,
      clauses: parsed.clauses, filters: { view: input.query.view ?? "default", classification: input.query.classification ?? "all",
        sender: input.query.sender ?? null, senderAddress: input.query.senderAddress ?? null, attentionBehavior: input.query.attentionBehavior ?? null, collectionId: input.query.collectionId ?? null, destinationId: input.query.destinationId ?? null,
        receivedAfter: input.query.receivedAfter ?? null, receivedBefore: input.query.receivedBefore ?? null }, exactCounts: Boolean(input.exactCounts) });
    const cursor = decodeSearchCursor(input.query.cursor, binding, input.cursorKey);
    if (input.mode === "metadata" && cursor.tier > 2) throw new SearchError("search_invalid_cursor");
    if (cursor.counts && !input.exactCounts) throw new SearchError("search_invalid_cursor");
    const scopes = sources.map(source => searchScopeKey(source.account_id, source.incarnation));
    const query = { ...input.query, query: undefined, cursor: undefined };
    let candidateRows = 0;
    let indexBatches = 0;
    const budget = { bodyBytes: 0 };
    const matches: Matched[] = [];
    let continuation: MailSearchPage["continuation"] = "none";
    let nextPosition: SearchPosition | undefined;
    // Signed totals are reusable only for this exact owner/query/filter/mode/
    // epoch/source/mailbox snapshot, already revalidated above on every page.
    let counts = cursor.counts;
    if (input.exactCounts && !counts) {
      counts = emptyCounts();
      const tiers: Matched[][] = [[], [], []];
      let after = "0";
      const expression = compileSearchTier(parsed.anchors, 2, "metadata", scopes, false);
      while (true) {
        const batch = candidates(index, "metadata", expression, after, sources); indexBatches++;
        if (!batch.length) break;
        candidateRows += batch.length;
        const baseRows = readMailboxCandidateRows(canonical, { authorization: input.authorization, query, messageIds: batch.map(candidate => candidate.message_id), presentationFilters: false });
        const byId = new Map(baseRows.map(row => [row.id, row]));
        for (const candidate of batch) {
          after = candidate.doc_id;
          const row = byId.get(candidate.message_id);
          if (!row || row.account_id !== candidate.account_id) continue;
          const tier = metadataTier(row, parsed.clauses);
          if (tier === 3) continue;
          addCount(counts, row);
          const position = { tier, after };
          if (row.presentation_match && follows(position, cursor) && tiers[tier]!.length < input.query.limit + 1) tiers[tier]!.push({ position, row });
        }
      }
      matches.push(...tiers.flat().slice(0, input.query.limit + 1));
      if (matches.length > input.query.limit) { matches.length = input.query.limit; continuation = "matches"; nextPosition = matches.at(-1)!.position; }
    } else {
      let position: SearchPosition = { tier: cursor.tier, after: cursor.after };
      const maxTier = input.mode === "full" ? 3 : 2;
      scan: for (let tier = cursor.tier; tier <= maxTier; tier++) {
        let after = tier === cursor.tier ? cursor.after : "0";
        const expression = compileSearchTier(parsed.anchors, tier, input.mode, scopes, parsed.shortClauses.length === 0);
        while (true) {
          const batch = candidates(index, input.mode, expression, after, sources); indexBatches++;
          if (!batch.length) break;
          const rows = readMailboxCandidateRows(canonical, { authorization: input.authorization, query, messageIds: batch.map(candidate => candidate.message_id) });
          const byId = new Map(rows.map(row => [row.id, row]));
          for (const candidate of batch) {
            // The count adapter promises complete pages, unlike public ranked
            // search's explicit partial-scan continuation. Keep its hard process
            // deadline, but do not silently introduce partial exact-count pages.
            if (!input.exactCounts && candidateRows >= (options.candidatePageBudget ?? rankedSearchReadLimits.candidatePageBudget)) { continuation = "scan"; nextPosition = position; break scan; }
            const row = byId.get(candidate.message_id);
            const actualTier = row && row.account_id === candidate.account_id
              ? matchCandidate(canonical, row, parsed.clauses, parsed.shortClauses, input.mode, budget, tier) : null;
            if (actualTier === "budget") { continuation = "scan"; nextPosition = position; break scan; }
            candidateRows++;
            after = candidate.doc_id;
            position = { tier, after };
            if (actualTier !== tier || !row) continue;
            if (matches.length === input.query.limit) {
              continuation = "matches";
              nextPosition = matches.at(-1)!.position;
              break scan;
            }
            matches.push({ row, position });
          }
        }
        position = { tier: tier + 1, after: "0" };
      }
    }
    const projected = serializeMailboxRows(canonical, matches.map(match => match.row), accounts);
    return {
      page: { accounts: accounts.map(account => serializeMailboxAccount(account)), messages: projected.messages,
        nextCursor: nextPosition ? encodeSearchCursor({ ...nextPosition, ...(counts ? { counts } : {}) }, binding, input.cursorKey) : null,
        continuation, snapshot: `search-v3:${binding}`, order: mailSearchOrder, semantics: mailSearchSemantics,
        coverage: input.mode === "full" ? "stored-plaintext" : "stored-metadata" },
      ...(counts ? { counts } : {}), freshness: { revision, lastSyncedAt: mailboxFreshAt(accounts) },
      capabilityAccounts: accounts.map(account => ({ id: account.id, provider: account.provider, scope: account.scope })),
      metric: { durationMs: performance.now() - start, candidateRows, indexBatches, shortBodyBytes: budget.bodyBytes, projectedMessages: projected.messages.length },
    };
  } finally {
    try { if (index?.inTransaction) index.exec("ROLLBACK"); } finally { index?.close(); }
    try { if (canonical.inTransaction) canonical.exec("ROLLBACK"); } finally { canonical.close(); }
  }
}
