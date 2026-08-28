CREATE TABLE `organization_correction_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_digest` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_correction_receipts_actor_key_unique_idx` ON `organization_correction_receipts` (`workspace_id`,`actor_type`,`actor_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `organization_correction_receipts_workspace_created_idx` ON `organization_correction_receipts` (`workspace_id`,`created_at`);
