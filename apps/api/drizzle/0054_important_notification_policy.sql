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
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
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
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 FOREIGN KEY(user_id,channel,installation_id) REFERENCES important_notification_installations(user_id,channel,installation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,claim_operation_id) REFERENCES important_notification_web_claims(user_id,operation_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES oauth_accounts(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,thread_id,message_id) REFERENCES emails(account_id,thread_id,id) ON DELETE CASCADE);
--> statement-breakpoint
CREATE UNIQUE INDEX important_notification_web_dedupe_idx ON important_notification_web_deliveries(user_id,installation_id,generation,message_id);
--> statement-breakpoint
CREATE INDEX important_notification_web_claim_idx ON important_notification_web_deliveries(user_id,installation_id,claim_operation_id);
