ALTER TABLE `collections` ADD `revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `pins` ADD `target_type` text DEFAULT 'resource' NOT NULL;
--> statement-breakpoint
ALTER TABLE `pins` ADD `resource_family` text;
--> statement-breakpoint
ALTER TABLE `pins` ADD `saved_query_id` text;
--> statement-breakpoint
ALTER TABLE `pins` ADD `revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE `organization_saved_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `organization_saved_queries` (`id`, `account_id`, `name`, `definition_json`)
SELECT 'query:legacy:' || `id`, `account_id`, `label`, `target_id`
FROM `pins`
WHERE `kind` = 'filter';
--> statement-breakpoint
UPDATE `pins`
SET `target_type` = 'query', `saved_query_id` = 'query:legacy:' || `id`
WHERE `kind` = 'filter';
--> statement-breakpoint
UPDATE `pins`
SET `resource_family` = `kind`
WHERE `kind` IN ('sender', 'thread', 'view');
--> statement-breakpoint
CREATE TABLE `organization_collection_pin_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`operation` text NOT NULL,
	`change_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`command_json` text NOT NULL,
	`reason` text NOT NULL,
	`reverts_change_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_collection_pin_audits_workspace_idempotency_unique_idx` ON `organization_collection_pin_audits` (`workspace_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `organization_collection_pin_audits_workspace_created_idx` ON `organization_collection_pin_audits` (`workspace_id`,`created_at`);
