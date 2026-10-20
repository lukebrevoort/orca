// Independent synthetic hostile-HTML review corpus. No account, API, or external network.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const root = resolve(import.meta.dir, '../..');
import {sanitizeInboundHtml,sanitizeProviderHtml,readableHtmlText} from '../../apps/api/src/mail/provider-html.ts';
const require=createRequire(resolve(root, 'package.json'));
const {chromium}=require('playwright');
const sanitizeHtml=require('sanitize-html');
const ts=require('typescript');
const source=execFileSync('git',['show','29958f22a1f91dd90c46766a67238603a5a5f857:apps/api/src/index.ts'],{cwd:root,encoding:'utf8'});
const sandbox={sanitizeHtml};
vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('const providerHtmlPolicy:'),source.indexOf('\nfunction sanitizeOutboundHtml'))+'\nglobalThis.old=sanitizeProviderHtml;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
const corpus=[
 '<img src="https://attacker.invalid/pixel" onerror="window.pwned=1" alt="&lt;img src=x onerror=window.pwned=1&gt;">',
 '<img src="cid:logo" alt="&amp;lt;script&amp;gt;window.pwned=1&amp;lt;/script&amp;gt;">',
 '<img alt="&quot;&gt;&lt;/span&gt;&lt;svg onload=window.pwned=1&gt;">',
 '<table role="presentation"><tr><td><img alt="</style><script>window.pwned=1</script>"></td></tr></table>',
 '<svg><style><img src=x onerror=window.pwned=1></style></svg>',
 '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.pwned=1>">',
 '<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=window.pwned=1>',
 '<noscript><p title="</noscript><img src=x onerror=window.pwned=1>">',
 '<textarea><img src=x onerror=window.pwned=1></textarea><xmp><script>window.pwned=1</script></xmp>',
 '<table><tr><td><svg><foreignObject><p onmouseover="window.pwned=1">hi</p></foreignObject></svg></td></tr></table>',
 '<iframe srcdoc="<script>parent.pwned=1</script>"></iframe><object data="https://attacker.invalid"></object><embed src="https://attacker.invalid">',
 '<link rel="stylesheet" href="https://attacker.invalid/x"><base href="https://attacker.invalid/"><meta http-equiv="refresh" content="0;url=https://attacker.invalid"><style>@import "https://attacker.invalid/css";</style>',
 '<video poster="https://attacker.invalid/x"><source src="https://attacker.invalid/x"></video><audio src="https://attacker.invalid/x"></audio>',
 '<div class="orca-mail-formatted reader-body hidden" id="root" name="location"><span class="orca-mail-image-note" style="background:url(https://attacker.invalid);position:fixed;behavior:url(https://attacker.invalid);-moz-binding:url(https://attacker.invalid)">hi</span></div>',
 '<table role="grid" class="orca-mail-layout"><tr><td class="orca-mail-formatted">hi</td></tr></table>',
 '<p style="width:expression(window.pwned=1);font-family:url(https://attacker.invalid);border:url(https://attacker.invalid);text-decoration:url(https://attacker.invalid);display:none">hidden</p>',
 '<a href="javascript:window.pwned=1" ping="https://attacker.invalid" download="x" target="_self">link</a>',
 '<a href="jav&#x09;ascript:window.pwned=1">link</a>',
 '<a href="&#106;avascript:window.pwned=1">link</a>',
 '<a href="data:text/html,<script>window.pwned=1</script>">link</a>',
 '<a href="vbscript:window.pwned=1">link</a>',
 '<a href="https://example.invalid/details" rel="opener" target="app">safe</a>',
 '<div title="&quot; onmouseover=&quot;window.pwned=1">hi</div>',
 '<table role="presentation"><tr><td style="width:100px">one</td><td>two</td></tr></table>',
 '<p>&lt;script&gt;window.pwned=1&lt;/script&gt; &amp; &quot;</p>',
 '<div style="display:none;width:0">preheader</div><p>keep</p>',
 '<pre>  if (a &lt; b) {\n    return &quot;hello&quot;;\n  }</pre>'
];
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),headless:true});
const results=[];
try{
 for(const [i,input] of corpus.entries()){
  assert.equal(sanitizeProviderHtml(input),sandbox.old(input),'outbound byte equality '+i);
  const safe=sanitizeInboundHtml(input)??'';
  const text=readableHtmlText(safe)??'';
  const context=await browser.newContext();
  const requests=[];await context.route('**/*',r=>{requests.push(r.request().url());return r.abort()});
  const page=await context.newPage();
  await page.setContent('<!doctype html><html><body><div id="container"></div></body></html>');
  await page.evaluate(s=>{document.querySelector('#container').innerHTML=s},safe);
  await page.waitForTimeout(30);
  const metrics=await page.evaluate(()=>({pwned:!!window.pwned,tags:[...document.querySelectorAll('#container *')].map(el=>el.tagName),badAttrs:[...document.querySelectorAll('#container *')].flatMap(el=>[...el.attributes].filter(a=>/^on|^(?:src|srcset|srcdoc|ping|id)$/i.test(a.name)).map(a=>a.name)),links:[...document.querySelectorAll('#container a')].map(el=>({href:el.getAttribute('href'),target:el.target,rel:el.rel}))}));
  assert.equal(metrics.pwned,false,'script '+i);assert.equal(requests.length,0,'network '+i);assert.equal(metrics.badAttrs.length,0,'attributes '+i);
  assert(!metrics.tags.some(t=>['SCRIPT','STYLE','IMG','SVG','MATH','IFRAME','OBJECT','EMBED','BASE','META','LINK'].includes(t)),'active tags '+i);
  for(const link of metrics.links){assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert(!/^(javascript|vbscript|data):/i.test(link.href??''));}
  if([13,14].includes(i))assert(!safe.includes('class='),'forged marker');
  results.push({i,input,safe,text,requests,metrics});await context.close();
 }
}finally{await browser.close();}
writeFileSync(process.env.MAIL_SECURITY_OUT || '/tmp/orca-security-probe-results.json',JSON.stringify({cases:results.length,results},null,2));
console.log(JSON.stringify({passed:results.length,scriptExecution:0,networkRequests:0,activeTags:0,outboundMatches:results.length}));
