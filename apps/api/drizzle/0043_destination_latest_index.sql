CREATE INDEX `emails_thread_latest_destination_idx` ON `emails` (`account_id`,`thread_id`,`received_at` DESC,`created_at` DESC,`id` ASC);
