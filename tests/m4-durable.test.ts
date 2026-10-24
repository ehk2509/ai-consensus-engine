import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import { createDebateSession, debateStepKey } from '../packages/core/src/debate.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const prompt = 'Assess a sustainable multi-agent startup operation with governance safeguards';
const providers: ProviderId[] = ['codex', 'claude'];
const request = { prompt, providers, maxRounds: 1, maxCalls: 20, maxDurationMs: 120000 };
function adapters(onCall?: (id: ProviderId, prompt: string) => void): Map<string, AgentAdapter> {
  return new Map(providers.map(id => [id, {
    id, propose: async (text: string) => { onCall?.(id, text); return 'Reviewable response from ' + id; },
  }]));
}
async function settled(app: ReturnType<typeof makeApp>, id: string) {
  let value: DebateSession | undefined;
  for (let i = 0; i < 180; i++) {
    const response = await app.inject({ method: 'GET', url: '/api/debates/' + id });
    value = response.json() as DebateSession;
    if (!['queued', 'running'].includes(value.status)) return value;
    await new Promise(done => setTimeout(done, 15));
  }
  assert.fail('Debate did not settle');
}
test('durable queue auto-recovers never-issued queued jobs after worker process restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-queue-'));
  const store = new DebateStore(dir);
  const session = createDebateSession(request);
  await store.save(session);
  const app = makeApp({ allowUnauthenticatedForTests: true, store: new DebateStore(dir), adapters: adapters() });
  try {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal((health.json() as { version: string }).version, '0.5.3');
    const finished = await settled(app, session.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.entries.filter(e => e.status === 'fulfilled').length, 8);
    const metrics = await app.inject({ method: 'GET', url: '/api/metrics' });
    assert.equal((metrics.json() as { calls: { recoveredQueued: number } }).calls.recoveredQueued, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('safe manual resume reuses completed model calls without duplicating provider cost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-safe-'));
  const store = new DebateStore(dir);
  const session = createDebateSession(request);
  session.status = 'running';
  session.calls = 1;
  session.entries.push({
    id: '39cb88ee-1796-4ee1-b2d0-8d43d8c05f81', stepKey: debateStepKey('proposal', 0, 'codex'),
    provider: 'codex', phase: 'proposal', round: 0, status: 'fulfilled',
    content: 'Previously completed codex response', durationMs: 120, createdAt: new Date().toISOString(),
  });
  await store.save(session);
  const calls: Array<{ id: ProviderId; prompt: string }> = [];
  const app = makeApp({ allowUnauthenticatedForTests: true, adapters: adapters((id, text) => calls.push({ id, prompt: text })), store: new DebateStore(dir) });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates/' + session.id })).json().status, 'interrupted');
    const resumed = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume', payload: {} });
    assert.equal(resumed.statusCode, 202);
    const finished = await settled(app, session.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.calls, 8);
    assert.equal(calls.length, 7);
    assert.equal(calls.filter(call => call.id === 'codex' && call.prompt.includes('Stage: INDEPENDENT PROPOSAL')).length, 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('uncertain externally issued calls fail closed until the operator explicitly authorizes replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-uncertain-'));
  const store = new DebateStore(dir);
  const session = createDebateSession(request);
  session.status = 'running';
  session.calls = 1;
  const uncertainId = 'c6fb3c79-00e8-43d2-9a3a-c2239e06f94d';
  session.entries.push({
    id: uncertainId, stepKey: debateStepKey('proposal', 0, 'codex'),
    provider: 'codex', phase: 'proposal', round: 0, status: 'issued',
    durationMs: 0, createdAt: new Date().toISOString(),
  });
  await store.save(session);
  const calls: string[] = [];
  const app = makeApp({ allowUnauthenticatedForTests: true, store: new DebateStore(dir), adapters: adapters(id => calls.push(id)) });
  try {
    const rejected = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume', payload: {} });
    assert.equal(rejected.statusCode, 409);
    assert.deepEqual((rejected.json() as { uncertainCallIds: string[] }).uncertainCallIds, [uncertainId]);
    assert.equal(calls.length, 0);
    const still = await new DebateStore(dir).getPersisted(session.id);
    assert.equal(still?.calls, 1);
    const badAuth = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume',
      payload: { retryCallIds: [uncertainId], acknowledgeMayRepeatCall: false } });
    assert.equal(badAuth.statusCode, 409);
    const accepted = await app.inject({ method: 'POST', url: '/api/debates/' + session.id + '/resume',
      payload: { retryCallIds: [uncertainId], acknowledgeMayRepeatCall: true } });
    assert.equal(accepted.statusCode, 202);
    const completed = await settled(app, session.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.calls, 9);
    assert.ok(completed.entries.some(e => e.id === uncertainId && e.status === 'uncertain' && e.retryAuthorized));
    assert.equal(completed.entries.filter(e => e.phase === 'proposal' && e.provider === 'codex' && e.status === 'fulfilled').length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('local API auth denies unauthenticated requests and uses HttpOnly cookies or bearer credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-auth-'));
  const apiToken = 'a-very-long-development-token-for-tests';
  const app = makeApp({ adapters: adapters(), store: new DebateStore(dir), apiToken });
  try {
    assert.equal((await app.inject('/api/health')).statusCode, 200);
    const status = await app.inject('/api/auth/status');
    assert.equal(status.json().required, true);
    assert.equal(status.json().authenticated, false);
    assert.equal((await app.inject('/api/debates')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { token: 'bad-token' } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: apiToken } });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    assert.match(String(login.headers['set-cookie']), /SameSite=Strict/);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates', headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates', headers: { authorization: 'Bearer ' + apiToken } })).statusCode, 200);
    assert.equal((await app.inject('/api/metrics')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/debates',
      payload: request })).statusCode, 401);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('data directory lease refuses a second worker and is released after shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m4-lease-'));
  try {
    const first = await new DebateStore(dir).acquireWorkerLease();
    try {
      await assert.rejects(new DebateStore(dir).acquireWorkerLease(), /Another active worker/);
    } finally {
      await first(); // Never strand an external flock helper on failed assertions.
    }
    const second = await new DebateStore(dir).acquireWorkerLease();
    await second();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
