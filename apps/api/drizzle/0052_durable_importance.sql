CREATE TABLE importance_choices (
 account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('conversation','sender')), target TEXT NOT NULL,
 choice TEXT CHECK(choice IN ('important','not_important')), revision INTEGER NOT NULL CHECK(revision>0),
 updated_at INTEGER NOT NULL, PRIMARY KEY(account_id,kind,target));
--> statement-breakpoint
CREATE TABLE importance_operations (
 account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('conversation','sender')), target TEXT NOT NULL,
 choice TEXT CHECK(choice IN ('important','not_important')), previous_choice TEXT CHECK(previous_choice IN ('important','not_important')),
 revision INTEGER NOT NULL CHECK(revision>0), fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,operation_id));
--> statement-breakpoint
CREATE INDEX importance_operations_target_idx ON importance_operations(account_id,kind,target,revision);
--> statement-breakpoint
CREATE TABLE importance_participants (
 account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 address TEXT NOT NULL, message_count INTEGER NOT NULL CHECK(message_count>0), PRIMARY KEY(account_id,thread_id,address));
--> statement-breakpoint
CREATE INDEX importance_participants_sender_idx ON importance_participants(account_id,address,thread_id);
--> statement-breakpoint
CREATE INDEX emails_importance_unread_idx ON emails(account_id,thread_id,is_read);
--> statement-breakpoint
CREATE INDEX emails_importance_participants_idx ON emails(account_id,thread_id,is_draft,from_address);
--> statement-breakpoint
CREATE TABLE importance_thread_state (
 account_id TEXT NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 effective TEXT NOT NULL CHECK(effective IN ('important','not_important','unreviewed')),
 important_count INTEGER NOT NULL, not_important_count INTEGER NOT NULL, unreviewed_count INTEGER NOT NULL,
 participant_count INTEGER NOT NULL, received_at INTEGER NOT NULL, retained_count INTEGER NOT NULL,
 PRIMARY KEY(account_id,thread_id));
