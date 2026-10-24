import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import { packObjections } from '../packages/core/src/objection-utils.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude', 'gemini'];
function request(overrides: Record<string, unknown> = {}) {
  return validateDebateRequest({ prompt: 'Evaluate an evidence-led problem discovery platform for startup validation.',
    providers, maxRounds: 2, consensus: true, maxCalls: 40, ...overrides });
}
function adapters(fn: (id: ProviderId, prompt: string) => string) {
  return new Map<string, AgentAdapter>(providers.map(id => [id, { id, propose: async (prompt: string) => fn(id, prompt) }]));
}
const draft = JSON.stringify({ proposal: 'A complete draft with evidence checks, a source permission register, opt-in research participants and explicit release gates.', assumptions: [], evidence: [] });
function objections(count: number, critical: number) {
  return JSON.stringify({ strengths: ['Well-scoped validation experiment'], objections:
    Array.from({ length: count }, (_, i) => ({
      claim: 'Specific failure hypothesis ' + i + ' ' + 'C'.repeat(130),
      criticism: 'Requires verification before marking this product risk resolved. ' + 'R'.repeat(280),
      severity: i < critical ? 'high' : 'medium', evidence: [], suggestedChange: 'Test against the stated acceptance gate',
    })) });
}
function sharedJson(prompt: string): string | null {
  return /<shared_objections_excerpted>\n([\s\S]+?)\n<\/shared_objections_excerpted>/.exec(prompt)?.[1] ?? null;
}
test('synthesis and every independent ballot see identical complete objection coverage, not author-only subsets', async () => {
  const session = createDebateSession(request());
  const contexts: Array<{ phase: string; provider: ProviderId; value: string }> = [];
  await executeDebate(session, adapters((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return objections(8, 3);
    if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
    const context = sharedJson(prompt);
    if (context) contexts.push({ phase: prompt.includes('CONSENSUS DRAFT') ? 'draft' : 'vote', provider: id, value: context });
    if (prompt.includes('Stage: CONSENSUS DRAFT')) return draft;
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({ verdict: 'conditional',
      rationale: 'There are substantive research concerns remaining.', concerns: ['Need further evidence before accepting.'],
      resolvedObjectionIds: [], supersessions: [] });
    return 'Substantive revision with source governance and explicit validation.';
  }), async () => {});
  assert.equal(session.objections.length, 96);
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(contexts.filter(v => v.phase === 'draft').length, 1);
  assert.equal(contexts.filter(v => v.phase === 'vote').length, 3);
  const all = contexts[0]!.value;
  assert.ok(contexts.every(v => v.value === all));
  const ids = new Set((JSON.parse(all) as Array<{ id: string }>).map(v => v.id));
  const critical = session.objections.filter(o => o.severity === 'high');
  assert.equal(critical.length, 36);
  assert.ok(critical.every(o => ids.has(o.id)));
  assert.equal(session.consensus?.contextOmittedCriticalIds?.length, 0);
  assert.equal(session.consensus?.objectionCoverage?.omittedCritical, 0);
  assert.match(session.consensus?.reportMarkdown ?? '', /Shared objection coverage/);
  assert.match(session.consensus?.reportMarkdown ?? '', /Shared context SHA-256/);
  assert.equal(session.consensus?.status, 'disputed');
});

test('large critical objection ledger is passed in full to synthesis and all ballots', async () => {
  const session = createDebateSession(request({ maxRounds: 1 }));
  let consensusCalls = 0;
  await executeDebate(session, adapters((_id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return objections(32, 32);
    if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
    if (prompt.includes('Stage: CONSENSUS DRAFT')) { consensusCalls++; return draft; }
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      consensusCalls++;
      return JSON.stringify({ verdict: 'accept', rationale: 'Still requires critical author signoff.',
        concerns: [], resolvedObjectionIds: [], supersessions: [] });
    }
    return 'Candidate proposal';
  }), async () => {});
  assert.equal(session.objections.length, 192);
  assert.equal(session.consensus?.contextOmittedCriticalIds?.length, 0);
  assert.equal(session.consensus?.objectionCoverage?.included, 192);
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(consensusCalls, 4);
  assert.equal(session.consensus?.status, 'blocked');
});
test('the original author can sign off fixed objections without falsely accepting the whole draft', async () => {
  const session = createDebateSession(request({ maxRounds: 1 }));
  await executeDebate(session, adapters((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return objections(1, 1);
    if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
    if (prompt.includes('Stage: CONSENSUS DRAFT')) return draft;
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
      const own = session.objections.filter(o => o.author === id);
      return JSON.stringify({ verdict: 'conditional', rationale: 'The revised draft fixes this one point but unresolved questions remain.',
        concerns: ['Still need operational evidence.'], resolvedObjectionIds: own.slice(0, 1).map(o => o.id), supersessions: [] });
    }
    return 'Revised proposal with explicit validation gates';
  }), async () => {});
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(session.objections.filter(o => o.authorStatus === 'confirmed_resolved').length, 3);
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 3);
});
test('lossless packing retains every parser-failure record despite old size hint', () => {
  const objs = Array.from({ length: 48 }, (_, i) => ({
    id: String(i).padStart(36, '0'), round: 2, author: providers[i % 3]!, target: providers[(i + 1) % 3]!,
    severity: i < 30 ? 'high' as const : 'medium' as const,
    kind: i === 0 ? 'parsing_failure' as const : 'substantive' as const,
    authorStatus: i === 0 ? 'confirmed_resolved' as const : 'open' as const,
    claim: 'Source concern ' + 'A'.repeat(700), criticism: 'Evidence not verified ' + 'B'.repeat(2500),
    resolution: 'unresolved' as const, evidence: [],
  }));
  const compact = packObjections(objs, 24000);
  const included = JSON.parse(compact.text) as Array<{id:string}>;
  assert.equal(new Set([...compact.includedIds, ...compact.omittedIds]).size, 48);
  assert.ok(included.some(o => o.id === objs[0]!.id));
  assert.equal(compact.omittedCriticalIds.includes(objs[0]!.id), false);
  assert.ok(compact.text.length > 24000);
  assert.equal(included.length, 48);
  assert.equal(compact.omittedIds.length, 0);
});
