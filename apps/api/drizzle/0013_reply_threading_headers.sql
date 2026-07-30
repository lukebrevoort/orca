ALTER TABLE `emails` ADD `internet_message_id` text;
--> statement-breakpoint
ALTER TABLE `emails` ADD `references` text;
--> statement-breakpoint
UPDATE `oauth_accounts` SET `last_synced_at` = NULL, `sync_cursor` = NULL;
