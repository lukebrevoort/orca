import json,pathlib
for context,sel in [('saved','.saved-view-results .view-continuation button'),('organization','.view-results .view-continuation button'),('search','.global-mail-load-more')]:
 c=[]
 for theme,w,h in [('light',1024,768),('light',1440,900),('dark',1440,900),('dark',1024,768)]:
  if context=='saved' and theme=='dark' and w==1024:continue
  name=f'lifetime6-{context}-{theme}-{w}-pending'
  guard=f'(()=>{{const e=document.querySelector({json.dumps(sel)});if(!e)return false;const r=e.getBoundingClientRect();return document.documentElement.dataset.theme==={json.dumps(theme)}&&e.matches(":disabled")&&e.textContent.includes("Loading")&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()'
  obs=f'''(async()=>{{const e=document.querySelector({json.dumps(sel)}),r=e.getBoundingClientRect(),control=await(await fetch('/v1/review/pending-continuation')).json();if(!control.held||control.receipt.context!=={json.dumps(context)}||!control.receipt.responseBodySha256)throw Error('Held real response absent');return {{controlObservation:{{scenario:{json.dumps(name)},at:new Date().toISOString(),url:location.href,theme:document.documentElement.dataset.theme,viewport:[innerWidth,innerHeight],text:e.textContent,disabled:e.matches(':disabled'),rect:r.toJSON(),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),control,themeMechanism:'real System Appearance with media emulation'}}}}}})()'''
  cap='({captureReceipt:{at:new Date().toISOString(),url:location.href,viewport:{width:innerWidth,height:innerHeight},theme:'+json.dumps(theme)+',scenario:'+json.dumps('Real '+context+' continuation response held unchanged, actual pending disabled control; explicit release follows')+',filename:'+json.dumps('screenshots/'+name+'.png')+'}})'
  c += [['set','media',theme],['set','viewport',str(w),str(h)],['scrollintoview',sel],['mouse','move','10','10'],['wait','--fn',guard],['eval',obs],['eval',cap],['screenshot','docs/verification/bre-387/screenshots/'+name+'.png']]
 pathlib.Path('/tmp/lifetime6-'+context+'-pending-captures.json').write_text(json.dumps(c))
