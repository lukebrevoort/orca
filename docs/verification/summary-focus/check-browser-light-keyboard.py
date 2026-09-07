"""Run against an existing authenticated Search authoring draft with preserved summary.
Only agent-browser drives the browser; eval records state, never changes the DOM.
"""
import json, subprocess, pathlib, sys
expected_theme=sys.argv[2]
out=pathlib.Path(__file__).parent/('browser-'+expected_theme)
out.mkdir(exist_ok=True)
session=sys.argv[1]
records=[]
def run(*args):
 p=subprocess.run(['/opt/homebrew/bin/agent-browser','--session',session,'--json',*args],capture_output=True,text=True)
 records.append({'command':args,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
 (out/'commands.json').write_text(json.dumps(records,indent=2))
 if p.returncode: raise RuntimeError(p.stdout+p.stderr)
 r=json.loads(p.stdout)
 if not r.get('success',True): raise RuntimeError(str(r))
 return r.get('data',r.get('result',r))
def read():
 r=run('eval',"JSON.stringify(({url:location.href,theme:document.documentElement.dataset.theme,viewport:[innerWidth,innerHeight],active:document.activeElement?.outerHTML,summary:document.activeElement===document.querySelector('.view-preserved-constraints summary'),color:document.activeElement===document.querySelector('.view-color-field input'),next:document.activeElement?.textContent==='Replace with subject contains “Project”',inside:!!document.activeElement?.closest('[data-top-layer=active]'),focusVisible:document.activeElement?.matches(':focus-visible'),open:document.querySelector('.view-preserved-constraints')?.open}))")
 if isinstance(r,dict): r=r.get('result',r)
 return json.loads(r) if isinstance(r,str) else r
for width,height in [(1024,768),(1440,900)]:
 run('set','viewport',str(width),str(height))
 for state in ['open','closed']:
  run('focus','.view-color-field input')
  run('press','Tab')
  current=read()
  assert current['summary'] and current['theme']==expected_theme and current['viewport']==[width,height],current
  if current['open'] != (state=='open'): run('press','Space')
  current=read()
  assert current['open']==(state=='open') and current['focusVisible'] and current['inside'],current
  (out/f'{width}-{state}-focus.json').write_text(json.dumps(current,indent=2))
  run('screenshot',str((out/f'{width}-{state}-focus.png').resolve()))
  run('press','Tab')
  forward=read()
  assert forward['next'] and forward['inside'],forward
  run('press','Shift+Tab')
  assert read()['summary']
  run('press','Shift+Tab')
  backward=read()
  assert backward['color'] and backward['inside'],backward
  (out/f'{width}-{state}-neighbors.json').write_text(json.dumps({'forward':forward,'backward':backward},indent=2))
(out/'result.json').write_text(json.dumps({'status':'PASS','cases':4,'scope':'Native forward/reverse summary neighbors and Space open/collapse; requested theme and viewport asserted.'},indent=2))
