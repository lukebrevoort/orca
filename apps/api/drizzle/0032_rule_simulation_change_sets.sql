ALTER TABLE `organization_change_sets` ADD `simulation_id` text;
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `risk` text NOT NULL DEFAULT 'low';
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `trace_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `inverse_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `resulting_revisions_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `status` text NOT NULL DEFAULT 'applied';
--> statement-breakpoint
ALTER TABLE `organization_change_sets` ADD `reverted_by_change_id` text;
