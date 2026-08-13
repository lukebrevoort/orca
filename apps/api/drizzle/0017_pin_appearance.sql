ALTER TABLE `pins` ADD `icon` text DEFAULT 'person' NOT NULL;
--> statement-breakpoint
ALTER TABLE `pins` ADD `color` text DEFAULT '#70867d' NOT NULL;
--> statement-breakpoint
UPDATE `pins`
SET `icon` = CASE `kind`
  WHEN 'sender' THEN 'person'
  WHEN 'thread' THEN 'thread'
  WHEN 'filter' THEN 'search'
  ELSE 'grid'
END;
