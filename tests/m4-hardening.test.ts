import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createDebateSession, debateStepKey } from '../packages/core/src/debate.ts';
import { makeApp } from '../apps/api/src/app.ts';
import type { AgentAdapter } from '../packages/core/src/types.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

const seed = () => createDebateSession({ prompt: 'Consider robust software startup operations and auditability',
  providers: ['codex','claude'], maxRounds: 1, maxCalls: 20, maxDurationMs: 10000 });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function status(app: ReturnType<typeof makeApp>, id: string): Promise<DebateSession> {
  for (let i = 0; i < 150; i++) {
    const value = (await app.inject('/api/debates/' + id)).json() as DebateSession;
    if (!['queued','running'].includes(value.status)) return value;
    await delay(20);
  }
  throw new Error('Debate timed out during test');
}
const adapters = (onCall: (name: string) => void = () => {}) =>
  new Map<string, AgentAdapter>(['codex','claude'].map(name => [name,{
    id: name as 'codex'|'claude', propose: async () => { onCall(name); return 'complete answer'; },
  }]));

test('API requires explicit authentication except when tests deliberately opt out', () => {
  const existing = process.env.ACE_API_TOKEN;
  delete process.env.ACE_API_TOKEN;
  try {
    assert.throws(() => makeApp({}), /access token is mandatory/i);
    const app = makeApp({ allowUnauthenticatedForTests: true });
    // Construction itself opts out; other tests cover startup and endpoint operation.
    void app.close();
  } finally {
    if (existing === undefined) delete process.env.ACE_API_TOKEN;
    else process.env.ACE_API_TOKEN = existing;
  }
});

test('recovery scans beyond 1,000 historical completions and reuses completed queued steps', { timeout: 45000 }, async () => {
  const dir=await mkdtemp(join(tmpdir(),'ace-m4-large-history-'));
  const store=new DebateStore(dir);
  let app: ReturnType<typeof makeApp>|undefined;
  try {
    const completed=seed();
    // More completed history than the previous 1,000-file scan threshold.
    for(let i=0;i<1005;i++){
      const hist=seed(); hist.status='completed'; hist.finishedAt=new Date().toISOString();
      await store.save(hist);
    }
    completed.status='queued';
    completed.calls=1;
    completed.entries.push({id:'b237eabd-d86a-4096-8dc2-52ce31d19d6c',
      stepKey:debateStepKey('proposal',0,'codex'),phase:'proposal',round:0,provider:'codex',
      status:'fulfilled',content:'previously saved proposal',durationMs:3,createdAt:new Date().toISOString()});
    await store.save(completed);
    const calls:string[]=[];
    app=makeApp({allowUnauthenticatedForTests:true,store:new DebateStore(dir),
      adapters:adapters(n=>calls.push(n))});
    await app.inject('/api/health');
    const done=await status(app,completed.id);
    assert.equal(done.status,'completed');
    assert.equal(done.calls,8);
    assert.equal(calls.length,7);
    const summary=(await app.inject('/api/metrics')).json() as {calls:{recoveredQueued:number}};
    assert.equal(summary.calls.recoveredQueued,1);
  } finally { if(app) await app.close(); await rm(dir,{recursive:true,force:true}); }
});

test('resuming after original wall-clock deadline never makes another model call', async () => {
  const dir=await mkdtemp(join(tmpdir(),'ace-m4-deadline-')); const store=new DebateStore(dir);
  const session=seed();session.status='running';session.executionDeadlineAt=new Date(Date.now()-2000).toISOString();
  session.calls=1;
  session.entries.push({id:'b237eabd-d86a-4096-8dc2-52ce31d19d6c',
    stepKey:debateStepKey('proposal',0,'codex'),phase:'proposal',round:0,provider:'codex',
    status:'fulfilled',content:'old response',durationMs:4,createdAt:new Date().toISOString()});
  await store.save(session);
  const called:string[]=[];const app=makeApp({allowUnauthenticatedForTests:true,
    store:new DebateStore(dir),adapters:adapters(n=>called.push(n))});
  try {
    const response=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(response.statusCode,202);
    const done=await status(app,session.id);
    assert.equal(done.status,'budget_exhausted');
    assert.equal(done.calls,1);
    assert.deepEqual(called,[]);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

test('kernel lock survives simultaneous stale-owner recovery without dual leaders', {
  skip: process.platform==='win32',timeout:25000,
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ace-m4-oslock-'));
  const owner=spawn(process.execPath,['--import','tsx','tests/fixtures/m4-lease-owner.ts'],{
    cwd:process.cwd(),env:{...process.env,ACE_LOCK_TEST_DIR:dir},stdio:['pipe','pipe','pipe'],
  });
  let ready='';owner.stdout.setEncoding('utf8');
  owner.stdout.on('data',(chunk:string)=>ready+=chunk);
  try {
    for(let i=0;i<200&&!ready.includes('LOCK_HELD');i++)await delay(20);
    assert.match(ready,/LOCK_HELD/);
    await assert.rejects(new DebateStore(dir).acquireWorkerLease(),/Another (?:active )?worker owns/i);
    owner.kill('SIGKILL');
    await new Promise<void>(resolve=>{if(owner.exitCode!==null||owner.signalCode!==null)resolve();
      else owner.once('exit',()=>resolve());});
    let results:PromiseSettledResult<()=>Promise<void>>[]=[];
    for(let tries=0;tries<60;tries++){
      results=await Promise.allSettled(Array.from({length:6},()=>new DebateStore(dir).acquireWorkerLease()));
      if(results.some(x=>x.status==='fulfilled'))break;
      await delay(25);
    }
    const won=results.filter(x=>x.status==='fulfilled');
    assert.equal(won.length,1,'exactly one contender must own the OS lock');
    await (won[0] as PromiseFulfilledResult<()=>Promise<void>>).value();
    await (await new DebateStore(dir).acquireWorkerLease())();
  } finally {if(owner.exitCode===null)owner.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});

test('a real server SIGKILL triggers watchdog to terminate provider descendants', {
  skip: process.platform==='win32',timeout:25000,
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ace-m4-orphan-'));
  const marker=join(dir,'started'),sentinel=join(dir,'orphan-output');
  const server=spawn(process.execPath,['--import','tsx','tests/fixtures/m4-orphan-parent.ts'],{
    cwd:process.cwd(),env:{...process.env,ACE_ORPHAN_MARKER:marker,ACE_ORPHAN_SENTINEL:sentinel},
    stdio:['ignore','pipe','pipe'],
  });
  let errors='';server.stderr.on('data',(x:Buffer)=>errors+=x.toString());
  try {
    let exists=false;
    for(let i=0;i<250;i++){try{await readFile(marker);exists=true;break;}catch{await delay(20);}}
    assert.ok(exists,'Provider did not start: '+errors.slice(0,400));
    // Give the independent process-group guardian time to start and bind its pipe.
    await delay(350);
    server.kill('SIGKILL');
    await new Promise<void>(resolve=>{if(server.exitCode!==null||server.signalCode!==null)resolve();
      else server.once('exit',()=>resolve());});
    await delay(2250);
    await assert.rejects(readFile(sentinel,'utf8'),{code:'ENOENT'});
  } finally {if(server.exitCode===null)server.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
});
