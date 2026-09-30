CREATE TABLE `mail_oauth_transactions` (
  `state_hash` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL,
  `provider` text NOT NULL,
  `intent` text NOT NULL,
  `account_id` text,
  `return_to` text,
  `pending_email` text,
  `code_verifier` text NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_oauth_transactions_expires_at_idx` ON `mail_oauth_transactions` (`expires_at`);
