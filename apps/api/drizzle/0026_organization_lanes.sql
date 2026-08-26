CREATE TABLE `organization_lane_policies` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`visibility` text NOT NULL,
	`interruption` text NOT NULL,
	`review` text NOT NULL,
	`retention_mode` text NOT NULL,
	`retention_days` integer,
	`provider_deletion` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_lane_policies_visibility_check` CHECK (`visibility` IN ('prominent','standard','muted')),
	CONSTRAINT `organization_lane_policies_interruption_check` CHECK (`interruption` IN ('notify','badge','quiet')),
	CONSTRAINT `organization_lane_policies_review_check` CHECK (`review` IN ('continuous','daily','weekly','manual')),
	CONSTRAINT `organization_lane_policies_retention_check` CHECK ((`retention_mode` = 'keep' AND `retention_days` IS NULL) OR (`retention_mode` = 'review_after' AND `retention_days` BETWEEN 1 AND 3650)),
	CONSTRAINT `organization_lane_policies_provider_delete_check` CHECK (`provider_deletion` = 0),
	CONSTRAINT `organization_lane_policies_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `organization_lanes` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`default_policy_id` text NOT NULL,
	`retired_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_lanes_workspace_policy_fk` FOREIGN KEY (`workspace_id`,`default_policy_id`) REFERENCES `organization_lane_policies`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `organization_lanes_position_check` CHECK (`position` >= 0),
	CONSTRAINT `organization_lanes_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_lanes_workspace_position_unique_idx` ON `organization_lanes` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE TABLE `organization_workspace_lane_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`fallback_lane_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_workspace_lane_settings_fallback_fk` FOREIGN KEY (`workspace_id`,`fallback_lane_id`) REFERENCES `organization_lanes`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `organization_workspace_lane_settings_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `organization_thread_lane_states` (
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`primary_lane_id` text NOT NULL,
	`placement_source` text DEFAULT 'workspace_fallback' NOT NULL,
	`source_id` text NOT NULL,
	`actor_id` text DEFAULT 'system:workspace-fallback' NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`reason` text NOT NULL,
	`manual_override_lane_id` text,
	`manual_override_at` integer,
	`safety_locked` integer DEFAULT 0 NOT NULL,
	`safety_lock_actor_id` text,
	`safety_lock_actor_type` text,
	`safety_lock_reason` text,
	`safety_lock_updated_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`account_id`,`thread_id`),
	CONSTRAINT `organization_thread_lane_states_workspace_account_fk` FOREIGN KEY (`workspace_id`,`account_id`) REFERENCES `oauth_accounts`(`user_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_lane_states_account_thread_fk` FOREIGN KEY (`account_id`,`thread_id`) REFERENCES `threads`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_thread_lane_states_primary_lane_fk` FOREIGN KEY (`workspace_id`,`primary_lane_id`) REFERENCES `organization_lanes`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `organization_thread_lane_states_manual_override_lane_fk` FOREIGN KEY (`workspace_id`,`manual_override_lane_id`) REFERENCES `organization_lanes`(`workspace_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `organization_thread_lane_states_source_check` CHECK (`placement_source` IN ('safety_lock','manual_override','rule_revision','lane_policy','workspace_fallback')),
	CONSTRAINT `organization_thread_lane_states_actor_type_check` CHECK (`actor_type` IN ('human','agent','system')),
	CONSTRAINT `organization_thread_lane_states_safety_actor_type_check` CHECK (`safety_lock_actor_type` IS NULL OR `safety_lock_actor_type` IN ('human','agent','system')),
	CONSTRAINT `organization_thread_lane_states_revision_check` CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `organization_thread_lane_states_lane_idx` ON `organization_thread_lane_states` (`workspace_id`,`primary_lane_id`,`account_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `organization_workspace_states` (`workspace_id`) SELECT `id` FROM `users`;
--> statement-breakpoint
INSERT INTO `organization_lane_policies` (`workspace_id`,`id`,`visibility`,`interruption`,`review`,`retention_mode`,`retention_days`,`provider_deletion`)
SELECT `id`, lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))), 'standard','badge','daily','keep',NULL,0 FROM `users`;
--> statement-breakpoint
INSERT INTO `organization_lanes` (`workspace_id`,`id`,`name`,`position`,`default_policy_id`)
SELECT `workspace_id`, lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))), 'Everything else', 0, `id` FROM `organization_lane_policies`;
--> statement-breakpoint
INSERT INTO `organization_workspace_lane_settings` (`workspace_id`,`fallback_lane_id`)
SELECT `workspace_id`,`id` FROM `organization_lanes`;
--> statement-breakpoint
INSERT INTO `organization_thread_lane_states` (`workspace_id`,`account_id`,`thread_id`,`primary_lane_id`,`source_id`,`reason`)
SELECT `oauth_accounts`.`user_id`,`threads`.`account_id`,`threads`.`id`,`organization_workspace_lane_settings`.`fallback_lane_id`,`organization_workspace_lane_settings`.`fallback_lane_id`,'No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.'
FROM `threads` JOIN `oauth_accounts` ON `oauth_accounts`.`id` = `threads`.`account_id` JOIN `organization_workspace_lane_settings` ON `organization_workspace_lane_settings`.`workspace_id` = `oauth_accounts`.`user_id`;
--> statement-breakpoint
CREATE TRIGGER `organization_users_default_lane_after_insert` AFTER INSERT ON `users` BEGIN
	INSERT OR IGNORE INTO `organization_workspace_states` (`workspace_id`) VALUES (NEW.`id`);
	INSERT INTO `organization_lane_policies` (`workspace_id`,`id`,`visibility`,`interruption`,`review`,`retention_mode`,`retention_days`,`provider_deletion`) VALUES (NEW.`id`, lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))), 'standard','badge','daily','keep',NULL,0);
	INSERT INTO `organization_lanes` (`workspace_id`,`id`,`name`,`position`,`default_policy_id`) SELECT NEW.`id`, lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))), 'Everything else', 0, `id` FROM `organization_lane_policies` WHERE `workspace_id` = NEW.`id` ORDER BY `created_at`,`id` LIMIT 1;
	INSERT INTO `organization_workspace_lane_settings` (`workspace_id`,`fallback_lane_id`) SELECT NEW.`id`,`id` FROM `organization_lanes` WHERE `workspace_id` = NEW.`id` ORDER BY `position`,`id` LIMIT 1;
END;
--> statement-breakpoint
CREATE TRIGGER `organization_threads_default_lane_after_insert` AFTER INSERT ON `threads` BEGIN
	INSERT INTO `organization_thread_lane_states` (`workspace_id`,`account_id`,`thread_id`,`primary_lane_id`,`source_id`,`reason`)
	SELECT `oauth_accounts`.`user_id`,NEW.`account_id`,NEW.`id`,`organization_workspace_lane_settings`.`fallback_lane_id`,`organization_workspace_lane_settings`.`fallback_lane_id`,'No higher-precedence outcome selected a Lane, so the configured Workspace Fallback Lane won.'
	FROM `oauth_accounts` JOIN `organization_workspace_lane_settings` ON `organization_workspace_lane_settings`.`workspace_id` = `oauth_accounts`.`user_id` WHERE `oauth_accounts`.`id` = NEW.`account_id`;
END;
