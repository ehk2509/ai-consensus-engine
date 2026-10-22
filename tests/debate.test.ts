import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest, recommendedTurnTimeoutMs } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

function adaptersWith(
  response: (provider: ProviderId, prompt: string) => Promise<string> | string,
): Map<string, AgentAdapter> {
  const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
  return new Map(ids.map((id) => [id, { id, propose: (prompt) => Promise.resolve(response(id, prompt)) }]));
}
const ideas = { prompt: 'Evaluate an autonomous AI startup platform.', providers: ['codex', 'claude', 'gemini'] as ProviderId[], maxRounds: 1 };

test('validates debate provider counts and bounded rounds', () => {
  assert.deepEqual(validateDebateRequest({ prompt: ideas.prompt, providers: ['codex', 'claude'] }).maxRounds, 1);
  for (const input of [
    { ...ideas, providers: ['claude'] }, { ...ideas, maxRounds: 0 }, { ...ideas, maxRounds: 4 },
    { ...ideas, maxRounds: 1.5 }, { ...ideas, maxRounds: '2' },
  ]) assert.throws(() => validateDebateRequest(input));
});

test('stages run in order, with peer-targeted critique and separate rebuttal and revisions', async () => {
  const calls: Array<{ id: ProviderId; prompt: string }> = [];
  const published: DebateSession[] = [];
  const session = createDebateSession(ideas);
  await executeDebate(session, adaptersWith((id, prompt) => {
    calls.push({ id, prompt });
    if (prompt.includes('Stage: INDEPENDENT PROPOSAL')) {
      assert.doesNotMatch(prompt, /proposal_under_review/);
      return 'Initial view by ' + id;
    }
    if (prompt.includes('Stage: CRITIQUE')) return 'Specific critique by ' + id;
    if (prompt.includes('Stage: REBUTTAL')) {
      assert.match(prompt, /Specific critique/);
      return 'Accept or explain';
    }
    if (prompt.includes('Stage: REVISE')) {
      assert.match(prompt, /Specific critique/);
      return 'Revised view by ' + id;
    }
    throw new Error('Unexpected phase');
  }), async (snapshot) => { published.push(structuredClone(snapshot)); });
  assert.equal(session.status, 'completed');
  assert.equal(session.entries.length, 15);
  assert.deepEqual(session.entries.filter((e) => e.phase === 'proposal').map((e) => e.provider).sort(), ['claude', 'codex', 'gemini']);
  const critiques = session.entries.filter((e) => e.phase === 'critique');
  assert.equal(critiques.length, 6);
  assert.ok(critiques.every((e) => e.provider !== e.target));
  assert.equal(new Set(critiques.map((e) => e.provider + '->' + e.target)).size, 6);
  assert.equal(session.entries.filter((e) => e.phase === 'rebuttal').length, 3);
  assert.equal(session.entries.filter((e) => e.phase === 'revision').length, 3);
  assert.equal(session.events.filter((event) => event.type === 'stage').length, 4);
  assert.ok(published.length >= session.entries.length);
  assert.deepEqual(session.events.map((event) => event.sequence), session.events.map((_event, i) => i + 1));
  const stages = calls.map((call) => /Stage: ([A-Z ]+)/.exec(call.prompt)?.[1]?.trim());
  assert.deepEqual(stages.slice(0, 3), ['INDEPENDENT PROPOSAL', 'INDEPENDENT PROPOSAL', 'INDEPENDENT PROPOSAL']);
  assert.ok(stages.slice(3, 9).every((stage) => stage === 'CRITIQUE'));
  assert.ok(stages.slice(9, 12).every((stage) => stage === 'REBUTTAL'));
  assert.ok(stages.slice(12).every((stage) => stage === 'REVISE'));
});

test('reruns debates for configured rounds using latest revisions', async () => {
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'], maxRounds: 2 });
  await executeDebate(session, adaptersWith((id, prompt) => {
    if (prompt.includes('Stage: REVISE')) return 'Revision at ' + /round (\d+)/.exec(prompt)?.[1] + ' from ' + id;
    if (prompt.includes('Stage: CRITIQUE, round 2')) {
      assert.match(prompt, /Revision at 1/);
    }
    return 'A concrete answer from ' + id;
  }), async () => {});
  assert.equal(session.status, 'completed');
  assert.equal(session.entries.length, 14);
  assert.equal(session.entries.filter((e) => e.phase === 'revision' && e.round === 2).length, 2);
  assert.equal(session.events.filter((e) => e.type === 'stage').length, 7);
});

test('isolates failed agents and marks insufficient participation correctly', async () => {
  const session = createDebateSession(ideas);
  await executeDebate(session, adaptersWith((id, prompt) => {
    if (id === 'gemini' && prompt.includes('INDEPENDENT PROPOSAL')) throw new Error('TOP SECRET');
    if (id === 'codex' && prompt.includes('Stage: CRITIQUE')) throw new Error('TOP SECRET');
    return 'A valid answer';
  }), async () => {});
  assert.equal(session.status, 'partial');
  assert.equal(session.entries.filter((e) => e.phase === 'critique').length, 2);
  assert.ok(session.entries.filter((e) => e.status === 'rejected').every((e) => e.error === 'Provider failed unexpectedly.'));
  const failAll = createDebateSession(ideas);
  await executeDebate(failAll, adaptersWith(() => { throw new Error('no service'); }), async () => {});
  assert.equal(failAll.status, 'insufficient');
  assert.ok(failAll.entries.every((entry) => entry.phase === 'proposal'));
});

