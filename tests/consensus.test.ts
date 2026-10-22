import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import { chooseFacilitator } from '../packages/core/src/consensus.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
const idea = 'Evaluate an autonomous AI startup studio with a repeatable revenue model';
function request(overrides: Record<string, unknown> = {}) {
  return validateDebateRequest({ prompt: idea, providers: ids, maxRounds: 1, maxCalls: 23,
    consensus: true, quorum: 'unanimous', blockCritical: true, ...overrides });
}
function agents(fn: (id: ProviderId, prompt: string) => string | Promise<string>): Map<string, AgentAdapter> {
  return new Map(ids.map((id) => [id, { id, propose: (prompt) => Promise.resolve(fn(id, prompt)) }]));
}
function answer(id: ProviderId, prompt: string, options: {
  vote?: (id: ProviderId, prompt: string) => unknown;
  objection?: boolean;
} = {}) {
  if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({
    objections: options.objection ? [{ claim: 'Speculative revenue assumption', criticism: 'Needs data',
      severity: 'high', evidence: ['No customers yet'] }] : [],
  });
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({
    proposal: 'An actionable synthesized startup strategy with milestones and risk tests.',
    assumptions: ['Target users will be reachable'],
    evidence: [{ claim: 'Reported addressable market estimate', source: 'Unverified founder estimate' }],
  });
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
    return JSON.stringify(options.vote ? options.vote(id, prompt) : {
      verdict: 'accept', rationale: 'The draft is appropriately specific.', concerns: [],
      resolvedObjectionIds: [], supersessions: [],
    });
  }
  return 'Structured independent response from ' + id;
}
async function evaluate(
  opts: Record<string, unknown> = {},
  answerOpts: { vote?: (id: ProviderId, prompt: string) => unknown; objection?: boolean } = {},
) {
  const session = createDebateSession(request(opts));
  const snapshots: number[] = [];
  await executeDebate(session, agents((id, prompt) => answer(id, prompt, answerOpts)),
    async (value) => { snapshots.push(value.events.length); });
  return { session, snapshots };
}

test('three accepted votes produce unanimous outcome with evidence clearly unverified', async () => {
  const { session, snapshots } = await evaluate();
  assert.equal(session.status, 'completed');
  assert.equal(session.calls, 19); // M2 15 + facilitator draft 1 + 3 independent ballots.
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(session.consensus?.votes.filter((v) => v.verdict === 'accept').length, 3);
  assert.equal(session.consensus?.draft?.evidence[0]?.verification, 'unverified');
  assert.match(session.consensus?.reportMarkdown ?? '', /not independently verified/);
  assert.match(session.consensus?.reportMarkdown ?? '', /Independent votes/);
  assert.ok(snapshots.length > 15);
  assert.deepEqual(session.events.map((e) => e.sequence), session.events.map((_, i) => i + 1));
});

test('unanimity requires all accepts; qualified majority requires non-author endorsements', async () => {
  const vote = (id: ProviderId) => ({
    verdict: id === 'gemini' ? 'conditional' : 'accept',
    rationale: 'Independent judgment',
    concerns: id === 'gemini' ? ['Privacy unresolved'] : [],
    resolvedObjectionIds: [], supersessions: [],
  });
  const unanimous = (await evaluate({}, { vote })).session;
  assert.equal(unanimous.consensus?.status, 'disputed');
  const majority = createDebateSession(request({ quorum: 'two_thirds' }));
  const author = chooseFacilitator(majority);
  const majorityVote = (id: ProviderId) => ({
    verdict: id === author ? 'conditional' : 'accept',
    rationale: 'Independent judgment', concerns: id === author ? ['Follow-up recommended'] : [],
    resolvedObjectionIds: [], supersessions: [],
  });
  await executeDebate(majority, agents((id, prompt) => answer(id, prompt, { vote: majorityVote })), async () => {});
  assert.equal(majority.consensus?.status, 'qualified');
  assert.match(majority.consensus?.reportMarkdown ?? '', /conditional/i);
});

test('critical objections block a unanimous vote unless their authors explicitly sign off', async () => {
  const blocked = (await evaluate({}, { objection: true })).session;
  assert.equal(blocked.consensus?.status, 'blocked');
  assert.equal(blocked.consensus?.blockingObjectionIds.length, 6);
  const signed = (await evaluate({}, { objection: true, vote: (_id, prompt) => ({
    verdict: 'accept', rationale: 'The draft now resolves my issues', concerns: [],
    resolvedObjectionIds: [...prompt.matchAll(/"id":"([0-9a-f-]{36})"/g)].map(m => m[1]), supersessions: [],
  }) })).session;
  assert.equal(signed.consensus?.status, 'unanimous');
  assert.equal(signed.consensus?.blockingObjectionIds.length, 0);
});

test('non-author objection IDs are ignored and cannot defeat the critical gate', async () => {
  const session = (await evaluate({}, { objection: true, vote: (_id, prompt) => ({
    verdict: 'accept', rationale: 'Looks good', concerns: [],
    resolvedObjectionIds: [...prompt.matchAll(/"id":"([0-9a-f-]{36})"/g)].map(m => m[1]).concat('unrecognized-id'), supersessions: [],
  }) })).session;
  assert.ok(session.consensus?.votes.every((v) => v.resolvedObjectionIds.every((id) =>
    session.objections.some((o) => o.id === id && o.author === v.provider))));
});

test('missing or malformed vote is not silently treated as abstention or acceptance', async () => {
  const session = (await evaluate({}, { vote: (id) => id === 'gemini'
    ? { verdict: 'accept' }
    : { verdict: 'accept', rationale: 'Works', concerns: [], resolvedObjectionIds: [], supersessions: [] } })).session;
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.votes.find((v) => v.provider === 'gemini')?.status, 'rejected');
});

test('insufficient call budget skips voting without consuming model calls or reporting agreement', async () => {
  const session = (await evaluate({ maxCalls: 15 })).session;
  assert.equal(session.status, 'completed');
  assert.equal(session.consensus?.status, 'not_assessed');
  assert.equal(session.consensus?.votes.length, 0);
  assert.equal(session.calls, 15);
});

test('invalid structured facilitator response prevents ballots', async () => {
  const session = createDebateSession(request());
  await executeDebate(session, agents((id, prompt) => prompt.includes('Stage: CONSENSUS DRAFT')
    ? 'A Markdown paragraph, not the requested object'
    : answer(id, prompt)), async () => {});
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.votes.length, 0);
  assert.equal(session.calls, 16);
});

test('legacy M2 requests retain no-vote semantics unless consensus is explicitly enabled', async () => {
  const session = createDebateSession(validateDebateRequest({ prompt: idea, providers: ids, maxRounds: 1 }));
  await executeDebate(session, agents((id, prompt) => answer(id, prompt)), async () => {});
  assert.equal(session.consensus, undefined);
  assert.equal(session.calls, 15);
});

test('reject invalid consensus configuration', () => {
  for (const override of [{ consensus: 'yes' }, { quorum: 'majority' }, { blockCritical: 'no' }]) {
    assert.throws(() => request(override));
  }
});
