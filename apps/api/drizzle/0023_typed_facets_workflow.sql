CREATE TABLE `organization_workspace_states` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_workspace_states_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `organization_facets` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`value_type` text NOT NULL,
	`cardinality` text NOT NULL,
	`is_optional` integer NOT NULL,
	`default_value` text,
	`retired_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_facets_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `organization_facets_workspace_position_idx` ON `organization_facets` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE INDEX `organization_facets_workspace_name_idx` ON `organization_facets` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `organization_workflow_states` (
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
	CONSTRAINT `organization_workflow_states_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `organization_workflow_states_workspace_position_idx` ON `organization_workflow_states` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE INDEX `organization_workflow_states_workspace_name_idx` ON `organization_workflow_states` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE TABLE `organization_thread_states` (
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`account_id`,`thread_id`),
	CONSTRAINT `organization_thread_states_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_states_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_states_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `organization_thread_facet_values` (
	`workspace_id` text NOT NULL,
	`facet_id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`facet_id`,`account_id`,`thread_id`),
	CONSTRAINT `organization_thread_facet_values_workspace_facet_fk` FOREIGN KEY (`workspace_id`,`facet_id`) REFERENCES `organization_facets`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_facet_values_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_facet_values_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_thread_facet_values_account_thread_idx` ON `organization_thread_facet_values` (`workspace_id`,`account_id`,`thread_id`);
--> statement-breakpoint
CREATE TABLE `organization_thread_workflow_states` (
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`state_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`account_id`,`thread_id`),
	CONSTRAINT `organization_thread_workflow_states_workspace_state_fk` FOREIGN KEY (`workspace_id`,`state_id`) REFERENCES `organization_workflow_states`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_workflow_states_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_workflow_states_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_thread_workflow_states_account_state_idx` ON `organization_thread_workflow_states` (`workspace_id`,`account_id`,`state_id`);
--> statement-breakpoint
CREATE TABLE `organization_change_sets` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_digest` text NOT NULL,
	`authority_trace` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_change_sets_workspace_idempotency_unique_idx` ON `organization_change_sets` (`workspace_id`,`idempotency_key`);
