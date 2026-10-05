import type { Database } from "bun:sqlite";
export const mailSearchIndexVersion = 1;

export const mailSearchBackfillDefaults = Object.freeze({ batchRows: 100, batchOctets: 4 * 1024 * 1024 });
const maxBatchRows = 1_000;
const maxBatchOctets = 64 * 1024 * 1024;

export type MailSearchIndexStatus = {
  version: number;
  phase: "building" | "ready";
  enabled: boolean;
  lastEmailId: string | null;
  verifiedAt: number | null;
  indexedMessages: number;
  canonicalMessages: number;
  indexedSourceOctets: number;
};

type StateRow = { version: number; phase: "building" | "ready"; enabled: number; last_email_id: string | null; verified_at: number | null };

export function readMailSearchIndexStatus(sqlite: Database): MailSearchIndexStatus {
  const state = readState(sqlite);
  const counts = sqlite.query(`select count(*) as count,
    coalesce(sum(metadata_octets + body_octets), 0) as octets from mail_search_documents`).get() as { count: number; octets: number };
  return {
    version: state.version, phase: state.phase, enabled: state.enabled === 1,
    lastEmailId: state.last_email_id, verifiedAt: state.verified_at,
    indexedMessages: counts.count,
    canonicalMessages: (sqlite.query("select count(*) as count from emails").get() as { count: number }).count,
    indexedSourceOctets: counts.octets,
  };
}

export class MailSearchBackfillBudgetError extends Error {
  constructor(readonly emailId: string, readonly requiredOctets: number, readonly batchOctets: number) {
    super(`Message ${emailId} needs ${requiredOctets} source bytes; batch budget is ${batchOctets}. Increase --batch-bytes explicitly (maximum ${maxBatchOctets}) after checking memory/disk capacity.`);
    this.name = "MailSearchBackfillBudgetError";
  }
}

/** A single atomic, resumable batch. Never invoked from API requests or startup. */
export function backfillMailSearchBatch(sqlite: Database, options: {
  batchRows?: number;
  batchOctets?: number;
} = {}): { processed: number; sourceOctets: number; complete: boolean; lastEmailId: string | null } {
  const batchRows = boundedInteger(options.batchRows ?? mailSearchBackfillDefaults.batchRows, 1, maxBatchRows, "batchRows");
  const batchOctets = boundedInteger(options.batchOctets ?? mailSearchBackfillDefaults.batchOctets, 1, maxBatchOctets, "batchOctets");
  return sqlite.transaction(() => {
    const state = readState(sqlite);
    if (state.phase === "ready") return { processed: 0, sourceOctets: 0, complete: true, lastEmailId: state.last_email_id };
    const rows = sqlite.query(`select e.id, e.account_id,
      ${metadataOctetsSql} as metadata_octets,
      coalesce(octet_length(e.body_text), 0) as body_octets
      from emails e ${state.last_email_id === null ? "" : "where e.id > ?"}
      order by e.id limit ?`).all(...(state.last_email_id === null ? [] : [state.last_email_id]), batchRows + 1) as Array<{
        id: string; account_id: string; metadata_octets: number; body_octets: number;
      }>;
    let processed = 0;
    let sourceOctets = 0;
    let lastEmailId = state.last_email_id;
    const insert = sqlite.query(`insert into mail_search_documents(email_id, account_id, metadata_octets, body_octets)
      values (?, ?, ?, ?) on conflict(email_id) do nothing`);
    for (const row of rows.slice(0, batchRows)) {
      const octets = row.metadata_octets + row.body_octets;
      if (sourceOctets + octets > batchOctets) {
        if (processed === 0) throw new MailSearchBackfillBudgetError(row.id, octets, batchOctets);
        break;
      }
      // Inserts fire the same transactional FTS maintenance used by live writes.
      insert.run(row.id, row.account_id, row.metadata_octets, row.body_octets);
      sourceOctets += octets;
      lastEmailId = row.id;
      processed++;
    }
    sqlite.query("update mail_search_state set last_email_id=? where singleton=1").run(lastEmailId);
    // Completion is not activation. verify/enable performs full coverage and FTS checks.
    return { processed, sourceOctets, complete: processed === rows.length, lastEmailId };
  }).immediate();
}

/** Explicit administrative full verification; not part of a latency-bounded batch. */
export function verifyMailSearchIndex(sqlite: Database): MailSearchIndexStatus {
  return sqlite.transaction(() => {
    readState(sqlite);
    const missing = sqlite.query(`select e.id from emails e
      left join mail_search_documents d on d.email_id=e.id
      where d.document_id is null or d.account_id <> e.account_id
        or d.metadata_octets <> (${metadataOctetsSql})
        or d.body_octets <> coalesce(octet_length(e.body_text), 0) limit 1`).get();
    const orphan = sqlite.query(`select d.email_id from mail_search_documents d
      left join emails e on e.id=d.email_id where e.id is null limit 1`).get();
    if (missing || orphan) throw new Error("Search index coverage is incomplete or inconsistent; resume backfill before enabling");
    for (const index of ["mail_search_metadata_v1", "mail_search_full_v1"]) {
      const missingPosting = sqlite.query(`select document_id from mail_search_documents
        except select rowid from ${index} limit 1`).get();
      const extraPosting = sqlite.query(`select rowid from ${index}
        except select document_id from mail_search_documents limit 1`).get();
      if (missingPosting || extraPosting) throw new Error(`Search index row coverage is inconsistent: ${index}`);
      // FTS's documented internal integrity command checks its inverted postings.
      sqlite.exec(`insert into ${index}(${index}) values ('integrity-check')`);
    }
    sqlite.query("update mail_search_state set phase='ready', verified_at=? where singleton=1").run(Date.now());
    return readMailSearchIndexStatus(sqlite);
  }).immediate();
}

/** Enabling is deliberate and fail-closed; disabling never changes canonical mail. */
export function setMailSearchEnabled(sqlite: Database, enabled: boolean): MailSearchIndexStatus {
  return sqlite.transaction(() => {
    if (enabled) verifyMailSearchIndex(sqlite);
    else readState(sqlite);
    sqlite.query("update mail_search_state set enabled=? where singleton=1").run(enabled ? 1 : 0);
    return readMailSearchIndexStatus(sqlite);
  }).immediate();
}

function readState(sqlite: Database): StateRow {
  const state = sqlite.query("select version, phase, enabled, last_email_id, verified_at from mail_search_state where singleton=1").get() as StateRow | null;
  if (!state || state.version !== mailSearchIndexVersion) throw new Error("Search index migration/version is unavailable; apply migration 0051 before using this tool");
  return state;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

const metadataOctetsSql = `coalesce(octet_length(e.from_name), 0) + coalesce(octet_length(e.from_address), 0) + coalesce(octet_length(e.subject), 0) + coalesce(octet_length(e.snippet), 0) + 3`;
