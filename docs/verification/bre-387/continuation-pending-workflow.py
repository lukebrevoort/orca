import subprocess,sys,json,pathlib,urllib.request,datetime
context=sys.argv[1];commands=sys.argv[2];p=pathlib.Path('docs/verification/bre-387');start=datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args):
 r=subprocess.run(args);assert r.returncode==0,('command failed',args,r.returncode)
def control(path,body=None):
 r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:3087'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'}),timeout=30);return json.load(r)
try:
 run(['python3','/tmp/bre387-hold-control6.py','arm',context])
 a=json.load(open(p/('lifetime6-'+context+'-arm.json')))['armed']['data']['receipt'];d=control('/v1/review/pending-continuation');assert d['armed'] and d['receipt']['id']==a['id'] and d['receipt']['requestIdentity']==a['requestIdentity'];p.joinpath('lifetime6-'+context+'-armed-confirmed.json').write_text(json.dumps(d,indent=2)+'\n')
 sel='.global-mail-load-more' if context=='search' else ('.saved-view-results' if context=='saved' else '.view-results')+' .view-continuation button'
 run(['python3','/tmp/bre387-ab6.py','click',sel,'--json'])
 run(['python3','/tmp/bre387-hold-control6.py','held',context])
 run(['python3','/tmp/bre387-batch6.py','lifetime6-'+context+'-pending-recovered',commands])
 run(['python3','/tmp/bre387-hold-control6.py','release',context])
 state="({controlObservation:{scenario:'lifetime6-"+context+"-settled',at:new Date().toISOString(),url:location.href,rows:document.querySelectorAll('"+('.global-mail-result-list a' if context=='search' else '.saved-view-results .view-thread-open' if context=='saved' else '.view-results .view-thread-list article')+"').length,button:document.querySelector('"+sel+"')?.outerHTML??null}})"
 c=[['wait','--fn',"!document.querySelector('"+sel+"')?.disabled"],['eval',state]];f=pathlib.Path('/tmp/lifetime6-'+context+'-settled.json');f.write_text(json.dumps(c));run(['python3','/tmp/bre387-batch6.py','lifetime6-'+context+'-settled',str(f)])
 run(['python3','/tmp/bre387-network-equality6.py',context])
 result='PASS'
except Exception as e:
 result='FAIL';print(repr(e),flush=True);raise
finally:
 d=control('/v1/review/release-continuation',{});p.joinpath('lifetime6-'+context+'-workflow.json').write_text(json.dumps({'startedAt':start,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':locals().get('result','FAIL'),'finallyRelease':d,'boundary':'Sequential arm terminal + matching armed receipt precede actual click; explicit/finally cleanup no retry'},indent=2)+'\n')
