import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const SEARCH_INDEX_FORMAT = 3;
export type SearchMode = "metadata" | "full";
export const SEARCH_MODES: readonly SearchMode[] = ["metadata", "full"];
export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const searchScopeKey = (accountId: string, incarnation: string): string =>
  `s${createHash("sha256").update(JSON.stringify([accountId, incarnation])).digest("hex")}`;
export const getSearchIndexPath = (canonicalPath: string): string => `${canonicalizePath(canonicalPath)}.search-v3.sqlite`;

export interface SearchControl {
  source_id: string; build_id: string; format_version: number;
  enabled: number; activation_epoch: number; worker_enabled: number; paused: number;
}
export interface SourceAccount {
  account_id: string; incarnation: string; mode: SearchMode; revision: number;
  baseline_cursor: string; baseline_complete: number; deleted: number;
}
export interface IndexControl {
  source_id: string; build_id: string; format_version: number; owner_token: string | null;
}
export interface IndexAccount {
  account_id: string; incarnation: string; mode: SearchMode;
  published_revision: number | null; ready: number; mutation_token: number; deleted: number;
}
export interface IndexDocument {
  /** SQLite signed-64-bit row IDs are lossless decimal strings at the JS boundary. */
  doc_id: string; account_id: string; incarnation: string; message_id: string;
  metadata_version: number | null; full_version: number | null;
  metadata_deleted: number; full_deleted: number; metadata_bytes: number; full_bytes: number;
}
export function readSearchControl(db: Database): SearchControl {
  const row = db.query<SearchControl, []>("SELECT source_id,build_id,format_version,enabled,activation_epoch,worker_enabled,paused FROM mail_search_control WHERE singleton=1").get();
  if (!row || row.format_version !== SEARCH_INDEX_FORMAT || !Number.isSafeInteger(row.activation_epoch) || row.activation_epoch < 0) throw new Error("search_schema_incompatible");
  return row;
}
export function readSourceAccounts(db: Database, accountIds: readonly string[], mode: SearchMode): SourceAccount[] {
  const statement = db.query<SourceAccount, [string, SearchMode]>("SELECT * FROM mail_search_accounts WHERE account_id=? AND mode=? AND deleted=0");
  return accountIds.flatMap((id) => { const row = statement.get(id, mode); return row ? [row] : []; });
}
export function readIndexControl(db: Database): IndexControl {
  const row = db.query<IndexControl, []>("SELECT source_id,build_id,format_version,owner_token FROM index_control WHERE singleton=1").get();
  if (!row || row.format_version !== SEARCH_INDEX_FORMAT) throw new Error("search_index_incompatible");
  return row;
}
export function readIndexAccount(db: Database, accountId: string, incarnation: string, mode: SearchMode): IndexAccount | null {
  return db.query<IndexAccount, [string, string, SearchMode]>("SELECT * FROM index_accounts WHERE account_id=? AND incarnation=? AND mode=?").get(accountId, incarnation, mode);
}
export function assertMatchingBuild(canonical: SearchControl, index: IndexControl): void {
  if (canonical.source_id !== index.source_id || canonical.build_id !== index.build_id || canonical.format_version !== index.format_version) throw new Error("search_build_mismatch");
}
/** Resolve symlinks to one SQLite/WAL path and refuse hard-linked database files. */
export function canonicalizePath(path: string): string {
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonical = resolve(realpathSync(dirname(resolve(path))), basename(path));
  }
  try {
    const stat = statSync(canonical);
    if (!stat.isFile()) throw new Error("search_database_not_regular_file");
    // Separate WAL/SHM/lock names for the same inode are unsafe SQLite aliases.
    if (stat.nlink !== 1) throw new Error("search_database_hardlink_unsupported");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return canonical;
}
export function openCanonicalReadOnly(path: string): Database {
  const db = new Database(canonicalizePath(path), { readonly: true, strict: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048");
  return db;
}
export function openIndexReadOnly(path: string): Database {
  const db = new Database(canonicalizePath(path), { readonly: true, strict: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048");
  return db;
}
export function assertDurableCanonical(db: Database): void {
  // synchronous is connection-local: canonical app writers must also use FULL.
  const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  const sync = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
  if (journal?.journal_mode !== "wal" || sync?.synchronous !== 2) throw new Error("search_requires_wal_full");
}
export function initializeIndex(db: Database, canonical: SearchControl): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048");
  db.exec(`
    CREATE TABLE index_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL,build_id TEXT NOT NULL,format_version INTEGER NOT NULL,owner_token TEXT);
    CREATE TABLE index_accounts(account_id TEXT NOT NULL,incarnation TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('metadata','full')),published_revision INTEGER,ready INTEGER NOT NULL DEFAULT 0,mutation_token INTEGER NOT NULL DEFAULT 0,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,incarnation,mode));
    CREATE TABLE index_documents(doc_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,incarnation TEXT NOT NULL,message_id TEXT NOT NULL,metadata_version INTEGER,full_version INTEGER,metadata_deleted INTEGER NOT NULL DEFAULT 1,full_deleted INTEGER NOT NULL DEFAULT 1,metadata_bytes INTEGER NOT NULL DEFAULT 0,full_bytes INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,incarnation,message_id));
    CREATE INDEX index_documents_account ON index_documents(account_id,incarnation,doc_id);
    CREATE INDEX index_documents_live_metadata ON index_documents(account_id,incarnation,doc_id) WHERE metadata_deleted=0;
    CREATE INDEX index_documents_live_full ON index_documents(account_id,incarnation,doc_id) WHERE full_deleted=0;
    CREATE VIRTUAL TABLE metadata_fts USING fts5(scope_key,sender,subject,snippet,content='',contentless_delete=1,tokenize='trigram case_sensitive 1',detail=full);
    CREATE VIRTUAL TABLE full_fts USING fts5(scope_key,sender,subject,snippet,body,content='',contentless_delete=1,tokenize='trigram case_sensitive 1',detail=full);
  `);
  db.query("INSERT INTO index_control(singleton,source_id,build_id,format_version) VALUES(1,?,?,?)").run(canonical.source_id, canonical.build_id, SEARCH_INDEX_FORMAT);
}
export function assertNoLegacySearch(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name IN ('mail_search_documents','mail_search_fts','mail_search_metadata_fts') LIMIT 1").get()) throw new Error("legacy_search_requires_separate_review");
}
