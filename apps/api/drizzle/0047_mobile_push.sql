CREATE TABLE `mobile_push_devices` (
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`session_id` text NOT NULL,
	`token_encrypted` text NOT NULL,
	`token_hash` text NOT NULL,
	`environment` text NOT NULL,
	`notification_mode` text NOT NULL DEFAULT 'human',
	`generation` integer NOT NULL DEFAULT 1,
	`eligible_after_at` integer NOT NULL,
	`watermark_created_at` integer NOT NULL,
	`watermark_email_id` text NOT NULL DEFAULT '',
	`registered_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`disabled_at` integer,
	`disabled_reason` text,
	PRIMARY KEY(`user_id`, `installation_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mobile_push_devices_environment_check` CHECK(`environment` IN ('sandbox','production')),
	CONSTRAINT `mobile_push_devices_mode_check` CHECK(`notification_mode` IN ('human','all','off')),
	CONSTRAINT `mobile_push_devices_generation_check` CHECK(`generation` >= 1)
);
--> statement-breakpoint
CREATE INDEX `mobile_push_devices_scan_idx` ON `mobile_push_devices` (`notification_mode`,`disabled_at`,`watermark_created_at`,`watermark_email_id`);
--> statement-breakpoint
CREATE INDEX `mobile_push_devices_stale_idx` ON `mobile_push_devices` (`last_seen_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_push_devices_token_owner_idx` ON `mobile_push_devices` (`token_hash`,`environment`);
--> statement-breakpoint
CREATE TABLE `mobile_push_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`device_generation` integer NOT NULL,
	`message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`environment` text NOT NULL,
	`payload_json` text NOT NULL,
	`apns_id` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempt_count` integer NOT NULL DEFAULT 0,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`user_id`,`installation_id`) REFERENCES `mobile_push_devices`(`user_id`,`installation_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`thread_id`,`message_id`) REFERENCES `emails`(`account_id`,`thread_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mobile_push_outbox_environment_check` CHECK(`environment` IN ('sandbox','production')),
	CONSTRAINT `mobile_push_outbox_state_check` CHECK(`state` IN ('pending','delivering','sent','dead')),
	CONSTRAINT `mobile_push_outbox_attempt_check` CHECK(`attempt_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_push_outbox_dedupe_idx` ON `mobile_push_outbox` (`user_id`,`installation_id`,`device_generation`,`message_id`);
--> statement-breakpoint
CREATE INDEX `mobile_push_outbox_ready_idx` ON `mobile_push_outbox` (`state`,`available_at`,`created_at`);
