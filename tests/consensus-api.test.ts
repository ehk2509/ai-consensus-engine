import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('API exposes a persistent M3 decision report only after valid voting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m3-api-'));
  const ids: ProviderId[] = ['codex', 'claude'];
  const adapters = new Map<string, AgentAdapter>(ids.map((id) => [id, { id, propose: async (prompt) => {
    if (prompt.includes('Stage: CRITIQUE')) return JSON.stringify({ objections: [] });
    if (prompt.includes('Stage: REBUTTAL')) return JSON.stringify({ responses: [] });
    if (prompt.includes('Stage: CONSENSUS DRAFT')) return JSON.stringify({
      proposal: 'Launch a small audited pilot before scaling the AI startup studio.',
      assumptions: ['Pilot customers are available'], evidence: [],
    });
    if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) return JSON.stringify({
      verdict: 'accept', rationale: 'Ready for a controlled pilot', concerns: [], resolvedObjectionIds: [], supersessions: [],
    });
    return 'A valid proposal from ' + id;
  } }]));
  const app = makeApp({ allowUnauthenticatedForTests: true, adapters, store: new DebateStore(dir) });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Evaluate a product initiative', providers: ids, consensus: true, quorum: 'impossible',
    } });
    assert.equal(invalid.statusCode, 400);
    const create = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Evaluate a product initiative', providers: ids, maxRounds: 1, consensus: true,
    } });
    assert.equal(create.statusCode, 202);
    const id = (create.json() as { id: string }).id;
    let final: DebateSession | undefined;
    for (let i = 0; i < 120; i++) {
      const r = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      const value = r.json() as DebateSession;
      if (!['running', 'queued'].includes(value.status)) { final = value; break; }
      await new Promise((done) => setTimeout(done, 15));
    }
    assert.ok(final);
    assert.equal(final.consensus?.status, 'unanimous');
    assert.equal(final.calls, 11);
    const report = await app.inject({ method: 'GET', url: '/api/debates/' + id + '/report' });
    assert.equal(report.statusCode, 200);
    assert.match(report.headers['content-type'] as string, /text\/markdown/);
    assert.match(report.headers['content-disposition'] as string, /attachment;/);
    assert.match(report.body, /Independent votes/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates/not-an-id/report' })).statusCode, 404);
    const stored = await new DebateStore(dir).get(id);
    assert.equal(stored?.consensus?.status, 'unanimous');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('report endpoint refuses non-voted M2 sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-m3-legacy-'));
  const adapters = new Map<string, AgentAdapter>([
    ['codex', { id: 'codex', propose: async () => 'Response A' }],
    ['claude', { id: 'claude', propose: async () => 'Response B' }],
  ]);
  const app = makeApp({ allowUnauthenticatedForTests: true, adapters, store: new DebateStore(dir) });
  try {
    const started = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Evaluate a small business initiative', providers: ['codex', 'claude'], maxRounds: 1,
    } });
    const id = (started.json() as { id: string }).id;
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates/' + id + '/report' })).statusCode, 409);
    for (let i = 0; i < 150; i++) {
      const snapshot = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      if (!['queued', 'running'].includes((snapshot.json() as DebateSession).status)) break;
      await new Promise((done) => setTimeout(done, 15));
    }
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
