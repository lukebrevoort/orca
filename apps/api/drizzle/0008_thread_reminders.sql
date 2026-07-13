CREATE TABLE `thread_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`timezone` text NOT NULL,
	`notify` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`resurfaced_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_reminders_account_thread_idx` ON `thread_reminders` (`account_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `thread_reminders_account_scheduled_for_idx` ON `thread_reminders` (`account_id`,`scheduled_for`);
--> statement-breakpoint
CREATE TABLE `reminder_view_settings` (
	`account_id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT 'Later' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
