CREATE TABLE `oauth_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`provider` text NOT NULL,
	`intent` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`return_to` text,
	`account_id` text,
	`code_verifier` text,
	`rate_limit_key` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_transactions_state_hash_unique_idx` ON `oauth_transactions` (`state_hash`);
--> statement-breakpoint
CREATE INDEX `oauth_transactions_expires_at_idx` ON `oauth_transactions` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `oauth_transactions_created_at_idx` ON `oauth_transactions` (`created_at`);
--> statement-breakpoint
CREATE INDEX `oauth_transactions_login_rate_idx` ON `oauth_transactions` (`intent`,`rate_limit_key`,`created_at`);
