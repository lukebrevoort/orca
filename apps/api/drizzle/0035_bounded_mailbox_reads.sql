CREATE INDEX `emails_mailbox_page_idx` ON `emails` (COALESCE(`received_at`,0) DESC,`account_id`,`id`);
