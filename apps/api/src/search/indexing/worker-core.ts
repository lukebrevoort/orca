import type { Database } from "bun:sqlite";
import { asciiLower, assertMatchingBuild, readIndexAccount, readIndexControl, readSearchControl, searchScopeKey, type IndexDocument, type SourceAccount, type SearchMode } from "./schema.ts";
import { DEFAULT_INDEX_LIMITS, jobKey, type IndexJob, type IndexLimits, type IndexReceipt } from "./queue.ts";

export interface WorkerIdentity { sourceId: string; buildId: string; ownerToken: string }
interface SourceText { sender: string; subject: string; snippet: string; body: string; bytes: number }
type SourceSnapshot = { kind: "stale" | "delete" | "account" | "oversize" } | { kind: "text"; text: SourceText };
export function assertWriter(index: Database, identity: WorkerIdentity): void {
  const control = readIndexControl(index);
  if (control.source_id !== identity.sourceId || control.build_id !== identity.buildId || control.owner_token !== identity.ownerToken) throw new Error("search_writer_fenced");
}
function receipt(job: IndexJob, status: IndexReceipt["status"]): IndexReceipt {
  if (!job.attempt_token) throw new Error("search_attempt_missing");
  return { protocol: 1, build_id: job.build_id, account_id: job.account_id, incarnation: job.incarnation, mode: job.mode, target: job.target, message_id: job.message_id, version: job.version, attempt_token: job.attempt_token, status };
}
function readSource(canonical: Database, job: IndexJob, identity: WorkerIdentity, limits: IndexLimits): SourceSnapshot {
  return canonical.transaction((): SourceSnapshot => {
    const control = readSearchControl(canonical);
    if (control.source_id !== identity.sourceId || control.build_id !== identity.buildId || job.build_id !== identity.buildId) throw new Error("search_build_mismatch");
    const current = canonical.query<IndexJob, [string, string, SearchMode, string, string]>("SELECT * FROM mail_search_outbox WHERE account_id=? AND incarnation=? AND mode=? AND target=? AND message_id=?").get(...jobKey(job));
    if (!current || current.version !== job.version || current.attempt_token !== job.attempt_token || current.state !== "claimed") return { kind: "stale" };
    const account = canonical.query<SourceAccount, [string, string, SearchMode]>("SELECT * FROM mail_search_accounts WHERE account_id=? AND incarnation=? AND mode=?").get(job.account_id, job.incarnation, job.mode);
    if (job.target === "account") return { kind: "account" };
    if (!account || account.deleted || job.operation === "delete") return { kind: "delete" };
    // SQLite obtains the byte length before any text value crosses into JS. Never
    // SELECT body_text for a metadata job, including its size/admission query.
    const bodySize = job.mode === "full" ? "+coalesce(length(CAST(body_text AS BLOB)),0)" : "";
    const size = canonical.query<{ bytes: number }, [string, string]>(`SELECT coalesce(length(CAST(from_name AS BLOB)),0)+coalesce(length(CAST(from_address AS BLOB)),0)+coalesce(length(CAST(subject AS BLOB)),0)+coalesce(length(CAST(snippet AS BLOB)),0)+1${bodySize} AS bytes FROM emails WHERE id=? AND account_id=?`).get(job.message_id, job.account_id);
    if (!size) return { kind: "delete" };
    if (size.bytes > (job.mode === "full" ? limits.fullBytes : limits.metadataBytes)) return { kind: "oversize" };
    const row = canonical.query<Omit<SourceText, "bytes">, [string, string]>(`SELECT coalesce(from_name,'') || ' ' || coalesce(from_address,'') AS sender,coalesce(subject,'') AS subject,coalesce(snippet,'') AS snippet,${job.mode === "full" ? "coalesce(body_text,'')" : "''"} AS body FROM emails WHERE id=? AND account_id=?`).get(job.message_id, job.account_id);
    if (!row) return { kind: "delete" };
    return { kind: "text", text: { ...row, bytes: size.bytes } };
  }).deferred();
}
function ensureAccount(index: Database, job: Pick<IndexJob, "account_id" | "incarnation" | "mode">): void {
  index.query("INSERT INTO index_accounts(account_id,incarnation,mode) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(job.account_id, job.incarnation, job.mode);
}
function invalidateAccount(index: Database, job: Pick<IndexJob, "account_id" | "incarnation" | "mode">, deleted = 0): void {
  index.query("UPDATE index_accounts SET ready=0,mutation_token=mutation_token+1,deleted=max(deleted,?) WHERE account_id=? AND incarnation=? AND mode=?").run(deleted, job.account_id, job.incarnation, job.mode);
}
export function applyIndexJob(canonical: Database, index: Database, job: IndexJob, identity: WorkerIdentity, limits: IndexLimits = DEFAULT_INDEX_LIMITS, fault?: "before_commit" | "after_commit"): IndexReceipt {
  assertWriter(index, identity);
  const source = readSource(canonical, job, identity, limits);
  if (source.kind === "stale") return receipt(job, "applied");
  if (source.kind === "oversize") return { ...receipt(job, "blocked"), error_code: "source_too_large" };
  const result = index.transaction(() => {
    assertWriter(index, identity);
    ensureAccount(index, job);
    const table = job.mode === "metadata" ? "metadata_fts" : "full_fts";
    const versionColumn = job.mode === "metadata" ? "metadata_version" : "full_version";
    const deletedColumn = job.mode === "metadata" ? "metadata_deleted" : "full_deleted";
    const bytesColumn = job.mode === "metadata" ? "metadata_bytes" : "full_bytes";
    if (source.kind === "account") {
      invalidateAccount(index, job, 1);
      const docs = index.query<{ doc_id: string }, [string, string, number]>(`SELECT CAST(doc_id AS TEXT) AS doc_id FROM index_documents WHERE account_id=? AND incarnation=? AND ${deletedColumn}=0 ORDER BY index_documents.doc_id LIMIT ?`).all(job.account_id, job.incarnation, limits.cleanupDocuments);
      for (const doc of docs) {
        index.query(`DELETE FROM ${table} WHERE rowid=?`).run(doc.doc_id);
        index.query(`UPDATE index_documents SET ${deletedColumn}=1,${bytesColumn}=0,${versionColumn}=max(coalesce(${versionColumn},0),?) WHERE doc_id=?`).run(job.version, doc.doc_id);
      }
      if (fault === "before_commit") throw new Error("injected_before_commit");
      const more = index.query(`SELECT 1 FROM index_documents WHERE account_id=? AND incarnation=? AND ${deletedColumn}=0 LIMIT 1`).get(job.account_id, job.incarnation);
      return receipt(job, more ? "more" : "applied");
    }
    index.query("INSERT INTO index_documents(account_id,incarnation,message_id) VALUES(?,?,?) ON CONFLICT DO NOTHING").run(job.account_id, job.incarnation, job.message_id);
    const doc = index.query<IndexDocument, [string, string, string]>("SELECT CAST(doc_id AS TEXT) AS doc_id,account_id,incarnation,message_id,metadata_version,full_version,metadata_deleted,full_deleted,metadata_bytes,full_bytes FROM index_documents WHERE account_id=? AND incarnation=? AND message_id=?").get(job.account_id, job.incarnation, job.message_id)!;
    const appliedVersion = doc[versionColumn];
    // NULL is unindexed. A first baseline version zero must apply.
    if (appliedVersion !== null && appliedVersion >= job.version) return receipt(job, "applied");
    const account = readIndexAccount(index, job.account_id, job.incarnation, job.mode)!;
    const deleted = source.kind === "delete" || account.deleted === 1;
    invalidateAccount(index, job);
    index.query(`DELETE FROM ${table} WHERE rowid=?`).run(doc.doc_id);
    if (!deleted && source.kind === "text") {
      const text = source.text;
      const values = [doc.doc_id, searchScopeKey(job.account_id, job.incarnation), asciiLower(text.sender), asciiLower(text.subject), asciiLower(text.snippet)];
      if (job.mode === "full") index.query("INSERT INTO full_fts(rowid,scope_key,sender,subject,snippet,body) VALUES(?,?,?,?,?,?)").run(...values, asciiLower(text.body));
      else index.query("INSERT INTO metadata_fts(rowid,scope_key,sender,subject,snippet) VALUES(?,?,?,?,?)").run(...values);
    }
    index.query(`UPDATE index_documents SET ${versionColumn}=?,${deletedColumn}=?,${bytesColumn}=? WHERE doc_id=?`).run(job.version, deleted ? 1 : 0, source.kind === "text" && !deleted ? source.text.bytes : 0, doc.doc_id);
    if (fault === "before_commit") throw new Error("injected_before_commit");
    return receipt(job, "applied");
  }).immediate();
  if (fault === "after_commit") throw new Error("injected_after_commit");
  return result;
}
export function publishAccountReady(canonical: Database, index: Database, accountId: string, incarnation: string, mode: SearchMode, identity: WorkerIdentity, betweenProofAndPublish?: () => void): boolean {
  assertWriter(index, identity);
  const before = readIndexAccount(index, accountId, incarnation, mode);
  const mutation = before?.mutation_token ?? 0;
  const proof = canonical.transaction(() => {
    const control = readSearchControl(canonical);
    assertMatchingBuild(control, readIndexControl(index));
    const account = canonical.query<SourceAccount, [string, string, SearchMode]>("SELECT * FROM mail_search_accounts WHERE account_id=? AND incarnation=? AND mode=? AND deleted=0").get(accountId, incarnation, mode);
    if (!account?.baseline_complete) return null;
    // Includes pending, claimed, delayed, blocked and account cleanup jobs.
    if (canonical.query("SELECT 1 FROM mail_search_outbox WHERE account_id=? AND incarnation=? AND mode=? LIMIT 1").get(accountId, incarnation, mode)) return null;
    return account.revision;
  }).deferred();
  if (proof === null) return false;
  betweenProofAndPublish?.();
  return index.transaction(() => {
    assertWriter(index, identity);
    ensureAccount(index, { account_id: accountId, incarnation, mode });
    return index.query("UPDATE index_accounts SET published_revision=?,ready=1 WHERE account_id=? AND incarnation=? AND mode=? AND mutation_token=? AND deleted=0")
      .run(proof, accountId, incarnation, mode, mutation).changes === 1;
  }).immediate();
}
