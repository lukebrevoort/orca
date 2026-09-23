CREATE TABLE `mobile_auth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`request_token_hash` text NOT NULL,
	`code_challenge` text NOT NULL,
	`state` text NOT NULL,
	`user_id` text,
	`browser_session_id` text,
	`csrf_token_hash` text,
	`authorization_code_hash` text,
	`request_expires_at` integer NOT NULL,
	`code_expires_at` integer,
	`authorized_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_auth_requests_request_token_hash_unique_idx` ON `mobile_auth_requests` (`request_token_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_auth_requests_code_hash_unique_idx` ON `mobile_auth_requests` (`authorization_code_hash`);
--> statement-breakpoint
CREATE INDEX `mobile_auth_requests_request_expiry_idx` ON `mobile_auth_requests` (`request_expires_at`);
--> statement-breakpoint
CREATE INDEX `mobile_auth_requests_code_expiry_idx` ON `mobile_auth_requests` (`code_expires_at`);
--> statement-breakpoint
CREATE TABLE `mobile_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_sessions_token_hash_unique_idx` ON `mobile_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mobile_sessions_user_idx` ON `mobile_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mobile_sessions_expires_at_idx` ON `mobile_sessions` (`expires_at`);
