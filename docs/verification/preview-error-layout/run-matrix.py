import pathlib,json,subprocess,sys
root=pathlib.Path(__file__).parent
session='preview-layout-f037';records=[]
def run(*args):
 p=subprocess.run(['/opt/homebrew/bin/agent-browser','--session',session,'--json',*args],capture_output=True,text=True)
 records.append({'command':args,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr});(root/'matrix-commands.json').write_text(json.dumps(records,indent=2))
 assert p.returncode==0,p.stdout+p.stderr
 r=json.loads(p.stdout);assert r.get('success',True),r
 return r.get('data',r.get('result',r))
def value(s):
 r=run('eval',s);return r.get('result',r) if isinstance(r,dict) else r
try:
 for theme in ['light','dark']:
  run('set','viewport','1024','768')
  run('open','http://127.0.0.1:5187/')
  run('wait','--fn',"!!document.querySelector('.desktop-theme-toggle')")
  if value('document.documentElement.dataset.theme')!=theme:run('click','.desktop-theme-toggle')
  run('wait','--fn',"document.documentElement.dataset.theme==='"+theme+"' && !document.documentElement.hasAttribute('data-orca-transition')")
  run('open','http://127.0.0.1:5187/?search=mail&searchQuery=Project&searchMailbox=all&searchEvidence=all&searchSource=%2F')
  run('wait','--fn',"!!document.querySelector('.global-mail-save:not(:disabled)')")
  run('network','route','**/v1/organization/views/preview','--body','{}')
  run('click','.global-mail-save')
  run('wait','--fn',"!!document.querySelector('.view-unsupported-clauses li button')")
  run('click','.view-unsupported-clauses li button:first-of-type')
  run('wait','--fn',"!!document.querySelector('.view-preview-retry')")
  for mode in ['error','normal']:
   if mode=='normal':
    run('network','unroute','**/v1/organization/views/preview')
    run('click','.view-preview-retry')
    run('wait','--fn',"!!document.querySelector('.view-save:not(:disabled)')")
   with (root/(theme+'-'+mode+'.txt')).open('w') as log:
    c=subprocess.run([sys.executable,str(root/'check.py'),session,theme,mode],stdout=log,stderr=subprocess.STDOUT)
   assert c.returncode==0,(theme,mode,c.returncode)
  run('network','requests','--filter','/v1/organization/views/preview')
 (root/'matrix-result.json').write_text(json.dumps({'status':'PASS','cases':12,'fixture':'Browser transport POST preview200{}; real recovery after unroute; no save; source and error text unchanged.'},indent=2))
finally:
 run('network','unroute','**/v1/organization/views/preview')
