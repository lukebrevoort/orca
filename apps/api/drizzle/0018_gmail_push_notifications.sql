ALTER TABLE `oauth_accounts` ADD `sync_history_id` text;
--> statement-breakpoint
ALTER TABLE `oauth_accounts` ADD `watch_expiration_at` integer;
--> statement-breakpoint
ALTER TABLE `oauth_accounts` ADD `watch_topic` text;
