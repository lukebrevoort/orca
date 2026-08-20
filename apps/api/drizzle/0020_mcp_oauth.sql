CREATE TABLE `mcp_oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_oauth_clients_created_at_idx` ON `mcp_oauth_clients` (`created_at`);
--> statement-breakpoint
CREATE TABLE `mcp_authorization_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`resource` text NOT NULL,
	`scopes` text NOT NULL,
	`account_ids` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_authorization_codes_code_hash_unique_idx` ON `mcp_authorization_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_authorization_codes_expires_at_idx` ON `mcp_authorization_codes` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_connections_user_idx` ON `mcp_connections` (`user_id`);
--> statement-breakpoint
CREATE INDEX `mcp_connections_revoked_at_idx` ON `mcp_connections` (`revoked_at`);
--> statement-breakpoint
CREATE TABLE `mcp_connection_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_connection_accounts_connection_account_unique_idx` ON `mcp_connection_accounts` (`connection_id`,`account_id`);
--> statement-breakpoint
CREATE INDEX `mcp_connection_accounts_account_idx` ON `mcp_connection_accounts` (`account_id`);
--> statement-breakpoint
CREATE TABLE `mcp_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`connection_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_access_tokens_token_hash_unique_idx` ON `mcp_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_connection_idx` ON `mcp_access_tokens` (`connection_id`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_expires_at_idx` ON `mcp_access_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `mcp_access_tokens_revoked_at_idx` ON `mcp_access_tokens` (`revoked_at`);
--> statement-breakpoint
CREATE TABLE `mcp_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`connection_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_refresh_tokens_token_hash_unique_idx` ON `mcp_refresh_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `mcp_refresh_tokens_connection_idx` ON `mcp_refresh_tokens` (`connection_id`);
--> statement-breakpoint
CREATE INDEX `mcp_refresh_tokens_expires_at_idx` ON `mcp_refresh_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `mcp_refresh_tokens_consumed_at_idx` ON `mcp_refresh_tokens` (`consumed_at`);
--> statement-breakpoint
CREATE INDEX `mcp_refresh_tokens_revoked_at_idx` ON `mcp_refresh_tokens` (`revoked_at`);
