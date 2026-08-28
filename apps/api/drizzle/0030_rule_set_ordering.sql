CREATE TABLE `organization_rule_sets` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`order_digest` text NOT NULL,
	`rule_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_rule_sets_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `organization_rule_sets_count_check` CHECK (`rule_count` >= 0),
	CONSTRAINT `organization_rule_sets_digest_check` CHECK (`order_digest` GLOB 'order-v1:[0-9a-f]*' AND length(`order_digest`) = 73)
);
--> statement-breakpoint
CREATE TABLE `organization_rules_0030` (
	`workspace_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`latest_revision` integer NOT NULL,
	`active_revision_id` text,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY (`workspace_id`,`id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_rules_latest_revision_check` CHECK (`latest_revision` >= 1),
	CONSTRAINT `organization_rules_position_check` CHECK (`position` >= 0)
);
--> statement-breakpoint
INSERT INTO `organization_rules_0030` (`workspace_id`,`id`,`name`,`latest_revision`,`active_revision_id`,`position`,`created_at`,`updated_at`)
SELECT rule.`workspace_id`,rule.`id`,rule.`name`,rule.`latest_revision`,rule.`active_revision_id`,
	(SELECT count(*) FROM `organization_rules` prior WHERE prior.`workspace_id`=rule.`workspace_id` AND (prior.`created_at` < rule.`created_at` OR (prior.`created_at` = rule.`created_at` AND prior.`id` < rule.`id`))),
	rule.`created_at`,rule.`updated_at`
FROM `organization_rules` rule;
--> statement-breakpoint
CREATE TABLE `organization_rule_revisions_0030` (
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
	CONSTRAINT `organization_rule_revisions_rule_fk` FOREIGN KEY (`workspace_id`,`rule_id`) REFERENCES `organization_rules_0030`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `organization_rule_revisions_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `organization_rule_revisions_schema_revision_check` CHECK (`workspace_schema_revision` >= 1),
	CONSTRAINT `organization_rule_revisions_language_check` CHECK (`language_version` = 1),
	CONSTRAINT `organization_rule_revisions_digest_check` CHECK (`source_digest` GLOB 'sha256:[0-9a-f]*' AND length(`source_digest`) = 71),
	CONSTRAINT `organization_rule_revisions_risk_check` CHECK (`risk` IN ('low','medium','high','destructive')),
	CONSTRAINT `organization_rule_revisions_actor_type_check` CHECK (`actor_type` IN ('human','agent','system'))
);
--> statement-breakpoint
INSERT INTO `organization_rule_revisions_0030` SELECT * FROM `organization_rule_revisions`;
--> statement-breakpoint
DROP TABLE `organization_rule_revisions`;
--> statement-breakpoint
DROP TABLE `organization_rules`;
--> statement-breakpoint
ALTER TABLE `organization_rules_0030` RENAME TO `organization_rules`;
--> statement-breakpoint
ALTER TABLE `organization_rule_revisions_0030` RENAME TO `organization_rule_revisions`;
--> statement-breakpoint
CREATE INDEX `organization_rules_workspace_updated_idx` ON `organization_rules` (`workspace_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_rules_workspace_position_unique_idx` ON `organization_rules` (`workspace_id`,`position`);
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
WHEN EXISTS (SELECT 1 FROM `organization_rules` WHERE `workspace_id`=OLD.`workspace_id` AND `id`=OLD.`rule_id`)
BEGIN
	SELECT RAISE(ABORT, 'Rule Revisions are immutable');
END;
--> statement-breakpoint
WITH RECURSIVE
payload(`workspace_id`,`value`,`rule_count`) AS (
	SELECT user.`id`,COALESCE((SELECT json_group_array(ordered.`id`) FROM (SELECT rule.`id` FROM `organization_rules` rule WHERE rule.`workspace_id`=user.`id` ORDER BY rule.`position`) ordered),'[]'),
		(SELECT count(*) FROM `organization_rules` rule WHERE rule.`workspace_id`=user.`id`)
	FROM `users` user
),
digest(`workspace_id`,`value`,`rule_count`,`offset`,`h1`,`h2`,`h3`,`h4`,`h5`,`h6`,`h7`,`h8`) AS (
	SELECT `workspace_id`,`value`,`rule_count`,1,17,29,43,59,71,89,101,127 FROM payload
	UNION ALL
	SELECT `workspace_id`,`value`,`rule_count`,`offset`+1,
		(`h1`*131+unicode(substr(`value`,`offset`,1)))%2147483647,
		(`h2`*137+unicode(substr(`value`,`offset`,1)))%2147483629,
		(`h3`*139+unicode(substr(`value`,`offset`,1)))%2147483587,
		(`h4`*149+unicode(substr(`value`,`offset`,1)))%2147483579,
		(`h5`*151+unicode(substr(`value`,`offset`,1)))%2147483563,
		(`h6`*157+unicode(substr(`value`,`offset`,1)))%2147483549,
		(`h7`*163+unicode(substr(`value`,`offset`,1)))%2147483543,
		(`h8`*167+unicode(substr(`value`,`offset`,1)))%2147483497
	FROM digest WHERE `offset`<=length(`value`)
)
INSERT INTO `organization_rule_sets` (`workspace_id`,`revision`,`order_digest`,`rule_count`,`created_at`,`updated_at`)
SELECT `workspace_id`,1,'order-v1:'||printf('%08x%08x%08x%08x%08x%08x%08x%08x',`h1`,`h2`,`h3`,`h4`,`h5`,`h6`,`h7`,`h8`),`rule_count`,unixepoch()*1000,unixepoch()*1000
FROM digest WHERE `offset`=length(`value`)+1;
