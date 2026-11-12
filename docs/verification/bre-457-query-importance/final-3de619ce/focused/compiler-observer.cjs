const fs=require('node:fs');let entry;try{entry=fs.realpathSync(process.argv[1]);}catch{return;}
if(entry!==process.env.BRE457_TSC_ENTRY)return;
const a=process.argv.slice(2),i=a.indexOf('--project');if(i<0)return;
const base={pid:process.pid,entry,execPath:fs.realpathSync(process.execPath),project:a[i+1],args:a,stage:process.env.BRE457_IMPORTANCE_GATE_STAGE};
function record(event){fs.appendFileSync(process.env.BRE457_COMPILER_EVENTS,JSON.stringify({...base,...event})+'\n');}
record({event:'start'});process.on('exit',code=>record({event:'exit',exitCode:code}));