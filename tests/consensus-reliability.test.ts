import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCritique, packObjections } from '../packages/core/src/objection-utils.ts';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
const request = (x: Record<string, unknown> = {}) => validateDebateRequest({
  prompt: 'Review a fully autonomous IT startup factory including security and economic risk',
  providers: ids, maxRounds: 1, consensus: true, maxCalls: 40, ...x,
});
const mk = (fn: (id: ProviderId, prompt: string) => string | Promise<string>) =>
  new Map<string, AgentAdapter>(ids.map(id => [id, { id, propose: p => Promise.resolve(fn(id, p)) }]));
const proposal = 'A concrete versioned startup-studio proposal including secure execution and human oversight';
const response = (id: ProviderId, prompt: string): string => {
  if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
  if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  if (prompt.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({ proposal, assumptions: [], evidence: [] });
  if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({
    verdict: 'accept', rationale: 'The proposal resolves the concerns.', concerns: [], resolvedObjectionIds: [], supersessions: [],
  });
  return 'A concrete first proposal from ' + id;
};
async function run(fn: (id: ProviderId, prompt: string) => string, overrides: Record<string, unknown> = {}) {
  const session = createDebateSession(request(overrides));
  await executeDebate(session, mk(fn), async () => {});
  return session;
}

test('large structured critique and all stored evidence remain complete', async () => {
  let firstLength = 0;
  const debate = await run((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) {
      const payload = JSON.stringify({ objections: Array.from({ length: 8 }, (_, i) => ({
        claim: 'Concern ' + i + ' ' + 'x'.repeat(2500),
        criticism: 'Missing evidence for claim ' + i + ' ' + 'y'.repeat(1800),
        severity: 'high', evidence: [],
      })) });
      firstLength = Math.max(firstLength, payload.length);
      return payload;
    }
    return response(id, prompt);
  }, { consensus: false });
  assert.ok(firstLength > 25000);
  assert.equal(debate.objections.length, 48);
  assert.equal(new Set(debate.objections.map(x => x.id)).size, 48);
  assert.ok(debate.objections.every(x => x.kind === 'substantive' && x.sourceEntryId));
  assert.ok(debate.entries.filter(x => x.phase === 'critique').every(x => (x.content?.length ?? 0) === firstLength));
  assert.ok(debate.objections.every(x => x.claim.length > 2500 && x.criticism.length > 1800));
});

test('partial malformed JSON salvages complete objects plus a separate parsing failure', () => {
  const first = { claim: 'Audit auth policy', criticism: 'Missing tenant boundaries', severity: 'high', evidence: [] };
  const second = { claim: 'Check billing', criticism: 'Webhook validation absent', severity: 'high', evidence: [] };
  const raw = '{"strengths":[],"objections":[' + JSON.stringify(first) + ',' + JSON.stringify(second) + ',{"claim":"truncated';
  const parsed = decodeCritique(raw);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.unparseable, true);
  assert.deepEqual(decodeCritique('{"objections":[]}').errors, []);
});

test('full objection packing retains every record and character regardless of old size hint', () => {
  const all = Array.from({ length: 30 }, (_, i) => ({
    id: String(i).padStart(36, 'a'), author: ids[i % 3]!, target: ids[(i + 1) % 3]!,
    round: i % 2 + 1, claim: 'C'.repeat(600), criticism: 'X'.repeat(850),
    severity: (i >= 15 ? 'high' : 'low') as 'high' | 'low', resolution: 'unresolved' as const,
    evidence: [], authorStatus: 'open' as const,
  }));
  const packed = packObjections(all, 1600);
  const parsed = JSON.parse(packed.text) as Array<{ id: string; severity: string }>;
  assert.equal(parsed.length, all.length);
  assert.ok(packed.text.includes('X'.repeat(850)));
  assert.equal(new Set([...packed.includedIds, ...packed.omittedIds]).size, all.length);
  assert.equal(packed.omittedCriticalIds.length, 0);
  assert.equal(packed.omittedIds.length, 0);
});

