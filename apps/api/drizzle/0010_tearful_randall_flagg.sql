CREATE TABLE `message_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`to_recipients` text DEFAULT '[]' NOT NULL,
	`cc_recipients` text DEFAULT '[]' NOT NULL,
	`bcc_recipients` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text,
	`context` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`provider_draft_id` text,
	`provider_message_id` text,
	`provider_thread_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`delivery_status` text DEFAULT 'draft' NOT NULL,
	`send_idempotency_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_drafts_account_updated_at_idx` ON `message_drafts` (`account_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_drafts_account_idempotency_unique_idx` ON `message_drafts` (`account_id`,`send_idempotency_key`);
