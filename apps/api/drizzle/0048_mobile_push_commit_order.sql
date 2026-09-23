CREATE TABLE `mobile_push_sequence_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	CONSTRAINT `mobile_push_sequence_counter_singleton_check` CHECK(`id` = 1),
	CONSTRAINT `mobile_push_sequence_counter_value_check` CHECK(`value` >= 0)
);
--> statement-breakpoint
CREATE TABLE `mobile_push_email_sequence` (
	`email_id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `mobile_push_email_sequence` (`email_id`,`sequence`) SELECT `id`, rowid FROM `emails`;
--> statement-breakpoint
INSERT INTO `mobile_push_sequence_counter` (`id`,`value`) SELECT 1, COALESCE(MAX(`sequence`),0) FROM `mobile_push_email_sequence`;
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_push_email_sequence_sequence_unique_idx` ON `mobile_push_email_sequence` (`sequence`);
--> statement-breakpoint
CREATE TRIGGER `mobile_push_email_sequence_after_insert`
AFTER INSERT ON `emails`
BEGIN
	UPDATE `mobile_push_sequence_counter` SET `value` = `value` + 1 WHERE `id` = 1;
	INSERT INTO `mobile_push_email_sequence` (`email_id`,`sequence`)
	VALUES (NEW.`id`, (SELECT `value` FROM `mobile_push_sequence_counter` WHERE `id` = 1));
END;
--> statement-breakpoint
ALTER TABLE `mobile_push_devices` ADD `watermark_sequence` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `mobile_push_devices` AS `device`
SET `watermark_sequence` = COALESCE((
	SELECT MAX(`push_order`.`sequence`)
	FROM `emails` AS `email`
	JOIN `mobile_push_email_sequence` AS `push_order` ON `push_order`.`email_id` = `email`.`id`
	JOIN `oauth_accounts` AS `account` ON `account`.`id` = `email`.`account_id`
	WHERE `account`.`user_id` = `device`.`user_id`
		AND (`email`.`created_at` < `device`.`watermark_created_at`
			OR (`email`.`created_at` = `device`.`watermark_created_at` AND `email`.`id` <= `device`.`watermark_email_id`))
), 0);
--> statement-breakpoint
DROP INDEX `mobile_push_devices_scan_idx`;
--> statement-breakpoint
CREATE INDEX `mobile_push_devices_scan_idx` ON `mobile_push_devices` (`notification_mode`,`disabled_at`,`watermark_sequence`);
