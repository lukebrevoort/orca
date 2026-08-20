CREATE TABLE `calendar_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`account_label` text NOT NULL,
	`access_token_encrypted` text,
	`refresh_token_encrypted` text,
	`token_expiry` integer,
	`scope` text NOT NULL,
	`state` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_connections_user_idx` ON `calendar_connections` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_connections_provider_identity_unique_idx` ON `calendar_connections` (`user_id`,`provider`,`provider_account_id`);
--> statement-breakpoint
CREATE TABLE `availability_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provider_calendar_id` text NOT NULL,
	`display_name` text NOT NULL,
	`time_zone` text,
	`selected` integer DEFAULT false NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`access_role` text NOT NULL,
	`last_discovered_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `calendar_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_calendars_connection_provider_unique_idx` ON `availability_calendars` (`connection_id`,`provider_calendar_id`);
--> statement-breakpoint
CREATE INDEX `availability_calendars_connection_selected_idx` ON `availability_calendars` (`connection_id`,`selected`);
--> statement-breakpoint
CREATE TABLE `calendar_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`time_zone` text NOT NULL,
	`working_hours` text,
	`stale_after_minutes` integer DEFAULT 15 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
