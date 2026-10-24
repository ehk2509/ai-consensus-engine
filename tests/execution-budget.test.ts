import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest,
  executionCallLimit, executionDurationLimitMs, isUnlimitedExecutionBudget } from '../packages/core/src/debate.ts';
import type { ProviderId, AgentAdapter } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude', 'gemini'];
const idea = 'Review the engineering and commercial feasibility of an AI software platform.';
const base = { prompt: idea, providers, maxRounds: 3, consensus: true, negotiationCycles: 1 };
const adapters = new Map<string, AgentAdapter>(providers.map(id => [id, {
  id, propose: async (prompt: string) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({objections:[]});
    if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({responses:[]});
    if (prompt.includes('Stage: CONSENSUS DRAFT'))
      return JSON.stringify({proposal:'Original evidence-aware pilot strategy with measurable gates.', assumptions:[],evidence:[]});
    if (prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION'))
      return JSON.stringify({proposal:'An improved operational pilot design by '+id,tradeoffs:[],addressedObjectionIds:[]});
    if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS'))
      return JSON.stringify({proposal:'Revised consensus decision with a pilot, governance controls and clear implementation gates.',assumptions:[],evidence:[]});
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      const accept = prompt.includes('Revised consensus decision');
      return JSON.stringify({verdict:accept?'accept':'conditional',rationale:'Evidence and constraints assessed.',
        concerns:accept?[]:['Business validation needs more support.'],resolvedObjectionIds:[],supersessions:[]});
    }
    return 'An actionable independent assessment with detailed implementation and validation milestones.';
  },
}]));
async function execute(values:Record<string,unknown>) {
  const session=createDebateSession(validateDebateRequest({...base,...values}));
  await executeDebate(session,adapters,async()=>{});
  return session;
}
test('new requests and created sessions default to unlimited calls and wall-clock time',async()=>{
  const request=validateDebateRequest({...base, maxRounds:1});
  assert.equal(request.unlimitedBudget,true);
  assert.equal(request.maxCalls,undefined);
  assert.equal(request.maxDurationMs,undefined);
  assert.equal(executionCallLimit(request),Infinity);
  assert.equal(executionDurationLimitMs(request),undefined);
  const session=createDebateSession(request);
  assert.equal(session.request.unlimitedBudget,true);
  assert.equal(session.executionDeadlineAt,undefined);
  assert.equal(isUnlimitedExecutionBudget(session.request),true);
});
test('unlimited budget completes more than 40 provider calls and M5 re-voting',async()=>{
  const session=await execute({unlimitedBudget:true});
  assert.equal(session.status,'completed');
  assert.equal(session.calls,50);
  assert.equal(session.consensus?.status,'unanimous');
  assert.equal(session.consensus?.negotiationHistory?.length,1);
  assert.equal(session.consensus?.votes.length,3);
  assert.equal(session.executionDeadlineAt,undefined);
  assert.equal(session.request.maxCalls,undefined);
  assert.equal(session.request.maxDurationMs,undefined);
});
test('turning unlimited off permits custom call and time caps larger than previous presets',async()=>{
  const req=validateDebateRequest({...base,unlimitedBudget:false,maxCalls:80,maxDurationMs:3600000});
  assert.equal(executionCallLimit(req),80);
  assert.equal(executionDurationLimitMs(req),3600000);
  const session=createDebateSession(req);
  assert.equal(session.request.unlimitedBudget,false);
  assert.equal(session.request.maxCalls,80);
  assert.equal(session.request.maxDurationMs,3600000);
  const done=await execute({...req});
  assert.equal(done.consensus?.status,'unanimous');
  assert.ok(done.executionDeadlineAt);
  assert.equal(done.calls,50);
});
test('legacy explicit budgets remain capped, including one-field callers',()=>{
  const a=validateDebateRequest({...base,maxCalls:17});
  assert.equal(a.unlimitedBudget,false);
  assert.equal(a.maxCalls,17);
  assert.equal(a.maxDurationMs,900000);
  const b=validateDebateRequest({...base,maxDurationMs:300000});
  assert.equal(b.unlimitedBudget,false);
  assert.equal(b.maxCalls,40);
  assert.equal(b.maxDurationMs,300000);
  assert.equal(isUnlimitedExecutionBudget(createDebateSession(a).request),false);
});
test('unlimited mode rejects contradictory finite limits and nonboolean flags',()=>{
  for(const values of [
    {unlimitedBudget:'true'},{unlimitedBudget:1},
    {unlimitedBudget:true,maxCalls:40},{unlimitedBudget:true,maxDurationMs:900000},
    {unlimitedBudget:false,maxCalls:10001},{unlimitedBudget:false,maxDurationMs:604800001},
    {unlimitedBudget:false,maxCalls:3.5},{unlimitedBudget:false,maxDurationMs:NaN},
  ])assert.throws(()=>validateDebateRequest({...base,...values}));
});
test('a small finite call budget still stops deterministically without false consensus',async()=>{
  const session=await execute({unlimitedBudget:false,maxCalls:4,maxDurationMs:600000});
  assert.equal(session.calls,4);
  assert.equal(session.status,'budget_exhausted');
  assert.ok(session.entries.some(e=>e.status==='skipped'));
  assert.notEqual(session.consensus?.status,'unanimous');
  assert.ok(session.executionDeadlineAt);
});
