import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp } from '../apps/api/src/app.ts';
import { DebateStore } from '../apps/api/src/debate-store.ts';
import type { AgentAdapter } from '../packages/core/src/types.ts';
import type { DebateSession } from '../packages/core/src/debate.ts';

test('creates asynchronous debates, streams completed state and retrieves history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ace-api-test-'));
  const adapters = new Map<string, AgentAdapter>([
    ['codex', { id: 'codex', propose: async () => 'Response A' }],
    ['claude', { id: 'claude', propose: async () => 'Response B' }],
  ]);
  const app = makeApp({ adapters, store: new DebateStore(dir) });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/api/debates', payload: { prompt: 'short', providers: ['codex'] } });
    assert.equal(invalid.statusCode, 400);
    const started = await app.inject({ method: 'POST', url: '/api/debates', payload: {
      prompt: 'Debate on autonomous startups', providers: ['codex', 'claude'], maxRounds: 1,
    } });
    assert.equal(started.statusCode, 202);
    const id = (started.json() as { id: string }).id;
    let session: DebateSession | null = null;
    for (let i = 0; i < 150; i++) {
      const response = await app.inject({ method: 'GET', url: '/api/debates/' + id });
      session = response.json() as DebateSession;
      if (!['queued', 'running'].includes(session.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(session?.status, 'completed');
    assert.equal(session?.entries.length, 8);
    const listing = await app.inject({ method: 'GET', url: '/api/debates' });
    assert.equal((listing.json() as { sessions: unknown[] }).sessions.length, 1);
    const streamed = await app.inject({ method: 'GET', url: '/api/debates/' + id + '/events' });
    assert.equal(streamed.statusCode, 200);
    assert.match(streamed.body, /event: update/);
    assert.match(streamed.body, /completed/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/debates/invalid' })).statusCode, 404);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