--> statement-breakpoint
CREATE INDEX importance_thread_page_idx ON importance_thread_state(account_id,effective,received_at DESC,thread_id) WHERE retained_count>0;
--> statement-breakpoint
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE 1 AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address));
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
CREATE TRIGGER importance_choices_insert AFTER INSERT ON importance_choices BEGIN INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.account_id AND (NEW.kind='conversation' AND p.thread_id=NEW.target OR NEW.kind='sender' AND p.thread_id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target))
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.account_id AND (NEW.kind='conversation' AND t.id=NEW.target OR NEW.kind='sender' AND t.id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target))
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; INSERT INTO mailbox_revisions(account_id,revision,updated_at) VALUES(NEW.account_id,1,unixepoch()*1000) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at; END;
--> statement-breakpoint
CREATE TRIGGER importance_choices_update AFTER UPDATE ON importance_choices BEGIN INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.account_id AND (NEW.kind='conversation' AND p.thread_id=NEW.target OR NEW.kind='sender' AND p.thread_id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target))
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.account_id AND (NEW.kind='conversation' AND t.id=NEW.target OR NEW.kind='sender' AND t.id IN (SELECT thread_id FROM importance_participants WHERE account_id=NEW.account_id AND address=NEW.target))
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; INSERT INTO mailbox_revisions(account_id,revision,updated_at) VALUES(NEW.account_id,1,unixepoch()*1000) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at; END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_insert AFTER INSERT ON emails BEGIN DELETE FROM importance_participants WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id;
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id=NEW.account_id AND e.thread_id=NEW.thread_id AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.account_id AND p.thread_id=NEW.thread_id
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.account_id AND t.id=NEW.thread_id
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_delete AFTER DELETE ON emails BEGIN DELETE FROM importance_participants WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id;
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id=OLD.account_id AND e.thread_id=OLD.thread_id AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=OLD.account_id AND p.thread_id=OLD.thread_id
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=OLD.account_id AND t.id=OLD.thread_id
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_emails_update AFTER UPDATE OF account_id,thread_id,from_address,is_draft,received_at ON emails WHEN OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id
 OR OLD.from_address IS NOT NEW.from_address OR OLD.is_draft IS NOT NEW.is_draft OR OLD.received_at IS NOT NEW.received_at BEGIN DELETE FROM importance_participants WHERE account_id=OLD.account_id AND thread_id=OLD.thread_id;
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id=OLD.account_id AND e.thread_id=OLD.thread_id AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); DELETE FROM importance_participants WHERE account_id=NEW.account_id AND thread_id=NEW.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id);
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id=NEW.account_id AND e.thread_id=NEW.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id) AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=OLD.account_id AND p.thread_id=OLD.thread_id
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=OLD.account_id AND t.id=OLD.thread_id
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.account_id AND p.thread_id=NEW.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id)
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.account_id AND t.id=NEW.thread_id AND (OLD.account_id IS NOT NEW.account_id OR OLD.thread_id IS NOT NEW.thread_id)
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_threads_insert AFTER INSERT ON threads BEGIN INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.account_id AND p.thread_id=NEW.id
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.account_id AND t.id=NEW.id
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_insert AFTER INSERT ON email_labels BEGIN DELETE FROM importance_participants WHERE thread_id IN (SELECT thread_id FROM emails WHERE id=NEW.email_id);
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.thread_id IN (SELECT thread_id FROM emails WHERE id=NEW.email_id) AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.thread_id IN (SELECT thread_id FROM emails WHERE id=NEW.email_id)
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.id IN (SELECT thread_id FROM emails WHERE id=NEW.email_id)
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_delete AFTER DELETE ON email_labels BEGIN DELETE FROM importance_participants WHERE thread_id IN (SELECT thread_id FROM emails WHERE id=OLD.email_id);
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.thread_id IN (SELECT thread_id FROM emails WHERE id=OLD.email_id) AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.thread_id IN (SELECT thread_id FROM emails WHERE id=OLD.email_id)
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.id IN (SELECT thread_id FROM emails WHERE id=OLD.email_id)
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_email_labels_update AFTER UPDATE ON email_labels BEGIN DELETE FROM importance_participants WHERE thread_id IN (SELECT thread_id FROM emails WHERE id IN (NEW.email_id,OLD.email_id));
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.thread_id IN (SELECT thread_id FROM emails WHERE id IN (NEW.email_id,OLD.email_id)) AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.thread_id IN (SELECT thread_id FROM emails WHERE id IN (NEW.email_id,OLD.email_id))
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.id IN (SELECT thread_id FROM emails WHERE id IN (NEW.email_id,OLD.email_id))
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_account_address AFTER UPDATE OF provider_email ON oauth_accounts BEGIN DELETE FROM importance_participants WHERE account_id=NEW.id;
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id=NEW.id AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id=NEW.id
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id=NEW.id
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
CREATE TRIGGER importance_labels_update AFTER UPDATE OF provider_label_id,account_id ON labels BEGIN DELETE FROM importance_participants WHERE account_id IN (NEW.account_id,OLD.account_id);
INSERT INTO importance_participants SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*)
 FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
 WHERE e.account_id IN (NEW.account_id,OLD.account_id) AND e.is_draft=0 AND trim(coalesce(e.from_address,''))<>''
 AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
 AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id
 WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
 GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)); INSERT INTO importance_thread_state
 SELECT t.account_id,t.id,coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END),
 coalesce(g.i,0),coalesce(g.n,0),coalesce(g.u,0),coalesce(g.total,0),
 coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0),
 (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id)
 FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
 LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,
 sum(s.choice='important') i,sum(s.choice='not_important') n,sum(s.choice IS NULL) u
 FROM importance_participants p LEFT JOIN importance_choices s ON s.account_id=p.account_id AND s.kind='sender' AND s.target=p.address
 WHERE p.account_id IN (NEW.account_id,OLD.account_id)
 GROUP BY p.account_id,p.thread_id) g ON g.account_id=t.account_id AND g.thread_id=t.id
 WHERE t.account_id IN (NEW.account_id,OLD.account_id)
 ON CONFLICT(account_id,thread_id) DO UPDATE SET effective=excluded.effective,important_count=excluded.important_count,
 not_important_count=excluded.not_important_count,unreviewed_count=excluded.unreviewed_count,participant_count=excluded.participant_count,
 received_at=excluded.received_at,retained_count=excluded.retained_count; END;
--> statement-breakpoint
-- Local thread IDs are normally never reused. Still retain a revision barrier
-- on deletion so a stale command/Undo cannot target a recreated identity.
CREATE TRIGGER importance_threads_delete AFTER DELETE ON threads
WHEN EXISTS(SELECT 1 FROM oauth_accounts WHERE id=OLD.account_id) BEGIN
 INSERT INTO importance_choices(account_id,kind,target,choice,revision,updated_at)
 VALUES(OLD.account_id,'conversation',OLD.id,NULL,1,unixepoch()*1000)
 ON CONFLICT(account_id,kind,target) DO UPDATE SET choice=NULL,revision=revision+1,updated_at=excluded.updated_at;
END;
