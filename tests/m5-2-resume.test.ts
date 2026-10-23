import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
const sleep = (n: number) => new Promise(done => setTimeout(done,n));
async function completed(app: ReturnType<typeof makeApp>, id: string): Promise<DebateSession> {
  for(let n=0;n<180;n++) {
    const response=await app.inject('/api/debates/'+id);
    const data=response.json() as DebateSession;
    if(!['queued','running'].includes(data.status)) return data;
    await sleep(15);
  }
  throw new Error('Recovery did not complete');
}
const request = (negotiationCycles: 0|1 = 0) => validateDebateRequest({
  prompt: 'Review a bootstrap startup business and its compliant source-reuse policy.',
  providers: ids, maxRounds: 1, maxCalls: 40, maxDurationMs: 120000,
  consensus: true, negotiationCycles,
});
const respond = (id: ProviderId, prompt: string): string => {
  if(prompt.includes('Stage: CRITIQUE')) return JSON.stringify({objections:[]});
  if(prompt.includes('Stage: REBUTTAL')) return JSON.stringify({responses:[]});
  if(prompt.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({
    proposal: 'Initial proposal for a small and compliant founder validation pilot.',
    assumptions:[],evidence:[],
  });
  if(prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION')) return JSON.stringify({
    proposal:'A targeted measurable and auditable revised plan from '+id,
    tradeoffs:[],addressedObjectionIds:[],
  });
  if(prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) return JSON.stringify({
    proposal:'Revised negotiated proposal with measurable risk gates and permission checks.',
    assumptions:[],evidence:[],
  });
  if(prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({
    verdict:prompt.includes('Revised negotiated proposal')?'accept':'conditional',
    rationale:'Reviewed the frozen proposal and can describe its outcome.',
    concerns:prompt.includes('Revised negotiated proposal')?[]:['A validation step is required.'],
    resolvedObjectionIds:[],supersessions:[],
  });
  return 'An independent plan with concrete product milestones by '+id;
};
function adapters(fn: (id: ProviderId,prompt:string)=>Promise<string>|string) {
  return new Map<string,AgentAdapter>(ids.map(id=>[id,{id,propose:async (prompt)=>fn(id,prompt)}]));
}
async function baseline(fn: (id: ProviderId,prompt:string)=>Promise<string>|string, cycles:0|1=0,
  signal?:AbortSignal):Promise<DebateSession> {
  const session=createDebateSession(request(cycles));
  await executeDebate(session,adapters(fn),async()=>{},signal);
  return session;
}
async function withServer(session:DebateSession,fn:(id:ProviderId,prompt:string)=>Promise<string>|string,
  run:(app:ReturnType<typeof makeApp>,store:DebateStore)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'ace-m52-'));
  const store=new DebateStore(dir);await store.save(session);
  const app=makeApp({allowUnauthenticatedForTests:true,store:new DebateStore(dir),adapters:adapters(fn)});
  try {await app.inject('/api/health');await run(app,store);}
  finally{await app.close();await rm(dir,{force:true,recursive:true});}
}
test('M5.2 explicitly retries failed final revision in a partial debate, retaining successful peer work',async()=>{
  const session=await baseline((id,prompt)=>{
    if(id==='claude'&&prompt.includes('Stage: REVISE')) throw new Error('Known CLI failure');
    return respond(id,prompt);
  });
  assert.equal(session.status,'partial');
  assert.equal(session.consensus?.status,'not_assessed');
  const failed=session.entries.find(e=>e.phase==='revision'&&e.provider==='claude')!;
  assert.equal(failed.status,'rejected');
  const previousIds=new Set(session.entries.filter(e=>e.status==='fulfilled').map(e=>e.id));
  let revisionCalls=0,proposalCalls=0;
  await withServer(session,(id,prompt)=>{
    if(prompt.includes('Stage: REVISE')) revisionCalls++;
    if(prompt.includes('Stage: INDEPENDENT PROPOSAL')) proposalCalls++;
    return respond(id,prompt);
  },async(app)=>{
    const noAuth=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',
      payload:{retryCallIds:[failed.id]}});
    assert.equal(noAuth.statusCode,409);
    const allow=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',
      payload:{retryCallIds:[failed.id],acknowledgeMayRepeatCall:true}});
    assert.equal(allow.statusCode,202);
    const done=await completed(app,session.id);
    assert.equal(done.status,'completed');
    assert.equal(done.consensus?.status,'disputed');
    assert.equal(done.recovery?.kind,'debate');
    assert.equal(revisionCalls,1);
    assert.equal(proposalCalls,0);
    assert.ok([...previousIds].every(id=>done.entries.some(e=>e.id===id&&e.status==='fulfilled')));
    assert.ok(done.entries.some(e=>e.id===failed.id&&e.retryAuthorized));
  });
});
test('M5.2 resumes incomplete consensus voting, preserving valid ballots and exact synthesis hash',async()=>{
  const session=await baseline((id,prompt)=>{
    if(id==='claude' && prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) throw new Error('Known vote failure');
    return prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')
      ? JSON.stringify({verdict:'accept',rationale:'Pilot is ready for testing.',concerns:[],
        resolvedObjectionIds:[],supersessions:[]})
      : respond(id,prompt);
  });
  assert.equal(session.status,'completed');
  assert.equal(session.consensus?.status,'incomplete');
  const sha=session.consensus!.draft!.sha256;
  const retry=session.consensus!.callJournal!.find(c=>c.stage==='vote'&&c.provider==='claude')!;
  assert.equal(retry.status,'rejected');
  let synthesisCalls=0,voteCalls=0;
  await withServer(session,(id,prompt)=>{
    if(prompt.includes('Stage: CONSENSUS DRAFT')) synthesisCalls++;
    if(prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) voteCalls++;
    return prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')
      ? JSON.stringify({verdict:'accept',rationale:'Pilot is ready for testing.',concerns:[],
        resolvedObjectionIds:[],supersessions:[]})
      : respond(id,prompt);
  },async(app)=>{
    const noAuth=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(noAuth.statusCode,409);
    assert.ok(noAuth.json().uncertainCallIds.includes(retry.id));
    assert.equal(voteCalls,0);
    // A finished incomplete vote must be explicitly re-authorized.
    const resumed=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',
      payload:{retryCallIds:[retry.id],acknowledgeMayRepeatCall:true}});
    assert.equal(resumed.statusCode,202);
    const done=await completed(app,session.id);
    assert.equal(done.consensus?.status,'unanimous');
    assert.equal(done.consensus?.draft?.sha256,sha);
    assert.equal(voteCalls,1);
    assert.equal(synthesisCalls,0);
    assert.ok(done.consensus?.votes.every(v=>v.status==='fulfilled'));
  });
});
test('M5.2 requires exact authorization to resume an interrupted M5 targeted revision',async()=>{
  const controller=new AbortController();
  const session=await baseline((id,prompt)=>{
    if(id==='claude'&&prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION'))controller.abort();
    return respond(id,prompt);
  },1,controller.signal);
  assert.equal(session.status,'cancelled');
  assert.equal(session.consensus?.status,'incomplete');
  const old= session.consensus?.negotiationHistory?.[0];
  assert.equal(old?.outcome,'interrupted');
  const retry=session.consensus?.negotiationCalls?.find(x=>x.provider==='claude'&&x.role==='targeted_revision');
  assert.equal(retry?.status,'rejected');
  let codexRevision=0,claudeRevision=0;
  await withServer(session,(id,prompt)=>{
    if(prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION')){
      if(id==='codex')codexRevision++;
      if(id==='claude')claudeRevision++;
    }
    return respond(id,prompt);
  },async(app)=>{
    const conflict=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(conflict.statusCode,409);
    const result=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',
      payload:{retryCallIds:[retry!.id],acknowledgeMayRepeatCall:true}});
    assert.equal(result.statusCode,202);
    const done=await completed(app,session.id);
    assert.equal(done.consensus?.status,'unanimous');
    assert.equal(done.consensus?.negotiationHistory?.length,1);
    assert.equal(done.consensus?.negotiationHistory?.[0]?.outcome,'completed');
    assert.equal(codexRevision,0);
    assert.equal(claudeRevision,1);
    assert.ok(done.consensus?.negotiationCalls?.some(x=>x.id===retry?.id&&x.retryAuthorized));
  });
});
test('M5.2 refuses legacy unjournaled consensus and an expired original deadline',async()=>{
  const session=createDebateSession(request());
  session.status='interrupted';session.debateStatus='completed';
  session.executionDeadlineAt=new Date(Date.now()+90000).toISOString();
  session.consensus={status:'voting',policy:{quorum:'unanimous',blockCritical:true},
    draft:{author:'codex',proposal:'Old unjournaled draft',assumptions:[],evidence:[],sha256:'legacy'},
    votes:[],unresolvedCriticalObjectionIds:[],blockingObjectionIds:[]};
  await withServer(session,respond,async(app)=>{
    const resp=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(resp.statusCode,409);assert.match(resp.json().error,/legacy|journal/i);
  });
  session.executionDeadlineAt=new Date(Date.now()-1000).toISOString();
  await withServer(session,respond,async(app)=>{
    const resp=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(resp.statusCode,409);assert.match(resp.json().error,/deadline/i);
  });
});

