-- V3 captures IDs and revisions only. Index creation/backfill/activation is explicit.
-- Refuse the incompatible experimental PR224 schema without destroying its data.
CREATE TEMP TABLE mail_search_v3_guard (ok INTEGER CHECK(ok = 1));
--> statement-breakpoint
INSERT INTO mail_search_v3_guard SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sqlite_master WHERE name IN ('mail_search_documents','mail_search_fts','mail_search_metadata_fts')
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE mail_search_v3_guard;
--> statement-breakpoint
CREATE TABLE mail_search_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  source_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 3 CHECK(format_version = 3),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  activation_epoch INTEGER NOT NULL DEFAULT 0 CHECK(activation_epoch >= 0),
  worker_enabled INTEGER NOT NULL DEFAULT 0 CHECK(worker_enabled IN (0,1)),
  paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
  claim_account TEXT NOT NULL DEFAULT '',
  seal_account TEXT NOT NULL DEFAULT '',
  seal_mode TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
INSERT INTO mail_search_control(singleton,source_id,build_id) VALUES(1,hex(randomblob(16)),hex(randomblob(16)));
--> statement-breakpoint
CREATE TABLE mail_search_activation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activation_epoch INTEGER NOT NULL,
  command TEXT NOT NULL CHECK(command IN ('init','enable','disable')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  source_id TEXT NOT NULL,
  build_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE mail_search_accounts (
  account_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('metadata','full')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  baseline_cursor TEXT NOT NULL DEFAULT '',
  baseline_complete INTEGER NOT NULL DEFAULT 0 CHECK(baseline_complete IN (0,1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  PRIMARY KEY(account_id,incarnation,mode)
);
--> statement-breakpoint
CREATE UNIQUE INDEX mail_search_current_account ON mail_search_accounts(account_id,mode) WHERE deleted=0;
--> statement-breakpoint
INSERT INTO mail_search_accounts(account_id,incarnation,mode) SELECT id,hex(randomblob(16)),'metadata' FROM oauth_accounts;
--> statement-breakpoint
INSERT INTO mail_search_accounts(account_id,incarnation,mode) SELECT account_id,incarnation,'full' FROM mail_search_accounts WHERE mode='metadata';
--> statement-breakpoint
CREATE TABLE mail_search_outbox (
  account_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('metadata','full')),
  target TEXT NOT NULL CHECK(target IN ('message','account')),
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 0),
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  build_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','blocked')),
  attempt_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
  error_code TEXT,
  PRIMARY KEY(account_id,incarnation,mode,target,message_id)
);
--> statement-breakpoint
CREATE INDEX mail_search_outbox_schedule ON mail_search_outbox(state,account_id,CASE mode WHEN 'metadata' THEN 0 ELSE 1 END,created_at,message_id);
--> statement-breakpoint
CREATE INDEX mail_search_baseline_ids ON emails(account_id,id);
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_accounts_ai AFTER INSERT ON oauth_accounts  BEGIN
  INSERT INTO mail_search_accounts(account_id,incarnation,mode,baseline_complete) VALUES(NEW.id,hex(randomblob(16)),'metadata',1);
  INSERT INTO mail_search_accounts(account_id,incarnation,mode,baseline_complete) SELECT account_id,incarnation,'full',1 FROM mail_search_accounts WHERE account_id=NEW.id AND mode='metadata' AND deleted=0;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_accounts_bd BEFORE DELETE ON oauth_accounts BEGIN
  DELETE FROM mail_search_outbox WHERE account_id=OLD.id AND target='message' AND incarnation IN (SELECT incarnation FROM mail_search_accounts WHERE account_id=OLD.id AND deleted=0);
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'account','',a.revision+1,'delete',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c WHERE a.account_id=OLD.id AND a.deleted=0
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation='delete',build_id=excluded.build_id,state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
  UPDATE mail_search_accounts SET revision=revision+1,deleted=1,baseline_complete=1 WHERE account_id=OLD.id AND deleted=0;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_emails_ai AFTER INSERT ON emails  BEGIN
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=NEW.account_id AND deleted=0 AND mode IN ('metadata','full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',NEW.id,a.revision,'upsert',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=NEW.account_id AND a.deleted=0 AND a.mode IN ('metadata','full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_emails_ad AFTER DELETE ON emails  BEGIN
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=OLD.account_id AND deleted=0 AND mode IN ('metadata','full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',OLD.id,a.revision,'delete',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=OLD.account_id AND a.deleted=0 AND a.mode IN ('metadata','full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_emails_metadata_au AFTER UPDATE OF from_address,from_name,subject,snippet ON emails WHEN OLD.id=NEW.id AND OLD.account_id=NEW.account_id BEGIN
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=NEW.account_id AND deleted=0 AND mode IN ('metadata','full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',NEW.id,a.revision,'upsert',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=NEW.account_id AND a.deleted=0 AND a.mode IN ('metadata','full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_emails_body_au AFTER UPDATE OF body_text ON emails WHEN OLD.id=NEW.id AND OLD.account_id=NEW.account_id BEGIN
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=NEW.account_id AND deleted=0 AND mode IN ('full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',NEW.id,a.revision,'upsert',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=NEW.account_id AND a.deleted=0 AND a.mode IN ('full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_emails_identity_au AFTER UPDATE OF id,account_id ON emails WHEN OLD.id<>NEW.id OR OLD.account_id<>NEW.account_id BEGIN
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=OLD.account_id AND deleted=0 AND mode IN ('metadata','full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',OLD.id,a.revision,'delete',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=OLD.account_id AND a.deleted=0 AND a.mode IN ('metadata','full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
  UPDATE mail_search_accounts SET revision=revision+1 WHERE account_id=NEW.account_id AND deleted=0 AND mode IN ('metadata','full');
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'message',NEW.id,a.revision,'upsert',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c
    WHERE a.account_id=NEW.account_id AND a.deleted=0 AND a.mode IN ('metadata','full')
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation=excluded.operation,build_id=excluded.build_id,
      state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_accounts_bu BEFORE UPDATE OF id ON oauth_accounts WHEN OLD.id<>NEW.id BEGIN
  DELETE FROM mail_search_outbox WHERE account_id=OLD.id AND target='message' AND incarnation IN (SELECT incarnation FROM mail_search_accounts WHERE account_id=OLD.id AND deleted=0);
  INSERT INTO mail_search_outbox(account_id,incarnation,mode,target,message_id,version,operation,build_id)
    SELECT a.account_id,a.incarnation,a.mode,'account','',a.revision+1,'delete',c.build_id
    FROM mail_search_accounts a CROSS JOIN mail_search_control c WHERE a.account_id=OLD.id AND a.deleted=0
    ON CONFLICT(account_id,incarnation,mode,target,message_id) DO UPDATE SET
      version=excluded.version,operation='delete',build_id=excluded.build_id,state='pending',attempt_token=NULL,attempt_count=0,available_at=0,error_code=NULL;
  UPDATE mail_search_accounts SET revision=revision+1,deleted=1,baseline_complete=1 WHERE account_id=OLD.id AND deleted=0;
END;
--> statement-breakpoint
CREATE TRIGGER mail_search_v3_accounts_au AFTER UPDATE OF id ON oauth_accounts WHEN OLD.id<>NEW.id  BEGIN
  INSERT INTO mail_search_accounts(account_id,incarnation,mode,baseline_complete) VALUES(NEW.id,hex(randomblob(16)),'metadata',1);
  INSERT INTO mail_search_accounts(account_id,incarnation,mode,baseline_complete) SELECT account_id,incarnation,'full',1 FROM mail_search_accounts WHERE account_id=NEW.id AND mode='metadata' AND deleted=0;
END;
