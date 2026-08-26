CREATE TABLE `organization_evaluation_traces` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`rule_set_revision` integer NOT NULL,
	`trace_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`logical_time` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	CONSTRAINT `organization_evaluation_traces_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_evaluation_traces_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_evaluation_traces_event_kind_check` CHECK (`event_kind` IN ('message.received','thread.updated','schedule.reached','user.corrected')),
	CONSTRAINT `organization_evaluation_traces_rule_set_revision_check` CHECK (`rule_set_revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_evaluation_traces_event_unique_idx` ON `organization_evaluation_traces` (`workspace_id`,`event_id`);
--> statement-breakpoint
CREATE INDEX `organization_evaluation_traces_thread_latest_idx` ON `organization_evaluation_traces` (`workspace_id`,`account_id`,`thread_id`,`logical_time`,`id`);
--> statement-breakpoint
CREATE TRIGGER `organization_evaluation_traces_no_update` BEFORE UPDATE ON `organization_evaluation_traces` BEGIN
	SELECT RAISE(ABORT, 'Evaluation Traces are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_evaluation_traces_no_delete` BEFORE DELETE ON `organization_evaluation_traces`
WHEN EXISTS (
	SELECT 1 FROM `users`
	WHERE `id` = OLD.`workspace_id`
)
AND EXISTS (
	SELECT 1 FROM `oauth_accounts`
	WHERE `user_id` = OLD.`workspace_id` AND `id` = OLD.`account_id`
)
AND EXISTS (
	SELECT 1 FROM `threads`
	WHERE `account_id` = OLD.`account_id` AND `id` = OLD.`thread_id`
)
BEGIN
	SELECT RAISE(ABORT, 'Evaluation Traces are immutable');
END;
