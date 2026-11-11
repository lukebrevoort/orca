-- Incremental, transactionally current importance metadata. Choices/receipts/wire contracts are preserved.
DROP TRIGGER importance_choices_insert;
--> statement-breakpoint
DROP TRIGGER importance_choices_update;
--> statement-breakpoint
DROP TRIGGER importance_emails_insert;
--> statement-breakpoint
DROP TRIGGER importance_emails_delete;
--> statement-breakpoint
DROP TRIGGER importance_emails_update;
--> statement-breakpoint
DROP TRIGGER importance_threads_insert;
--> statement-breakpoint
DROP TRIGGER importance_email_labels_insert;
--> statement-breakpoint
DROP TRIGGER importance_email_labels_delete;
--> statement-breakpoint
DROP TRIGGER importance_email_labels_update;
--> statement-breakpoint
DROP TRIGGER importance_account_address;
--> statement-breakpoint
DROP TRIGGER importance_labels_update;
--> statement-breakpoint
CREATE TABLE importance_message_state (
 email_id TEXT PRIMARY KEY NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 sender_address TEXT NOT NULL, participant_address TEXT, received_at INTEGER);
--> statement-breakpoint
CREATE INDEX importance_message_thread_time_idx ON importance_message_state(account_id,thread_id,received_at DESC);
--> statement-breakpoint
CREATE INDEX importance_message_sender_idx ON importance_message_state(account_id,sender_address,email_id);
--> statement-breakpoint
INSERT INTO importance_message_state SELECT e.id,e.account_id,e.thread_id,lower(trim(coalesce(e.from_address,''))),CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END,e.received_at FROM emails e;
--> statement-breakpoint
DELETE FROM importance_participants;
--> statement-breakpoint
INSERT INTO importance_participants SELECT account_id,thread_id,participant_address,count(*)
 FROM importance_message_state WHERE participant_address IS NOT NULL GROUP BY account_id,thread_id,participant_address;
--> statement-breakpoint
INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE 1
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE 1
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count;
--> statement-breakpoint
CREATE TRIGGER importance_votes_changed AFTER UPDATE OF important_count,not_important_count,unreviewed_count ON importance_thread_state
 BEGIN UPDATE importance_thread_state SET effective=coalesce((SELECT choice FROM importance_choices WHERE account_id=NEW.account_id AND kind='conversation' AND target=NEW.thread_id),
 CASE WHEN NEW.important_count>0 THEN 'important' WHEN NEW.unreviewed_count>0 OR NEW.not_important_count=0 THEN 'unreviewed' ELSE 'not_important' END) WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id; END;
--> statement-breakpoint
CREATE TRIGGER importance_threads_insert AFTER INSERT ON threads BEGIN
 INSERT INTO importance_thread_state VALUES(NEW.account_id,NEW.id,
 coalesce((SELECT choice FROM importance_choices WHERE account_id=NEW.account_id AND kind='conversation' AND target=NEW.id),'unreviewed'),0,0,0,0,0,0); END;
--> statement-breakpoint
CREATE TRIGGER importance_participant_insert AFTER INSERT ON importance_participants BEGIN
 UPDATE importance_thread_state SET participant_count=participant_count+1,
 important_count=important_count+coalesce((SELECT choice FROM importance_choices WHERE account_id=NEW.account_id AND kind='sender' AND target=NEW.address)='important',0),
 not_important_count=not_important_count+coalesce((SELECT choice FROM importance_choices WHERE account_id=NEW.account_id AND kind='sender' AND target=NEW.address)='not_important',0),
 unreviewed_count=unreviewed_count+((SELECT choice FROM importance_choices WHERE account_id=NEW.account_id AND kind='sender' AND target=NEW.address) IS NULL)
 WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id; END;
--> statement-breakpoint
CREATE TRIGGER importance_participant_delete AFTER DELETE ON importance_participants BEGIN
 UPDATE importance_thread_state SET participant_count=participant_count-1,
 important_count=important_count-coalesce((SELECT choice FROM importance_choices WHERE account_id=OLD.account_id AND kind='sender' AND target=OLD.address)='important',0),
 not_important_count=not_important_count-coalesce((SELECT choice FROM importance_choices WHERE account_id=OLD.account_id AND kind='sender' AND target=OLD.address)='not_important',0),
 unreviewed_count=unreviewed_count-((SELECT choice FROM importance_choices WHERE account_id=OLD.account_id AND kind='sender' AND target=OLD.address) IS NULL)
 WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id; END;
