CREATE UNIQUE INDEX `oauth_accounts_user_id_id_unique_idx` ON `oauth_accounts` (`user_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_account_id_id_unique_idx` ON `threads` (`account_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_account_thread_id_unique_idx` ON `emails` (`account_id`,`thread_id`,`id`);
--> statement-breakpoint
CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`provider` text NOT NULL,
	`sender_name` text,
	`sender_address` text NOT NULL,
	`source_subject` text NOT NULL,
	`source_received_at` integer NOT NULL,
	`source_url` text NOT NULL,
	`trigger` text NOT NULL,
	`policy_version` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` text NOT NULL,
	`execution_mode` text NOT NULL,
	`event_kind` text NOT NULL,
	`importance` text NOT NULL,
	`relevance` text NOT NULL,
	`destination` text NOT NULL,
	`reason_codes` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`why_this_matters` text NOT NULL,
	`suggested_next_step` text,
	`human_classification` text,
	`human_signal` integer,
	`human_classification_reasons` text,
	`human_classifier_version` text,
	`human_classification_source` text,
	`deduplication_key` text NOT NULL,
	`assessment_fingerprint` text NOT NULL,
	`evaluated_at` integer NOT NULL,
	`lifecycle_state` text DEFAULT 'new' NOT NULL,
	`last_transition` text DEFAULT 'created' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`seen_at` integer,
	`snoozed_until` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `agent_events_owner_account_fk` FOREIGN KEY (`owner_user_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agent_events_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agent_events_source_message_fk` FOREIGN KEY (`account_id`,`thread_id`,`message_id`) REFERENCES `emails`(`account_id`,`thread_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `agent_events_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `agent_events_destination_check` CHECK (`destination` <> 'none')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_events_owner_account_dedupe_unique_idx` ON `agent_events` (`owner_user_id`,`account_id`,`deduplication_key`);
--> statement-breakpoint
CREATE INDEX `agent_events_account_updated_at_idx` ON `agent_events` (`account_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `agent_events_account_state_idx` ON `agent_events` (`account_id`,`lifecycle_state`);
--> statement-breakpoint
CREATE TABLE `agent_propagation_policy_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`category` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_propagation_policy_overrides_account_category_unique_idx` ON `agent_propagation_policy_overrides` (`account_id`,`category`);
--> statement-breakpoint
CREATE TABLE `agent_propagation_mutes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`target_scope` text NOT NULL,
	`target_value` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_propagation_mutes_account_target_unique_idx` ON `agent_propagation_mutes` (`account_id`,`target_scope`,`target_value`);
