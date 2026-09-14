CREATE TABLE account_attention_routing (
 account_id text PRIMARY KEY NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 default_behavior text CHECK(default_behavior IN ('normal','quiet')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
--> statement-breakpoint
CREATE TABLE thread_attention_overrides (
 account_id text NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 thread_id text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 behavior text NOT NULL CHECK(behavior IN ('normal','quiet')),
 PRIMARY KEY(account_id,thread_id)
);
--> statement-breakpoint
CREATE TRIGGER attention_thread_owner_insert BEFORE INSERT ON thread_attention_overrides BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM threads WHERE id=NEW.thread_id AND account_id=NEW.account_id)
 THEN RAISE(ABORT, 'Thread does not belong to account') END;
 END;
--> statement-breakpoint
CREATE TRIGGER attention_thread_owner_update BEFORE UPDATE ON thread_attention_overrides BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM threads WHERE id=NEW.thread_id AND account_id=NEW.account_id)
 THEN RAISE(ABORT, 'Thread does not belong to account') END;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_sender_attention_rules_insert AFTER INSERT ON sender_attention_rules BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT NEW.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=NEW.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_sender_attention_rules_update AFTER UPDATE ON sender_attention_rules BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT NEW.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=NEW.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_sender_attention_rules_delete AFTER DELETE ON sender_attention_rules BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT OLD.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=OLD.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_thread_attention_overrides_insert AFTER INSERT ON thread_attention_overrides BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT NEW.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=NEW.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_thread_attention_overrides_update AFTER UPDATE ON thread_attention_overrides BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT NEW.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=NEW.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER routing_revision_thread_attention_overrides_delete AFTER DELETE ON thread_attention_overrides BEGIN
 INSERT INTO account_attention_routing(account_id,revision)
 SELECT OLD.account_id,1 WHERE EXISTS(SELECT 1 FROM oauth_accounts WHERE id=OLD.account_id)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 END;
--> statement-breakpoint
CREATE TRIGGER mailbox_revision_routing_insert AFTER INSERT ON account_attention_routing BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=(unixepoch()*1000) WHERE account_id=NEW.account_id;
 END;
--> statement-breakpoint
CREATE TRIGGER mailbox_revision_routing_update AFTER UPDATE ON account_attention_routing BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=(unixepoch()*1000) WHERE account_id=NEW.account_id;
 END;
--> statement-breakpoint
CREATE TRIGGER mailbox_revision_routing_delete AFTER DELETE ON account_attention_routing BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=(unixepoch()*1000) WHERE account_id=OLD.account_id;
 END;
