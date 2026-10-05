import type { Database } from "bun:sqlite";
import { mailSearchTerms } from "@orca/shared";

import { mailSearchIndexVersion } from "../db/mail-search-index.ts";
export const mailSearchResidualLimits = Object.freeze({
  maxCandidates: 500,
  // Conservative LIKE work estimate: source bytes × total original term length.
  // Bounds repeated-character phrases as well as large bodies and many terms.
  maxEstimatedComparisons: 32 * 1024 * 1024,
});

export class MailSearchUnavailableError extends Error {
  readonly code = "search_index_not_ready" as const;
  constructor() {
    super("Mail search is being prepared. Try again after indexing is complete.");
    this.name = "MailSearchUnavailableError";
  }
}

export class MailSearchAdmissionError extends Error {
  readonly code = "search_query_too_broad" as const;
  constructor(message = "This search is too broad. Add a specific word or phrase of at least 3 characters, or narrow the Account scope.") {
    super(message);
    this.name = "MailSearchAdmissionError";
  }
}

export type MailSearchRelation = {
  /** A server-created, account/owner-scoped SELECT with one column: email_id. */
  sql: string;
  params: Array<string | number>;
  strategy: "bounded-residual";
};

export type MailSearchAuthorization = {
  userId: string;
  accountIds?: readonly string[];
};

type IndexState = { version: number; phase: string; enabled: number };

/**
 * Prepare once inside the mailbox reader's read transaction, then reuse the
 * relation for both counts and pages in that same snapshot. No body is projected.
 * Authority and body permission must come from the server, never request params.
 */
export function prepareMailSearch(sqlite: Database, input: {
  query: string;
  authorization: MailSearchAuthorization;
  searchBodyText: boolean;
}): MailSearchRelation {
  if (!sqlite.inTransaction) throw new Error("Mail search requires a shared read transaction");
  const terms = mailSearchTerms(input.query);
  if (terms.some(term => term.includes("\0"))) throw new MailSearchAdmissionError("Mail search cannot contain a NUL character");
  assertMailSearchReady(sqlite);

  const index = input.searchBodyText ? "mail_search_full_v1" : "mail_search_metadata_v1";
  const anchors = mailSearchAnchors(terms);
  const clauses = ["a.user_id = ?"];
  const params: Array<string | number> = [input.authorization.userId];
  if (input.authorization.accountIds) {
    if (input.authorization.accountIds.length === 0) clauses.push("0");
    else {
      clauses.push(`d.account_id in (${input.authorization.accountIds.map(() => "?").join(",")})`);
      params.push(...input.authorization.accountIds);
    }
  }
  if (anchors.length) {
    clauses.push(`${index} MATCH ?`);
    params.push(compileMailSearchMatch(anchors));
  }
  const from = `from mail_search_documents d
    join oauth_accounts a on a.id = d.account_id
    ${anchors.length ? `join ${index} on ${index}.rowid = d.document_id` : ""}
    where ${clauses.join(" and ")}`;

  // Admission reads only the stable mapping and the selected authority's index.
  // In particular metadata-only search does not even SELECT body_octets.
  const candidates = sqlite.query(`select d.email_id, d.metadata_octets as octets
    ${input.searchBodyText ? ", d.body_octets as body_octets" : ""}
    ${from} limit ?`).all(...params, mailSearchResidualLimits.maxCandidates + 1) as Array<{
      email_id: string; octets: number; body_octets?: number;
    }>;
  if (candidates.length > mailSearchResidualLimits.maxCandidates
    || candidates.reduce((sum, row) => sum + row.octets + (row.body_octets ?? 0), 0) * terms.reduce((sum, term) => sum + term.length, 0)
      > mailSearchResidualLimits.maxEstimatedComparisons) throw new MailSearchAdmissionError();

  const residualParams: Array<string | number> = [JSON.stringify(candidates.map(row => row.email_id))];
  const predicates = terms.map(term => {
    const pattern = `%${term.replace(/[\\%_]/gu, character => `\\${character}`)}%`;
    residualParams.push(pattern);
    if (input.searchBodyText) residualParams.push(pattern);
    return `(${metadataLiteralSql} like ? escape '\\'
      ${input.searchBodyText ? "or coalesce(e.body_text, '') like ? escape '\\'" : ""})`;
  });
  const matched = sqlite.query(`select e.id as email_id from emails e
    where e.id in (select value from json_each(?)) and ${predicates.length ? predicates.join(" and ") : "1"}`)
    .all(...residualParams) as Array<{ email_id: string }>;
  return {
    // Residual text is evaluated exactly once. Counts and every attention/account
    // page reuse only these bounded IDs, without multiplying the admitted work.
    sql: "select value as email_id from json_each(?)",
    params: [JSON.stringify(matched.map(row => row.email_id))],
    strategy: "bounded-residual",
  };
}

export function assertMailSearchReady(sqlite: Database): void {
  // A rolled-back binary or a database that has not migrated is a known state,
  // not permission to resurrect the former unbounded body scan.
  const exists = sqlite.query("select 1 from sqlite_schema where type='table' and name='mail_search_state'").get();
  if (!exists) throw new MailSearchUnavailableError();
  const state = sqlite.query("select version, phase, enabled from mail_search_state where singleton=1").get() as IndexState | null;
  if (state?.version !== mailSearchIndexVersion || state.phase !== "ready" || state.enabled !== 1) {
    throw new MailSearchUnavailableError();
  }
}

/** FTS receives only distinct single-trigram tokens, never expensive positional
 * phrases. First/middle/last anchors may admit false positives, so every original
 * term is verified once against canonical text AFTER row/byte-work admission. */
export function mailSearchAnchors(terms: readonly string[]): string[] {
  const anchors = new Set<string>();
  for (const term of terms) {
    const characters = [...term];
    if (characters.length < 3) continue;
    for (const offset of [0, Math.floor((characters.length - 3) / 2), characters.length - 3]) {
      anchors.add(characters.slice(offset, offset + 3).join(""));
    }
  }
  return [...anchors];
}

/** Every anchor is exactly one literal trigram; FTS operators cannot be injected. */
export function compileMailSearchMatch(terms: readonly string[]): string {
  if (terms.some(term => term.includes("\0") || [...term].length !== 3)) throw new MailSearchAdmissionError("Indexed anchors must contain exactly 3 characters and no NUL character");
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

const metadataLiteralSql = `lower(coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, ''))`;
