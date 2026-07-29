CREATE TABLE `user_preferences` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  `signature` text DEFAULT '' NOT NULL,
  `compose_format` text DEFAULT 'plain' NOT NULL,
  `reply_behavior` text DEFAULT 'reply' NOT NULL,
  `notify_by_default` integer DEFAULT false NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
