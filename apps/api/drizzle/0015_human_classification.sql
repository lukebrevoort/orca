ALTER TABLE `emails` ADD `human_classification` text;
--> statement-breakpoint
ALTER TABLE `emails` ADD `human_classification_reasons` text;
--> statement-breakpoint
ALTER TABLE `emails` ADD `human_classifier_version` text;
--> statement-breakpoint
ALTER TABLE `emails` ADD `human_classification_evidence` text;
--> statement-breakpoint
CREATE INDEX `emails_account_human_classification_idx` ON `emails` (`account_id`,`human_classification`);
