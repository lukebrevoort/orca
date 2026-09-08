"""Run against an existing authenticated Search authoring draft with preserved summary.
Only agent-browser drives the browser; eval records state, never changes the DOM.
"""
import json, subprocess, pathlib, sys
expected_theme=sys.argv[2]
out=pathlib.Path(__file__).parent/('browser-'+expected_theme)
out.mkdir(exist_ok=True)
hover_only='--hover-only' in sys.argv
session=sys.argv[1]
records=[]
command_file='hover-commands.json' if hover_only else 'commands.json'
def run(*args):
 p=subprocess.run(['/opt/homebrew/bin/agent-browser','--session',session,'--json',*args],capture_output=True,text=True)
 records.append({'command':args,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
 (out/command_file).write_text(json.dumps(records,indent=2))
 if p.returncode: raise RuntimeError(p.stdout+p.stderr)
 r=json.loads(p.stdout)
 if not r.get('success',True): raise RuntimeError(str(r))
 return r.get('data',r.get('result',r))
def read():
 r=run('eval',"JSON.stringify(({url:location.href,theme:document.documentElement.dataset.theme,viewport:[innerWidth,innerHeight],active:document.activeElement?.outerHTML,summary:document.activeElement===document.querySelector('.view-preserved-constraints summary'),color:document.activeElement===document.querySelector('.view-color-field input'),next:document.activeElement?.textContent==='Replace with subject contains “Project”',inside:!!document.activeElement?.closest('[data-top-layer=active]'),focusVisible:document.activeElement?.matches(':focus-visible'),open:document.querySelector('.view-preserved-constraints')?.open}))")
 if isinstance(r,dict): r=r.get('result',r)
 return json.loads(r) if isinstance(r,str) else r
def hover_capture(width,state):
 run('focus','.view-color-field input')
 run('hover','.view-preserved-constraints summary')
 r=run('eval',"JSON.stringify((()=>{const e=document.querySelector('.view-preserved-constraints summary'),r=e.getBoundingClientRect(),s=getComputedStyle(e),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {theme:document.documentElement.dataset.theme,viewport:[innerWidth,innerHeight],open:e.parentElement.open,text:e.textContent,hover:e.matches(':hover'),focused:e===document.activeElement,hit:e===h||e.contains(h),rect:{x:r.x,y:r.y,width:r.width,height:r.height},color:s.color,fontSize:s.fontSize,visibility:s.visibility}})())")
 if isinstance(r,dict): r=r.get('result',r)
 r=json.loads(r) if isinstance(r,str) else r
 assert r['theme']==expected_theme and r['viewport']==[width,768 if width==1024 else 900] and r['open']==(state=='open') and r['hover'] and not r['focused'] and r['hit'] and r['text'].strip() and r['rect']['width']>0 and r['rect']['height']>0 and r['visibility']=='visible',r
 (out/f'{width}-{state}-hover.json').write_text(json.dumps(r,indent=2))
 run('screenshot',str((out/f'{width}-{state}-hover.png').resolve()))
for width,height in [(1024,768),(1440,900)]:
 run('set','viewport',str(width),str(height))
 for state in ['open','closed']:
  run('focus','.view-color-field input')
  run('press','Tab')
  current=read()
  assert current['summary'] and current['theme']==expected_theme and current['viewport']==[width,height],current
  if current['open'] != (state=='open'): run('press','Space')
  current=read()
  if hover_only:
   hover_capture(width,state)
   continue
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
  hover_capture(width,state)
(out/('hover-result.json' if hover_only else 'result.json')).write_text(json.dumps({'status':'PASS','cases':4,'scope':('Pointer-only open/closed hover states; prior keyboard results retained separately.' if hover_only else 'Native forward/reverse summary neighbors and Space open/collapse, plus pointer-only hover; requested theme and viewport asserted.')},indent=2))
