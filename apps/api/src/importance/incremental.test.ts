import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";

// Independent source-table oracle after every transition, not mutation responses.
test("BRE-461 incremental metadata stays equivalent to retained source mail through mixed address/label/draft/account/delete transitions", () => {
  const dir=mkdtempSync(join(tmpdir(),"orca-incremental-")); const {db,sqlite:s}=createDatabaseClient(join(dir,"test.sqlite"));
  try {
    migrate(db,{migrationsFolder:resolve(import.meta.dir,"../../drizzle")});
    s.exec(`INSERT INTO users(id,email) VALUES('u','u@example.com'),('other','other@example.com');
      INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','self@example.com'),('b','other','gmail','b','other@example.com');
      INSERT INTO threads(id,account_id,provider_thread_id) VALUES('t','a','same'),('t2','a','second'),('tb','b','same');
      INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES('sent','a','SENT','Sent','system'),('draft','a','DRAFT','Draft','system'),('inbox','a','INBOX','Inbox','system');`);
    const check=()=>{
      const expected=s.query(`SELECT e.account_id,e.thread_id,lower(trim(e.from_address)) address,count(*) message_count
        FROM emails e JOIN oauth_accounts a ON a.id=e.account_id
        WHERE e.is_draft=0 AND trim(coalesce(e.from_address,''))<>'' AND lower(trim(e.from_address))<>lower(trim(a.provider_email))
        AND NOT EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id WHERE el.email_id=e.id AND l.account_id=e.account_id AND l.provider_label_id IN ('SENT','DRAFT'))
        GROUP BY e.account_id,e.thread_id,lower(trim(e.from_address)) ORDER BY e.account_id,e.thread_id,address`).all();
      expect(s.query("SELECT * FROM importance_participants ORDER BY account_id,thread_id,address").all()).toEqual(expected);
      const oracle=s.query(`SELECT t.account_id,t.id thread_id,
        coalesce(c.choice,CASE WHEN coalesce(g.i,0)>0 THEN 'important' WHEN coalesce(g.u,0)>0 OR coalesce(g.n,0)=0 THEN 'unreviewed' ELSE 'not_important' END) effective,
        coalesce(g.i,0) important_count,coalesce(g.n,0) not_important_count,coalesce(g.u,0) unreviewed_count,coalesce(g.total,0) participant_count,
        coalesce((SELECT max(received_at) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id),0) received_at,
        (SELECT count(*) FROM emails e WHERE e.account_id=t.account_id AND e.thread_id=t.id) retained_count
        FROM threads t LEFT JOIN importance_choices c ON c.account_id=t.account_id AND c.kind='conversation' AND c.target=t.id
        LEFT JOIN (SELECT p.account_id,p.thread_id,count(*) total,sum(c.choice='important') i,sum(c.choice='not_important') n,sum(c.choice IS NULL) u
          FROM importance_participants p LEFT JOIN importance_choices c ON c.account_id=p.account_id AND c.kind='sender' AND c.target=p.address GROUP BY p.account_id,p.thread_id) g
          ON g.account_id=t.account_id AND g.thread_id=t.id ORDER BY t.account_id,t.id`).all();
      expect(s.query("SELECT * FROM importance_thread_state ORDER BY account_id,thread_id").all()).toEqual(oracle);
      expect((s.query("SELECT count(*) n FROM importance_message_state").get() as {n:number}).n).toBe((s.query("SELECT count(*) n FROM emails").get() as {n:number}).n);
      expect(s.query("PRAGMA foreign_key_check").all()).toEqual([]);
    };
    const run=(sql:string)=>{s.exec(sql);check();};
    for(let i=0;i<80;i++) run(`INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,received_at) VALUES('m${i}','a','t','m${i}','${i%4===0?'other':i%4===1?'self':'sender'}@example.com',${i===0?'NULL':i-100})`);
    run("INSERT INTO importance_choices VALUES('a','sender','sender@example.com','important',1,0),('a','sender','other@example.com','not_important',1,0)");
    run("INSERT INTO email_labels(id,email_id,label_id) VALUES('x','m2','sent'),('y','m2','draft')");
    run("DELETE FROM email_labels WHERE id='x'"); // Still blocked by DRAFT.
    run("UPDATE labels SET provider_label_id='ARCHIVE' WHERE id='draft'");
    run("UPDATE labels SET provider_label_id='DRAFT' WHERE id='draft'");
    run("DELETE FROM labels WHERE id='draft'"); // Catalog cascade must restore eligibility.
    run("INSERT INTO email_labels(id,email_id,label_id) VALUES('z','m3','sent')");
    run("UPDATE email_labels SET email_id='m6' WHERE id='z'");
    run("UPDATE labels SET account_id='b' WHERE id='sent'");
    run("UPDATE labels SET account_id='a' WHERE id='sent'");
    const beforeCache=s.query("SELECT * FROM importance_message_state ORDER BY email_id").all();
    run("UPDATE emails SET body_text='Changed body',is_read=1 WHERE id='m1'");
    expect(s.query("SELECT * FROM importance_message_state ORDER BY email_id").all()).toEqual(beforeCache);
    run("UPDATE email_labels SET label_id='inbox' WHERE id='z'");
    run("UPDATE emails SET is_draft=1 WHERE id IN ('m7','m8')");
    run("UPDATE emails SET from_address=' NEW@example.com ',received_at=900 WHERE id='m9'");
    run("UPDATE emails SET thread_id='t2' WHERE id='m9'");
    run("UPDATE emails SET account_id='b',thread_id='tb' WHERE id='m9'");
    run("UPDATE oauth_accounts SET provider_email='sender@example.com' WHERE id='a'");
    run("UPDATE oauth_accounts SET provider_email='self@example.com' WHERE id='a'");
    run("INSERT INTO importance_choices VALUES('a','conversation','t','not_important',1,0)");
    run("UPDATE importance_choices SET choice='not_important',revision=2 WHERE kind='sender' AND target='sender@example.com'");
    run("UPDATE importance_choices SET choice=NULL,revision=2 WHERE kind='conversation'");
    for(let i=0;i<80;i++) if(i!==9) run(`DELETE FROM emails WHERE id='m${i}'`);
    run("DELETE FROM threads WHERE id='tb'");
    run("DELETE FROM oauth_accounts WHERE id='a'");
  } finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test("BRE-461 upgrades an existing 0052 database without rewriting mail, choices, receipts or tombstones", () => {
  const dir=mkdtempSync(join(tmpdir(),"orca-importance-53-upgrade-")); const {db,sqlite:s}=createDatabaseClient(join(dir,"test.sqlite"));
  const migrations=resolve(import.meta.dir,"../../drizzle"),old=join(dir,"old");mkdirSync(join(old,"meta"),{recursive:true});
  const journal=JSON.parse(readFileSync(join(migrations,"meta/_journal.json"),"utf8"));
  writeFileSync(join(old,"meta/_journal.json"),JSON.stringify({...journal,entries:journal.entries.filter((e:{idx:number})=>e.idx<=52)}));
  for(const file of readdirSync(migrations))if(file.endsWith(".sql")&&Number(file.slice(0,4))<=52)copyFileSync(join(migrations,file),join(old,file));
  try{
    migrate(db,{migrationsFolder:old});
    s.exec(`INSERT INTO users(id,email) VALUES('u','u@example.com'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','self@example.com');
      INSERT INTO threads(id,account_id,provider_thread_id) VALUES('t','a','t');
      INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,received_at) VALUES('m','a','t','m','sender@example.com',1000);
      INSERT INTO importance_choices VALUES('a','sender','sender@example.com','important',4,10),('a','conversation','t',NULL,6,10);
      INSERT INTO importance_operations VALUES('a','old-operation','u','conversation','t',NULL,'not_important',6,'old-fingerprint',10);`);
    const tables=["emails","threads","importance_choices","importance_operations","importance_participants","importance_thread_state"];
    const before=tables.map(t=>s.query(`SELECT * FROM ${t}`).all());
    const revision=(s.query("SELECT revision FROM mailbox_revisions WHERE account_id='a'").get() as {revision:number}).revision;
    migrate(db,{migrationsFolder:migrations});
    for(let i=0;i<tables.length;i++)expect(s.query(`SELECT * FROM ${tables[i]}`).all()).toEqual(before[i]);
    expect((s.query("SELECT revision FROM mailbox_revisions WHERE account_id='a'").get() as {revision:number}).revision).toBeGreaterThan(revision);
    expect(s.query("SELECT participant_address FROM importance_message_state").all()).toEqual([{participant_address:"sender@example.com"}]);
    s.exec("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,received_at) VALUES('new','a','t','new','new@example.com',2000)");
    expect(s.query("SELECT effective,participant_count,important_count,unreviewed_count,retained_count FROM importance_thread_state").get()).toEqual({effective:"important",participant_count:2,important_count:1,unreviewed_count:1,retained_count:2});
    migrate(db,{migrationsFolder:migrations});expect(s.query("PRAGMA foreign_key_check").all()).toEqual([]);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
