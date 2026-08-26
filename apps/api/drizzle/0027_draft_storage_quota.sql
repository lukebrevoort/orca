ALTER TABLE `message_drafts` ADD `storage_bytes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `message_drafts`
SET `storage_bytes` =
  length(CAST(`to_recipients` AS BLOB)) +
  length(CAST(`cc_recipients` AS BLOB)) +
  length(CAST(`bcc_recipients` AS BLOB)) +
  length(CAST(`subject` AS BLOB)) +
  length(CAST(`body_text` AS BLOB)) +
  coalesce(length(CAST(`body_html` AS BLOB)), 0) +
  coalesce(length(CAST(`context` AS BLOB)), 0) +
  length(CAST(`attachments` AS BLOB));
