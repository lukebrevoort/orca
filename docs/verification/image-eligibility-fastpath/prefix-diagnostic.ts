import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const root='/workspace/orca-oct18-perf';
const base=await import('/workspace/orca-oct18-base/apps/api/src/mail/images/render.ts');
const candidate=await import(`${root}/apps/api/src/mail/images/render.ts`);
const rows=[];
for(const size of [102400,1048576]){
 const tail='<img alt="Synthetic" src="https://images.example.org/banner.png">';
 const unit='<p>Synthetic message content only.</p>';
 const remaining=size-tail.length;
 const html=unit.repeat(Math.floor(remaining/unit.length))+'x'.repeat(remaining%unit.length)+tail;
 for(let pair=-1;pair<8;pair++)for(const role of pair%2?['candidate','baseline']:['baseline','candidate']){
  const helper=role==='baseline'?base.hasLoadableImages:candidate.hasLoadableImages;
  const cpu=process.cpuUsage(),start=performance.now();
  for(let i=0;i<5;i++)assert.equal(helper(html),true);
  const wallMs=(performance.now()-start)/5,usage=process.cpuUsage(cpu);
  if(pair>=0)rows.push({size,pair,role,wallMs,cpuMs:(usage.user+usage.system)/5000});
 }
 const start=performance.now();let matches=0;
 for(let i=0;i<200;i++)matches+=Number(/<im/i.test(html));
 assert.equal(matches,200);
 rows.push({size,role:'prefix-only',repetitions:200,wallMs:(performance.now()-start)/200});
}
writeFileSync('/workspace/orca-oct18-optimization/prefix-diagnostic.json',JSON.stringify({baseline:'e9f928258479aa7b46f7489c6e3e100c254a064f',candidate:'a2c7940b987df63d944d2218d5fcb7333b9dadac',description:'same-process alternating real helper on positive tail fixtures,5calls/sample,1discardedwarmuppair,8pairs; separate200repetition regex diagnostic; asserts inside timing; not end-to-end API',rows},null,2)+'\n',{flag:'wx'});
