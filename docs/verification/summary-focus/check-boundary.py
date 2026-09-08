import json,subprocess,pathlib
out=pathlib.Path(__file__).parent
records=[]
def run(*args):
 p=subprocess.run(['/opt/homebrew/bin/agent-browser','--session','summary-focus-f037','--json',*args],capture_output=True,text=True)
 records.append({'command':args,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
 (out/'boundary-commands.json').write_text(json.dumps(records,indent=2))
 assert p.returncode==0,p.stdout+p.stderr
 return json.loads(p.stdout).get('data')
def check(expr):
 r=run('eval',expr)
 if isinstance(r,dict): r=r.get('result')
 assert r is True,r
run('focus','button[aria-controls="search-view-tune"]')
run('press','Tab')
check("document.activeElement===document.querySelector('.view-composer-actions button') && document.activeElement.textContent==='Cancel'")
run('press','Shift+Tab')
check("document.activeElement===document.querySelector('button[aria-controls=\"search-view-tune\"]')")
run('screenshot',str((out/'boundary-dark.png').resolve()))
run('press','Escape')
check("!document.querySelector('.view-composer') && document.activeElement===document.querySelector('.global-mail-save')")
run('press','Escape')
check("!document.querySelector('.global-mail-search-heading') && document.activeElement===document.querySelector('.desktop-global-search input')")
(out/'boundary-result.json').write_text(json.dumps({'status':'PASS','scope':'Black1440 actual Tune→Tab→Cancel, ShiftTab→Tune; Escape→Search Save, Escape→header Search'},indent=2))
