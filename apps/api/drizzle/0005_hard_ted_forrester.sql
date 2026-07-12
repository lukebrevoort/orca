CREATE TABLE `email_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`provider_attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_attachments_email_idx` ON `email_attachments` (`email_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_attachments_provider_attachment_unique_idx` ON `email_attachments` (`email_id`,`provider_attachment_id`);
