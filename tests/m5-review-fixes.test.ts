import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude', 'gemini'];
const makeRequest = (extra: Record<string, unknown> = {}) => validateDebateRequest({
  prompt: 'Choose an auditable data-source policy and paid founder research pilot',
  providers, maxRounds: 1, consensus: true, negotiationCycles: 1,
  maxCalls: 40, maxDurationMs: 120000, ...extra,
});
const ballot = (kind: 'accept'|'conditional'|'reject', resolvedObjectionIds: string[] = []) =>
  JSON.stringify({ verdict: kind, rationale: 'Evaluated the complete frozen draft against the objections.',
    concerns: kind === 'accept' ? [] : ['More evidence is needed before a product launch.'],
    resolvedObjectionIds, supersessions: [] });
const critique = JSON.stringify({ objections: [{
  claim: 'Permissions for commercial source content are missing',
  criticism: 'The pilot must verify explicit commercial reuse rights for each forum.',
  severity: 'high', suggestedChange: 'Add a permission register.',
}] });
const validDraft = (text: string) => JSON.stringify({ proposal: text, assumptions: [], evidence: [] });
const oldDraft = 'The original plan uses a permission register and a founder interview pilot.';
const newDraft = 'The negotiated proposal revises rollout scope and changes permissions strategy.';
async function run(fn: (id: ProviderId, prompt: string, session: DebateSession, controller: AbortController) => string,
  options: Record<string, unknown> = {}) {
  const session = createDebateSession(makeRequest(options));
  const controller = new AbortController();
  const calls: Array<{provider: ProviderId; prompt: string}> = [];
  const adapters = new Map<string, AgentAdapter>(providers.map(id => [id, {
    id, propose: async (prompt: string) => {
      calls.push({provider:id,prompt});
      return fn(id,prompt,session,controller);
    },
  }]));
  await executeDebate(session, adapters, async () => {}, controller.signal);
  return { session, calls };
}
function reply(id: ProviderId, prompt: string): string {
  if (prompt.includes('Stage: CRITIQUE')) return critique;
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({responses: []});
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return validDraft(oldDraft);
  if (prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION'))
    return JSON.stringify({proposal: 'Targeted ' + id + ' revision addresses specific source governance defects.',
      tradeoffs: [],addressedObjectionIds: []});
  if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) return validDraft(newDraft);
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE'))
    return ballot('conditional');
  return 'A detailed, implementable independent proposal from '+id;
}
const currentVote = (prompt: string) =>
  prompt.includes('<frozen_synthesis_draft>\n' + newDraft) ||
  prompt.includes('<frozen_synthesis_draft>\n' + newDraft.slice(0, 12));

test('P0: sign-offs for Draft A are reopened for Draft B even with fresh accepting votes', async () => {
  const {session} = await run((id,prompt,debate) => {
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      return currentVote(prompt) ? ballot('accept') :
        ballot('conditional', debate.objections.filter(o => o.author === id).map(o => o.id));
    }
    if (prompt.includes('Stage: FINAL OBJECTION RESOLUTION')) return '{"decisions":[]}';
    return reply(id,prompt);
  });
  const consensus = session.consensus!;
  assert.equal(consensus.negotiationHistory?.length, 1);
  assert.equal(consensus.status, 'blocked');
  const originalHash = consensus.negotiationHistory![0]!.originalDraftSha256;
  const revisedHash = consensus.negotiationHistory![0]!.revisedDraftSha256!;
  assert.notEqual(originalHash, revisedHash);
  assert.equal(session.objections.length, 6);
  assert.ok(session.objections.every(o => o.authorStatus === 'open'));
  assert.ok(session.objections.every(o => o.authorResolutionDraftSha256 === undefined));
  assert.ok(session.objections.every(o => o.authorSignoffs?.some(s => s.draftSha256 === originalHash)));
  assert.equal(consensus.unresolvedCriticalObjectionIds.length, 6);
  assert.ok(consensus.votes.every(v => v.verdict === 'accept' && v.draftSha256 === revisedHash));
});

