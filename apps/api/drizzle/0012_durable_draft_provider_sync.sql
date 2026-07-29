ALTER TABLE `message_drafts` ADD `provider_sync_status` text DEFAULT 'not_applicable' NOT NULL;
--> statement-breakpoint
ALTER TABLE `message_drafts` ADD `provider_sync_error` text;
