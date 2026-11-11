-- BRE-464: labels cascade before retained emails during account disposal. The
-- email-label delete trigger could recreate a mailbox revision for the removed
-- account, violating its FK. Only surviving parent accounts need invalidation.
-- Ordinary label/mail/thread changes keep their revision and cursor ABA barrier.
DROP TRIGGER mailbox_revision_email_label_delete;
--> statement-breakpoint
CREATE TRIGGER mailbox_revision_email_label_delete AFTER DELETE ON email_labels BEGIN
 INSERT INTO mailbox_revisions(account_id,revision,updated_at)
 SELECT e.account_id,1,unixepoch()*1000 FROM emails e
 JOIN oauth_accounts account ON account.id=e.account_id
 WHERE e.id=OLD.email_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at;
END;
