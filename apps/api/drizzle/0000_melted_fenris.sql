CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`from_address` text,
	`from_name` text,
	`subject` text,
	`snippet` text,
	`body_text` text,
	`body_html` text,
	`received_at` integer,
	`internal_date` integer,
	`is_read` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`is_draft` integer DEFAULT false NOT NULL,
	`human_signal` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_provider_message_unique_idx` ON `emails` (`account_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `emails_account_received_at_idx` ON `emails` (`account_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `emails_thread_idx` ON `emails` (`thread_id`);--> statement-breakpoint
CREATE TABLE `oauth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_email` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token_encrypted` text,
	`refresh_token_encrypted` text,
	`token_expiry` integer,
	`scope` text,
	`sync_cursor` text,
	`last_synced_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_accounts_user_idx` ON `oauth_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_accounts_provider_identity_unique_idx` ON `oauth_accounts` (`user_id`,`provider`,`provider_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`subject` text,
	`latest_received_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_provider_thread_unique_idx` ON `threads` (`account_id`,`provider_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_account_latest_received_at_idx` ON `threads` (`account_id`,`latest_received_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique_idx` ON `users` (`email`);