CREATE TABLE `sender_attention_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	`behavior` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_attention_rules_account_scope_value_unique_idx` ON `sender_attention_rules` (`account_id`,`scope`,`value`);--> statement-breakpoint
CREATE INDEX `sender_attention_rules_account_idx` ON `sender_attention_rules` (`account_id`);--> statement-breakpoint
CREATE TABLE `attention_view_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`behavior` text NOT NULL,
	`display_name` text NOT NULL,
	`icon` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attention_view_settings_account_behavior_unique_idx` ON `attention_view_settings` (`account_id`,`behavior`);--> statement-breakpoint
CREATE UNIQUE INDEX `attention_view_settings_account_position_unique_idx` ON `attention_view_settings` (`account_id`,`position`);
