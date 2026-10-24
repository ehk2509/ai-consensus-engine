import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import { chooseFacilitator } from '../packages/core/src/consensus.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude', 'gemini'];
const brief = 'A complete SEO/GEO optimizer pilot with approved publishing and measurable research gates.';
const longDraft = 'A very long draft that must never be cut. ' + 'research evidence and tradeoffs '.repeat(800);
const request = (extra: Record<string, unknown> = {}) => validateDebateRequest({
  prompt: 'Review a practical, evidence-grounded SEO and GEO optimization service',
  providers, consensus: true, maxRounds: 1, negotiationCycles: 0,
  unlimitedBudget: true, ...extra,
});
const response = (id: ProviderId, prompt: string): string => {
  if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({ proposal: brief, assumptions: [], evidence: [] });
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({
    verdict: 'accept', rationale: 'The bounded draft is complete and evidence claims are labeled.',
    concerns: [], resolvedObjectionIds: [], supersessions: [],
  });
  return 'A complete but concise and independently reviewed product plan by ' + id;
};
const agents = (fn: (id: ProviderId, prompt: string) => string) =>
  new Map<string, AgentAdapter>(providers.map(id => [id, { id, propose: async prompt => fn(id, prompt) }]));

test('long structured synthesis is preserved uncut and voted on with the complete SHA-bound draft', async () => {
  assert.ok(longDraft.length > 18000);
  const session = createDebateSession(request());
  const first = chooseFacilitator(session);
  let voteCalls = 0;
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: CONSENSUS DRAFT') && id === first)
      return JSON.stringify({ proposal: longDraft, assumptions: [], evidence: [] });
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) voteCalls++;
    return response(id, prompt);
  }), async () => {});
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.draft?.author, first);
  assert.equal(session.consensus?.draft?.proposal, longDraft);
  assert.equal(voteCalls, 3);
  const calls = session.consensus?.callJournal?.filter(c => c.stage === 'synthesis') ?? [];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, 'fulfilled');
  assert.equal(JSON.parse(calls[0]!.rawResponse!).proposal, longDraft);
  assert.ok(!session.consensus?.draft?.proposal.includes('[Context truncated]'));
});

test('an upstream truncation marker inside a well-formed JSON draft cannot be approved', async () => {
  const session = createDebateSession(request());
  const first = chooseFacilitator(session);
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: CONSENSUS DRAFT') && id === first)
      return JSON.stringify({ proposal: 'Research findings...\n[Context truncated]', assumptions: [], evidence: [] });
    return response(id, prompt);
  }), async () => {});
  assert.equal(session.consensus?.status, 'unanimous');
  assert.notEqual(session.consensus?.draft?.author, first);
  assert.equal(session.consensus?.callJournal?.[0]?.status, 'rejected');
});

test('all valid lengthy synthesis outputs are accepted without hiding any tail', async () => {
  const session = createDebateSession(request());
  let votes = 0;
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: CONSENSUS DRAFT'))
      return JSON.stringify({ proposal: longDraft, assumptions: [], evidence: [] });
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) votes++;
    return response(id, prompt);
  }), async () => {});
  assert.equal(session.consensus?.status, 'unanimous');
  assert.equal(session.consensus?.draft?.proposal, longDraft);
  assert.equal(votes, 3);
  assert.equal(session.consensus?.callJournal?.filter(x => x.stage === 'synthesis' && x.status === 'fulfilled').length, 1);
});

test('even if the model omits the objection table, the decision report indexes every original ID', async () => {
  const session = createDebateSession(request());
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [
      { claim: 'Missing evidence of consumer API equivalence', criticism: 'Provider benchmarks do not represent consumer products.', severity: 'high' },
      { claim: 'Unclear source provenance', criticism: 'Evidence must remain auditable.', severity: 'medium' },
    ] });
    return response(id, prompt);
  }), async () => {});
  assert.equal(session.objections.length, 12);
  const report = session.consensus?.reportMarkdown ?? '';
  assert.match(report, /Complete objection register \(deterministic audit\)/);
  const index = report.split('## Complete objection register (deterministic audit)')[1]!.split('## Objection grouping')[0]!;
  for (const o of session.objections) {
    assert.ok(index.includes(o.id), 'missing objection ID ' + o.id);
  }
  assert.match(report, /Requested negotiation cycles: 0; attempted: 0/);
  assert.ok(!session.consensus?.draft?.proposal.includes('Missing evidence of consumer API equivalence'));
});

test('long negotiated targeted revision is retained in full for downstream synthesis', async () => {
  const session = createDebateSession(request({ negotiationCycles: 1 }));
  let revisedDraftCalls = 0;
  await executeDebate(session, agents((id, prompt) => {
    if (prompt.includes('Stage: M5 TARGETED NEGOTIATION REVISION'))
      return JSON.stringify({ proposal: longDraft, tradeoffs: [], addressedObjectionIds: [] });
    if (prompt.includes('Stage: M5 NEGOTIATED SYNTHESIS')) revisedDraftCalls++;
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE'))
      return JSON.stringify({ verdict: 'conditional', rationale: 'The initial proposal is incomplete.',
        concerns: ['Need further testing'], resolvedObjectionIds: [], supersessions: [] });
    return response(id, prompt);
  }), async () => {});
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(revisedDraftCalls, 3);
  assert.equal(session.consensus?.negotiationHistory?.[0]?.outcome, 'failed');
  assert.equal(session.consensus?.negotiationCalls?.find(x => x.role === 'targeted_revision')?.status, 'fulfilled');
  assert.ok(session.consensus?.negotiationHistory?.[0]?.revisions.every(x => x.proposal === longDraft));
});
