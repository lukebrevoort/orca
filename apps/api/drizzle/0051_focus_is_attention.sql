-- Focus/Notify control attention only. Explicit destinations, safety locks, rules,
-- and Quiet/Hidden compatibility routing retain their existing precedence.
-- No threads, bindings, lane state, or provider labels are moved or rewritten.
DROP VIEW organization_effective_destinations;
--> statement-breakpoint
CREATE VIEW organization_effective_destinations AS
 SELECT t.account_id,t.id thread_id,a.user_id workspace_id,
 CASE
 WHEN ls.safety_locked=1 THEN coalesce(ls.safety_lock_lane_id,ls.manual_override_lane_id,ls.primary_lane_id)
 WHEN ls.manual_override_lane_id IS NOT NULL THEN ls.manual_override_lane_id
 WHEN cb.revision IS NULL AND ta.behavior IS NOT NULL AND ta.behavior NOT IN ('notify','focus') THEN coalesce(tl.destination_id,ws.fallback_lane_id)
 WHEN sb.destination_id IS NOT NULL THEN sb.destination_id
 WHEN sb.revision IS NULL AND sa.behavior IS NOT NULL AND sa.behavior NOT IN ('notify','focus') THEN coalesce(sl.destination_id,ws.fallback_lane_id)
 WHEN ls.placement_source IN ('rule_revision','lane_policy') THEN ls.primary_lane_id
 WHEN sd.behavior IS NOT NULL AND sd.behavior NOT IN ('notify','focus') THEN coalesce(dl.destination_id,ws.fallback_lane_id)
 WHEN ab.destination_id IS NOT NULL THEN ab.destination_id
 WHEN ab.revision IS NULL AND ar.default_behavior IS NOT NULL AND ar.default_behavior NOT IN ('notify','focus') THEN coalesce(al.destination_id,ws.fallback_lane_id)
 ELSE ws.fallback_lane_id END destination_id,
 CASE WHEN ls.safety_locked=1 THEN 'safety_lock' WHEN ls.manual_override_lane_id IS NOT NULL THEN 'conversation'
 WHEN cb.revision IS NULL AND ta.behavior IS NOT NULL AND ta.behavior NOT IN ('notify','focus') THEN 'conversation'
 WHEN sb.destination_id IS NOT NULL OR (sb.revision IS NULL AND sa.behavior IS NOT NULL AND sa.behavior NOT IN ('notify','focus')) THEN 'sender'
 WHEN ls.placement_source IN ('rule_revision','lane_policy') THEN 'advanced'
 WHEN sd.behavior IS NOT NULL AND sd.behavior NOT IN ('notify','focus') THEN 'legacy'
 WHEN ab.destination_id IS NOT NULL OR (ab.revision IS NULL AND ar.default_behavior IS NOT NULL AND ar.default_behavior NOT IN ('notify','focus')) THEN 'account'
 ELSE 'fallback' END source,
 coalesce(ls.safety_locked,0) locked
 FROM threads t JOIN oauth_accounts a ON a.id=t.account_id
 JOIN organization_workspace_lane_settings ws ON ws.workspace_id=a.user_id
 LEFT JOIN emails latest ON latest.id=(SELECT e.id FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id ORDER BY e.received_at DESC,e.created_at DESC,e.id ASC LIMIT 1) AND latest.account_id=t.account_id
 LEFT JOIN organization_thread_lane_states ls ON ls.workspace_id=a.user_id AND ls.account_id=t.account_id AND ls.thread_id=t.id
 LEFT JOIN organization_destination_bindings cb ON cb.workspace_id=a.user_id AND cb.account_id=t.account_id AND cb.scope='conversation' AND cb.value=t.id
 LEFT JOIN organization_destination_bindings sb ON sb.workspace_id=a.user_id AND sb.account_id=t.account_id AND sb.scope='sender' AND sb.value=lower(trim(latest.from_address))
 LEFT JOIN organization_destination_bindings ab ON ab.workspace_id=a.user_id AND ab.account_id=t.account_id AND ab.scope='account' AND ab.value=''
 LEFT JOIN thread_attention_overrides ta ON ta.account_id=t.account_id AND ta.thread_id=t.id
 LEFT JOIN sender_attention_rules sa ON sa.account_id=t.account_id AND sa.scope='address' AND sa.value=lower(trim(latest.from_address))
 LEFT JOIN sender_attention_rules sd ON sd.account_id=t.account_id AND sd.scope='domain' AND sd.value=substr(lower(trim(latest.from_address)),instr(lower(trim(latest.from_address)),'@')+1)
 LEFT JOIN account_attention_routing ar ON ar.account_id=t.account_id
 LEFT JOIN organization_destination_legacy tl ON tl.workspace_id=a.user_id AND tl.behavior=ta.behavior
 LEFT JOIN organization_destination_legacy sl ON sl.workspace_id=a.user_id AND sl.behavior=sa.behavior
 LEFT JOIN organization_destination_legacy dl ON dl.workspace_id=a.user_id AND dl.behavior=sd.behavior
 LEFT JOIN organization_destination_legacy al ON al.workspace_id=a.user_id AND al.behavior=ar.default_behavior;

--> statement-breakpoint
-- Retire routing and mailbox snapshots whose derived Inbox membership changed.
-- The existing workspace-revision trigger advances each owned mailbox revision.
UPDATE organization_workspace_states SET revision=revision+1;