test('peer material is delimited and trimmed before being reintroduced as context', async () => {
  let examined = 0;
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'] });
  await executeDebate(session, adaptersWith((_id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) {
      examined++;
      assert.ok(prompt.includes('<proposal_under_review>'));
      assert.ok(prompt.includes('UNTRUSTED'));
      assert.ok(prompt.length < 40000);
    }
    if (prompt.includes('Stage: INDEPENDENT')) return 'X'.repeat(29000);
    return 'Response';
  }), async () => {});
  assert.equal(examined, 2);
  assert.ok(session.entries.every((e) => !e.content || e.content.length <= 25100));
});

test('records structured objections and maps rebuttal responses to exact objection IDs', async () => {
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'] });
  await executeDebate(session, adaptersWith((_id, prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) {
      return JSON.stringify({ objections: [{ claim: 'Assumes zero marginal cost', criticism: 'Compute costs are not free', severity: 'high', evidence: ['API metering'], suggestedChange: 'Run cost experiments' }] });
    }
    if (prompt.includes('Stage: REBUTTAL')) {
      const ids = [...prompt.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1]);
      return JSON.stringify({ responses: ids.map((objectionId) => ({ objectionId, resolution: 'accepted', reason: 'Budget the compute costs.' })) });
    }
    return 'A plausible proposal';
  }), async () => {});
  assert.equal(session.objections.length, 2);
  assert.equal(new Set(session.objections.map((o) => o.id)).size, 2);
  assert.ok(session.objections.every((o) => o.severity === 'high' && o.resolution === 'accepted'));
  assert.ok(session.objections.every((o) => o.response?.includes('Budget the compute')));
});

test('preserves unstructured objections as unresolved rather than assuming an agreement', async () => {
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'] });
  await executeDebate(session, adaptersWith((_id, prompt) => prompt.includes('Stage: CRITIQUE') ? 'This is not structured JSON' : 'Plaintext reply'), async () => {});
  assert.equal(session.objections.length, 2);
  assert.ok(session.objections.every((o) => o.severity === 'unspecified' && o.resolution === 'unresolved'));
});

test('caps total provider calls and reports budget exhaustion', async () => {
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'], maxRounds: 3, maxCalls: 3 });
  let invoked = 0;
  await executeDebate(session, adaptersWith(() => { invoked++; return 'A valid proposal'; }), async () => {});
  assert.equal(invoked, 3);
  assert.equal(session.calls, 3);
  assert.equal(session.status, 'budget_exhausted');
  assert.ok(session.entries.some((entry) => entry.status === 'skipped'));
});

test('stops debates when cancelled without falsely claiming completion', async () => {
  const controller = new AbortController();
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'] });
  await executeDebate(session, adaptersWith(async () => {
    controller.abort();
    return 'A response';
  }), async () => {}, controller.signal);
  assert.equal(session.status, 'cancelled');
  assert.ok(session.calls <= 2);
});

test('rejects invalid total call and time budgets', () => {
  for (const values of [{ maxCalls: 41 }, { maxCalls: 1 }, { maxDurationMs: 9000 }, { maxDurationMs: 1900000 }]) {
    assert.throws(() => validateDebateRequest({ ...ideas, ...values }));
  }
});

test('revision timeout increases for later rounds without crossing the session deadline', async () => {
  assert.equal(recommendedTurnTimeoutMs('proposal', 0), 150000);
  assert.equal(recommendedTurnTimeoutMs('critique', 3), 150000);
  assert.equal(recommendedTurnTimeoutMs('revision', 1), 180000);
  assert.equal(recommendedTurnTimeoutMs('revision', 2), 210000);
  assert.equal(recommendedTurnTimeoutMs('revision', 3), 240000);
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude'], maxRounds: 3, maxDurationMs: 10000 });
  const seen: Array<{ stage: string; timeoutMs?: number }> = [];
  const adapters = new Map<string, AgentAdapter>(['codex', 'claude'].map(id => [id, {
    id: id as ProviderId,
    propose: async (prompt: string, _signal?: AbortSignal, options?: {timeoutMs?: number}) => {
      seen.push({ stage: prompt.includes('Stage: REVISE') ? 'revision' : 'other', timeoutMs: options?.timeoutMs });
      return 'A measured answer';
    },
  }]));
  await executeDebate(session, adapters, async () => {});
  const revision = seen.filter(x => x.stage === 'revision');
  assert.equal(revision.length, 6);
  assert.ok(revision.every(x => x.timeoutMs !== undefined && x.timeoutMs > 0 && x.timeoutMs <= 10000));
});

test('late-round revision prompts are explicitly bounded rather than endlessly copying full history', async () => {
  const session = createDebateSession({ ...ideas, providers: ['codex', 'claude', 'gemini'], maxRounds: 3 });
  const lengths: number[] = [];
  await executeDebate(session, adaptersWith((_id, prompt) => {
    if (prompt.includes('Stage: REVISE, round 3')) {
      lengths.push(prompt.length);
      assert.match(prompt, /below 1,800 words/);
    }
    return 'long proposal '.repeat(1800);
  }), async () => {});
  assert.equal(lengths.length, 3);
  assert.ok(lengths.every(length => length < 30000));
});
