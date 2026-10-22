import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import { chooseFacilitator } from '../packages/core/src/consensus.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
const base = { prompt: 'Assess an AI developer startup and validate its legal and security risks',
  providers: ids, maxRounds: 1, consensus: true, quorum: 'unanimous', maxCalls: 40, blockCritical: true } as const;
type Responder = (id: ProviderId, prompt: string) => string | Promise<string>;
function agents(respond: Responder): Map<string, AgentAdapter> {
  return new Map(ids.map(id => [id, { id, propose: (prompt) => Promise.resolve(respond(id, prompt)) }]));
}
function voteResponse(verdict: 'accept' | 'conditional' | 'reject' = 'accept', overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    verdict, rationale: 'The detailed draft has been reviewed', concerns: [], resolvedObjectionIds: [], supersessions: [], ...overrides,
  });
}
const draft = JSON.stringify({ proposal: 'Ship a small pilot with strict privacy controls and testable gates.',
  assumptions: ['A valid pilot market exists'], evidence: [{ claim: 'Market size estimation' }] });
function standard(id: ProviderId, prompt: string): string {
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return draft;
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return voteResponse();
  if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  return 'Detailed proposal by ' + id;
}
async function run(overrides: Record<string, unknown> = {}, custom: Responder = standard) {
  const session = createDebateSession(validateDebateRequest({ ...base, ...overrides }));
  await executeDebate(session, agents(custom), async () => {});
  return session;
}
function authoredCritiques(_id: ProviderId, prompt: string): string {
  if (prompt.includes('Stage: CRITIQUE')) {
    if (prompt.includes('round 1')) return JSON.stringify({ objections: [{
      claim: 'Missing access control', criticism: 'Permissions are not established', severity: 'high', evidence: [],
    }] });
    return JSON.stringify({ objections: [] });
  }
  return standard(_id, prompt);
}

test('a high-severity objection in round 1 remains blocking after round 2 omits it', async () => {
  const session = await run({ maxRounds: 2 }, authoredCritiques);
  assert.equal(session.status, 'completed');
  assert.equal(session.debateStatus, 'completed');
  assert.equal(session.consensus?.status, 'blocked');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 6);
  assert.equal(session.objections.filter(o => o.round === 1).length, 6);
  assert.ok(session.consensus?.reportMarkdown?.includes('round 1'));
});

test('the original author can confirm a round-1 objection resolved in the final accepted ballot', async () => {
  const session = await run({ maxRounds: 2 }, (id, prompt) => {
    if (prompt.includes('INDEPENDENT CONSENSUS VOTE')) {
      const m = prompt.match(/<your_objections_across_all_rounds>\n([\s\S]*?)\n<\/your_objections_across_all_rounds>/);
      const own = JSON.parse(m?.[1] ?? '[]') as Array<{ id: string }>;
      return voteResponse('accept', { resolvedObjectionIds: own.map(o => o.id) });
    }
    return authoredCritiques(id, prompt);
  });
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 0);
  assert.ok(session.objections.every(o => o.authorStatus === 'confirmed_resolved'));
});

test('supersession needs original-author signoff and references a newer objection', async () => {
  const session = await run({ maxRounds: 2 }, (id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [{
      claim: 'Privacy threat', criticism: 'Privacy review required', severity: 'high',
    }] });
    if (prompt.includes('INDEPENDENT CONSENSUS VOTE')) {
      const m = prompt.match(/<your_objections_across_all_rounds>\n([\s\S]*?)\n<\/your_objections_across_all_rounds>/);
      const own = JSON.parse(m?.[1] ?? '[]') as Array<{ id: string; round: number }>;
      const old = own.filter(o => o.round === 1);
      const newer = own.filter(o => o.round === 2);
      return voteResponse('accept', {
        resolvedObjectionIds: newer.map(o => o.id),
        supersessions: old.map((o, index) => ({
          oldObjectionId: o.id, newObjectionId: newer[index % newer.length]!.id, reason: 'The later critique replaces the older one',
        })),
      });
    }
    return standard(id, prompt);
  });
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 0);
  assert.ok(session.objections.filter(o => o.round === 1).every(o => o.authorStatus === 'superseded' && o.supersededBy));
});

test('malformed nonempty objection arrays are never silently interpreted as no concerns', async () => {
  const session = await run({}, (id, prompt) =>
    prompt.includes('Stage: CRITIQUE') ? JSON.stringify({ objections: [{ claim: 'Security issue' }] }) : standard(id, prompt));
  assert.equal(session.consensus?.status, 'blocked_by_unparseable_evidence');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 6);
  assert.ok(session.objections.every(o => o.severity === 'unspecified' && o.claim.includes('Malformed')));
});

test('accept with explicit blocking concerns becomes invalid, not unanimous', async () => {
  const session = await run({}, (id, prompt) => prompt.includes('INDEPENDENT CONSENSUS VOTE')
    ? voteResponse('accept', { concerns: ['Security architecture is still unacceptable'] }) : standard(id, prompt));
  assert.equal(session.consensus?.status, 'incomplete');
  assert.ok(session.consensus?.votes.every(v => v.status === 'rejected' && v.rawResponse?.includes('Security architecture')));
  assert.match(session.consensus?.reportMarkdown ?? '', /incomplete/i);
});

