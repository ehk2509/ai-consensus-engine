import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCritique } from '../packages/core/src/objection-utils.ts';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const issue = { claim: 'Require a complete audit', criticism: 'The source verification gate is not defined', severity: 'high' };
const full = JSON.stringify({ strengths: ['A clear methodology'], objections: [issue] });
const fence = String.fromCharCode(96).repeat(3);
test('complete JSON remains trusted and does not create a false parser blocker', () => {
  const result = decodeCritique(full);
  assert.equal(result.status, 'complete');
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.unparseable, false);
});

test('fenced JSON and valid JSON wrapped in prose recover a complete object without inventing missing evidence', () => {
  for (const raw of [fence + 'json\n' + full + '\n' + fence, 'Model review follows:\n' + full + '\nThat is the review.']) {
    const parsed = decodeCritique(raw);
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.unparseable, false);
    assert.deepEqual(parsed.errors, []);
  }
  assert.equal(decodeCritique(fence + 'json\n' + full + '\n' + fence).status, 'complete');
  assert.equal(decodeCritique('Review:\n' + full + '\nDone.').status, 'embedded_json');
});

test('complete objections are recovered individually from a partially emitted JSON array', () => {
  const incomplete = '{"strengths":["clear plan"],"objections":[' +
    JSON.stringify(issue) + ',{"claim":"Recruit five to eight founders or venture resear';
  const result = decodeCritique(incomplete);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.unparseable, true);
  assert.deepEqual(result.records.map(x => x.claim), [issue.claim]);
  assert.match(result.errors[0] ?? '', /ended before/i);
});

test('a mid-claim cutoff with no complete objection fails closed instead of fabricating a criticism', () => {
  const incomplete = '{"strengths":["Clear epistemic separation of supplied premises"],"objections":[{"claim":"Recruit five to eight founders or venture resear';
  const result = decodeCritique(incomplete);
  assert.deepEqual(result.records, []);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.unparseable, true);
  assert.equal(result.errors.length, 1);
});

test('malformed recovered records are rejected, preserving valid complete objections', () => {
  const raw = '{"objections":[{"claim":"Missing criticism"},' + JSON.stringify(issue) + ',{"claim":"unfinished';
  const result = decodeCritique(raw);
  assert.deepEqual(result.records.map(x => x.claim), [issue.claim]);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.errors.some(x => x.includes('malformed structured objection')));
});

test('stored critique diagnostics link to the full uncut original response', async () => {
  const long = '{"strengths":[' + JSON.stringify('A'.repeat(1200)) +
    '],"objections":[{"claim":"Recruit five to eight founders or venture resear';
  const providers: ProviderId[] = ['codex', 'claude'];
  const request = validateDebateRequest({ prompt: 'Assess evidence-based startup opportunities', providers, maxRounds: 1,
    consensus: false, maxCalls: 20 });
  const session = createDebateSession(request);
  const adapters = new Map<string, AgentAdapter>(providers.map(id => [id, {
    id,
    propose: async (prompt: string) => {
      if (prompt.includes('Stage: CRITIQUE')) return id === 'codex' ? long : JSON.stringify({ objections: [] });
      if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
      return 'Concrete proposal text';
    },
  }]));
  await executeDebate(session, adapters, async () => {});
  const critique = session.entries.find(e => e.phase === 'critique' && e.provider === 'codex');
  assert.equal(critique?.status, 'fulfilled');
  assert.deepEqual(critique?.critiqueParsing, { status: 'incomplete', originalChars: long.length, recoveredObjections: 0 });
  const failure = session.objections.find(o => o.sourceEntryId === critique?.id && o.kind === 'parsing_failure');
  assert.ok(failure);
  assert.equal(critique?.content, long);
  assert.match(failure.criticism, /Full provider response \(unparsed and not validated as a critique\)/);
  assert.ok(failure.criticism.includes(long));
  assert.doesNotMatch(failure.criticism, /Truncated for context or display/);
  assert.equal(session.objections.some(o => o.kind === 'substantive' && o.author === 'codex'), false);
});
