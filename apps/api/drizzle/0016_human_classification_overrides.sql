CREATE TABLE `human_classification_overrides` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `target_type` text NOT NULL,
  `target_value` text NOT NULL,
  `classification` text NOT NULL,
  `source` text NOT NULL DEFAULT 'user_choice',
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `human_classification_overrides_account_target_unique_idx` ON `human_classification_overrides` (`account_id`,`target_type`,`target_value`);
--> statement-breakpoint
CREATE INDEX `human_classification_overrides_account_idx` ON `human_classification_overrides` (`account_id`);
