import { runAgentProcess } from '../../apps/api/src/process.ts';
const marker = process.env.ACE_ORPHAN_MARKER, sentinel = process.env.ACE_ORPHAN_SENTINEL;
if (!marker || !sentinel) throw new Error('Missing orphan fixture paths');
const grandchild = 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "orphaned"), 2000);';
const provider = 'const cp=require("node:child_process");' +
  'const gc=cp.spawn(process.execPath, ["-e", ' + JSON.stringify(grandchild) + '], {stdio:"ignore"});' +
  'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', String(gc.pid));' +
  'setInterval(() => {}, 1000);';
await runAgentProcess({ executable: process.execPath, args: ['-e', provider], stdin: '', timeoutMs: 12000 });