test('missing or malformed arrays yield invalid votes, with raw responses retained', async () => {
  const session = await run({}, (id, prompt) => prompt.includes('INDEPENDENT CONSENSUS VOTE')
    ? JSON.stringify({ verdict: 'accept', rationale: 'Fine', concerns: 'none', resolvedObjectionIds: [], supersessions: [] })
    : standard(id, prompt));
  assert.equal(session.consensus?.status, 'incomplete');
  assert.ok(session.consensus?.votes.every(v => v.status === 'rejected' && v.rawResponse?.includes('none')));
});

test('turning off the critical gate preserves unresolved objections without labeling them blockers', async () => {
  const session = await run({ blockCritical: false }, authoredCritiques);
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.blockingObjectionIds.length, 0);
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 6);
  assert.match(session.consensus?.reportMarkdown ?? '', /disabled \(open objections remain recorded/);
});

test('the facilitator self-vote cannot substitute for non-author support', async () => {
  const source = createDebateSession(validateDebateRequest({ ...base, quorum: 'two_thirds' }));
  const author = chooseFacilitator(source);
  const other = ids.filter(id => id !== author);
  await executeDebate(source, agents((id, prompt) =>
    prompt.includes('INDEPENDENT CONSENSUS VOTE') ?
      voteResponse(other[1] === id ? 'conditional' : 'accept', {
        concerns: other[1] === id ? ['Needs privacy changes'] : [],
      }) : standard(id, prompt)), async () => {});
  assert.equal(source.consensus?.status, 'disputed');
  assert.equal(source.consensus?.votes.find(v => v.provider === author)?.authoredDraft, true);
  const qualified = createDebateSession(validateDebateRequest({ ...base, quorum: 'two_thirds' }));
  const writer = chooseFacilitator(qualified);
  await executeDebate(qualified, agents((id, prompt) => prompt.includes('INDEPENDENT CONSENSUS VOTE')
    ? voteResponse(writer === id ? 'conditional' : 'accept', { concerns: writer === id ? ['Could be more ambitious'] : [] })
    : standard(id, prompt)), async () => {});
  assert.equal(qualified.consensus?.status, 'qualified');
});

test('consensus and debate outcomes are distinct and ballots have traceable frozen draft hashes', async () => {
  const session = await run();
  assert.equal(session.debateStatus, 'completed');
  assert.equal(session.status, 'completed');
  assert.equal(session.consensus?.status, 'unanimous');
  const draftHash = session.consensus?.draft?.sha256;
  assert.match(draftHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(session.consensus?.votes.every(v => v.draftSha256 === draftHash &&
    v.provenance?.model === 'unreported' && /^[a-f0-9]{64}$/.test(v.provenance.promptSha256)));
  assert.ok(session.consensus?.votes.every(v => v.rawResponse?.includes('"verdict"')));
});

test('failed draft, exhausted budget and interrupted vote all produce decision reports', async () => {
  const noBudget = await run({ maxCalls: 15 });
  assert.equal(noBudget.consensus?.status, 'not_assessed');
  assert.match(noBudget.consensus?.reportMarkdown ?? '', /not assessed/i);
  const invalidDraft = await run({}, (id, prompt) =>
    prompt.includes('Stage: CONSENSUS DRAFT') ? 'invalid draft' : standard(id, prompt));
  assert.equal(invalidDraft.consensus?.status, 'incomplete');
  assert.match(invalidDraft.consensus?.reportMarkdown ?? '', /No valid synthesis draft/);
  const controller = new AbortController();
  const interrupted = createDebateSession(validateDebateRequest({ ...base }));
  await executeDebate(interrupted, agents((id, prompt) => {
    if (prompt.includes('INDEPENDENT CONSENSUS VOTE')) controller.abort();
    return standard(id, prompt);
  }), async () => {}, controller.signal);
  assert.equal(interrupted.status, 'cancelled');
  assert.equal(interrupted.debateStatus, 'completed');
  assert.equal(interrupted.consensus?.status, 'incomplete');
  assert.match(interrupted.consensus?.reportMarkdown ?? '', /Voting interrupted|incomplete/i);
});

test('transient persistence failure during the vote still produces an incomplete decision record', async () => {
  const session = createDebateSession(validateDebateRequest({ ...base }));
  let once = false;
  await executeDebate(session, agents(standard), async value => {
    if (value.phase === 'vote' && value.consensus?.status === 'voting' && !once) {
      once = true;
      throw new Error('simulated transient disk write failure');
    }
  });
  assert.equal(once, true);
  assert.equal(session.debateStatus, 'completed');
  assert.equal(session.consensus?.status, 'incomplete');
  assert.match(session.consensus?.reportMarkdown ?? '', /incomplete/i);
});

test('cancelling during M2 produces a recorded, downloadable-eligible M3 incomplete report without extra calls', async () => {
  const controller = new AbortController();
  const session = createDebateSession(validateDebateRequest({ ...base }));
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: INDEPENDENT PROPOSAL')) controller.abort();
    return standard(id, prompt);
  }), async () => {}, controller.signal);
  assert.equal(session.status, 'cancelled');
  assert.equal(session.consensus?.status, 'incomplete');
  assert.ok(session.consensus?.reportMarkdown?.includes('cancelled or timed out'));
  assert.equal(session.consensus?.votes.length, 0);
  assert.ok(session.calls <= 3);
});