--> statement-breakpoint
CREATE TRIGGER importance_message_insert AFTER INSERT ON importance_message_state BEGIN
 INSERT INTO importance_participants(account_id,thread_id,address,message_count)
 SELECT NEW.account_id,NEW.thread_id,NEW.participant_address,1 WHERE NEW.participant_address IS NOT NULL AND (1)
 ON CONFLICT(account_id,thread_id,address) DO UPDATE SET message_count=message_count+1;
 UPDATE importance_thread_state SET retained_count=retained_count+1,received_at=coalesce((SELECT received_at FROM importance_message_state WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id ORDER BY received_at DESC LIMIT 1),0)
 WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id; END;
--> statement-breakpoint
CREATE TRIGGER importance_message_delete AFTER DELETE ON importance_message_state BEGIN
 DELETE FROM importance_participants WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id AND address=OLD.participant_address AND (1) AND message_count=1;
 UPDATE importance_participants SET message_count=message_count-1 WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id AND address=OLD.participant_address AND (1) AND message_count>1;
 UPDATE importance_thread_state SET retained_count=retained_count-1,received_at=coalesce((SELECT received_at FROM importance_message_state WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id ORDER BY received_at DESC LIMIT 1),0)
 WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id; END;
--> statement-breakpoint
CREATE TRIGGER importance_message_update AFTER UPDATE ON importance_message_state BEGIN
 DELETE FROM importance_participants WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id AND address=OLD.participant_address AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.participant_address IS NOT NEW.participant_address) AND message_count=1;
 UPDATE importance_participants SET message_count=message_count-1 WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id AND address=OLD.participant_address AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.participant_address IS NOT NEW.participant_address) AND message_count>1; INSERT INTO importance_participants(account_id,thread_id,address,message_count)
 SELECT NEW.account_id,NEW.thread_id,NEW.participant_address,1 WHERE NEW.participant_address IS NOT NULL AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.participant_address IS NOT NEW.participant_address)
 ON CONFLICT(account_id,thread_id,address) DO UPDATE SET message_count=message_count+1;
 UPDATE importance_thread_state SET retained_count=retained_count-CASE WHEN OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id THEN 1 ELSE 0 END,received_at=coalesce((SELECT received_at FROM importance_message_state WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id ORDER BY received_at DESC LIMIT 1),0)
 WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.received_at IS NOT NEW.received_at);
 UPDATE importance_thread_state SET retained_count=retained_count+1,received_at=coalesce((SELECT received_at FROM importance_message_state WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id ORDER BY received_at DESC LIMIT 1),0)
 WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id); END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_insert AFTER INSERT ON emails BEGIN INSERT INTO importance_message_state SELECT e.id,e.account_id,e.thread_id,lower(trim(coalesce(e.from_address,''))),CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END,e.received_at
 FROM emails e WHERE e.id=NEW.id
 ON CONFLICT(email_id) DO UPDATE SET account_id=excluded.account_id,thread_id=excluded.thread_id,sender_address=excluded.sender_address,
 participant_address=excluded.participant_address,received_at=excluded.received_at
 WHERE importance_message_state.account_id IS NOT excluded.account_id OR importance_message_state.thread_id IS NOT excluded.thread_id
 OR importance_message_state.sender_address IS NOT excluded.sender_address OR importance_message_state.participant_address IS NOT excluded.participant_address
 OR importance_message_state.received_at IS NOT excluded.received_at; END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_update AFTER UPDATE OF account_id,thread_id,from_address,is_draft,received_at ON emails
 WHEN OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.from_address IS NOT NEW.from_address OR OLD.is_draft IS NOT NEW.is_draft OR OLD.received_at IS NOT NEW.received_at BEGIN INSERT INTO importance_message_state SELECT e.id,e.account_id,e.thread_id,lower(trim(coalesce(e.from_address,''))),CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END,e.received_at
 FROM emails e WHERE e.id=NEW.id
 ON CONFLICT(email_id) DO UPDATE SET account_id=excluded.account_id,thread_id=excluded.thread_id,sender_address=excluded.sender_address,
 participant_address=excluded.participant_address,received_at=excluded.received_at
 WHERE importance_message_state.account_id IS NOT excluded.account_id OR importance_message_state.thread_id IS NOT excluded.thread_id
 OR importance_message_state.sender_address IS NOT excluded.sender_address OR importance_message_state.participant_address IS NOT excluded.participant_address
 OR importance_message_state.received_at IS NOT excluded.received_at; END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_delete AFTER DELETE ON emails BEGIN DELETE FROM importance_message_state WHERE email_id=OLD.id; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_insert AFTER INSERT ON email_labels
 WHEN EXISTS(SELECT 1 FROM labels WHERE id=NEW.label_id AND provider_label_id IN ('SENT','DRAFT'))
 BEGIN UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT NEW.email_id)) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_delete AFTER DELETE ON email_labels
 WHEN EXISTS(SELECT 1 FROM labels WHERE id=OLD.label_id AND provider_label_id IN ('SENT','DRAFT'))
 BEGIN UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT OLD.email_id)) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_update AFTER UPDATE OF email_id,label_id ON email_labels
 WHEN (OLD.email_id IS NOT NEW.email_id OR OLD.label_id IS NOT NEW.label_id)
 AND EXISTS(SELECT 1 FROM labels WHERE id IN (OLD.label_id,NEW.label_id) AND provider_label_id IN ('SENT','DRAFT'))
 BEGIN UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT OLD.email_id UNION SELECT NEW.email_id)) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_labels_update AFTER UPDATE OF provider_label_id,account_id ON labels
 WHEN (OLD.account_id IS NOT NEW.account_id OR OLD.provider_label_id IS NOT NEW.provider_label_id)
 AND (OLD.provider_label_id IN ('SENT','DRAFT') OR NEW.provider_label_id IN ('SENT','DRAFT'))
 BEGIN UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT email_id FROM email_labels WHERE label_id=NEW.id)) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_labels_delete BEFORE DELETE ON labels WHEN OLD.provider_label_id IN ('SENT','DRAFT')
 BEGIN UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT') AND l.id<>OLD.id)
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT email_id FROM email_labels WHERE label_id=OLD.id)) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_account_address AFTER UPDATE OF provider_email ON oauth_accounts
 WHEN lower(trim(OLD.provider_email)) IS NOT lower(trim(NEW.provider_email)) BEGIN
 UPDATE importance_message_state SET participant_address=next.address
 FROM (SELECT e.id,CASE WHEN e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>(SELECT lower(trim(provider_email)) FROM oauth_accounts WHERE id=e.account_id)
 AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 THEN lower(trim(e.from_address)) ELSE NULL END address FROM emails e WHERE e.id IN (SELECT email_id FROM importance_message_state WHERE account_id=NEW.id AND sender_address IN (lower(trim(OLD.provider_email)),lower(trim(NEW.provider_email))))) next
 WHERE importance_message_state.email_id=next.id AND importance_message_state.participant_address IS NOT next.address; END;