test('P0: explicit author re-confirmation signs only the revised hash and preserves previous sign-off history', async () => {
  const {session} = await run((id,prompt,debate) => {
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return ballot(
      currentVote(prompt) ? 'accept' : 'conditional',
      debate.objections.filter(o => o.author === id).map(o => o.id));
    return reply(id,prompt);
  });
  const c = session.consensus!;
  assert.equal(c.status, 'unanimous');
  const originalHash = c.negotiationHistory![0]!.originalDraftSha256;
  const revisedHash = c.draft!.sha256!;
  assert.ok(session.objections.every(o => o.authorStatus === 'confirmed_resolved'));
  assert.ok(session.objections.every(o => o.authorResolutionDraftSha256 === revisedHash));
  assert.ok(session.objections.every(o => o.authorSignoffs?.some(x => x.draftSha256 === originalHash)));
  assert.ok(session.objections.every(o => o.authorSignoffs?.some(x => x.draftSha256 === revisedHash)));
});

test('P0: changing evidence or assumptions without changing proposal text still invalidates earlier author sign-offs', async () => {
  const votesByProvider = new Map<ProviderId, number>();
  const {session,calls} = await run((id,prompt,debate) => {
    if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) {
      return JSON.stringify({proposal:oldDraft,
        assumptions:['A newly added assumption must be validated'],
        evidence:[{claim:'The pilot costs are unknown'}]});
    }
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      const number = (votesByProvider.get(id) ?? 0) + 1;
      votesByProvider.set(id, number);
      return ballot('conditional', number === 1 ? debate.objections.filter(o=>o.author===id).map(o=>o.id) : []);
    }
    return reply(id,prompt);
  });
  const cycle = session.consensus!.negotiationHistory![0]!;
  assert.equal(cycle.outcome,'completed');
  assert.notEqual(cycle.originalDraftSha256,cycle.revisedDraftSha256);
  assert.equal(session.consensus?.draft?.proposal,oldDraft);
  assert.equal(calls.filter(c=>c.prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')).length,6);
  assert.ok(session.objections.every(o=>o.authorStatus==='open'));
  assert.ok(session.objections.every(o=>o.authorSignoffs?.some(x=>x.draftSha256===cycle.originalDraftSha256)));
});

test('P1: partial fresh ballot set does not sign off ANY objections, and cycle is partial', async () => {
  const {session} = await run((id,prompt,debate) => {
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE') && currentVote(prompt)) {
      if (id === 'codex') return 'broken re-vote JSON';
      return ballot('accept', debate.objections.filter(o => o.author === id).map(o => o.id));
    }
    return reply(id,prompt);
  });
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'partial');
  assert.equal(session.consensus?.votes.filter(v => v.status === 'rejected').length, 1);
  assert.ok(session.objections.every(o => o.authorStatus === 'open'));
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 6);
});

