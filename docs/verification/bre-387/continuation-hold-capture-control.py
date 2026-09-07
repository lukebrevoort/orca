import urllib.request,http.cookiejar,json,pathlib,datetime,sys,time,hashlib,urllib.parse
p=pathlib.Path('docs/verification/bre-387');stage=sys.argv[1];context=sys.argv[2];j=http.cookiejar.CookieJar();o=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(j));base='http://127.0.0.1:3087'
def req(path,body=None):
 r=o.open(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'}),timeout=20);raw=r.read();return {'status':r.status,'bodySha256':hashlib.sha256(raw).hexdigest(),'data':json.loads(raw)}
o.open('http://127.0.0.1:5187/v1/review/login',timeout=30).read()
if stage=='arm':
 if context=='search':path='/v1/inbox?limit=100&classification=all&view=all&query=Project'
 else:
  setup=json.load(open(p/'lifetime6-lifecycle-fixture-setup.json'));view=setup['created'][0]['saved']['view']['id'];path='/v1/organization/views/'+view+'/results?limit=25'
 first=req(path)
 for _ in range((int(sys.argv[3]) if len(sys.argv)>3 else 1)-1):
  cursor=first['data']['nextCursor'];assert cursor;first=req(path+'&cursor='+urllib.parse.quote(cursor,safe=''))
 cursor=first['data']['nextCursor'];assert cursor;full=path+'&cursor='+urllib.parse.quote(cursor,safe='');arm=req('/v1/review/hold-next-continuation',{'context':context,'requestPath':full});assert arm['status']==200;data={'initialPage':first,'armed':arm,'requestPath':full}
elif stage=='held':
 end=time.monotonic()+20
 while True:
  r=req('/v1/review/pending-continuation');d=r['data']
  if d['held'] and d['receipt'].get('responseBodySha256'):break
  assert time.monotonic()<end,'No actual hashed response held'
  time.sleep(.1)
 assert d['receipt']['context']==context;data=r
elif stage=='release':
 r=req('/v1/review/release-continuation',{});assert r['data']['released'];d=req('/v1/review/pending-continuation');assert not d['data']['armed'] and not d['data']['held'];data={'released':r,'settledControl':d}
else:raise SystemExit('Unknown stage')
p.joinpath('lifetime6-'+context+'-'+stage+'.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeSha':'465be988438e12631a4e201f6706a6f8e0dfb035','harnessSha':'d8a52896efb29b34ec07cbe4d06bcd7b805ddf43','context':context,**data},indent=2)+'\n');print(stage,context)
