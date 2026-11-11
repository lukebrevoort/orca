-- Explicit adoption is separate from legacy placement preferences and APNs credentials.
CREATE TABLE important_notification_installations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN ('apns','open_app')),
 installation_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 permission TEXT NOT NULL CHECK(permission IN ('granted','denied','default','unavailable')),
 revision INTEGER NOT NULL CHECK(revision>=1),
 generation INTEGER NOT NULL CHECK(generation>=1),
 previous_selection TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_scan_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,channel,installation_id));
--> statement-breakpoint
CREATE TABLE important_notification_accounts (
 user_id TEXT NOT NULL, channel TEXT NOT NULL, installation_id TEXT NOT NULL,
 account_id TEXT NOT NULL, eligible_after_at INTEGER NOT NULL,
 boundary_sequence INTEGER NOT NULL, watermark_sequence INTEGER NOT NULL,
 PRIMARY KEY(user_id,channel,installation_id,account_id),
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES oauth_accounts(user_id,id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE INDEX important_notification_account_scan_idx ON important_notification_accounts(account_id,watermark_sequence);
--> statement-breakpoint
CREATE TABLE important_notification_operations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, channel TEXT NOT NULL, installation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, applied_revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,operation_id),
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE TABLE important_notification_cooldowns (
 user_id TEXT NOT NULL, channel TEXT NOT NULL, installation_id TEXT NOT NULL,
 account_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 reservation_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
 FOREIGN KEY(account_id,thread_id) REFERENCES threads(account_id,id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,channel,installation_id,account_id,thread_id),
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES oauth_accounts(user_id,id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE TABLE important_notification_web_claims (
 user_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'open_app' CHECK(channel='open_app'),
 installation_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,operation_id),
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE TABLE important_notification_web_deliveries (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL,
 channel TEXT NOT NULL DEFAULT 'open_app' CHECK(channel='open_app'),
 installation_id TEXT NOT NULL, generation INTEGER NOT NULL,
 claim_operation_id TEXT NOT NULL, message_id TEXT NOT NULL,
 account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('claimed','constructed','failed','dead')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, envelope_json TEXT NOT NULL,
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,claim_operation_id) REFERENCES important_notification_web_claims(user_id,operation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES oauth_accounts(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,thread_id,message_id) REFERENCES emails(account_id,thread_id,id) ON UPDATE CASCADE ON DELETE CASCADE);
--> statement-breakpoint
CREATE UNIQUE INDEX important_notification_web_dedupe_idx ON important_notification_web_deliveries(user_id,installation_id,generation,message_id);
--> statement-breakpoint
CREATE INDEX important_notification_web_claim_idx ON important_notification_web_deliveries(user_id,installation_id,claim_operation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX important_notification_installation_owner_idx ON important_notification_installations(channel,installation_id);
--> statement-breakpoint
CREATE TABLE important_notification_arrivals (
 message_id TEXT PRIMARY KEY NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 observed_at INTEGER NOT NULL, received_at INTEGER, sequence INTEGER NOT NULL UNIQUE,
 evidence TEXT NOT NULL CHECK(evidence IN ('gmail_smtp_metadata','unknown')),
 reason TEXT NOT NULL, revoked_at INTEGER, unread_at_arrival INTEGER NOT NULL CHECK(unread_at_arrival IN (0,1)), important_at_arrival INTEGER NOT NULL CHECK(important_at_arrival IN (0,1)),
 FOREIGN KEY(account_id,thread_id,message_id) REFERENCES emails(account_id,thread_id,id) ON UPDATE CASCADE ON DELETE CASCADE);
--> statement-breakpoint
CREATE INDEX important_notification_arrivals_account_idx ON important_notification_arrivals(account_id,sequence);
--> statement-breakpoint
ALTER TABLE mobile_push_outbox ADD COLUMN important_generation INTEGER;
--> statement-breakpoint
CREATE INDEX important_notification_accounts_installation_idx ON important_notification_accounts(user_id,channel,installation_id,account_id,watermark_sequence);

--> statement-breakpoint
-- Corrected/read mail cannot regain an old queued interruption if later changed back.
CREATE TRIGGER important_notification_importance_revoked AFTER UPDATE OF effective ON importance_thread_state
WHEN NEW.effective<>'important' AND OLD.effective='important' BEGIN
 UPDATE important_notification_arrivals SET revoked_at=coalesce(revoked_at,unixepoch()*1000)
 WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id;
END;
--> statement-breakpoint
CREATE TRIGGER important_notification_read_revoked AFTER UPDATE OF is_read,is_draft ON emails
WHEN NEW.is_read=1 OR NEW.is_draft=1 BEGIN
 UPDATE important_notification_arrivals SET revoked_at=coalesce(revoked_at,unixepoch()*1000) WHERE message_id=NEW.id;
END;

--> statement-breakpoint
CREATE TRIGGER important_notification_sent_revoked AFTER INSERT ON email_labels
WHEN EXISTS(SELECT 1 FROM labels WHERE id=NEW.label_id AND upper(provider_label_id) IN ('SENT','DRAFT')) BEGIN
 UPDATE important_notification_arrivals SET revoked_at=coalesce(revoked_at,unixepoch()*1000) WHERE message_id=NEW.email_id;
END;
--> statement-breakpoint
CREATE TRIGGER important_notification_identity_revoked AFTER UPDATE OF from_address,internal_date,thread_id,account_id ON emails
WHEN NEW.from_address IS NOT OLD.from_address OR NEW.internal_date IS NOT OLD.internal_date OR NEW.thread_id IS NOT OLD.thread_id OR NEW.account_id IS NOT OLD.account_id BEGIN
 UPDATE important_notification_arrivals SET revoked_at=coalesce(revoked_at,unixepoch()*1000) WHERE message_id=NEW.id;
END;
--> statement-breakpoint
-- Retain the adoption tombstone when credentials/ownership are removed. A later
-- token registration cannot silently restore a stale permission report.
CREATE TRIGGER important_notification_device_removed AFTER DELETE ON mobile_push_devices BEGIN
 UPDATE important_notification_installations SET generation=generation+1,revision=revision+1,permission='unavailable',updated_at=unixepoch()*1000
 WHERE user_id=OLD.user_id AND channel='apns' AND installation_id=OLD.installation_id;
 UPDATE important_notification_accounts SET eligible_after_at=unixepoch()*1000,
 boundary_sequence=(SELECT value FROM mobile_push_sequence_counter WHERE id=1),watermark_sequence=(SELECT value FROM mobile_push_sequence_counter WHERE id=1)
 WHERE user_id=OLD.user_id AND channel='apns' AND installation_id=OLD.installation_id;
END;
