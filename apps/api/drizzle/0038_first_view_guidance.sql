ALTER TABLE `user_preferences` ADD `first_view_guidance_completed_at` text;
--> statement-breakpoint
-- Existing View owners have already reached the outcome. Backfill once at
-- upgrade, so GET remains read-only and deleting the last View cannot reset it.
INSERT INTO user_preferences (user_id, first_view_guidance_completed_at)
SELECT users.id, strftime('%Y-%m-%dT%H:%M:%fZ', min(organization_views.created_at) / 1000.0, 'unixepoch')
FROM users JOIN organization_views ON organization_views.workspace_id = users.id
WHERE true
GROUP BY users.id
ON CONFLICT(user_id) DO UPDATE SET
  first_view_guidance_completed_at = coalesce(user_preferences.first_view_guidance_completed_at, excluded.first_view_guidance_completed_at);
