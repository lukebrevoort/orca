"""Immutable-Git SQL comparison. Callback counts and separately timed, callback-free samples."""
import hashlib, json, os, resource, sqlite3, subprocess, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]

def worker(p):
    c=sqlite3.connect(':memory:');c.execute('PRAGMA foreign_keys=ON')
    for entry in p['sql']: c.executescript(entry['text'])
    c.executescript("INSERT INTO users(id,email) VALUES('u','u@example.com'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','u@example.com'); INSERT INTO threads(id,account_id,provider_thread_id) VALUES('t','a','t');")
    n=p['n']
    insert="INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,received_at) VALUES(?,'a','t',?,'p@example.com',?)"
    if p['phase']=='labelRefresh':
        for i in range(n): c.execute(insert,(f'e{i}',f'e{i}',i))
        c.executescript("INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES('inbox','a','INBOX','Inbox','system'),('unread','a','UNREAD','Unread','system');")
        for i in range(n):
            for label in ('inbox','unread'): c.execute("INSERT INTO email_labels(id,email_id,label_id) VALUES(?,?,?)",(f'e{i}:{label}',f'e{i}',label))
    c.commit(); count=[0]
    def tick(): count[0]+=1; return 0
    if p['profile']: c.set_progress_handler(tick,1)
    wall=time.perf_counter_ns();cpu=time.process_time_ns()
    with c:
        if p['phase']=='insert':
            for i in range(n): c.execute(insert,(f'e{i}',f'e{i}',i))
        else:
            # Same delete-all + chunks-of-400 association pattern as upsertEmailLabels.
            c.execute('DELETE FROM email_labels WHERE email_id IN ('+','.join('?'*n)+')',[f'e{i}' for i in range(n)])
            rows=[(f'e{i}:{label}',f'e{i}',label) for i in range(n) for label in ('inbox','unread')]
            for at in range(0,len(rows),400):
                chunk=rows[at:at+400]
                c.execute('INSERT INTO email_labels(id,email_id,label_id) VALUES '+','.join('(?,?,?)' for _ in chunk),[x for row in chunk for x in row])
    cpu=time.process_time_ns()-cpu;wall=time.perf_counter_ns()-wall;c.set_progress_handler(None,0)
    assert c.execute('SELECT count(*) FROM emails').fetchone()[0]==n
    if any('0052_' in x['path'] for x in p['sql']):
        assert c.execute('SELECT address,message_count FROM importance_participants').fetchall()==[('p@example.com',n)]
        assert c.execute('SELECT effective,participant_count,unreviewed_count,retained_count,received_at FROM importance_thread_state').fetchall()==[('unreviewed',1,1,n,n-1)]
    result={'callbacksInterval1':count[0] if p['profile'] else None,'wallMs':wall/1e6,'cpuMs':cpu/1e6,'processPeakRssBytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)}
    c.close();return result

if '--worker' in sys.argv:
    print(json.dumps(worker(json.load(sys.stdin))));raise SystemExit()

def git(*args): return subprocess.check_output(['git','-C',str(ROOT),*args],text=True).strip()
def snapshot(rev):
    sha=git('rev-parse','--verify',rev+'^{commit}'); assert len(sha)==40
    entries=[]
    for path in git('ls-tree','-r','--name-only',sha,'apps/api/drizzle').splitlines():
        if path.endswith('.sql'):
            raw=subprocess.check_output(['git','-C',str(ROOT),'show',sha+':'+path])
            entries.append({'path':path,'sha256':hashlib.sha256(raw).hexdigest(),'text':raw.decode()})
    return sha,sorted(entries,key=lambda e:e['path'])

if len(sys.argv)<3: raise SystemExit('Usage: importance-write-work.py <candidate-commit> <new-output.json> [--assert-near-linear]')
out=Path(sys.argv[2]);assert not out.exists()
old,oldsql=snapshot('2ebee41d73e3601610ef00dd39e5b81a60f486e2');new,newsql=snapshot(sys.argv[1])
report={'baseline':old,'candidate':new,'sqliteVersion':sqlite3.sqlite_version,'python':sys.version,'source':'immutable Git SQL, each file SHA256 recorded; no worktree migration reads','units':'progress callbacks at interval1; separate callback-free wall/processCPU ms; fresh subprocess peak RSS includes setup/migration','runs':[],'hashes':{old:[{k:v for k,v in e.items() if k!='text'} for e in oldsql],new:[{k:v for k,v in e.items() if k!='text'} for e in newsql]}}
for phase in ('insert','labelRefresh'):
    for n in (100,200,400):
        for profile,sample in [(True,0),(False,1),(False,2),(False,3)]:
            for sha,sql in [(old,oldsql),(new,newsql)] if sample%2==0 else [(new,newsql),(old,oldsql)]:
                run=subprocess.run([sys.executable,__file__,'--worker'],input=json.dumps({'sql':sql,'n':n,'phase':phase,'profile':profile}),text=True,capture_output=True,check=True)
                report['runs'].append({'sha':sha,'phase':phase,'messages':n,'profile':profile,'sample':sample,**json.loads(run.stdout)})
checks=[]
for phase in ('insert','labelRefresh'):
    rows=[r for r in report['runs'] if r['sha']==new and r['phase']==phase and r['profile']]
    # Same revision baseline/candidate (red replay) has duplicates; exact callbacks agree.
    counts={r['messages']:r['callbacksInterval1'] for r in rows}
    for a,b in ((100,200),(200,400)):
        ratio=counts[b]/counts[a];checks.append({'phase':phase,'from':a,'to':b,'ratio':ratio,'nearLinear':ratio<=2.5})
report['scalingAssertions']=checks
out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'baseline':old,'candidate':new,'scalingAssertions':checks,'output':str(out)}))
if '--assert-near-linear' in sys.argv and not all(c['nearLinear'] for c in checks): raise SystemExit(1)
