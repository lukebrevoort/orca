ALTER TABLE `mobile_push_devices` ADD `notify_inbox` integer NOT NULL DEFAULT 1 CHECK (`notify_inbox` IN (0,1));
--> statement-breakpoint
UPDATE `mobile_push_devices` SET `notify_inbox` = CASE WHEN `notification_mode` = 'off' THEN 0 ELSE 1 END;
--> statement-breakpoint
CREATE TABLE `mobile_push_device_spaces` (
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	PRIMARY KEY(`user_id`,`installation_id`,`space_id`),
	FOREIGN KEY (`user_id`,`installation_id`) REFERENCES `mobile_push_devices`(`user_id`,`installation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mobile_push_device_spaces_kind_check` CHECK(`kind` IN ('destination','collection','view'))
);
--> statement-breakpoint
CREATE INDEX `mobile_push_device_spaces_resource_idx` ON `mobile_push_device_spaces` (`kind`,`resource_id`);
--> statement-breakpoint
DROP INDEX `mobile_push_devices_scan_idx`;
--> statement-breakpoint
CREATE INDEX `mobile_push_devices_selection_scan_idx` ON `mobile_push_devices` (`notify_inbox`,`disabled_at`,`watermark_sequence`);
