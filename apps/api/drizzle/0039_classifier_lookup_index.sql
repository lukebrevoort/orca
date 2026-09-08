CREATE INDEX `emails_account_classifier_lookup_idx` ON `emails` (`account_id`, `human_classifier_version`, `received_at`, `id`);
