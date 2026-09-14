-- Keep the frozen visible target separate from the underlying policy candidate.
ALTER TABLE organization_thread_lane_states ADD COLUMN safety_lock_lane_id text;
--> statement-breakpoint
UPDATE organization_thread_lane_states
SET safety_lock_lane_id = coalesce(manual_override_lane_id, primary_lane_id)
WHERE safety_locked = 1;
--> statement-breakpoint
CREATE TABLE organization_destination_bindings (
 workspace_id text NOT NULL, account_id text NOT NULL, scope text NOT NULL, value text NOT NULL,
 destination_id text, revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 PRIMARY KEY(workspace_id,account_id,scope,value),
 FOREIGN KEY(workspace_id,account_id) REFERENCES oauth_accounts(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,destination_id) REFERENCES organization_lanes(workspace_id,id),
 CHECK(scope IN ('account','sender','conversation')),
 CHECK(scope != 'account' OR value = ''), CHECK(scope != 'conversation' OR destination_id IS NULL)
);
--> statement-breakpoint
CREATE TABLE organization_destination_legacy (
 workspace_id text NOT NULL, behavior text NOT NULL, destination_id text NOT NULL,
 PRIMARY KEY(workspace_id,behavior),
 FOREIGN KEY(workspace_id,destination_id) REFERENCES organization_lanes(workspace_id,id)
);
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode) SELECT workspace_id, ':orca-compat:quiet', 'muted','quiet','manual','keep' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='quiet'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id) SELECT workspace_id, ':orca-compat:quiet', CASE WHEN EXISTS(SELECT 1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id AND l.retired_at IS NULL AND lower(trim(l.name))=lower('Quiet')) THEN 'Quiet ('||lower(hex(randomblob(4)))||')' ELSE 'Quiet' END, (SELECT coalesce(max(position),-1)+1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id), ':orca-compat:quiet' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='quiet')) s;
--> statement-breakpoint
INSERT OR IGNORE INTO organization_destination_legacy SELECT workspace_id,'quiet',':orca-compat:quiet' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='quiet') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='quiet'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode) SELECT workspace_id, ':orca-compat:hidden', 'muted','quiet','manual','keep' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='hidden'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id) SELECT workspace_id, ':orca-compat:hidden', CASE WHEN EXISTS(SELECT 1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id AND l.retired_at IS NULL AND lower(trim(l.name))=lower('Hidden (legacy)')) THEN 'Hidden (legacy) ('||lower(hex(randomblob(4)))||')' ELSE 'Hidden (legacy)' END, (SELECT coalesce(max(position),-1)+1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id), ':orca-compat:hidden' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='hidden')) s;
--> statement-breakpoint
INSERT OR IGNORE INTO organization_destination_legacy SELECT workspace_id,'hidden',':orca-compat:hidden' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='hidden') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='hidden'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode) SELECT workspace_id, ':orca-compat:focus', 'muted','quiet','manual','keep' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='focus'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id) SELECT workspace_id, ':orca-compat:focus', CASE WHEN EXISTS(SELECT 1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id AND l.retired_at IS NULL AND lower(trim(l.name))=lower('Focus (legacy)')) THEN 'Focus (legacy) ('||lower(hex(randomblob(4)))||')' ELSE 'Focus (legacy)' END, (SELECT coalesce(max(position),-1)+1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id), ':orca-compat:focus' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='focus')) s;
--> statement-breakpoint
INSERT OR IGNORE INTO organization_destination_legacy SELECT workspace_id,'focus',':orca-compat:focus' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='focus') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='focus'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode) SELECT workspace_id, ':orca-compat:notify', 'muted','quiet','manual','keep' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='notify'));
--> statement-breakpoint
INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id) SELECT workspace_id, ':orca-compat:notify', CASE WHEN EXISTS(SELECT 1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id AND l.retired_at IS NULL AND lower(trim(l.name))=lower('Notify (legacy)')) THEN 'Notify (legacy) ('||lower(hex(randomblob(4)))||')' ELSE 'Notify (legacy)' END, (SELECT coalesce(max(position),-1)+1 FROM organization_lanes l WHERE l.workspace_id=s.workspace_id), ':orca-compat:notify' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='notify')) s;
--> statement-breakpoint
INSERT OR IGNORE INTO organization_destination_legacy SELECT workspace_id,'notify',':orca-compat:notify' FROM (SELECT DISTINCT a.user_id workspace_id FROM oauth_accounts a WHERE EXISTS(SELECT 1 FROM sender_attention_rules r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM thread_attention_overrides r WHERE r.account_id=a.id AND r.behavior='notify') OR EXISTS(SELECT 1 FROM account_attention_routing r WHERE r.account_id=a.id AND r.default_behavior='notify'));
--> statement-breakpoint
CREATE TRIGGER destinations_compat_sender_attention_rules_insert AFTER INSERT ON sender_attention_rules WHEN NEW.behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, 'muted','quiet','manual','keep' WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.behavior,':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_compat_sender_attention_rules_update AFTER UPDATE ON sender_attention_rules WHEN NEW.behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, 'muted','quiet','manual','keep' WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.behavior,':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_compat_thread_attention_overrides_insert AFTER INSERT ON thread_attention_overrides WHEN NEW.behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, 'muted','quiet','manual','keep' WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.behavior,':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_compat_thread_attention_overrides_update AFTER UPDATE ON thread_attention_overrides WHEN NEW.behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, 'muted','quiet','manual','keep' WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.behavior,':orca-compat:'||NEW.behavior WHERE NEW.behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_compat_account_attention_routing_insert AFTER INSERT ON account_attention_routing WHEN NEW.default_behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.default_behavior, 'muted','quiet','manual','keep' WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.default_behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.default_behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.default_behavior WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.default_behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.default_behavior,':orca-compat:'||NEW.default_behavior WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.default_behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_compat_account_attention_routing_update AFTER UPDATE ON account_attention_routing WHEN NEW.default_behavior IS NOT NULL BEGIN 
 INSERT OR IGNORE INTO organization_lane_policies(workspace_id,id,visibility,interruption,review,retention_mode)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.default_behavior, 'muted','quiet','manual','keep' WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lane_policies WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.default_behavior);
 INSERT OR IGNORE INTO organization_lanes(workspace_id,id,name,position,default_policy_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id), ':orca-compat:'||NEW.default_behavior, CASE WHEN EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND retired_at IS NULL AND lower(trim(name))=lower(CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)) THEN (CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END)||' ('||lower(hex(randomblob(4)))||')' ELSE (CASE NEW.default_behavior WHEN 'quiet' THEN 'Quiet' WHEN 'hidden' THEN 'Hidden (legacy)' WHEN 'focus' THEN 'Focus (legacy)' ELSE 'Notify (legacy)' END) END,
 (SELECT coalesce(max(position),-1)+1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id)), ':orca-compat:'||NEW.default_behavior WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_lanes WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND id=':orca-compat:'||NEW.default_behavior);
 INSERT OR IGNORE INTO organization_destination_legacy(workspace_id,behavior,destination_id)
 SELECT (SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id),NEW.default_behavior,':orca-compat:'||NEW.default_behavior WHERE NEW.default_behavior != 'normal' AND NOT EXISTS(SELECT 1 FROM organization_destination_legacy WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id) AND behavior=NEW.default_behavior); END;
