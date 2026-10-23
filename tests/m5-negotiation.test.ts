import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude', 'gemini'];
const draft = (proposal: string) => JSON.stringify({ proposal, assumptions: [], evidence: [] });
const vote = (verdict: 'accept' | 'conditional' | 'reject', resolvedObjectionIds: string[] = []) => JSON.stringify({
  verdict, rationale: verdict === 'accept' ? 'The implementation concerns are addressed.' : 'The current implementation needs specific additional evidence.',
  concerns: verdict === 'accept' ? [] : ['The design still needs evidence for its implementation choices.'],
  resolvedObjectionIds, supersessions: [],
});
const configured = (changes: Record<string, unknown> = {}) => validateDebateRequest({
  prompt: 'Review a plausible evidence-led SaaS discovery product with accountable evidence gates.',
  providers, maxRounds: 1, consensus: true, negotiationCycles: 1, maxCalls: 40, ...changes,
});
async function scenario(fn: (id: ProviderId, prompt: string, session: DebateSession) => string,
  changes: Record<string, unknown> = {}) {
  const session = createDebateSession(configured(changes));
  const calls: Array<{ provider: ProviderId; prompt: string }> = [];
  const adapters = new Map<string, AgentAdapter>(providers.map(id => [id, {
    id, propose: async (prompt: string) => {
      calls.push({ provider: id, prompt });
      return fn(id, prompt, session);
    },
  }]));
  await executeDebate(session, adapters, async () => {});
  return { session, calls };
}
function simple(id: ProviderId, prompt: string): string {
  if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return draft('Initial frozen decision proposal with a workable pilot and necessary governance controls.');
  if (prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION')) return JSON.stringify({
    proposal: 'A targeted, actionable revision by ' + id + ' with stronger validation gates and measurable operational tradeoffs.',
    tradeoffs: ['Implementation cost remains measurable'], addressedObjectionIds: [],
  });
  if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) return draft(
    'The revised shared decision includes precise operational evidence gates, a measurable pilot, privacy controls and documented tradeoffs.');
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE'))
    return vote(prompt.includes('revised shared decision') ? 'accept' : 'conditional');
  return 'An actionable independent proposal or revision from ' + id;
}
test('M5 re-synthesizes after targeted independent revisions and freezes a NEW SHA for fresh ballots', async () => {
  const { session, calls } = await scenario(simple);
  assert.equal(session.status, 'completed');
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.calls, 26);
  assert.equal(session.consensus?.negotiationHistory?.length, 1);
  const cycle = session.consensus!.negotiationHistory![0]!;
  assert.equal(cycle.outcome, 'completed');
  assert.equal(cycle.revisions.length, 3);
  assert.equal(cycle.revisions.filter(x => x.status === 'fulfilled').length, 3);
  assert.notEqual(cycle.originalDraftSha256, cycle.revisedDraftSha256);
  assert.deepEqual(cycle.previousVotes.map(v => v.verdict), ['conditional', 'conditional', 'conditional']);
  assert.equal(session.consensus?.votes.length, 3);
  assert.ok(session.consensus!.votes.every(v => v.verdict === 'accept' && v.draftSha256 === cycle.revisedDraftSha256));
  assert.equal(cycle.newVotes?.length, 3);
  assert.equal(session.consensus?.negotiationCalls?.length, 7);
  assert.ok(session.consensus!.negotiationCalls!.every(x => x.status === 'fulfilled'));
  assert.ok(session.consensus?.reportMarkdown?.includes('Negotiation history (M5)'));
  const firstRevision = calls.findIndex(c => c.prompt.includes('M5 TARGETED NEGOTIATION REVISION'));
  const synthesis = calls.findIndex(c => c.prompt.includes('M5 NEGOTIATED SYNTHESIS'));
  assert.ok(firstRevision > 0 && synthesis > firstRevision);
  assert.equal(calls.filter(x => x.prompt.includes('M5 TARGETED NEGOTIATION REVISION')).length, 3);
  assert.equal(calls.filter(x => x.prompt.includes('M5 NEGOTIATED SYNTHESIS')).length, 1);
});

test('M5 cannot treat a changed draft as objection resolution without each original author signing off', async () => {
  const { session } = await scenario((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [{
      claim: 'Permission risk', criticism: 'Commercial data reuse requires source-specific permission.', severity: 'high',
    }] });
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return vote('accept');
    return simple(id, prompt);
  });
  // Even unanimous NEW ballots are not sufficient until critical objections are
  // acknowledged by their original authors.
  assert.equal(session.consensus?.negotiationHistory?.length, 1);
  assert.equal(session.consensus?.votes.filter(v => v.verdict === 'accept').length, 3);
  assert.equal(session.consensus?.status, 'blocked');
  assert.ok((session.consensus?.unresolvedCriticalObjectionIds.length ?? 0) > 0);
});

