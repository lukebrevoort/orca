CREATE TABLE `organization_views` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`definition` text NOT NULL,
	`revision` integer NOT NULL DEFAULT 1,
	`created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	PRIMARY KEY(`workspace_id`, `id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_views_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `organization_views_position_check` CHECK (`position` >= 0),
	CONSTRAINT `organization_views_definition_json_check` CHECK (json_valid(`definition`))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_views_workspace_position_unique_idx` ON `organization_views` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE INDEX `organization_thread_facet_values_lookup_idx` ON `organization_thread_facet_values` (`workspace_id`,`facet_id`,`account_id`,`thread_id`,`value`);
--> statement-breakpoint
CREATE INDEX `emails_thread_view_evidence_idx` ON `emails` (`account_id`,`thread_id`,`received_at`,`from_address`,`human_signal`,`human_classification`);
--> statement-breakpoint
CREATE INDEX `threads_view_order_idx` ON `threads` (COALESCE(`latest_received_at`,`created_at`) DESC,`account_id`,`id`);