--> statement-breakpoint
CREATE TRIGGER destinations_new_workspace AFTER INSERT ON organization_workspace_lane_settings BEGIN UPDATE organization_lanes SET name='Inbox' WHERE workspace_id=NEW.workspace_id AND id=NEW.fallback_lane_id AND name='Everything else'; END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_sender_attention_rules_insert AFTER INSERT ON sender_attention_rules BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_sender_attention_rules_update AFTER UPDATE ON sender_attention_rules BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_sender_attention_rules_delete AFTER DELETE ON sender_attention_rules BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=OLD.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_thread_attention_overrides_insert AFTER INSERT ON thread_attention_overrides BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_thread_attention_overrides_update AFTER UPDATE ON thread_attention_overrides BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_thread_attention_overrides_delete AFTER DELETE ON thread_attention_overrides BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=OLD.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_account_attention_routing_insert AFTER INSERT ON account_attention_routing BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_account_attention_routing_update AFTER UPDATE ON account_attention_routing BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=NEW.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_revision_account_attention_routing_delete AFTER DELETE ON account_attention_routing BEGIN UPDATE organization_workspace_states SET revision=revision+1 WHERE workspace_id=(SELECT user_id FROM oauth_accounts WHERE id=OLD.account_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lanes_insert AFTER INSERT ON organization_lanes BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lanes_update AFTER UPDATE ON organization_lanes BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lanes_delete AFTER DELETE ON organization_lanes BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lane_policies_insert AFTER INSERT ON organization_lane_policies BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lane_policies_update AFTER UPDATE ON organization_lane_policies BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_lane_policies_delete AFTER DELETE ON organization_lane_policies BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_thread_lane_states_insert AFTER INSERT ON organization_thread_lane_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_thread_lane_states_update AFTER UPDATE ON organization_thread_lane_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_thread_lane_states_delete AFTER DELETE ON organization_thread_lane_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_bindings_insert AFTER INSERT ON organization_destination_bindings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_bindings_update AFTER UPDATE ON organization_destination_bindings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_bindings_delete AFTER DELETE ON organization_destination_bindings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_legacy_insert AFTER INSERT ON organization_destination_legacy BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_legacy_update AFTER UPDATE ON organization_destination_legacy BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_destination_legacy_delete AFTER DELETE ON organization_destination_legacy BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_lane_settings_insert AFTER INSERT ON organization_workspace_lane_settings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_lane_settings_update AFTER UPDATE ON organization_workspace_lane_settings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_lane_settings_delete AFTER DELETE ON organization_workspace_lane_settings BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_states_insert AFTER INSERT ON organization_workspace_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_states_update AFTER UPDATE ON organization_workspace_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER destinations_mailbox_organization_workspace_states_delete AFTER DELETE ON organization_workspace_states BEGIN UPDATE mailbox_revisions SET revision=revision+1 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id=OLD.workspace_id); END;
--> statement-breakpoint
CREATE VIEW organization_effective_destinations AS
 SELECT t.account_id,t.id thread_id,a.user_id workspace_id,
 CASE
 WHEN ls.safety_locked=1 THEN coalesce(ls.safety_lock_lane_id,ls.manual_override_lane_id,ls.primary_lane_id)
 WHEN ls.manual_override_lane_id IS NOT NULL THEN ls.manual_override_lane_id
 WHEN cb.revision IS NULL AND ta.behavior IS NOT NULL THEN coalesce(tl.destination_id,ws.fallback_lane_id)
 WHEN sb.destination_id IS NOT NULL THEN sb.destination_id
 WHEN sb.revision IS NULL AND sa.behavior IS NOT NULL THEN coalesce(sl.destination_id,ws.fallback_lane_id)
 WHEN ls.placement_source IN ('rule_revision','lane_policy') THEN ls.primary_lane_id
 WHEN sd.behavior IS NOT NULL THEN coalesce(dl.destination_id,ws.fallback_lane_id)
 WHEN ab.destination_id IS NOT NULL THEN ab.destination_id
 WHEN ab.revision IS NULL AND ar.default_behavior IS NOT NULL THEN coalesce(al.destination_id,ws.fallback_lane_id)
 ELSE ws.fallback_lane_id END destination_id,
 CASE WHEN ls.safety_locked=1 THEN 'safety_lock' WHEN ls.manual_override_lane_id IS NOT NULL THEN 'conversation'
 WHEN cb.revision IS NULL AND ta.behavior IS NOT NULL THEN 'conversation'
 WHEN sb.destination_id IS NOT NULL OR (sb.revision IS NULL AND sa.behavior IS NOT NULL) THEN 'sender'
 WHEN ls.placement_source IN ('rule_revision','lane_policy') THEN 'advanced'
 WHEN sd.behavior IS NOT NULL THEN 'legacy'
 WHEN ab.destination_id IS NOT NULL OR (ab.revision IS NULL AND ar.default_behavior IS NOT NULL) THEN 'account'
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