test('M5 sign-off on the re-vote closes only authored substantive IDs and preserves the vote hash', async () => {
  const { session } = await scenario((id, prompt, debate) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [{
      claim: 'Insufficient operational evidence', criticism: 'The plan has no defined measurement and success gates.', severity: 'high',
    }] });
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      if (prompt.includes('revised shared decision')) {
        return vote('accept', debate.objections.filter(o => o.author === id).map(o => o.id));
      }
      return vote('conditional');
    }
    return simple(id, prompt);
  });
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 0);
  assert.ok(session.objections.every(o => o.authorStatus === 'confirmed_resolved'));
  assert.notEqual(session.consensus?.draft?.sha256, session.consensus?.negotiationHistory?.[0]?.originalDraftSha256);
});

test('M5 skips a complete cycle if the call budget cannot pay for 3 revisions + synthesis + 3 votes', async () => {
  const { session, calls } = await scenario(simple, { maxCalls: 22 });
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.calls, 19);
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'skipped');
  assert.match(session.consensus?.negotiationHistory?.[0]?.reason ?? '', /Insufficient budget/);
  assert.equal(calls.filter(c => c.prompt.includes('M5 TARGETED')).length, 0);
  assert.equal(session.consensus?.votes.length, 3);
});

test('A failed targeted revision retains previous frozen draft and ballots without re-voting', async () => {
  const { session } = await scenario((id, prompt) => {
    if (prompt.includes('M5 TARGETED NEGOTIATION REVISION') && id === 'claude')
      return '{"proposal":';
    return simple(id, prompt);
  });
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'failed');
  assert.equal(session.consensus?.negotiationHistory?.[0]?.newVotes, undefined);
  assert.equal(session.consensus?.draft?.sha256, session.consensus?.negotiationHistory?.[0]?.originalDraftSha256);
  assert.equal(session.consensus?.votes.length, 3);
  assert.ok(session.consensus?.votes.every(x => x.verdict === 'conditional'));
});

test('A failed new ballot never borrows the prior vote and cannot infer quorum', async () => {
  const { session } = await scenario((id, prompt) => {
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE') &&
        prompt.includes('revised shared decision') && id === 'codex') return 'invalid ballot format';
    return simple(id, prompt);
  });
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(session.consensus?.votes.find(v => v.provider === 'codex')?.status, 'rejected');
  assert.ok(session.consensus?.negotiationHistory?.[0]?.previousVotes.every(v => v.verdict === 'conditional'));
});

test('M5 never negotiates parser-integrity blockers or omitted critical objection context', async () => {
  const { session, calls } = await scenario((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE') && id === 'codex') return '{"objections":[{"claim":"unfinished';
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return vote('accept');
    return simple(id, prompt);
  });
  assert.equal(session.consensus?.status, 'blocked_by_unparseable_evidence');
  assert.equal(session.consensus?.negotiationHistory, undefined);
  assert.equal(calls.filter(x => x.prompt.includes('M5 TARGETED')).length, 0);
});

test('M5 may run two cycles when explicitly permitted and remaining budget allows', async () => {
  let generation = 0;
  const { session } = await scenario((id, prompt) => {
    if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) {
      generation++;
      return draft('Revised shared decision generation ' + generation + ' preserves the validation gates and specific constraints.');
    }
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE'))
      return vote(prompt.includes('generation 2') ? 'accept' : 'conditional');
    return simple(id, prompt);
  }, { negotiationCycles: 2 });
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.negotiationHistory?.length, 2);
  assert.ok(session.consensus?.negotiationHistory?.every(x => x.outcome === 'completed'));
  assert.equal(session.calls, 33);
  assert.equal(session.consensus?.negotiationCalls?.length, 14);
  assert.equal(new Set(session.consensus?.negotiationHistory?.map(x => x.revisedDraftSha256)).size, 2);
});

test('M5 is opt-in and its parameter is strictly bounded', async () => {
  const old = await scenario(simple, { negotiationCycles: 0 });
  assert.equal(old.session.consensus?.status, 'disputed');
  assert.equal(old.session.consensus?.negotiationHistory, undefined);
  assert.equal(old.session.calls, 19);
  for (const negotiationCycles of [-1, 3, 1.5, '1', null]) {
    assert.throws(() => configured({ negotiationCycles }), /negotiationCycles/);
  }
});
