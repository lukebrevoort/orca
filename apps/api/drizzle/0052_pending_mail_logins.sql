CREATE TABLE `pending_mail_logins` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `pending_email` text NOT NULL
);
