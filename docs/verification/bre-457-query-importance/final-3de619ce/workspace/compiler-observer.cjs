const fs=require('node:fs'),path=require('node:path');let entry;
try{entry=fs.realpathSync(process.argv[1]);}catch{return;}
if(![process.env.BRE457_FULL_TSC,process.env.BRE457_FULL_VITE].includes(entry))return;
const args=process.argv.slice(2);const ix=args.findIndex(x=>x==='-p'||x==='--project');
const project=ix>=0&&args[ix+1]?path.resolve(process.cwd(),args[ix+1]):null;
const base={pid:process.pid,entry,execPath:fs.realpathSync(process.execPath),cwd:process.cwd(),args,project,stage:process.env.BRE457_FULL_STAGE};
function emit(event){fs.appendFileSync(process.env.BRE457_FULL_EVENTS,JSON.stringify({...base,...event})+'\n');}
emit({event:'start'});process.on('exit',code=>emit({event:'exit',exitCode:code}));