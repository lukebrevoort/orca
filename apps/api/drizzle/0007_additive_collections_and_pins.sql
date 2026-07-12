CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_account_name_unique_idx` ON `collections` (`account_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_account_position_unique_idx` ON `collections` (`account_id`,`position`);
--> statement-breakpoint
CREATE TABLE `collection_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_threads_membership_unique_idx` ON `collection_threads` (`collection_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `collection_threads_thread_idx` ON `collection_threads` (`thread_id`);
--> statement-breakpoint
CREATE TABLE `pins` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`label` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pins_account_target_unique_idx` ON `pins` (`account_id`,`kind`,`target_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `pins_account_position_unique_idx` ON `pins` (`account_id`,`position`);