for (const stage of ['targeted', 'synthesis', 're-vote'] as const) {
  test('P1: cancellation during ' + stage + ' is marked interrupted, never as prior successful verdict', async () => {
    const {session} = await run((id,prompt,_debate,controller) => {
      if ((stage === 'targeted' && prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION')) ||
          (stage === 'synthesis' && prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) ||
          (stage === 're-vote' && prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE') && currentVote(prompt))) {
        controller.abort();
      }
      return reply(id,prompt);
    });
    const cycle = session.consensus?.negotiationHistory?.[0];
    assert.equal(cycle?.outcome, 'interrupted');
    assert.equal(session.consensus?.status, 'incomplete');
    assert.match(session.consensus?.reason ?? '', /interrupt|cancel|deadline/i);
    assert.ok(cycle?.previousVotes.every(v => v.verdict === 'conditional'));
    assert.equal(session.status, 'cancelled');
  });
}

test('P1: a deadline exceeded during targeted revision becomes interrupted, not a restored old verdict', async () => {
  const actualClock = Date.now;
  try {
    const {session} = await run((id,prompt) => {
      if (prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION')) {
        Date.now = () => actualClock() + 180000;
      }
      return reply(id,prompt);
    });
    assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'interrupted');
    assert.equal(session.consensus?.status, 'incomplete');
    assert.match(session.consensus?.reason ?? '', /interrupt|deadline/i);
    assert.ok(session.consensus?.negotiationHistory?.[0]?.previousVotes.every(v => v.verdict === 'conditional'));
  } finally {
    Date.now = actualClock;
  }
});

test('P1: preserve budget for required author sign-offs and bounded clarifications', async () => {
  const {session,calls} = await run(reply, {maxCalls: 29});
  assert.equal(session.calls, 19);
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'skipped');
  assert.match(session.consensus?.negotiationHistory?.[0]?.reason ?? '', /confirmations/);
  assert.equal(calls.filter(c => c.prompt.includes('M5 TARGETED')).length, 0);
});

test('P1: budget reserves author reconfirmation for objections already signed on Draft A', async () => {
  const {session,calls} = await run((id,prompt,debate) => {
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      return ballot('conditional', debate.objections.filter(o => o.author === id).map(o => o.id));
    }
    return reply(id,prompt);
  }, {maxCalls: 29});
  assert.equal(session.calls,19);
  assert.equal(session.consensus?.status,'disputed');
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome,'skipped');
  assert.match(session.consensus?.negotiationHistory?.[0]?.reason ?? '',/confirmations/);
  assert.ok(session.objections.every(o => o.authorStatus === 'confirmed_resolved'));
  assert.equal(calls.filter(c => c.prompt.includes('Stage: M5 TARGETED')).length,0);
});

test('P2: a contradictory new accept ballot receives one journaled, independent clarification', async () => {
  const {session,calls} = await run((id,prompt) => {
    if (prompt.includes('Stage: CONSENSUS CLARIFICATION')) {
      return ballot('conditional'); // a clarification never has to force acceptance
    }
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE') && currentVote(prompt)) {
      return JSON.stringify({verdict:'accept',rationale:'Cannot verify this requirement yet.',
        concerns:[],resolvedObjectionIds:[],supersessions:[]});
    }
    return reply(id,prompt);
  });
  const c=session.consensus!;
  assert.equal(c.negotiationHistory?.[0]?.outcome, 'completed');
  assert.equal(c.status, 'disputed');
  assert.equal(c.negotiationHistory?.[0]?.newVotes?.length, 3);
  assert.ok(c.votes.every(v => v.status === 'fulfilled' && v.verdict === 'conditional'));
  assert.equal(c.negotiationCalls?.filter(x=>x.role==='clarification').length,3);
  assert.ok(c.negotiationCalls?.filter(x=>x.role==='clarification').every(x=>x.status==='fulfilled'));
  assert.equal(calls.filter(c=>c.prompt.includes('Stage: CONSENSUS CLARIFICATION')).length,3);
  assert.equal(session.calls,29);
});

test('P2: per-provider negotiation prompts rank unresolved critical IDs without merging ledger records', async () => {
  const {session,calls} = await run(reply);
  const prompts=calls.filter(c=>c.prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION'));
  assert.equal(prompts.length,3);
  for(const {provider,prompt} of prompts) {
    const m=/<priority_action_plan>\n([^\n]+)\n<\/priority_action_plan>/.exec(prompt);
    assert.ok(m);
    const priorities=JSON.parse(m[1]!) as Array<{id:string,ownedByYou:boolean,severity:string}>;
    assert.ok(priorities.length>0);
    assert.ok(priorities.every(p=>p.severity==='high'));
    assert.equal(priorities[0]?.ownedByYou, true);
    assert.ok(priorities.some(p=>session.objections.find(o=>o.id===p.id)?.author===provider));
  }
});
