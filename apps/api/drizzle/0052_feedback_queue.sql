CREATE TABLE `feedback_queue` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `id` text NOT NULL,
  `issue_id` text NOT NULL UNIQUE,
  `title` text NOT NULL,
  `description` text NOT NULL,
  `kind` text NOT NULL,
  `platform` text NOT NULL,
  `route` text NOT NULL,
  `created_at` text NOT NULL,
  `identifier` text,
  `url` text,
  `delivery_error` text,
  `lease_until` integer NOT NULL DEFAULT 0,
  `last_attempt_at` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `feedback_queue_user_created_idx` ON `feedback_queue` (`user_id`, `created_at`);