--> statement-breakpoint
CREATE TRIGGER importance_choices_insert AFTER INSERT ON importance_choices BEGIN
 UPDATE importance_thread_state SET effective=coalesce(NEW.choice,
 CASE WHEN important_count>0 THEN 'important' WHEN unreviewed_count>0 OR not_important_count=0 THEN 'unreviewed' ELSE 'not_important' END)
 WHERE NEW.kind='conversation' AND account_id=NEW.account_id AND thread_id=NEW.target;
 UPDATE importance_thread_state SET important_count=important_count+(coalesce(NEW.choice='important',0)-coalesce(NULL='important',0)),not_important_count=not_important_count+(coalesce(NEW.choice='not_important',0)-coalesce(NULL='not_important',0)),unreviewed_count=unreviewed_count+((NEW.choice IS NULL)-(NULL IS NULL))
 WHERE NEW.kind='sender' AND account_id=NEW.account_id AND thread_id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target);
 INSERT INTO mailbox_revisions(account_id,revision,updated_at) VALUES(NEW.account_id,1,unixepoch()*1000)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at; END;
--> statement-breakpoint
CREATE TRIGGER importance_choices_update AFTER UPDATE ON importance_choices BEGIN
 UPDATE importance_thread_state SET effective=coalesce(NEW.choice,
 CASE WHEN important_count>0 THEN 'important' WHEN unreviewed_count>0 OR not_important_count=0 THEN 'unreviewed' ELSE 'not_important' END)
 WHERE NEW.kind='conversation' AND account_id=NEW.account_id AND thread_id=NEW.target;
 UPDATE importance_thread_state SET important_count=important_count+(coalesce(NEW.choice='important',0)-coalesce(OLD.choice='important',0)),not_important_count=not_important_count+(coalesce(NEW.choice='not_important',0)-coalesce(OLD.choice='not_important',0)),unreviewed_count=unreviewed_count+((NEW.choice IS NULL)-(OLD.choice IS NULL))
 WHERE NEW.kind='sender' AND account_id=NEW.account_id AND thread_id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target);
 INSERT INTO mailbox_revisions(account_id,revision,updated_at) VALUES(NEW.account_id,1,unixepoch()*1000)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at; END;
--> statement-breakpoint
UPDATE mailbox_revisions SET revision=revision+1,updated_at=unixepoch()*1000;
