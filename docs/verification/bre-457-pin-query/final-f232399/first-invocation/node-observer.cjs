
const fs = require('node:fs');
const path = require('node:path');
let entry;
try { entry = fs.realpathSync(process.argv[1]); } catch { return; }
if (![process.env.BRE457_TSC_ENTRY, process.env.BRE457_VITE_ENTRY].includes(entry)) return;
const args = process.argv.slice(2);
let project = null;
const index = args.findIndex(arg => arg === '-p' || arg === '--project');
if (index >= 0 && args[index + 1]) project = path.resolve(process.cwd(), args[index + 1]);
const base = {pid: process.pid, entry, execPath: fs.realpathSync(process.execPath), command: [fs.realpathSync(process.execPath), entry, ...args], cwd: process.cwd(), args, project, stage: process.env.BRE457_FINAL_STAGE};
function record(event) { fs.appendFileSync(process.env.BRE457_NODE_EVENTS, JSON.stringify({...base, ...event}) + '\n'); }
record({event: 'start'});
process.on('exit', code => record({event: 'exit', exitCode: code}));
