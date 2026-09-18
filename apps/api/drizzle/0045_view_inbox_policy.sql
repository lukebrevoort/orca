-- Inbox visibility is saved View metadata, never a routing or provider mutation.
ALTER TABLE organization_views ADD COLUMN skip_inbox integer NOT NULL DEFAULT 0 CHECK(skip_inbox IN (0,1));
--> statement-breakpoint
CREATE TRIGGER mailbox_view_policy_insert AFTER INSERT ON organization_views WHEN NEW.skip_inbox=1 BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000
 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id IN (NEW.workspace_id));
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_policy_update AFTER UPDATE ON organization_views WHEN (OLD.skip_inbox=1 OR NEW.skip_inbox=1) AND (OLD.skip_inbox != NEW.skip_inbox OR OLD.definition != NEW.definition OR OLD.workspace_id != NEW.workspace_id) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000
 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id IN (OLD.workspace_id,NEW.workspace_id));
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_policy_delete AFTER DELETE ON organization_views WHEN OLD.skip_inbox=1 BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000
 WHERE account_id IN (SELECT id FROM oauth_accounts WHERE user_id IN (OLD.workspace_id));
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_facet_values_insert AFTER INSERT ON organization_thread_facet_values
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_facet_values_update AFTER UPDATE ON organization_thread_facet_values
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id,NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id,NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_facet_values_delete AFTER DELETE ON organization_thread_facet_values
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_context_relationships_insert AFTER INSERT ON organization_thread_context_relationships
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_context_relationships_update AFTER UPDATE ON organization_thread_context_relationships
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id,NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id,NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_context_relationships_delete AFTER DELETE ON organization_thread_context_relationships
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_workflow_states_insert AFTER INSERT ON organization_thread_workflow_states
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_workflow_states_update AFTER UPDATE ON organization_thread_workflow_states
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id,NEW.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id,NEW.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_organization_thread_workflow_states_delete AFTER DELETE ON organization_thread_workflow_states
WHEN EXISTS (SELECT 1 FROM organization_views WHERE skip_inbox=1 AND workspace_id IN (OLD.workspace_id)) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id);
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_view_thread_update AFTER UPDATE OF subject,is_read ON threads
WHEN EXISTS (SELECT 1 FROM organization_views v JOIN oauth_accounts a ON a.user_id=v.workspace_id WHERE a.id=NEW.account_id AND v.skip_inbox=1) BEGIN
 UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000 WHERE account_id IN (OLD.account_id,NEW.account_id);
END;
