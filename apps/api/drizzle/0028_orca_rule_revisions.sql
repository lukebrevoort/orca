CREATE TABLE `organization_rules` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`latest_revision` integer NOT NULL,
	`active_revision_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_rules_latest_revision_check` CHECK (`latest_revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `organization_rules_workspace_updated_idx` ON `organization_rules` (`workspace_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `organization_rule_revisions` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`rule_id` text NOT NULL,
	`revision` integer NOT NULL,
	`workspace_schema_revision` integer NOT NULL,
	`language_version` integer NOT NULL,
	`source` text NOT NULL,
	`source_digest` text NOT NULL,
	`compiled_json` text NOT NULL,
	`required_capabilities` text NOT NULL,
	`risk` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	CONSTRAINT `organization_rule_revisions_rule_fk` FOREIGN KEY (`workspace_id`,`rule_id`) REFERENCES `organization_rules`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_rule_revisions_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `organization_rule_revisions_schema_revision_check` CHECK (`workspace_schema_revision` >= 1),
	CONSTRAINT `organization_rule_revisions_language_check` CHECK (`language_version` = 1),
	CONSTRAINT `organization_rule_revisions_digest_check` CHECK (`source_digest` GLOB 'sha256:[0-9a-f]*' AND length(`source_digest`) = 71),
	CONSTRAINT `organization_rule_revisions_risk_check` CHECK (`risk` IN ('low','medium','high','destructive')),
	CONSTRAINT `organization_rule_revisions_actor_type_check` CHECK (`actor_type` IN ('human','agent','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_rule_revisions_rule_revision_unique_idx` ON `organization_rule_revisions` (`workspace_id`,`rule_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `organization_rule_revisions_workspace_created_idx` ON `organization_rule_revisions` (`workspace_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `organization_rule_revisions_no_update` BEFORE UPDATE ON `organization_rule_revisions` BEGIN
	SELECT RAISE(ABORT, 'Rule Revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_rule_revisions_no_delete` BEFORE DELETE ON `organization_rule_revisions`
WHEN EXISTS (
	SELECT 1 FROM `organization_rules`
	WHERE `workspace_id` = OLD.`workspace_id` AND `id` = OLD.`rule_id`
)
BEGIN
	SELECT RAISE(ABORT, 'Rule Revisions are immutable');
END;