test('final author resolution clears substantive objections after accepted ballots', async () => {
  let resolutionCalls = 0;
  const session = await run((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({
      objections: [{ claim: 'Need stable access control', criticism: 'Auth policies require review', severity: 'high' }],
    });
    if (prompt.includes('Stage: FINAL OBJECTION RESOLUTION')) {
      resolutionCalls++;
      const json = /<authored_open_objections>\n([^]*?)\n<\/authored_open_objections>/.exec(prompt)?.[1] ?? '[]';
      const objections = JSON.parse(json) as Array<{ id: string }>;
      return JSON.stringify({ decisions: objections.map(o => ({
        objectionId: o.id, resolved: true, reason: 'The frozen draft explicitly assigns human approval and a security review.',
      })) });
    }
    return response(id, prompt);
  });
  assert.equal(resolutionCalls, 3);
  assert.equal(session.calls, 22);
  assert.equal(session.consensus?.status, 'unanimous');
  assert.ok(session.objections.every(o => o.authorStatus === 'confirmed_resolved'));
  assert.equal(session.consensus?.resolutionAttempts?.length, 3);
  assert.match(session.consensus?.reportMarkdown ?? '', /Resolution attempts: 3/);
});

test('unparseable critiques remain distinguishable blockers despite 3 accepted votes', async () => {
  const session = await run((id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE') && id === 'codex') return '{"objections":[{"claim":"unreadable';
    if (prompt.includes('Stage: FINAL OBJECTION RESOLUTION')) throw new Error('should not clear parsing failures');
    return response(id, prompt);
  });
  assert.equal(session.consensus?.votes.filter(v => v.verdict === 'accept').length, 3);
  assert.equal(session.consensus?.status, 'blocked_by_unparseable_evidence');
  assert.ok(session.objections.some(o => o.kind === 'parsing_failure'));
  assert.match(session.consensus?.reportMarkdown ?? '', /Unparseable evidence failures/);
  assert.equal(session.calls, 19);
});

test('contradictory acceptance requires a separately logged clarification call', async () => {
  let clarified = 0;
  const session = await run((id, prompt) => {
    if (prompt.includes('Stage: CONSENSUS CLARIFICATION')) {
      clarified++;
      return JSON.stringify({ verdict: 'conditional', rationale: 'I cannot confirm the quoted concern', concerns: ['Requires human validation'],
        resolvedObjectionIds: [], supersessions: [] });
    }
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE') && id === 'codex')
      return JSON.stringify({ verdict: 'accept', rationale: 'I cannot confirm resolution of the truncated objection in full.',
        concerns: [], resolvedObjectionIds: [], supersessions: [] });
    return response(id, prompt);
  });
  assert.equal(clarified, 1);
  assert.equal(session.consensus?.clarificationAttempts?.length, 1);
  assert.equal(session.calls, 20);
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.consensus?.votes.find(v => v.provider === 'codex')?.verdict, 'conditional');
});

test('resolution cannot exceed call budget; missing signoff stays blocked', async () => {
  const session = await run((id, prompt) => prompt.includes('Stage: CRITIQUE')
    ? JSON.stringify({ objections: [{ claim: 'Need security proof', criticism: 'Security tests are absent', severity: 'high' }] })
    : response(id, prompt), { maxCalls: 19 });
  assert.equal(session.calls, 19);
  assert.equal(session.consensus?.status, 'blocked');
  assert.equal(session.consensus?.resolutionAttempts?.length, 0);
});

test('large critical evidence is not omitted and unresolved objections still block acceptance', async () => {
  const session = await run((id, prompt) => prompt.includes('Stage: CRITIQUE')
    ? JSON.stringify({ objections: Array.from({ length: 32 }, (_, i) => ({
      claim: 'Unresolved critical risk ' + i,
      criticism: 'The claim has no tested empirical foundation; this issue must be resolved explicitly ' + 'Z'.repeat(300),
      severity: 'high',
    })) })
    : response(id, prompt));
  assert.equal(session.consensus?.contextOmittedCriticalIds?.length, 0);
  assert.equal(session.consensus?.objectionCoverage?.included, session.objections.length);
  assert.equal(session.consensus?.status, 'blocked');
  assert.equal(session.consensus?.blockingObjectionIds.length, session.objections.length);
});
