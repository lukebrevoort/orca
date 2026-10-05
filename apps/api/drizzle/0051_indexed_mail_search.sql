-- Additive only: no existing mail is scanned or rewritten by this migration.
-- Requires SQLite >= 3.43 (contentless_delete + octet_length), with FTS5/trigram.
-- Indexing existing mail and activation are explicit offline-admin steps.
CREATE TABLE mail_search_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  phase TEXT NOT NULL DEFAULT 'building' CHECK (phase IN ('building', 'ready')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  last_email_id TEXT,
  verified_at INTEGER,
  CHECK (enabled = 0 OR phase = 'ready')
);
--> statement-breakpoint
INSERT INTO mail_search_state (singleton, version) VALUES (1, 1);
--> statement-breakpoint
CREATE TABLE mail_search_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE ON UPDATE CASCADE,
  account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  metadata_octets INTEGER NOT NULL CHECK (metadata_octets >= 0),
  body_octets INTEGER NOT NULL CHECK (body_octets >= 0)
);
--> statement-breakpoint
CREATE INDEX mail_search_documents_account_idx ON mail_search_documents(account_id, document_id);
--> statement-breakpoint
-- Single-trigram candidate lookups need no positional postings.
-- Separate postings are an authority boundary: metadata-only callers never query
-- a body-bearing FTS table, including for candidate counts or admission budgets.
CREATE VIRTUAL TABLE mail_search_metadata_v1 USING fts5(
  metadata, content='', contentless_delete=1,
  tokenize='trigram case_sensitive 1', detail=none
);
--> statement-breakpoint
CREATE VIRTUAL TABLE mail_search_full_v1 USING fts5(
  metadata, body, content='', contentless_delete=1,
  tokenize='trigram case_sensitive 1', detail=none
);
--> statement-breakpoint
-- Explicit stable document IDs survive VACUUM; emails' implicit rowids do not.
CREATE TRIGGER mail_search_documents_ai AFTER INSERT ON mail_search_documents BEGIN
  INSERT INTO mail_search_metadata_v1(rowid, metadata)
    SELECT NEW.document_id, lower(CASE WHEN instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0)) > 0 THEN substr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), 1, instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0))-1) ELSE (coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')) END) FROM emails e WHERE e.id=NEW.email_id;
  INSERT INTO mail_search_full_v1(rowid, metadata, body)
    SELECT NEW.document_id, lower(CASE WHEN instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0)) > 0 THEN substr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), 1, instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0))-1) ELSE (coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')) END), lower(CASE WHEN instr((coalesce(e.body_text, '')), char(0)) > 0 THEN substr((coalesce(e.body_text, '')), 1, instr((coalesce(e.body_text, '')), char(0))-1) ELSE (coalesce(e.body_text, '')) END) FROM emails e WHERE e.id=NEW.email_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_documents_au AFTER UPDATE ON mail_search_documents BEGIN
  DELETE FROM mail_search_metadata_v1 WHERE rowid=OLD.document_id;
  DELETE FROM mail_search_full_v1 WHERE rowid=OLD.document_id;
  INSERT INTO mail_search_metadata_v1(rowid, metadata)
    SELECT NEW.document_id, lower(CASE WHEN instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0)) > 0 THEN substr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), 1, instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0))-1) ELSE (coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')) END) FROM emails e WHERE e.id=NEW.email_id;
  INSERT INTO mail_search_full_v1(rowid, metadata, body)
    SELECT NEW.document_id, lower(CASE WHEN instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0)) > 0 THEN substr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), 1, instr((coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')), char(0))-1) ELSE (coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')) END), lower(CASE WHEN instr((coalesce(e.body_text, '')), char(0)) > 0 THEN substr((coalesce(e.body_text, '')), 1, instr((coalesce(e.body_text, '')), char(0))-1) ELSE (coalesce(e.body_text, '')) END) FROM emails e WHERE e.id=NEW.email_id;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_documents_ad AFTER DELETE ON mail_search_documents BEGIN
  DELETE FROM mail_search_metadata_v1 WHERE rowid=OLD.document_id;
  DELETE FROM mail_search_full_v1 WHERE rowid=OLD.document_id;
END;
--> statement-breakpoint
-- These database triggers cover existing binaries, both providers, and SQL writes.
CREATE TRIGGER mail_search_emails_ai AFTER INSERT ON emails BEGIN
  INSERT INTO mail_search_documents(email_id, account_id, metadata_octets, body_octets)
    VALUES (NEW.id, NEW.account_id, coalesce(octet_length(NEW.from_name), 0) + coalesce(octet_length(NEW.from_address), 0) + coalesce(octet_length(NEW.subject), 0) + coalesce(octet_length(NEW.snippet), 0) + 3, coalesce(octet_length(NEW.body_text), 0));
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_emails_au
AFTER UPDATE OF id, account_id, from_name, from_address, subject, snippet, body_text ON emails
WHEN OLD.id IS NOT NEW.id OR OLD.account_id IS NOT NEW.account_id
  OR OLD.from_name IS NOT NEW.from_name OR OLD.from_address IS NOT NEW.from_address
  OR OLD.subject IS NOT NEW.subject OR OLD.snippet IS NOT NEW.snippet OR OLD.body_text IS NOT NEW.body_text
BEGIN
  INSERT INTO mail_search_documents(email_id, account_id, metadata_octets, body_octets)
    VALUES (NEW.id, NEW.account_id, coalesce(octet_length(NEW.from_name), 0) + coalesce(octet_length(NEW.from_address), 0) + coalesce(octet_length(NEW.subject), 0) + coalesce(octet_length(NEW.snippet), 0) + 3, coalesce(octet_length(NEW.body_text), 0))
    ON CONFLICT(email_id) DO UPDATE SET account_id=excluded.account_id,
      metadata_octets=excluded.metadata_octets, body_octets=excluded.body_octets;
END;
