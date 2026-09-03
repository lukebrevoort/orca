DROP INDEX `emails_mailbox_page_idx`;
--> statement-breakpoint
CREATE INDEX `emails_mailbox_account_page_idx` ON `emails` (`account_id`,COALESCE(`received_at`,0) DESC,`id`);
--> statement-breakpoint

CREATE TABLE `mailbox_revisions` (
	`account_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `oauth_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `mailbox_revisions_revision_check` CHECK(`revision` >= 1)
);
--> statement-breakpoint

INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
SELECT `id`, 1, (unixepoch() * 1000) FROM `oauth_accounts`;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_account_insert` AFTER INSERT ON `oauth_accounts` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	VALUES (NEW.`id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO NOTHING;
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_account_projection_update`
AFTER UPDATE OF `provider`, `provider_email`, `profile_image_url`, `scope`, `sync_history_id`, `last_synced_at` ON `oauth_accounts` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	VALUES (NEW.`id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET
		`revision` = `revision` + 1,
		`updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_user_display_update` AFTER UPDATE OF `display_name` ON `users` BEGIN
	UPDATE `mailbox_revisions`
	SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000)
	WHERE `account_id` IN (SELECT `id` FROM `oauth_accounts` WHERE `user_id` = NEW.`id`);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_email_insert` AFTER INSERT ON `emails` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_email_update` AFTER UPDATE ON `emails` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE OLD.`account_id` <> NEW.`account_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_email_delete` AFTER DELETE ON `emails` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE EXISTS (SELECT 1 FROM `oauth_accounts` WHERE `id` = OLD.`account_id`)
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_attention_insert` AFTER INSERT ON `sender_attention_rules` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_attention_update` AFTER UPDATE ON `sender_attention_rules` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE OLD.`account_id` <> NEW.`account_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_attention_delete` AFTER DELETE ON `sender_attention_rules` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE EXISTS (SELECT 1 FROM `oauth_accounts` WHERE `id` = OLD.`account_id`)
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_classification_insert` AFTER INSERT ON `human_classification_overrides` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_classification_update` AFTER UPDATE ON `human_classification_overrides` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE OLD.`account_id` <> NEW.`account_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_classification_delete` AFTER DELETE ON `human_classification_overrides` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE EXISTS (SELECT 1 FROM `oauth_accounts` WHERE `id` = OLD.`account_id`)
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_label_insert` AFTER INSERT ON `labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_label_update` AFTER UPDATE ON `labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`) VALUES (NEW.`account_id`, 1, (unixepoch() * 1000))
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE OLD.`account_id` <> NEW.`account_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_label_delete` AFTER DELETE ON `labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT OLD.`account_id`, 1, (unixepoch() * 1000) WHERE EXISTS (SELECT 1 FROM `oauth_accounts` WHERE `id` = OLD.`account_id`)
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint

CREATE TRIGGER `mailbox_revision_email_label_insert` AFTER INSERT ON `email_labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT `account_id`, 1, (unixepoch() * 1000) FROM `emails` WHERE `id` = NEW.`email_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_email_label_update` AFTER UPDATE ON `email_labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT `account_id`, 1, (unixepoch() * 1000) FROM `emails` WHERE `id` = NEW.`email_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT `account_id`, 1, (unixepoch() * 1000) FROM `emails` WHERE `id` = OLD.`email_id` AND OLD.`email_id` <> NEW.`email_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
--> statement-breakpoint
CREATE TRIGGER `mailbox_revision_email_label_delete` AFTER DELETE ON `email_labels` BEGIN
	INSERT INTO `mailbox_revisions` (`account_id`, `revision`, `updated_at`)
	SELECT `account_id`, 1, (unixepoch() * 1000) FROM `emails` WHERE `id` = OLD.`email_id`
	ON CONFLICT (`account_id`) DO UPDATE SET `revision` = `revision` + 1, `updated_at` = (unixepoch() * 1000);
END;
