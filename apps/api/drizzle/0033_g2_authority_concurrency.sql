CREATE UNIQUE INDEX `mcp_connections_workspace_connection_unique_idx` ON `mcp_connections` (`user_id`,`id`);
--> statement-breakpoint
CREATE TABLE `mcp_organization_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`approver_user_id` text NOT NULL,
	`operation` text NOT NULL,
	`account_ids_digest` text NOT NULL,
	`command_digest` text NOT NULL,
	`simulation_id` text NOT NULL,
	`risk` text NOT NULL,
	`revisions_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer NOT NULL,
	`consumed_by_idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mcp_organization_approvals_workspace_connection_fk` FOREIGN KEY (`workspace_id`,`connection_id`) REFERENCES `mcp_connections`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_organization_approvals_connection_simulation_unique_idx` ON `mcp_organization_approvals` (`connection_id`,`simulation_id`);
--> statement-breakpoint
CREATE INDEX `mcp_organization_approvals_workspace_created_idx` ON `mcp_organization_approvals` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `organization_mutation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connection_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_digest` text NOT NULL,
	`account_count` integer NOT NULL,
	`account_ids_digest` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_mutation_attempts_workspace_operation_key_unique_idx` ON `organization_mutation_attempts` (`workspace_id`,`operation`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `organization_mutation_attempts_workspace_created_idx` ON `organization_mutation_attempts` (`workspace_id`,`created_at`);
