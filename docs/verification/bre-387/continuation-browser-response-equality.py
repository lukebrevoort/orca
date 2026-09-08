import subprocess,json,pathlib,urllib.parse,hashlib,base64,sys,datetime
p=pathlib.Path('docs/verification/bre-387');context=sys.argv[1];held=json.load(open(p/('lifetime6-'+context+'-held.json')))['data']['receipt'];expected=held['requestIdentity'];sha=held['responseBodySha256']
def cli(args):
 r=subprocess.run(['/opt/homebrew/bin/agent-browser','--session','bre387-held-clean-d8a5289',*args,'--json'],capture_output=True,text=True);assert r.returncode==0,r.stderr;return json.loads(r.stdout)
def canonical(url):
 u=urllib.parse.urlsplit(url);return u.path+'?'+urllib.parse.urlencode(sorted(urllib.parse.parse_qsl(u.query,keep_blank_values=True)))
def nodes(x):
 yield x
 if isinstance(x,dict):
  for v in x.values():yield from nodes(v)
 elif isinstance(x,list):
  for v in x:yield from nodes(v)
x=cli(['network','requests','--filter','cursor=']);matches=[v for v in nodes(x) if isinstance(v,dict) and v.get('method')=='GET' and 'requestId'in v and canonical(v.get('url',''))==expected];assert matches,'No matching actual browser request';request=matches[-1];detail=cli(['network','request',request['requestId']]);bodyMatches=[]
for value in nodes(detail):
 if isinstance(value,str):
  if hashlib.sha256(value.encode()).hexdigest()==sha:bodyMatches.append('utf8 body')
  try:
   if hashlib.sha256(base64.b64decode(value,validate=True)).hexdigest()==sha:bodyMatches.append('base64 body')
  except Exception:pass
record={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'context':context,'requestId':request['requestId'],'url':request['url'],'requestIdentity':expected,'status':request.get('status'),'expectedStatus':held['responseStatus'],'expectedBodySha256':sha,'bodyHashMatched':bool(bodyMatches),'matchingEncodings':bodyMatches,'boundary':'Browser response detail inspected in memory; request headers/cookies not retained. Actual page context is bound separately by perframe URL.'}
p.joinpath('lifetime6-'+context+'-browser-response-equality.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));assert record['status']==held['responseStatus'] and bodyMatches,'Actual response body equality not established'
