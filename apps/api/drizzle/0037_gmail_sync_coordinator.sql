ALTER TABLE `emails` ADD `provider_snapshot_digest` text;
--> statement-breakpoint
CREATE TABLE `gmail_sync_jobs` (
	`account_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`request_version` integer DEFAULT 0 NOT NULL,
	`pending_sources` integer DEFAULT 0 NOT NULL,
	`pending_history_id` text,
	`pending_full_resync` integer DEFAULT false NOT NULL,
	`pending_freshness_at` integer,
	`active_sources` integer DEFAULT 0 NOT NULL,
	`active_history_id` text,
	`active_full_resync` integer DEFAULT false NOT NULL,
	`active_freshness_at` integer,
	`lease_owner` text,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`available_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`coalesced_count` integer DEFAULT 0 NOT NULL,
	`total_enqueued` integer DEFAULT 0 NOT NULL,
	`total_runs` integer DEFAULT 0 NOT NULL,
	`last_started_at` integer,
	`last_finished_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `gmail_sync_jobs_state_check` CHECK (`state` IN ('idle','queued','running')),
	CONSTRAINT `gmail_sync_jobs_pending_sources_check` CHECK (`pending_sources` >= 0 AND `pending_sources` <= 15),
	CONSTRAINT `gmail_sync_jobs_active_sources_check` CHECK (`active_sources` >= 0 AND `active_sources` <= 15),
	CONSTRAINT `gmail_sync_jobs_request_version_check` CHECK (`request_version` >= 0),
	CONSTRAINT `gmail_sync_jobs_lease_version_check` CHECK (`lease_version` >= 0)
);
--> statement-breakpoint
CREATE INDEX `gmail_sync_jobs_ready_idx` ON `gmail_sync_jobs` (`state`,`available_at`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `gmail_sync_jobs_lease_expiry_idx` ON `gmail_sync_jobs` (`state`,`lease_expires_at`);
--> statement-breakpoint
CREATE TABLE `gmail_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`request_version` integer NOT NULL,
	`lease_version` integer NOT NULL,
	`sources` integer NOT NULL,
	`history_id` text,
	`full_resync` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`provider_fetch_ms` integer DEFAULT 0 NOT NULL,
	`db_prepare_count` integer DEFAULT 0 NOT NULL,
	`db_write_ms` integer DEFAULT 0 NOT NULL,
	`freshness_ms` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `gmail_sync_runs_status_check` CHECK (`status` IN ('succeeded','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_sync_runs_account_lease_unique_idx` ON `gmail_sync_runs` (`account_id`,`lease_version`);
--> statement-breakpoint
CREATE INDEX `gmail_sync_runs_account_finished_idx` ON `gmail_sync_runs` (`account_id`,`finished_at`);
