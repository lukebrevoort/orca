import urllib.request,urllib.error,urllib.parse,http.cookiejar,http.client,socket,json,time,datetime,pathlib,hashlib,concurrent.futures
p=pathlib.Path('docs/verification/bre-387');out={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'harnessSha':'d8a52896efb29b34ec07cbe4d06bcd7b805ddf43','runtimeSha':'465be988438e12631a4e201f6706a6f8e0dfb035','scope':'Direct API harness controls, not browser or provider proof','records':[]};jar=http.cookiejar.CookieJar();op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar));base='http://127.0.0.1:3087'
def record(name,**data):
 out['records'].append({'name':name,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**data});p.joinpath('lifetime6-hold-validation.json').write_text(json.dumps(out,indent=2)+'\n');print(name,flush=True)
def req(path,body=None,method=None,timeout=20):
 q=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'},method=method)
 try:r=op.open(q,timeout=timeout)
 except urllib.error.HTTPError as e:r=e
 raw=r.read();return {'status':r.status,'sha256':hashlib.sha256(raw).hexdigest(),'data':json.loads(raw) if raw[:1] in [b'{',b'['] else raw.decode()}
def pending():return req('/v1/review/pending-continuation')['data']
def release():return req('/v1/review/release-continuation',{})
def arm(path,context='search'):return req('/v1/review/hold-next-continuation',{'context':context,'requestPath':path})
def wait_held():
 end=time.monotonic()+15
 while time.monotonic()<end:
  d=pending()
  if d['held'] and d['receipt'].get('responseBodySha256'):return d
  time.sleep(.1)
 raise AssertionError('No hashed held response')
op.open('http://127.0.0.1:5187/v1/review/login',timeout=20).read();cookie='; '.join(c.name+'='+c.value for c in jar)
first=req('/v1/inbox?limit=100&classification=all&view=all&query=Project');cursor=first['data']['nextCursor'];assert cursor
path='/v1/inbox?'+urllib.parse.urlencode({'limit':100,'classification':'all','view':'all','query':'Project','cursor':cursor})
record('setup',firstStatus=first['status'],firstRows=len(first['data']['messages']),requestPath=path,initialProbeBoundary='Earlier directAPI login followed302 to absent APIroot404; corrected SPAlogin before any arm')
# Reject invalid identities without arming.
for bad,context in [('/v1/inbox?cursor=','search'),('/v1/inbox?cursor=a&%63ursor=b','search'),('/v1/inbox?cursor=%ZZ','search'),('/v1/inbox?cursor=%FF','search'),('/v1/inbox?cursor=a','saved'),('/v1/preferences?cursor=a','search'),('/v1/inbox?cursor=a#fragment','search')]:
 r=arm(bad,context);assert r['status']==400 and not pending()['armed'];record('reject identity',path=bad,context=context,status=r['status'])
assert req('/v1/review/hold-next-preview',{})['status']==200
assert arm(path)['status']==409
release();assert arm(path)['status']==200
assert req('/v1/review/hold-next-preview',{})['status']==409
record('symmetric mutual exclusion',status='PASS');release()
# Delayed body makes the post-await race deterministic.
def slow_arm(other):
 body=json.dumps({'context':'search','requestPath':path}).encode();c=http.client.HTTPConnection('127.0.0.1',3087,timeout=20);c.putrequest('POST','/v1/review/hold-next-continuation');c.putheader('Content-Type','application/json');c.putheader('Content-Length',str(len(body)));c.endheaders();c.send(body[:1]);winner=other();assert winner['status']==200;c.send(body[1:]);r=c.getresponse();raw=r.read();assert r.status==409;c.close();return winner
winner=slow_arm(lambda:arm(path+'&accountId=work'));d=pending();assert d['receipt']['requestIdentity']==winner['data']['receipt']['requestIdentity'];record('concurrent continuation arm',loserStatus=409,retained=d);release()
slow_arm(lambda:req('/v1/review/hold-next-preview',{}));assert req('/v1/review/pending-preview')['data']['armed'];record('preview wins delayed continuation body',loserStatus=409);release()
assert arm(path)['status']==200;identity=pending()['receipt']['id']
for wrong,method in [(path.replace('Project','Other'),'GET'),(path.replace('cursor=','cursor=x'),'GET'),('/v1/organization/views/other/results?limit=25&cursor=x','GET'),(path,'POST')]:
 r=req(wrong,{} if method=='POST' else None,method);d=pending();assert d['armed'] and d['receipt']['id']==identity;record('unmatched preserves arm',method=method,path=wrong,status=r['status'])
release();assert not pending()['armed'];assert release()['data']['released']==False;record('unconsumed idempotent release',receipt=pending())
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
 assert arm(path)['status']==200;f=pool.submit(req,path,None,None,270);held=wait_held();assert not f.done();record('matched held original response',pending=held);release();actual=f.result(20);assert actual['status']==held['receipt']['responseStatus'] and actual['sha256']==held['receipt']['responseBodySha256'];record('explicit release identical response',status=actual['status'],sha256=actual['sha256'],receipt=pending())
# Direct TCP abort only; does not assert browser proxy abort propagation.
assert arm(path)['status']==200;s=socket.create_connection(('127.0.0.1',3087),timeout=10);s.sendall(('GET '+path+' HTTP/1.1\r\nHost: 127.0.0.1:3087\r\nCookie: '+cookie+'\r\nConnection: close\r\n\r\n').encode());held=wait_held();s.shutdown(socket.SHUT_RDWR);s.close();end=time.monotonic()+10
while pending()['held'] and time.monotonic()<end:time.sleep(.1)
d=pending();assert not d['held'] and d['receipt']['releaseReason']=='abort';record('direct TCP abort',receipt=d)
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
 assert arm(path)['status']==200;start=time.monotonic();f=pool.submit(req,path,None,None,270);held=wait_held();record('actual configured held timeout started',pending=held)
 actual=f.result(270);elapsed=time.monotonic()-start;d=pending();assert elapsed>=239 and d['receipt']['releaseReason']=='timeout' and not d['held'];assert actual['sha256']==held['receipt']['responseBodySha256'];record('actual240s held timeout',elapsedSeconds=elapsed,status=actual['status'],sha256=actual['sha256'],receipt=d)
assert arm(path)['status']==200;start=time.monotonic();record('actual configured unconsumed arm timeout started',pending=pending())
while pending()['armed']:
 assert time.monotonic()-start<270
 time.sleep(2)
elapsed=time.monotonic()-start;d=pending();assert elapsed>=239 and d['receipt']['releaseReason']=='arm-timeout';record('actual240s unconsumed arm timeout',elapsedSeconds=elapsed,receipt=d)
release();out['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();out['status']='PASS';record('final controls clear',pending=pending())
