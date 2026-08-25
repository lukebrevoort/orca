ALTER TABLE `organization_change_sets` ADD `resource_family` text DEFAULT 'facet_workflow' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `operation` text DEFAULT 'apply' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `command_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `reverts_change_id` text;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `workspace_revision_before` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `workspace_revision_after` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE `organization_change_actions` (
	`workspace_id` text NOT NULL,
	`change_id` text NOT NULL,
	`position` integer NOT NULL,
	`action_kind` text NOT NULL,
	`resource_family` text NOT NULL,
	`resource_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	PRIMARY KEY (`workspace_id`,`change_id`,`position`),
	CONSTRAINT `organization_change_actions_change_fk` FOREIGN KEY (`workspace_id`,`change_id`) REFERENCES `organization_change_sets`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_change_actions_resource_idx` ON `organization_change_actions` (`workspace_id`,`resource_family`,`resource_id`);
--> statement-breakpoint
CREATE TABLE `organization_context_types` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`retired_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_context_types_position_check` CHECK (`position` >= 0),
	CONSTRAINT `organization_context_types_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_context_types_workspace_position_unique_idx` ON `organization_context_types` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_context_types_workspace_name_unique_idx` ON `organization_context_types` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `organization_context_relationship_types` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`context_type_id` text NOT NULL,
	`name` text NOT NULL,
	`inverse_name` text NOT NULL,
	`direction` text NOT NULL,
	`position` integer NOT NULL,
	`maximum_per_thread` integer NOT NULL,
	`retired_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	CONSTRAINT `organization_context_relationship_types_context_type_fk` FOREIGN KEY (`workspace_id`,`context_type_id`) REFERENCES `organization_context_types`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_context_relationship_types_direction_check` CHECK (`direction` IN ('thread_to_context', 'context_to_thread')),
	CONSTRAINT `organization_context_relationship_types_position_check` CHECK (`position` >= 0),
	CONSTRAINT `organization_context_relationship_types_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `organization_context_relationship_types_maximum_check` CHECK (`maximum_per_thread` >= 1 AND `maximum_per_thread` <= 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_context_relationship_types_workspace_type_name_unique_idx` ON `organization_context_relationship_types` (`workspace_id`,`context_type_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_context_relationship_types_workspace_type_position_unique_idx` ON `organization_context_relationship_types` (`workspace_id`,`context_type_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_context_relationship_types_workspace_id_type_direction_unique_idx` ON `organization_context_relationship_types` (`workspace_id`,`id`,`context_type_id`,`direction`);
--> statement-breakpoint
CREATE TABLE `organization_contexts` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`context_type_id` text NOT NULL,
	`name` text NOT NULL,
	`retired_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	CONSTRAINT `organization_contexts_context_type_fk` FOREIGN KEY (`workspace_id`,`context_type_id`) REFERENCES `organization_context_types`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_contexts_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_contexts_workspace_type_name_unique_idx` ON `organization_contexts` (`workspace_id`,`context_type_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_contexts_workspace_id_type_unique_idx` ON `organization_contexts` (`workspace_id`,`id`,`context_type_id`);
--> statement-breakpoint
CREATE TABLE `organization_thread_context_relationships` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`context_type_id` text NOT NULL,
	`context_id` text NOT NULL,
	`relationship_type_id` text NOT NULL,
	`direction` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	CONSTRAINT `organization_thread_context_relationships_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_context_relationships_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_context_relationships_context_fk` FOREIGN KEY (`workspace_id`,`context_id`,`context_type_id`) REFERENCES `organization_contexts`(`workspace_id`,`id`,`context_type_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_context_relationships_relationship_type_fk` FOREIGN KEY (`workspace_id`,`relationship_type_id`,`context_type_id`,`direction`) REFERENCES `organization_context_relationship_types`(`workspace_id`,`id`,`context_type_id`,`direction`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_context_relationships_direction_check` CHECK (`direction` IN ('thread_to_context', 'context_to_thread')),
	CONSTRAINT `organization_thread_context_relationships_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_thread_context_relationships_stable_edge_unique_idx` ON `organization_thread_context_relationships` (`workspace_id`,`account_id`,`thread_id`,`context_id`,`relationship_type_id`);
--> statement-breakpoint
CREATE INDEX `organization_thread_context_relationships_thread_idx` ON `organization_thread_context_relationships` (`workspace_id`,`account_id`,`thread_id`);
--> statement-breakpoint
CREATE INDEX `organization_thread_context_relationships_context_idx` ON `organization_thread_context_relationships` (`workspace_id`,`context_id`);
