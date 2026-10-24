import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { AgentExecutionError } from '../apps/api/src/process.ts';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import { chooseFacilitator } from '../packages/core/src/consensus.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const ids: ProviderId[] = ['codex', 'claude', 'gemini'];
const prompt = 'Evaluate an evidence-grounded startup concept with transparent uncertainty.';
const req = (extra: Record<string, unknown> = {}) =>
  validateDebateRequest({ prompt, providers: ids, maxRounds: 1, consensus: true,
    unlimitedBudget: true, negotiationCycles: 0, ...extra });
const success = (id: ProviderId, text: string) => {
  if (text.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
  if (text.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
  if (text.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({
    proposal: 'Evidence-aware, phased validation with legal and customer research gates.',
    assumptions: [], evidence: [],
  });
  if (text.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({
    verdict: 'accept', rationale: 'Explicit assumptions and validation gates are preserved.',
    concerns: [], resolvedObjectionIds: [], supersessions: [],
  });
  return 'A concrete, independently reviewed plan by ' + id;
};
function agents(fn: (id: ProviderId, text: string, timeout?: number) => string | Promise<string>) {
  return new Map<string, AgentAdapter>(ids.map(id => [id, {
    id, propose: (text, _signal, options) => Promise.resolve(fn(id, text, options?.timeoutMs)),
  }]));
}
async function run(fn: (id: ProviderId, text: string, timeout?: number) => string | Promise<string>,
  extra: Record<string, unknown> = {}) {
  const session = createDebateSession(req(extra));
  await executeDebate(session, agents(fn), async () => {});
  return session;
}
async function withServer(session: DebateSession,
  fn: (id: ProviderId, text: string, timeout?: number) => string | Promise<string>,
  check: (app: ReturnType<typeof makeApp>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ace-m54-'));
  await new DebateStore(directory).save(session);
  const app = makeApp({
    allowUnauthenticatedForTests: true, store: new DebateStore(directory), adapters: agents(fn),
  });
  try { await app.inject('/api/health'); await check(app); }
  finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
}
async function recovered(app: ReturnType<typeof makeApp>, id: string): Promise<DebateSession> {
  for (let tries = 0; tries < 160; tries++) {
    const data = (await app.inject('/api/debates/' + id)).json() as DebateSession;
    if (!['running', 'queued'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Recovery did not settle in time');
}

test('synthesis timeout is configurable and fallback defaults on with strict bounded validation', () => {
  assert.equal(req().synthesisTimeoutMs, 600000);
  assert.equal(req().synthesisFallback, true);
  assert.equal(req({ synthesisTimeoutMs: 30000, synthesisFallback: false }).synthesisTimeoutMs, 30000);
  assert.equal(req({ synthesisTimeoutMs: 1800000 }).synthesisTimeoutMs, 1800000);
  for (const value of [0, 29999, 1800001, 12.5, '600000', null]) {
    assert.throws(() => req({ synthesisTimeoutMs: value }));
  }
  for (const value of [null, 'false', 1]) {
    assert.throws(() => req({ synthesisFallback: value }));
  }
});

test('timed-out synthesis falls back to another selected model without hiding the first failure', async () => {
  const timeouts: Array<{ id: ProviderId; ms?: number }> = [];
  const session = createDebateSession(req({ synthesisTimeoutMs: 450000 }));
  const preferred = chooseFacilitator(session);
  await executeDebate(session, agents((id, text, timeoutMs) => {
    if (text.includes('Stage: CONSENSUS DRAFT')) {
      timeouts.push({ id, ms: timeoutMs });
      if (id === preferred) throw new AgentExecutionError('Provider timed out.');
    }
    return success(id, text);
  }), async () => {});
  assert.equal(session.status, 'completed');
  assert.equal(session.consensus?.status, 'unanimous');
  assert.notEqual(session.consensus?.draft?.author, preferred);
  assert.equal(session.consensus?.callJournal?.filter(c => c.stage === 'synthesis').length, 2);
  const attempts = session.consensus?.callJournal?.filter(c => c.stage === 'synthesis') ?? [];
  assert.equal(attempts[0]?.provider, preferred);
  assert.equal(attempts[0]?.status, 'rejected');
  assert.match(attempts[0]?.error ?? '', /timed out/i);
  assert.equal(attempts[0]?.timeoutMs, 450000);
  assert.equal(attempts[1]?.status, 'fulfilled');
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts.every(x => x.ms === 450000));
  assert.equal(session.consensus?.votes.length, 3);
  assert.match(session.consensus?.reportMarkdown ?? '', /timeout ms: 450000/);
});

test('invalid structured synthesis triggers fallback but never becomes a frozen draft', async () => {
  const session = createDebateSession(req());
  const preferred = chooseFacilitator(session);
  await executeDebate(session, agents((id, text) =>
    text.includes('Stage: CONSENSUS DRAFT') && id === preferred ? '{"proposal": ""}' : success(id, text)
  ), async () => {});
  assert.equal(session.consensus?.status, 'unanimous');
  assert.notEqual(session.consensus?.draft?.author, preferred);
  assert.equal(session.consensus?.callJournal?.[0]?.stage, 'synthesis');
  assert.equal(session.consensus?.callJournal?.[0]?.status, 'rejected');
  assert.equal(session.consensus?.callJournal?.filter(c => c.stage === 'synthesis').length, 2);
});

test('fallback can be disabled, leaving an auditable incomplete outcome and zero ballots', async () => {
  const session = await run((id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT')) throw new AgentExecutionError('Provider timed out.');
    return success(id, text);
  }, { synthesisFallback: false });
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.draft, undefined);
  assert.equal(session.consensus?.votes.length, 0);
  assert.equal(session.consensus?.callJournal?.length, 1);
  assert.match(session.consensus?.reportMarkdown ?? '', /No valid synthesis draft/);
});

test('all failed synthesis attempts resume with ONE named authorization, not a full debate replay', async () => {
  const session = await run((id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT')) throw new AgentExecutionError('Provider timed out.');
    return success(id, text);
  });
  const before = session.calls;
  const entries = session.entries.map(e => e.id);
  const failed = session.consensus?.callJournal?.filter(c => c.stage === 'synthesis') ?? [];
  assert.equal(failed.length, 3);
  assert.equal(session.consensus?.status, 'incomplete');
  assert.equal(session.consensus?.votes.length, 0);
  const selectedId = failed[0]!.id;
  let synthesisRepeats = 0;
  let debateRepeats = 0;
  await withServer(session, (id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT')) synthesisRepeats++;
    else if (!text.includes('Stage: INDEPENDENT CONSENSUS VOTE')) debateRepeats++;
    return success(id, text);
  }, async app => {
    const withoutAuth = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume',
      payload: {} });
    assert.equal(withoutAuth.statusCode, 409);
    const blocked = withoutAuth.json() as { uncertainCallIds: string[] };
    assert.deepEqual(new Set(blocked.uncertainCallIds), new Set(failed.map(c => c.id)));
    const withAuth = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume',
      payload: { retryCallIds: [selectedId], acknowledgeMayRepeatCall: true } });
    assert.equal(withAuth.statusCode, 202);
    const done = await recovered(app, session.id);
    assert.equal(done.consensus?.status, 'unanimous');
    assert.equal(done.calls, before + 4);
    assert.deepEqual(done.entries.map(e => e.id), entries);
    assert.equal(synthesisRepeats, 1);
    assert.equal(debateRepeats, 0);
    assert.equal(done.consensus?.callJournal?.filter(c => c.stage === 'synthesis').length, 4);
    assert.equal(done.consensus?.callJournal?.filter(c => c.stage === 'synthesis' && c.retryAuthorized).length, 1);
    assert.equal(done.recoveryHistory?.[0]?.authorizedCallIds[0], selectedId);
  });
});

test('historical failed synthesis can resume via an untouched alternate model without replaying old call', async () => {
  const session = await run((id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT')) throw new AgentExecutionError('Provider timed out.');
    return success(id, text);
  }, { synthesisFallback: false });
  const original = session.consensus!.callJournal![0]!;
  // Emulate an old pre-fallback session: a single failed synthesis and no fallback flag.
  session.request.synthesisFallback = undefined;
  const before = session.calls;
  let reusedOriginal = false;
  await withServer(session, (id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT') && id === original.provider) reusedOriginal = true;
    return success(id, text);
  }, async app => {
    const result = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume', payload: {} });
    assert.equal(result.statusCode, 202);
    const done = await recovered(app, session.id);
    assert.equal(done.consensus?.status, 'unanimous');
    assert.equal(done.consensus?.callJournal?.[0]?.id, original.id);
    assert.equal(done.consensus?.callJournal?.[0]?.status, 'rejected');
    assert.equal(done.calls, before + 4);
    assert.equal(reusedOriginal, false);
  });
});

test('fallback still respects unresolved critical objection gate and independent voting', async () => {
  const session = createDebateSession(req());
  const preferred = chooseFacilitator(session);
  await executeDebate(session, agents((id, text) => {
    if (text.includes('Stage: CONSENSUS DRAFT') && id === preferred) throw new AgentExecutionError('Provider timed out.');
    if (text.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: Array.from({ length: 4 }, (_, i) => ({
      claim: 'Unverified data reuse authorization ' + id + '-' + i,
      criticism: 'Commercial processing permissions and lawful basis are not established.',
      severity: 'high', evidence: [],
    })) });
    if (text.includes('Stage: FINAL OBJECTION RESOLUTION')) return JSON.stringify({ decisions: [] });
    return success(id, text);
  }), async () => {});
  assert.equal(session.objections.length, 24);
  assert.equal(session.consensus?.votes.length, 3);
  assert.equal(session.consensus?.status, 'blocked');
  assert.equal(session.consensus?.unresolvedCriticalObjectionIds.length, 24);
  assert.equal(session.consensus?.objectionCoverage?.omittedCritical, 0);
});
