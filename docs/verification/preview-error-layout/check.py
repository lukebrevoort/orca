import json,pathlib,subprocess,sys
root=pathlib.Path(__file__).parent

def failures(m):
 return ([] if m.get('applicable') else ['missing footer']) + (["text overlap/escape"] if m.get('textOverlap') or m.get('previewEscapes') or m.get('validationEscapes') else []) + (["zero preview width"] if m.get('preview',{}).get('rect',{}).get('width',0)<=0 else [])
if sys.argv[1]=='--baseline':
 r=json.loads((root/'lifetime4-footer-two-frame-geometry.json').read_text())
 f={k:failures(r[k]) for k in ['first','second']}
 print(json.dumps(f));sys.exit(1 if any(f.values()) else 0)
session,theme,mode=sys.argv[1:4]
assert theme in ['light','dark'] and mode in ['error','normal']
out=root/(theme+'-'+mode);out.mkdir(exist_ok=True);records=[]
def run(*args):
 p=subprocess.run(['/opt/homebrew/bin/agent-browser','--session',session,'--json',*args],capture_output=True,text=True)
 records.append({'command':args,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr});(out/'commands.json').write_text(json.dumps(records,indent=2))
 if p.returncode:raise RuntimeError(p.stdout+p.stderr)
 r=json.loads(p.stdout);assert r.get('success',True),r
 return r.get('data',r.get('result',r))
def evaluate(s):
 r=run('eval',s)
 return r.get('result',r) if isinstance(r,dict) else r
expr=(root/'measurement.js').read_text().strip()
baseline=json.loads((root/'lifetime4-footer-two-frame-geometry.json').read_text())['first']['validationText']
for width,height in [(1024,768),(1440,900),(390,844)]:
 run('set','viewport',str(width),str(height))
 run('scrollintoview','.view-builder-footer')
 run('wait','--fn',"!document.documentElement.hasAttribute('data-orca-transition')")
 pair=evaluate('new Promise(resolve=>{const first='+expr+';requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({first,second:'+expr+'})))})')
 (out/f'{width}-geometry.json').write_text(json.dumps(pair,indent=2))
 for m in pair.values():
  assert not failures(m),failures(m)
  assert m['theme']==theme and m['viewport']==[width,height] and m['transition'] is None,m
  if mode=='error':assert m['validationText']==baseline and m['retry'] and not m['retry']['disabled'] and m['saveDisabled'],m
  else:assert m['retry'] is None and not m['saveDisabled'] and m['validationText']=='Preview is current. Ready to save this perspective.',m
  if width<760:assert m['validation']['rect']['top']>=m['preview']['rect']['bottom']-1,m
 if mode=='error':
  run('focus','.view-color-field input')
  for i in range(30):
   run('press','Tab')
   if evaluate("document.activeElement===document.querySelector('.view-preview-retry')"):break
  else:raise AssertionError('Retry not reached with Tab')
  state=evaluate("(()=>{const e=document.querySelector('.view-preview-retry'),r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {focus:e===document.activeElement,focusVisible:e.matches(':focus-visible'),hit:e===h||e.contains(h),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()")
  assert state['focus'] and state['focusVisible'] and state['hit'],state
  (out/f'{width}-retry-focus.json').write_text(json.dumps(state,indent=2))
 run('screenshot',str((out/f'{width}.png').resolve()))
(out/'result.json').write_text(json.dumps({'status':'PASS','mode':mode,'theme':theme,'widths':[1024,1440,390],'fixture':'malformed POST200{} when error; actual server response when normal; no save'},indent=2))