test('M5.2 replays a persisted full ballot RESPONSE without a second provider call after cold restart',async()=>{
  const session=await baseline((id,prompt)=>prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')
    ? JSON.stringify({verdict:'accept',rationale:'Pilot fits the evidence gates.',concerns:[],
        resolvedObjectionIds:[],supersessions:[]})
    : respond(id,prompt));
  assert.equal(session.consensus?.status,'unanimous');
  const priorCalls=session.calls;
  const expectedHash=session.consensus!.draft!.sha256;
  const priorClaude=session.consensus!.callJournal!.find(c=>c.stage==='vote'&&c.provider==='claude');
  assert.equal(priorClaude?.status,'fulfilled');
  // Crash boundary: provider output is durably committed, but the parsed vote
  // and terminal report have not been saved yet.
  session.consensus!.votes=session.consensus!.votes.filter(v=>v.provider!=='claude');
  session.consensus!.status='voting';
  session.status='running';
  session.finishedAt=undefined;
  let providerCalls=0;
  await withServer(session,(_id,prompt)=>{providerCalls++;return respond(_id,prompt);},async(app,store)=>{
    const current=(await app.inject('/api/debates/'+session.id)).json() as DebateSession;
    assert.equal(current.status,'interrupted');
    assert.equal(providerCalls,0);
    const accepted=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(accepted.statusCode,202);
    const done=await completed(app,session.id);
    assert.equal(done.consensus?.status,'unanimous');
    assert.equal(done.consensus?.draft?.sha256,expectedHash);
    assert.equal(done.calls,priorCalls);
    assert.equal(providerCalls,0);
    assert.equal(done.consensus?.votes.length,3);
    assert.equal((await store.getPersisted(session.id))?.consensus?.status,'unanimous');
  });
});
test('M5.2 refuses to restart a cold-restart issued ballot until its exact ID is authorized',async()=>{
  const session=await baseline((id,prompt)=>prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')
    ? JSON.stringify({verdict:'accept',rationale:'Pilot fits the evidence gates.',concerns:[],
        resolvedObjectionIds:[],supersessions:[]})
    : respond(id,prompt));
  const prior=session.calls;
  const vote=session.consensus!.callJournal!.find(c=>c.stage==='vote'&&c.provider==='claude')!;
  vote.status='issued';
  vote.rawResponse=undefined;
  session.consensus!.votes=session.consensus!.votes.filter(v=>v.provider!=='claude');
  session.consensus!.status='voting';
  session.status='running';
  session.finishedAt=undefined;
  let providerCalls=0;
  await withServer(session,(id,prompt)=>{
    providerCalls++;
    return prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')
      ? JSON.stringify({verdict:'accept',rationale:'Pilot fits the evidence gates.',concerns:[],
          resolvedObjectionIds:[],supersessions:[]}) : respond(id,prompt);
  },async(app)=>{
    await app.inject('/api/health');
    assert.equal(providerCalls,0);
    assert.equal((await app.inject('/api/debates/'+session.id)).json().status,'interrupted');
    const blocked=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',payload:{}});
    assert.equal(blocked.statusCode,409);
    assert.deepEqual(blocked.json().uncertainCallIds,[vote.id]);
    assert.equal(providerCalls,0);
    const accepted=await app.inject({method:'POST',url:'/api/debates/'+session.id+'/resume',
      payload:{retryCallIds:[vote.id],acknowledgeMayRepeatCall:true}});
    assert.equal(accepted.statusCode,202);
    const done=await completed(app,session.id);
    assert.equal(done.consensus?.status,'unanimous');
    assert.equal(done.calls,prior+1);
    assert.equal(providerCalls,1);
    assert.ok(done.consensus?.callJournal?.some(c=>c.id===vote.id&&c.retryAuthorized));
  });
});
